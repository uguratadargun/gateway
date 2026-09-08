import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { getAgent, listAgents, readAgentSource } from "@/agents/registry";
import type { WorkflowEvent } from "@/events/types";
import { getWorkflow, readWorkflowSource } from "@/workflows/registry";

import { decodeConnectionToken, looksLikeConnectionToken } from "@/lib/connect-token";

import { CLI_VERSION, GateApiError, GateClient } from "./api";
import { cacheScope, clearLocalState, readManifest, writeBundle, type Manifest } from "./cache";
import { isTrusted, readConfig, repoPaths, setRepoPath, trustWorkflow, writeConfig, type ClientConfig } from "./config";
import { runLocal } from "./run";
import { begin, next, step, wait, work, type Instruction, type SessionRunContext } from "./step";

/**
 * `gate` — the command a developer runs, and what /gate:run calls.
 *
 * It connects with the person's own API key, mirrors their team's definitions
 * onto this machine, and runs one of them here: this process is the engine,
 * the worktree is a branch of the repository they are standing in, and only
 * the model calls and the reporting go to the server.
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
  gate run <workflow> [task…]                   run one here, headless, in this repository
       --input key=value                        (repeat for more than one input)
       --yes                                    skip the first-run approval prompt
       --quiet                                  only print the outcome

  the protocol /gate:run drives, one node at a time in your own session:
  gate begin <workflow> [task…]                 start a run, print the first instruction
  gate next <execution-id>                      what to do next
  gate step <execution-id> <node> --output-file <f>   hand back a node's answer
  gate wait <execution-id> [--for <seconds>]     follow a node running in its own model
  gate repo [<id> <path>]                       point a pinned repository at your clone
  gate reset                                    disconnect this machine and clear what it pulled
  gate status [--limit n]                       your team's recent runs
  gate cancel <execution-id>                    ask a run to stop

Environment: GATE_URL and GATE_KEY override the saved login.`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Which flags take a value.
 *
 * Guessing from "the next word does not start with --" cannot work here: the
 * task a run is given is a positional sentence, so `run smoke --yes make a
 * file` would swallow "make" as the value of --yes and lose the task. The list
 * is short, and the alternative is a parser that is wrong in exactly the case
 * the tool exists for.
 */
const VALUE_FLAGS = new Set(["url", "key", "token", "input", "limit", "team", "dir", "output-file", "for"]);

