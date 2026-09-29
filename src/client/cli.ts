import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { getAgent, listAgents, readAgentSource } from "@/agents/registry";
import { optionalRunInputs, requiredRunInputs } from "@/workflows/inputs";
import { getWorkflow, readWorkflowSource } from "@/workflows/registry";

import type { TeachAccount } from "@/lib/client-api-schemas";
import { decodeConnectionToken, looksLikeConnectionToken } from "@/lib/connect-token";
import { describeActivity, describeFeature, describeFeatureList, describeHistory, describeRepoRecord, describeSearch } from "@/memory/cards";
import { parseSince } from "@/memory/since";
import { LINKED_DIRECTORIES } from "@/repos/detect";
import { checkpointWork, publishBranch } from "@/repos/publish";
import { readRemoteUrl, type RunWorkspace } from "@/runtime/workspace";

import { CLI_VERSION, GateApiError, GateClient } from "./api";
import { cacheScope, clearLocalState, readManifest, writeBundle, type Manifest } from "./cache";
import {
  isTrusted,
  readConfig,
  repoPaths,
  setRepoPath,
  trustWorkflow,
  writeConfig,
  writeLogin,
  type ClientConfig,
} from "./config";
import { applyClean, describeVerdict, listWorkspaces, planClean } from "./clean";
import { begin, continueRun, next, noteSession, step, type Instruction, type SessionRunContext } from "./step";
import { cleanGatewayWiring } from "./claude-settings";
import { removeSubagents, syncSubagents } from "./subagents";
import { describeBranch, readAccount, readBranch, readBranchDiff, TeachError, type BranchReading } from "./teach";

/**
 * `gate` — the command a developer runs, and what /gate:run calls.
 *
 * It connects with the person's own API key, mirrors their team's definitions
 * onto this machine, and hands the person's Claude Code session one node at a
 * time: the worktree is a branch of the repository they are standing in, every
 * model call is their own Claude login, and only the reporting goes to the
 * server.
 */

const USAGE = `gate ${CLI_VERSION} — run your team's agent workflows on this machine

  gate install                                  put gate itself on your PATH
  gate login <token>                            connect this machine (one token from your dashboard)
       --url <gate-url> --key <api-key>         …or the two halves separately
  gate whoami                                   who this key belongs to
  gate version                                  what this build is
  gate pull                                     refresh your team's definitions
  gate list                                     what you can run, and what it needs
  gate agents                                   the agents your team's pipelines use
  gate show <workflow|agent-id>                 print a definition as it is on the server
  gate push <file…> [--replace]                 save definitions to your team (needs an author key)

  the protocol /gate:run drives, one node at a time in your own session:
  gate begin <workflow> [task…]                 start a run, print the first instruction
       --input key=value                        (repeat for more than one input)
       --task-id <id>                           file this run under a cross-team task
  gate next <execution-id> [--full]             what to do next (--full: the whole
                                                prompt again, for a node whose
                                                subagent is gone)
  gate step <execution-id> <node> --output-file <f>   hand back a node's answer
        [--subagent <id>]                        the agent id the Agent tool returned, so its next pass
                                                 continues it — not the gate-<team>-<agent> type name
  gate continue <execution-id>                  pick a failed run back up at the node it failed on
  gate repo [<id> <path>]                       point a pinned repository at your clone
  gate clean [--all] [--dry-run]                remove worktrees runs left behind (branches keep the work)
  gate reset                                    disconnect this machine and clear what it pulled
  gate status [--limit n]                       your team's recent runs
  gate cancel <execution-id>                    ask a run to stop
  gate memory search [words…] [--path <prefix>]… [--feature <id>] [--since 30d] [--as-of <date>] [--limit n] [--json]
                                                what your team's tree decided before: why, how, where, which commits
  gate memory feature <id> [--json]             one feature: how each team built it, and every decision under it
  gate memory history [--path <prefix>]… [--since 30d] [--repo <host/owner/name>] [--limit n] [--json]
                                                what changed there on the base branch: commits, their record, their run
  gate memory activity [--json]                 what the rest of your team's tree is running right now
  gate memory features [--json]                 the tree's feature catalogue: the ids a design doc is named by
  gate memory repo [--json]                     whether this checkout's repository is connected and read by the gate
  gate ask "<question>" --repo <host/owner/name> [--ref <branch>] [--commit <sha>]
       …or --run <id>                           ask another team what their code does: starts an ask run here,
                                                answered from one commit the gate fixes, with files
  gate source tree <ask> [path] [--depth n]      that commit's files, read through the gate
  gate source grep <ask> <pattern> [--path p] [--ext ts]
  gate source file <ask> <path> [--offset n] [--limit n]
  gate teach [--base <ref>]                     read the finished branch you are on: its range, commits and files
  gate teach --account-file <f> [--base <ref>] [--force] [--no-wait] [--task-id <id>]
                                                teach it to your team's memory, recorded the way a run is
       --wip                                    the branch is not finished: its decisions are recorded as
                                                in-progress, so other teams object before they set

Environment: GATE_URL and GATE_KEY override the saved login.`;

export interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Which flags take a value.
 *
 * Guessing from "the next word does not start with --" cannot work here: the
 * task a run is given is a positional sentence, so `begin smoke --yes make a
 * file` would swallow "make" as the value of --yes and lose the task. The list
 * is short, and the alternative is a parser that is wrong in exactly the case
 * the tool exists for.
 */
