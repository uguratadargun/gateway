import { createInterface } from "node:readline/promises";

import { getAgent, listAgents, readAgentSource } from "@/agents/registry";
import type { WorkflowEvent } from "@/events/types";
import { getWorkflow, readWorkflowSource } from "@/workflows/registry";

import { CLI_VERSION, GateApiError, GateClient } from "./api";
import { cacheScope, readManifest, writeBundle, type Manifest } from "./cache";
import { isTrusted, readConfig, trustWorkflow, writeConfig, type ClientConfig } from "./config";
import { runLocal } from "./run";

/**
 * `gate` — the command a developer runs, and what /gate-run calls.
 *
 * It connects with the person's own API key, mirrors their team's definitions
 * onto this machine, and runs one of them here: this process is the engine,
 * the worktree is a branch of the repository they are standing in, and only
 * the model calls and the reporting go to the server.
 */

const USAGE = `gate ${CLI_VERSION} — run your team's agent workflows on this machine

  gate login --url <gate-url> --key <api-key>   connect this machine
  gate whoami                                   who this key belongs to
  gate pull                                     refresh your team's definitions
  gate list                                     what you can run, and what it needs
  gate agents                                   the agents your team's pipelines use
  gate show <workflow|agent-id>                 print a definition as it is on the server
  gate run <workflow> [task…]                   run one here, in this repository
       --input key=value                        (repeat for more than one input)
       --yes                                    skip the first-run approval prompt
       --quiet                                  only print the outcome
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
const VALUE_FLAGS = new Set(["url", "key", "input", "limit", "team"]);

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
    die("not connected — run `gate login --url <gate-url> --key <api-key>` (your key comes from your gate dashboard)");
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

async function cmdLogin(flags: Args["flags"]): Promise<number> {
  const url = typeof flags.url === "string" ? flags.url.replace(/\/+$/, "") : "";
  const key = typeof flags.key === "string" ? flags.key : "";
  if (!url || !key) die("usage: gate login --url <gate-url> --key <api-key>");

  const client = new GateClient({ url, key });
  const me = await client.me();
  writeConfig({ url, key, team: me.team.id, user: me.user?.email });
  console.log(`connected to ${url} as ${me.user?.email ?? "this key"} · team ${me.team.name}`);

  const manifest = await sync(client, me.team.id, true);
  console.log(`${manifest.workflows.length} workflow(s) available — \`gate list\` to see them`);
  return 0;
}

async function cmdWhoami(): Promise<number> {
  const client = connect();
  const me = await client.me();
  console.log(`${me.user?.email ?? "(key with no owner)"} · team ${me.team.name} (${me.team.id}) · ${client.url}`);
  console.log(`scopes: ${me.scopes.join(", ")}`);
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

/** The definition itself — what /gate-design reads before proposing a change to it. */
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

async function cmdPull(): Promise<number> {
  const client = connect();
  const config = readConfig()!;
  const manifest = await sync(client, await teamOf(client, config), true);
  console.log(`pulled ${manifest.workflows.length} workflow(s) for team ${manifest.team} from ${manifest.from}`);
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
  // pipeline's single input is called — and what /gate-run passes.
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
      case "login":
        return await cmdLogin(args.flags);
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
      case "run":
        return await cmdRun(args);
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
          ? "\nRun `gate login --url <gate-url> --key <api-key>` with a key from your dashboard."
          : "";
      console.error(`${e.message}${hint}`);
      return 1;
    }
    console.error((e as Error).message);
    return 1;
  }
}