function parseArgs(argv: string[]): Args {
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
      (flags[name] = name === "input" && typeof flags.input === "string" ? `${flags.input} ${value}` : value);

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
  writeConfig({ ...config, team: me.team.id, user: me.user?.email });
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
  writeConfig({ url, key, team: me.team.id, user: me.user?.email });
  console.log(`connected to ${url} as ${me.user?.email ?? "this key"} · team ${me.team.name}`);

  const manifest = await sync(client, me.team.id, true);
  console.log(`${manifest.workflows.length} workflow(s) available — \`gate list\` to see them`);
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

async function cmdList(): Promise<number> {
  const client = connect();
  const config = readConfig()!;
  const manifest = await sync(client, await teamOf(client, config));
  if (!manifest.workflows.length) {
    console.log("no workflows defined for your team yet");
    return 0;
  }
  for (const wf of manifest.workflows) {
    const inputs = wf.inputs.length ? wf.inputs.join(", ") : "none";
    const where = !wf.workspace
      ? "no workspace (agents cannot touch files)"
      : wf.workspace.repo
        ? `git worktree of ${wf.workspace.repo}`
        : "git worktree of the repo you run it in";
    console.log(wf.id);
    console.log(`  ${wf.name}${wf.description ? ` — ${wf.description}` : ""}`);
    console.log(`  input: ${inputs} · ${wf.nodeCount} nodes · ${where}`);
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
    console.log(readWorkflowSource(id, scope));
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
        const how = agent.executor === "claude-code" ? "a headless Claude Code session" : `tools: ${agent.tools.join(", ") || "none"}`;
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

function parseInputs(flags: Args["flags"], trailing: string[]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (typeof flags.input === "string") {
    for (const pair of flags.input.split(" ")) {
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

function printEvent(event: WorkflowEvent): void {
  switch (event.type) {
    case "node.started":
      console.error(`▸ ${event.nodeId}`);
      break;
    case "tool.called":
      console.error(`  ${event.ok ? "·" : "✗"} ${event.tool} ${event.summary}`);
      break;
    case "node.completed":
      console.error(`  ✓ ${event.nodeId} (${Math.round(event.durationMs / 1000)}s)`);
      break;
    case "node.failed":
      console.error(`  ✗ ${event.nodeId}: ${event.message}`);
      break;
    case "edge.selected":
      console.error(`  → ${event.to}${event.label ? ` · ${event.label}` : ""}`);
      break;
    default:
      break;
  }
}

async function cmdRun(args: Args): Promise<number> {
  const [workflowId, ...trailing] = args.positional;
  if (!workflowId) die("usage: gate run <workflow> [task…]  ·  `gate list` shows what you can run");

  // Said before anything else, because it is about which command you are
  // running rather than how it went: inside a session this does the whole
  // pipeline headlessly, so the person watching sees one line and a result
  // minutes later, and nothing the run does can ask them anything. Not
  // refused — running headless on purpose is legitimate — but named.
  if ((process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDECODE) && args.flags.quiet !== true) {
    console.error(
      "# heads up: this runs headlessly — you will see the outcome, not the work.\n" +
        "# In Claude Code, /gate:run drives the same workflow in this session (gate begin/next/step),\n" +
        "# where you can watch each node and answer it when it asks.",
    );
  }

  const client = connect();
  const config = readConfig()!;
  const team = await teamOf(client, config);
  const manifest = await sync(client, team, true);

  const entry = manifest.workflows.find((w) => w.id === workflowId);
  if (!entry) {
    die(`no workflow "${workflowId}" for your team — \`gate list\` shows what there is`);
  }
  if (!(await confirmTrust(workflowId, entry.sha, team, args.flags.yes === true))) return 1;

  const quiet = args.flags.quiet === true;
  const input = parseInputs(args.flags, trailing);

  const result = await runLocal(client, {
    workflowId,
    input,
    cwd: process.cwd(),
    team,
    repos: repoPaths(),
    onEvent: quiet ? undefined : printEvent,
    onNotice: (message) => console.error(`# ${message}`),
  });

  const { state, workspace, executionId } = result;
  console.log(`${state.status}: ${workflowId} (${executionId})`);
  if (state.error) console.log(`${state.error.code}: ${state.error.message}`);
  if (workspace) {
    console.log(`branch ${workspace.branch} in ${workspace.root}`);
    console.log(`review it with: git -C ${workspace.root} diff`);
  }
  console.log(`${client.url}/executions/${executionId}`);
  return state.status === "completed" ? 0 : 1;
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
  return { ctx: { client, team, say: (m) => console.error(m) }, team };
}

function printInstruction(instruction: Instruction): number {
  console.log(JSON.stringify(instruction, null, 2));
  return instruction.do === "failed" ? 1 : 0;
}

async function cmdBegin(args: Args): Promise<number> {
  const [workflowId, ...trailing] = args.positional;
  if (!workflowId) die("usage: gate begin <workflow> [task…]");
  const { ctx, team } = await sessionContext();

  const manifest = readManifest(team);
  const entry = manifest?.workflows.find((w) => w.id === workflowId);
  if (!entry) die(`no workflow "${workflowId}" for your team — \`gate list\` shows what there is`);
  // The same approval a headless run asks for. A session makes the work
  // visible, which is not the same as having agreed to it.
  if (!(await confirmTrust(workflowId, entry.sha, team, args.flags.yes === true))) return 1;

  return printInstruction(
    await begin(ctx, workflowId, parseInputs(args.flags, trailing), process.cwd(), repoPaths()),
  );
}

async function cmdNext(args: Args): Promise<number> {
  const [executionId] = args.positional;
  if (!executionId) die("usage: gate next <execution-id>");
  const { ctx } = await sessionContext();
  return printInstruction(await next(ctx, executionId));
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
  const { ctx } = await sessionContext();
  return printInstruction(await step(ctx, executionId, nodeId, answer));
}

async function cmdWait(args: Args): Promise<number> {
  const [executionId] = args.positional;
  if (!executionId) die("usage: gate wait <execution-id> [--for <seconds>]");
  const seconds = Number(args.flags.for);
  const { ctx } = await sessionContext();
  return printInstruction(await wait(ctx, executionId, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined));
}

/**
 * The detached worker `gate next` starts for a claude-code node. Not in the
 * usage text: nothing but this CLI runs it, and its stdout is the node's log.
 */
async function cmdWork(args: Args): Promise<number> {
  const [executionId, nodeId] = args.positional;
  if (!executionId || !nodeId) die("usage: gate work <execution-id> <node>");
  const { ctx } = await sessionContext();
  return (await work(ctx, executionId, nodeId)) ? 0 : 1;
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
    console.log(
      `${run.id.slice(0, 8)}  ${String(run.status).padEnd(9)} ${run.workflowId}  ${new Date(run.startedAt).toLocaleString()}  on ${where}`,
    );
  }
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
      case "run":
        return await cmdRun(args);
      case "begin":
        return await cmdBegin(args);
      case "next":
        return await cmdNext(args);
      case "step":
        return await cmdStep(args);
      case "wait":
        return await cmdWait(args);
      case "work":
        return await cmdWork(args);
      case "repo":
        return cmdRepo(args);
      case "reset":
        return cmdReset();
      case "status":
        return await cmdStatus(args);
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