const VALUE_FLAGS = new Set([
  "url", "key", "token", "input", "limit", "team", "dir", "output-file", "subagent", "path", "feature", "since", "as-of", "base", "account-file", "task-id",
  // `gate ask`: which repository, and which version of it.
  "repo", "run", "ref", "commit",
  // `gate source`: where to look, and how much.
  "depth", "ext", "offset",
]);

/** Flags that collect when repeated, rather than the last one winning. */
const REPEATABLE_FLAGS = new Set(["input", "path"]);

export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    // Repeated --input key=value pairs collect rather than overwrite.
    const collect = (value: string) =>
      (flags[name] = REPEATABLE_FLAGS.has(name) && typeof flags[name] === "string" ? `${flags[name]}\u0000${value}` : value);

    if (inline !== undefined) {
      collect(inline);
      continue;
    }
    const next = rest[i + 1];
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
      collect(next);
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { command, positional, flags };
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function connect(): GateClient {
  const config = readConfig();
  if (!config) {
    die(
      "not connected — run `/gate:login <token>` in Claude Code, with the token from your gate dashboard's Team page " +
        "(or `gate login <token>` in a terminal)",
    );
  }
  return new GateClient(config);
}

/**
 * Brings the mirror up to date, cheaply.
 *
 * The bundle carries a hash and the server answers 304 when nothing changed,
 * so this runs before every list and every run: a definition edited in the
 * dashboard is live on every machine at the next command, and nobody has to
 * remember to pull.
 */
async function sync(client: GateClient, team: string | undefined, quiet = false): Promise<Manifest> {
  const known = team ? readManifest(team) : null;
  try {
    const bundle = await client.bundle(known?.hash);
    if (!bundle) return known!;
    const manifest = writeBundle(bundle, client.url);
    if (!quiet && known && known.hash !== manifest.hash) {
      console.error(`# definitions updated (${manifest.workflows.length} workflows)`);
    }
    for (const error of bundle.errors) {
      console.error(`# warning: workflow "${error.id}" is broken on the server — ${error.message}`);
    }
    return manifest;
  } catch (e) {
    // Offline is survivable when there is a mirror; it is fatal when there is
    // not, and saying which is the difference between a warning and a wall.
    if (known) {
      if (!quiet) console.error(`# using the definitions pulled ${new Date(known.pulledAt).toLocaleString()} (${(e as Error).message})`);
      return known;
    }
    throw e;
  }
}

/** The team this machine is connected as, from the saved login or from /me. */
async function teamOf(client: GateClient, config: ClientConfig): Promise<string> {
  if (config.team) return config.team;
  const me = await client.me();
  // A connection from the environment is for this command only; the login
  // on disk stays whatever the person made it.
  if (!config.fromEnv) writeConfig({ ...config, team: me.team.id, user: me.user?.email });
  return me.team.id;
}

/**
 * Connects this machine.
 *
 * A token is the ordinary way in — one string from the dashboard carrying both
 * the address and the key, so nothing has to be typed twice or in the right
 * order. The two flags stay for scripts and for anyone who has the halves
 * rather than the token.
 */
async function cmdLogin(args: Args): Promise<number> {
  const flags = args.flags;
  const [positional] = args.positional;
  let url = typeof flags.url === "string" ? flags.url.replace(/\/+$/, "") : "";
  let key = typeof flags.key === "string" ? flags.key : "";

  const token = positional ?? (typeof flags.token === "string" ? flags.token : "");
  if (token) {
    if (!looksLikeConnectionToken(token)) {
      // A bare key pasted where a token goes is the likely mistake, and it is
      // worth naming rather than reporting a malformed token.
      die(
        token.startsWith("gate_")
          ? "that is an API key, not a connection token — copy the whole `/gate:login …` line from your dashboard, or pass --url and --key"
          : `that does not look like a gate token: ${token.slice(0, 12)}…`,
      );
    }
    try {
      const connection = decodeConnectionToken(token);
      url = connection.url;
      key = connection.key;
    } catch (e) {
      die((e as Error).message);
    }
  }

  if (!url || !key) die("usage: gate login <token>   (or: gate login --url <gate-url> --key <api-key>)");

  const client = new GateClient({ url, key });
  const me = await client.me();
  writeLogin({ url, key, team: me.team.id, user: me.user?.email });
  console.log(`connected to ${url} as ${me.user?.email ?? "this key"} · team ${me.team.name}`);

  const manifest = await sync(client, me.team.id, true);
  console.log(`${manifest.workflows.length} workflow(s) available — \`gate list\` to see them`);

  // A machine that joined before 0.47 had its sessions put on the gate's
  // gateway; that is gone, and every session runs on the person's own login.
  for (const line of cleanGatewayWiring()) console.log(line);
  const synced = syncSubagents(me.team.id, cacheScope(me.team.id));
  if (synced.created) console.log("restart Claude Code once: its agents directory did not exist before, and it reads a new one at startup");
  return 0;
}

/**
 * Puts `gate` on the PATH.
 *
 * The plugin ships one bundled script and Claude Code invokes it by absolute
 * path, which is all `/gate:run` needs — but everything written down for a
 * person to type ("gate login", the command the dashboard hands them) assumes
 * a `gate` that exists. A three-line shim is the whole of making the two
 * agree; it points at this exact bundle, so a plugin update moves with it.
 *
 * The plugin's SessionStart hook (`plugins/gate/scripts/session-start.mjs`)
 * writes the same shim unasked, because the person who needs it most cannot
 * run this command: a Claude Code at its weekly limit runs no prompt at all.
 * This command stays for a machine holding the bundle without the plugin, and
 * for one that wants the shim somewhere else; the two writers must agree on
 * the shim's contents.
 */
function cmdInstall(args: Args): number {
  const target = typeof args.flags.dir === "string" ? args.flags.dir : join(homedir(), ".local", "bin");
  const script = process.argv[1];
  const shim = join(target, "gate");
  try {
    mkdirSync(target, { recursive: true });
    writeFileSync(shim, `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  } catch (e) {
    die(`could not write ${shim}: ${(e as Error).message}`);
  }
  console.log(`installed ${shim}`);
  const path = (process.env.PATH ?? "").split(":");
  if (!path.includes(target)) {
    console.log(`${target} is not on your PATH — add it, or run gate as ${shim}`);
    console.log(`  echo 'export PATH="${target}:$PATH"' >> ~/.zshrc`);
  }
  return 0;
}

/** This build, without needing a connection — what `/gate:update` reports. */
function cmdVersion(): number {
  console.log(CLI_VERSION);
  return 0;
}

async function cmdWhoami(): Promise<number> {
  const client = connect();
  const me = await client.me();
  console.log(`${me.user?.email ?? "(key with no owner)"} · team ${me.team.name} (${me.team.id}) · ${client.url}`);
  console.log(`scopes: ${me.scopes.join(", ")}`);
  // Both ends, side by side: the first thing to check when a command starts
  // failing in a way the message does not explain.
  console.log(
    `gate ${CLI_VERSION} here · ${me.server?.version ?? "unknown"} there` +
      (me.server?.minClientVersion ? ` (needs ${me.server.minClientVersion}+)` : ""),
  );
  return 0;
}

/**
 * The third `gate list` line: what a workflow needs to start, and — if the
 * workflow's guards read anything else — what else it will listen to. The two
 * lists never share a key, so there is nothing to reconcile between them; the
 * optional segment simply disappears when there is nothing in it, which is
 * why a workflow with no guard-read key prints exactly what it always has.
 */
export function inputSummary(required: string[], optional: string[]): string {
  const base = `input: ${required.length ? required.join(", ") : "none"}`;
  return optional.length ? `${base} · optional: ${optional.join(", ")}` : base;
}

async function cmdList(): Promise<number> {
  const client = connect();
  const config = readConfig()!;
  const team = await teamOf(client, config);
  const manifest = await sync(client, team);
  if (!manifest.workflows.length) {
    console.log("no workflows defined for your team yet");
    return 0;
  }
  const scope = cacheScope(team);
  for (const wf of manifest.workflows) {
    let optional: string[] = [];
    try {
      optional = optionalRunInputs(getWorkflow(wf.id, scope), (id) => getAgent(id, scope));
    } catch {
      // A definition the mirror cannot parse must not stop the listing; it
      // simply shows no optional inputs.
    }
    const where = !wf.workspace
      ? "no workspace (agents cannot touch files)"
      : wf.workspace.repo
        ? `git worktree of ${wf.workspace.repo}`
        : "git worktree of the repo you run it in";
    console.log(wf.id);
    console.log(`  ${wf.name}${wf.description ? ` — ${wf.description}` : ""}`);
    console.log(`  ${inputSummary(wf.inputs, optional)} · ${wf.nodeCount} nodes · ${where}`);
  }
  return 0;
}

async function cmdAgents(): Promise<number> {
  const client = connect();
  const config = readConfig()!;
  const team = await teamOf(client, config);
  await sync(client, team, true);
  const { agents, errors } = listAgents(cacheScope(team));
  for (const agent of agents) {
    const how = agent.executor === "claude-code" ? "claude-code" : `tools: ${agent.tools.join(", ") || "none"}`;
    console.log(`${agent.id}`);
    console.log(`  ${agent.name} · ${agent.model}${agent.effort ? `/${agent.effort}` : ""} · ${how}`);
    console.log(`  inputs: ${agent.inputs.join(", ") || "none"} · output: ${agent.output.type}`);
  }
  for (const error of errors) console.log(`${error.id}\n  BROKEN — ${error.message}`);
  return 0;
}

/** The definition itself — what /gate:design reads before proposing a change to it. */
async function cmdShow(args: Args): Promise<number> {
  const [id] = args.positional;
  if (!id) die("usage: gate show <workflow-id|agent-id>");
  const client = connect();
  const config = readConfig()!;
  const team = await teamOf(client, config);
  await sync(client, team, true);
  const scope = cacheScope(team);
  try {
    const source = readWorkflowSource(id, scope);
    try {
      const workflow = getWorkflow(id, scope);
      const req = requiredRunInputs(workflow, (agentId) => getAgent(agentId, scope));
      const opt = optionalRunInputs(workflow, (agentId) => getAgent(agentId, scope));
      if (req.length) console.log(`# required input: ${req.join(", ")}`);
      if (opt.length) console.log(`# optional input: ${opt.join(", ")}`);
      if (req.length || opt.length) console.log();
    } catch {
      // A source the mirror cannot parse into a definition is still printed
      // as-is; the header is a courtesy, not a requirement to read it.
    }
    console.log(source);
  } catch {
    try {
      console.log(readAgentSource(id, scope));
    } catch {
      die(`no workflow or agent "${id}" for your team`);
    }
  }
  return 0;
}

/**
 * Saves designed definitions to the team.
 *
 * Agents before workflows, whatever order the files were given in: a workflow
 * naming an agent that is not on the server yet is refused, and having to
 * discover that by reading an error is a worse experience than the tool simply
 * knowing which goes first. The kind comes from the extension and the id from
 * the filename, because that is how the dashboard names them too.
 */
async function cmdPush(args: Args): Promise<number> {
  const files = args.positional;
  if (!files.length) die("usage: gate push <file…>   (.md is an agent, .yaml a workflow)");

  const client = connect();
  const config = readConfig()!;
  await teamOf(client, config);

  const items = files.map((file) => {
    const name = basename(file);
    const kind: "agent" | "workflow" = name.endsWith(".md") ? "agent" : "workflow";
    if (!/\.(md|ya?ml)$/.test(name)) die(`${file}: expected a .md agent or a .yaml workflow`);
    return { kind, id: name.replace(/\.(md|ya?ml)$/, ""), file };
  });
  // Agents first — a workflow that names one is validated against what is
  // already there.
  items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "agent" ? -1 : 1));

  let failed = 0;
  for (const item of items) {
    let source: string;
    try {
      source = readFileSync(item.file, "utf8");
    } catch (e) {
      console.error(`${item.file}: ${(e as Error).message}`);
      failed++;
      continue;
    }
    try {
      const res = await client.saveDefinition({
        kind: item.kind,
        id: item.id,
        source,
        replace: args.flags.replace === true,
      });
      console.log(`${res.replaced ? "replaced" : "saved"} ${item.kind} ${item.id}`);
    } catch (e) {
      // Named and counted, then on to the next: one workflow that will not
      // validate should not strand the four agents behind it.
      console.error(`${item.kind} ${item.id}: ${(e as Error).message}`);
      failed++;
    }
  }
  if (!failed) console.log("`gate list` now shows them, on every machine on your team");
  return failed ? 1 : 0;
}

async function cmdPull(): Promise<number> {
  const client = connect();
  const config = readConfig()!;
  const manifest = await sync(client, await teamOf(client, config), true);
  console.log(
    `pulled ${manifest.workflows.length} workflow(s)` +
      (manifest.skills?.length ? ` and ${manifest.skills.length} skill(s)` : "") +
      ` for team ${manifest.team} from ${manifest.from}`,
  );
  return 0;
}

/**
 * What this workflow is allowed to do on this machine, in the plainest terms
 * available: the commands it will run, and whether its agents may write files.
 *
 * This is the one thing a local runner owes its user that a server-side one did
 * not. On the server the blast radius was gate's own worktree; here it is
 * someone's laptop, and the definitions come from the team, not from them.
 */
function describeCapabilities(workflowId: string, team: string): string[] {
  const scope = cacheScope(team);
  const workflow = getWorkflow(workflowId, scope);
  const lines: string[] = [];
  for (const node of workflow.nodes) {
    if (node.type === "command") lines.push(`  runs: ${node.command.join(" ")}`);
    if (node.type === "agent") {
      try {
        const agent = getAgent(node.agent, scope);
        const how = agent.executor === "claude-code" ? "a subagent of your Claude Code session" : `tools: ${agent.tools.join(", ") || "none"}`;
        lines.push(`  agent ${node.agent}: ${how}`);
      } catch {
        lines.push(`  agent ${node.agent}: (definition missing)`);
      }
    }
  }
  return lines;
}

async function confirmTrust(workflowId: string, sha: string, team: string, assumeYes: boolean): Promise<boolean> {
  if (isTrusted(workflowId, sha)) return true;
  // `--yes` is an approval, not a bypass: recording it means a person who
  // approved this version once is not asked again, and an edited definition
  // still is.
  if (assumeYes) {
    trustWorkflow(workflowId, sha);
    return true;
  }

  const lines = describeCapabilities(workflowId, team);
  console.error(`"${workflowId}" has not been run on this machine at this version. It will:`);
  for (const line of lines) console.error(line);
  console.error("  …in a git worktree of this repository, on its own branch.");

  if (!process.stdin.isTTY) {
    console.error("Refusing to run unattended without approval — re-run with --yes if this is expected.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question("Run it? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") return false;
  trustWorkflow(workflowId, sha);
  return true;
}

export function parseInputs(flags: Args["flags"], trailing: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (typeof flags.input === "string") {
    // Two shapes arrive here and both are used. `--input a=1 --input b=2`
    // repeats the flag, and `parseArgs` joins those on NUL; `--input "a=1 b=2"`
    // groups them into one quoted value separated by spaces. Splitting on only
    // one of the two silently folds every extra pair into the first value.
    for (const pair of flags.input.split(/[\u0000 ]+/).filter(Boolean)) {
      const [key, ...rest] = pair.split("=");
      if (!key || !rest.length) die(`--input must be key=value (got "${pair}")`);
      input[key] = rest.join("=");
    }
  }
  // Everything after the workflow id is the task, which is what nearly every
  // pipeline's single input is called — and what /gate:run passes.
  const task = trailing.join(" ").trim();
  if (task && input.task === undefined) input.task = task;
  return input;
}

/**
 * What a workflow's pinned repository means on this machine.
 *
 * A team's pipeline says `repo: ulak-desktop` — an id the server resolves to
 * the checkout it manages. Here the same id can only mean this person's own
 * clone, so they say once where it is and every run of that pipeline finds it.
 */
function cmdRepo(args: Args): number {
  const [id, path] = args.positional;
  if (!id) {
    const repos = repoPaths();
    const entries = Object.entries(repos);
    if (!entries.length) {
      console.log("no repositories mapped — `gate repo <id> /path/to/your/clone` when a workflow asks for one");
      return 0;
    }
    for (const [key, value] of entries) console.log(`${key}  ${value}`);
    return 0;
  }
  if (!path) die(`usage: gate repo ${id} /path/to/your/clone`);
  setRepoPath(id, resolve(path));
  console.log(`${id} → ${resolve(path)}`);
  return 0;
}

/**
 * Puts this machine back to how it was before anyone logged in.
 *
 * That is the whole of it: the login, the mirror of the team's definitions, and
 * the approvals this person gave for running workflows here. Nothing anyone
 * else can see changes — the definitions are the team's and live on the server,
 * and deleting those belongs in the dashboard, where you can see what you are
 * deleting before you do.
 *
 * Worktrees are kept too. A run's worktree is work it produced, a branch
 * somebody may still want, and "reset" meaning "delete everything every run
 * here ever made" is a surprise nobody wants twice.
 */
function cmdReset(): number {
  for (const line of cleanGatewayWiring()) console.log(line);
  const agents = removeSubagents();
  if (agents.length) console.log(`removed subagents ${agents.join(", ")} from ~/.claude/agents`);
  for (const line of clearLocalState()) console.log(line);
  console.log("this machine is disconnected — `/gate:login <token>` connects it again");
  return 0;
}

/**
 * The three commands a session drives a run with.
 *
 * Each prints one JSON instruction on stdout — what to do, or that the run is
 * over — while everything a person should watch goes to stderr. That split is
 * what lets the model read the answer without the terminal going quiet.
 */
async function sessionContext(): Promise<{ ctx: SessionRunContext; team: string }> {
  const client = connect();
  const config = readConfig()!;
  const team = await teamOf(client, config);
  await sync(client, team, true);
  // The team's claude-code agents run as the session's own subagents, so
  // Claude Code has to know them; kept in step with the mirror here, before
  // every instruction, so an agent edited in the dashboard is the one the
  // next node starts.
  const synced = syncSubagents(team, cacheScope(team));
  if (synced.created) {
    console.error("# subagents written to ~/.claude/agents for the first time — restart Claude Code once so it sees them");
  } else if (synced.written.length) {
    console.error(`# subagents updated: ${synced.written.join(", ")}`);
  }
  return { ctx: { client, team, say: (m) => console.error(m) }, team };
}

function printInstruction(instruction: Instruction): number {
  noteSession(instruction);
  console.log(JSON.stringify(instruction, null, 2));
  return instruction.do === "failed" || instruction.do === "stopped" ? 1 : 0;
}

async function cmdBegin(args: Args): Promise<number> {
  const [workflowId, ...trailing] = args.positional;
  if (!workflowId) die("usage: gate begin <workflow> [task…] [--input key=value]");
  const { ctx, team } = await sessionContext();

  const manifest = readManifest(team);
  const entry = manifest?.workflows.find((w) => w.id === workflowId);
  if (!entry) die(`no workflow "${workflowId}" for your team — \`gate list\` shows what there is`);
  // A session makes the work visible, which is not the same as having
  // agreed to it.
  if (!(await confirmTrust(workflowId, entry.sha, team, args.flags.yes === true))) return 1;

  return printInstruction(
    await begin(ctx, workflowId, parseInputs(args.flags, trailing), process.cwd(), repoPaths(), {
      taskId: typeof args.flags["task-id"] === "string" ? (args.flags["task-id"] as string) : undefined,
    }),
  );
}

async function cmdNext(args: Args): Promise<number> {
  const [executionId] = args.positional;
  if (!executionId) die("usage: gate next <execution-id> [--full]");
  const { ctx } = await sessionContext();
  // A node's second pass is normally only what changed since its first, sent
  // to the subagent that is still holding the rest. --full is for when that
  // subagent is gone and the node has to be started from nothing.
  return printInstruction(await next(ctx, executionId, { full: args.flags.full === true }));
}

async function cmdStep(args: Args): Promise<number> {
  const [executionId, nodeId] = args.positional;
  if (!executionId || !nodeId) die("usage: gate step <execution-id> <node> --output-file <file>");
  const file = typeof args.flags["output-file"] === "string" ? args.flags["output-file"] : "";
  if (!file) die("gate step needs --output-file <file>: the node's answer, as the agent declared it");
  let answer: string;
  try {
    answer = readFileSync(file, "utf8");
  } catch (e) {
    die(`cannot read ${file}: ${(e as Error).message}`);
  }
  const subagent = typeof args.flags.subagent === "string" ? args.flags.subagent : undefined;
  const { ctx } = await sessionContext();
  return printInstruction(await step(ctx, executionId, nodeId, answer, { subagent }));
}

/**
 * A failed run, picked back up where it failed — the worktree is checked out
 * again from the run's branch, the node is tried again there, and everything
 * before it stands. Only for a run /gate:run drove: the branch and the pinned
 * definitions are on this machine, and the walk is replayed from the history
 * the server keeps.
 */
async function cmdContinue(args: Args): Promise<number> {
  const [executionId] = args.positional;
  if (!executionId) die("usage: gate continue <execution-id>");
  const { ctx } = await sessionContext();
  return printInstruction(await continueRun(ctx, executionId));
}

/**
 * The worktrees runs left on this machine, and the removal of the ones whose
 * run is over. What each left uncommitted is committed onto its branch first,
 * and branches are never deleted, so nothing is lost.
 */
async function cmdClean(args: Args): Promise<number> {
  const client = connect();
  const entries = await listWorkspaces(client);
  if (!entries.length) {
    console.log("no run worktrees on this machine");
    return 0;
  }
  const plan = planClean(entries, args.flags.all === true);
  const dry = args.flags["dry-run"] === true;
  for (const e of entries) {
    const goes = plan.removed.includes(e);
    console.log(
      `${goes ? (dry ? "would remove" : "remove") : "keep"}  ${e.executionId.slice(0, 8)}  ${e.branch ?? "?"}  ${e.status}  — ${describeVerdict(e.verdict)}`,
    );
  }
  if (dry) {
    console.log(`${plan.removed.length} of ${entries.length} would be removed; run without --dry-run to do it`);
    return 0;
  }
  const notes = applyClean(plan);
  for (const note of notes) console.log(note);
  console.log(
    `removed ${plan.removed.length - notes.length} worktree(s), kept ${plan.kept.length + notes.length}; every branch is still there`,
  );
  return 0;
}

/**
 * Publishes a run's branch now, mid-run, instead of waiting for it to end.
 *
 * A run that ends publishes on its way out, and for finished work that is
 * enough. The case this exists for is the other one: another team is asking
 * about work that is still going — which is when the question is worth
 * asking at all — and the branch is sitting in a worktree they cannot reach.
 * So whatever is in the worktree is committed as a checkpoint, said to be a
 * checkpoint in its own message, and pushed.
 *
 * Nothing here is force: a branch that has moved on the remote is a refusal,
 * printed and left alone. `gate push` is not this — that sends the team's
 * workflow and agent definitions up.
 */
async function cmdPublish(args: Args): Promise<number> {
  const [executionId] = args.positional;
  if (!executionId) die("usage: gate publish <execution-id>");
  const client = connect();
  const { execution, publish } = await client.execution(executionId);
  const ws = execution.workspace as RunWorkspace | null;
  if (!ws?.root || !ws.branch) return die(`run ${executionId.slice(0, 8)} has no worktree on any machine`);
  if (!existsSync(ws.root)) {
    return die(`this run's worktree (${ws.root}) is not on this machine — publish from the machine that ran it`);
  }
  if (!publish) {
    return die(
      `the repository this run works in does not publish anywhere — give it a publication remote on the Repos page first`,
    );
  }

  const committed = checkpointWork(ws.root, `work in progress on ${ws.branch}, published on request`, LINKED_DIRECTORIES);
  if (committed) console.log(`checkpointed what was uncommitted as ${committed.slice(0, 8)}`);
  const outcome = publishBranch(ws.root, ws.branch, publish);
  console.log(outcome.ok ? outcome.note : `not published: ${outcome.note}`);
  await client
    .report(executionId, {
      events: [],
      steps: [],
      published: outcome.ok ? outcome.published : { error: outcome.note },
    })
    .catch((e) => console.log(`the gate could not be told: ${(e as Error).message}`));
  return outcome.ok ? 0 : 1;
}

/** `gate memory …`: the memory tools, for a person and for the session driving a run. */
async function cmdMemory(args: Args): Promise<number> {
  const [sub, ...rest] = args.positional;
  const client = connect();
  const json = args.flags.json === true;
  const many = (v: string | boolean | undefined) => (typeof v === "string" ? v.split("\u0000").filter(Boolean) : []);
  const one = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
  if (sub === "search") {
    const query = rest.join(" ").trim();
    const paths = many(args.flags.path);
    const featureId = one(args.flags.feature);
    if (!query && !paths.length && !featureId) die("usage: gate memory search <words…> [--path <prefix>]… [--feature <id>] [--since 30d] [--as-of <date>] [--limit n] [--json]");
    const since = parseSince(one(args.flags.since));
    const asOf = parseSince(one(args.flags["as-of"]));
    if (one(args.flags.since) && since == null) die(`--since: not a time: ${args.flags.since}`);
    if (one(args.flags["as-of"]) && asOf == null) die(`--as-of: not a time: ${args.flags["as-of"]}`);
    const limit = args.flags.limit ? Number(args.flags.limit) : undefined;
    // The checkout this is typed in, when it is one: a path means something
    // only in its own repository, and its decisions rank first. What is in
    // flight leaves out this person's own runs, the one driving this session
    // among them — the key says who is asking.
    const result = await client.memorySearch(
      {
        query: query || undefined,
        paths: paths.length ? paths : undefined,
        featureId,
        since: since ?? undefined,
        asOf: asOf ?? undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      },
      readRemoteUrl(process.cwd()),
    );
    console.log(json ? JSON.stringify(result, null, 2) : describeSearch(result));
    return 0;
  }
  if (sub === "history") {
    const paths = [...many(args.flags.path), ...rest.filter(Boolean)];
    const since = parseSince(one(args.flags.since));
    if (one(args.flags.since) && since == null) die(`--since: not a time: ${args.flags.since}`);
    const repo = one(args.flags.repo);
    const remote = repo ? null : readRemoteUrl(process.cwd());
    if (!repo && !remote) die("usage: gate memory history [--path <prefix>]… [--since 30d] [--repo <host/owner/name>] — outside a checkout, name the repository with --repo");
    const limit = args.flags.limit ? Number(args.flags.limit) : undefined;
    const result = await client.memoryHistory(
      { paths, since: since ?? undefined, repoId: repo ?? null, limit: Number.isFinite(limit) ? limit : undefined },
      remote,
    );
    console.log(json ? JSON.stringify(result, null, 2) : describeHistory(result));
    return result.unavailable ? 1 : 0;
  }
  if (sub === "features") {
    const features = await client.memoryFeatures();
    console.log(json ? JSON.stringify(features, null, 2) : describeFeatureList(features));
    return 0;
  }
  if (sub === "repo") {
    const record = await client.memoryRepo(readRemoteUrl(process.cwd()));
    // Not being read is an answer, not a failure: /gate:init prints this
    // before it writes anything and goes on either way.
    console.log(json ? JSON.stringify(record, null, 2) : describeRepoRecord(record));
    return 0;
  }
  if (sub === "activity") {
    const activity = await client.memoryActivity();
    console.log(json ? JSON.stringify(activity, null, 2) : describeActivity(activity));
    return 0;
  }
  if (sub === "feature") {
    const [id] = rest;
    if (!id) die("usage: gate memory feature <id> [--json]");
    const detail = await client.memoryFeature(id);
    if (!detail) {
      console.log(`no feature "${id}" in your team's catalogue`);
      return 1;
    }
    console.log(json ? JSON.stringify(detail, null, 2) : describeFeature(detail));
    return 0;
  }
  die("usage: gate memory search <words…> | feature <id> | history --path <prefix> | activity | features | repo");
}

/** How long `gate teach` waits to show what the recorder wrote. */
const TEACH_WAIT_MS = 5 * 60_000;

/**
 * `gate teach`: a finished branch, into the team's memory.
 *
 * Without an account it only reads — the range, the commits, the files — which
 * is what /gate:teach starts from. With one, the branch is sent to be kept as a
 * finished run and recorded like one, and this waits to print the decisions
 * the recorder wrote, so the person sees what was learnt where they asked.
 */
async function cmdTeach(args: Args): Promise<number> {
  const base = typeof args.flags.base === "string" ? args.flags.base : undefined;
  let reading: BranchReading;
  try {
    reading = readBranch(process.cwd(), base);
  } catch (e) {
    if (e instanceof TeachError) die(e.message);
    throw e;
  }

  const file = typeof args.flags["account-file"] === "string" ? args.flags["account-file"] : "";
  if (!file) {
    console.log(describeBranch(reading));
    return 0;
  }
  let account: TeachAccount;
  try {
    account = readAccount(file);
  } catch (e) {
    if (e instanceof TeachError) die(e.message);
    throw e;
  }

  const client = connect();
  const taught = await client.teach({
    account,
    commits: reading.commits,
    workspace: {
      root: reading.repo,
      repo: reading.repo,
      remoteUrl: readRemoteUrl(reading.repo),
      branch: reading.branch,
      baseRef: reading.baseRef,
      baseCommit: reading.baseCommit,
      commit: reading.head,
      changedFiles: reading.changedFiles,
    },
    startedAt: reading.startedAt,
    finishedAt: reading.finishedAt,
    diff: readBranchDiff(reading),
    host: hostname(),
    version: CLI_VERSION,
    force: args.flags.force === true,
    taskId: typeof args.flags["task-id"] === "string" ? (args.flags["task-id"] as string) : undefined,
    wip: args.flags.wip === true,
  });
  const url = `${client.url}/executions/${taught.executionId}`;
  console.log(`${taught.replaced ? "taught again, replacing the earlier teaching" : "taught"}: ${reading.branch} → ${url}`);
  if (!taught.recording) {
    console.log("memory is off on this gate (Settings → Memory): the branch is kept, and is recorded once it is on");
    return 0;
  }
  if (args.flags["no-wait"] === true) return 0;

  console.error("# the recorder is reading it…");
  const until = Date.now() + TEACH_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3_000));
    const memory = await client.runMemory(taught.executionId);
    const status = memory.extraction?.status;
    if (status === "done") {
      const cost = memory.extraction?.costUsd != null ? ` · $${memory.extraction.costUsd.toFixed(2)}` : "";
      const where = memory.feature ? ` under "${memory.feature.name}" (${memory.feature.id})` : "";
      console.log(`recorded ${memory.decisions.length} decision${memory.decisions.length === 1 ? "" : "s"}${where}${cost}:`);
      for (const d of memory.decisions) console.log(`  ${d.id}  ${d.title}`);
      return 0;
    }
    if (status === "skipped" || (status === "failed" && memory.extraction?.error)) {
      console.log(`the recorder ${status === "skipped" ? "skipped it" : "failed"}: ${memory.extraction?.error ?? "no reason given"}`);
      if (status === "failed") console.log(`it tries again on its own, up to three times; the run page has "Record again": ${url}`);
      return 1;
    }
  }
  // Not a promise that it worked: the recorder can still fail after we stop
  // watching, and the run's own "completed" says nothing about the recording.
  // Say the outcome is unknown and how to settle it, or the failure is silent.
  console.log(`still recording after ${TEACH_WAIT_MS / 60_000} minutes — the outcome is not known yet`);
  console.log(`check it on ${url}, or with \`gate memory search --path <a changed directory>\` once it settles`);
  return 0;
}

async function cmdStatus(args: Args): Promise<number> {
  const client = connect();
  const limit = Number(args.flags.limit ?? 10);
  const runs = await client.listRuns(Number.isFinite(limit) ? limit : 10);
  if (!runs.length) {
    console.log("no runs yet");
    return 0;
  }
  for (const run of runs) {
    const where = run.origin === "local" ? (run.client?.host ?? "a machine") : "the server";
    // A running run waiting on the person reads as paused, as it does on the dashboard.
    const status = run.status === "running" && run.pausedAt != null ? "paused" : String(run.status);
    console.log(
      `${run.id.slice(0, 8)}  ${status.padEnd(9)} ${run.workflowId}  ${new Date(run.startedAt).toLocaleString()}  on ${where}`,
    );
  }
  return 0;
}

/**
 * `gate ask "…" --repo <host/owner/name>`: what another team's code does.
 *
 * The server is what can reach the other team's repository — this machine has
 * one checkout of one project and no business holding four — so it fixes the
 * commit, checks the family, and reads memory at that commit. The reading is
 * done here, by this person's own Claude Code, in a run of the `ask` workflow
 * like any other: this starts it and prints its first instruction, and the
 * session reads the source through `gate source`. What comes back when there
 * is nothing to read is the reason, which is usually a branch somebody has not
 * published. Neither is a guess, and that is the whole point of the command.
 */
async function cmdAsk(args: Args): Promise<number> {
  const question = args.positional.join(" ").trim();
  const one = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
  if (!question) {
    die('usage: gate ask "<question>" --repo <host/owner/name> [--ref <branch>] [--commit <sha>] | --run <id>');
  }
  const { ctx, team } = await sessionContext();
  const asked = await ctx.client.ask({
    question,
    repo: one(args.flags.repo),
    run: one(args.flags.run),
    ref: one(args.flags.ref),
    commit: one(args.flags.commit),
  });

  if (asked.status !== "ready") {
    console.log(asked.reason);
    // Named, not implied: the person reading this has to go and ask someone
    // to run one command, and it is worth spelling out which branch.
    if (asked.status === "source_unavailable" && asked.publish?.ref) {
      console.log(`whoever has ${asked.publish.ref} can publish it with \`gate publish\`, and then this is answerable`);
    }
    return 1;
  }

  const source = asked.source;
  const entry = readManifest(team)?.workflows.find((w) => w.id === asked.workflow);
  if (!entry) die(`your team has no "${asked.workflow}" workflow — restore the shipped workflows on the Workflows page`);
  if (!(await confirmTrust(asked.workflow, entry.sha, team, args.flags.yes === true))) return 1;
  console.error(`# reading ${source.repo} at ${source.commit.slice(0, 12)} (${source.ref}) — served by the gate, for a day`);
  return printInstruction(
    await begin(
      ctx,
      asked.workflow,
      {
        question,
        source: source.repoId ?? source.repo,
        ref: source.ref,
        commit: source.commit,
        ask: asked.askId,
        memory: asked.memory,
      },
      process.cwd(),
      repoPaths(),
      { taskId: one(args.flags["task-id"]) },
    ),
  );
}

/**
 * `gate source tree|grep|file <ask> …`: another team's repository at the one
 * commit an ask fixed, read through the gate. The files are not on this
 * machine and are never checked out; every answer is the server's git reading
 * that commit, and nothing here can write to it.
 */
async function cmdSource(args: Args): Promise<number> {
  const [what, askId, ...rest] = args.positional;
  const one = (v: string | boolean | undefined) => (typeof v === "string" ? v.split("\u0000")[0] : undefined);
  const usage =
    "usage: gate source tree <ask> [path] [--depth n] · gate source grep <ask> <pattern> [--path p] [--ext ts] · " +
    "gate source file <ask> <path> [--offset n] [--limit n]";
  if (!askId || (what !== "tree" && what !== "grep" && what !== "file")) die(usage);
  const client = connect();
  const params: Record<string, string | undefined> =
    what === "tree"
      ? { path: rest.join(" ") || one(args.flags.path), depth: one(args.flags.depth) }
      : what === "grep"
        ? { pattern: rest.join(" "), path: one(args.flags.path), ext: one(args.flags.ext) }
        : { path: rest.join(" ") || one(args.flags.path), offset: one(args.flags.offset), limit: one(args.flags.limit) };
  if (what === "grep" && !params.pattern) die(usage);
  if (what === "file" && !params.path) die(usage);
  console.log(await client.askRead(askId, what, params));
  return 0;
}

async function cmdCancel(args: Args): Promise<number> {
  const [id] = args.positional;
  if (!id) die("usage: gate cancel <execution-id>");
  const client = connect();
  // The same flag the dashboard's Stop sets: whichever machine is running it
  // sees it on its next report and aborts itself.
  const res = await client.cancel(id);
  console.log(res.requested ? `asked ${id} to stop; it settles on its next report` : `nothing to stop — ${res.reason ?? "run not found"}`);
  return res.requested ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    switch (args.command) {
      case "install":
        return cmdInstall(args);
      case "login":
        return await cmdLogin(args);
      case "version":
      case "--version":
      case "-v":
        return cmdVersion();
      case "whoami":
        return await cmdWhoami();
      case "pull":
        return await cmdPull();
      case "list":
        return await cmdList();
      case "agents":
        return await cmdAgents();
      case "show":
        return await cmdShow(args);
      case "push":
        return await cmdPush(args);
      case "publish":
        return await cmdPublish(args);
      case "begin":
        return await cmdBegin(args);
      case "next":
        return await cmdNext(args);
      case "step":
        return await cmdStep(args);
      case "continue":
        return await cmdContinue(args);
      case "clean":
        return await cmdClean(args);
      case "repo":
        return cmdRepo(args);
      case "reset":
        return cmdReset();
      case "status":
        return await cmdStatus(args);
      case "memory":
        return await cmdMemory(args);
      case "teach":
        return await cmdTeach(args);
      case "ask":
        return await cmdAsk(args);
      case "source":
        return await cmdSource(args);
      case "cancel":
        return await cmdCancel(args);
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return 0;
      default:
        console.error(`unknown command "${args.command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    if (e instanceof GateApiError) {
      // The server's own words, with the one hint that is not in them.
      const hint =
        e.code === "NO_API_KEY" || e.code === "INVALID_API_KEY"
          ? "\nRun `/gate:login <token>` with the token from your dashboard's Team page."
          : "";
      console.error(`${e.message}${hint}`);
      return 1;
    }
    console.error((e as Error).message);
    return 1;
  }
}
