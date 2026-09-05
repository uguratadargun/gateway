#!/usr/bin/env node
/**
 * Shell client for gate's agent workflows: list what is defined, start a run,
 * follow it to the end. This is what the `/gate-run` slash command calls, so
 * Claude Code can offer the workflows that actually exist instead of asking
 * you to remember their ids.
 *
 * The management API sits behind the admin cookie, so every call logs in first.
 * The secret comes from GATE_ADMIN_SECRET, or from the .env of this checkout.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");
const BASE = (process.env.GATE_URL || "http://127.0.0.1:4141").replace(/\/+$/, "");

function die(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Where a .env might be, nearest first: an explicitly named checkout, then
 * every directory above this file. Walking up is what lets the same script work
 * when it is run straight out of the repository; an installed plugin is a copy
 * with no .env beside it, so there the environment is the way in.
 */
function envFiles() {
  const files = [];
  if (process.env.GATE_DIR) files.push(join(process.env.GATE_DIR, ".env"));
  let dir = HERE;
  for (let i = 0; i < 5; i++) {
    files.push(join(dir, ".env"));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return files;
}

/** Where `login` keeps the secret, for a plugin copy with no .env near it. */
function secretFile() {
  return join(process.env.GATE_HOME || join(homedir(), ".gate"), "cli-secret");
}

function adminSecret() {
  if (process.env.GATE_ADMIN_SECRET) return process.env.GATE_ADMIN_SECRET;
  for (const file of envFiles()) {
    let contents;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of contents.split("\n")) {
      if (!line.startsWith("GATE_ADMIN_SECRET=")) continue;
      const value = line.slice("GATE_ADMIN_SECRET=".length).trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  try {
    const stored = readFileSync(secretFile(), "utf8").trim();
    if (stored) return stored;
  } catch {
    // Nothing stored; `login` is how it gets there.
  }
  return null;
}

let cookie = null;

async function login() {
  const secret = adminSecret();
  if (!secret) die("no admin secret: run `gate-workflow.mjs login` once from your gate checkout, or export GATE_ADMIN_SECRET");
  let res;
  try {
    res = await fetch(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
  } catch {
    die(`cannot reach gate at ${BASE} — start the server with \`npm run dev\` in your gate checkout`);
  }
  if (!res.ok) die(`admin login failed (${res.status}); check GATE_ADMIN_SECRET`);
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) die("admin login returned no session cookie");
}

async function api(path, init = {}) {
  if (!cookie) await login();
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON body: reported below through the status.
  }
  if (!res.ok) {
    const detail = json?.error ? `${json.error}${json.code ? ` [${json.code}]` : ""}` : `HTTP ${res.status}`;
    die(`${path}: ${detail}`);
  }
  return json;
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

async function listWorkflows() {
  const { workflows = [], errors = [] } = await api("/api/workflows");
  return { workflows, errors };
}

async function cmdList() {
  const { workflows, errors } = await listWorkflows();
  if (!workflows.length && !errors.length) {
    console.log("no workflows defined (~/.gate/workflows is empty)");
    return 0;
  }
  for (const wf of workflows) {
    const inputs = wf.inputs?.length ? wf.inputs.join(", ") : "none";
    const where = !wf.workspace
      ? "no workspace (agents cannot touch files)"
      : wf.workspace.repo
        ? `git worktree of ${wf.workspace.repo}`
        : "git worktree of the repo you run it in";
    console.log(`${wf.id}`);
    console.log(`  ${wf.name}${wf.description ? ` — ${wf.description}` : ""}`);
    console.log(`  input: ${inputs} · ${wf.nodes?.length ?? 0} nodes · ${where}`);
  }
  for (const e of errors) console.log(`${e.id}\n  BROKEN — ${e.message}`);
  return 0;
}

async function cmdAgents() {
  const { agents = [], errors = [] } = await api("/api/agents");
  if (!agents.length && !errors.length) {
    console.log("no agents defined (~/.gate/agents is empty)");
    return 0;
  }
  for (const agent of agents) {
    const fields = Object.keys(agent.output?.schema ?? {});
    const output = agent.output?.type === "json" ? `json {${fields.join(", ")}}` : "text";
    console.log(`${agent.id}`);
    console.log(`  ${agent.name}${agent.description ? ` — ${agent.description}` : ""}`);
    console.log(
      `  ${agent.model}${agent.effort ? `/${agent.effort}` : ""} · output ${output}` +
        `${agent.inputs?.length ? ` · reads ${agent.inputs.join(", ")}` : ""}` +
        `${agent.tools?.length ? ` · tools ${agent.tools.join(", ")}` : ""}`,
    );
  }
  for (const e of errors) console.log(`${e.id}\n  BROKEN — ${e.message}`);
  return 0;
}

/**
 * Writes a definition through the server, which parses and validates it before
 * anything reaches disk — a rejected save means the definition is wrong, and
 * says how. An id that already exists is protected: replacing an agent someone
 * tuned should be a decision, not a side effect of a generated name colliding.
 */
async function cmdSave(kind, argv) {
  const rest = [];
  let replace = false;
  for (const arg of argv) {
    if (arg === "--replace") replace = true;
    else rest.push(arg);
  }
  const [id, file] = rest;
  if (!id || !file) die(`usage: gate-workflow save-${kind} <id> <file> [--replace]`);

  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    die(`cannot read ${file}`);
  }

  const collection = kind === "agent" ? "agents" : "workflows";
  const listing = await api(`/api/${collection}`);
  const known = new Set([
    ...(listing[collection] ?? []).map((d) => d.id),
    ...(listing.errors ?? []).map((e) => e.id),
  ]);
  if (known.has(id) && !replace) die(`${kind} "${id}" already exists — pass --replace to overwrite it`);

  await api(`/api/${collection}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, source }),
  });
  console.log(`saved ${kind} ${id}`);
  return 0;
}

/**
 * Removes a definition. An agent a workflow still names is refused: deleting it
 * would not fail, it would simply stop that workflow from parsing the next time
 * it is loaded, which is a surprise worth one flag.
 */
async function cmdDelete(kind, argv) {
  const rest = [];
  let force = false;
  for (const arg of argv) {
    if (arg === "--force") force = true;
    else rest.push(arg);
  }
  const id = rest[0];
  if (!id) die(`usage: gate-workflow delete-${kind} <id>${kind === "agent" ? " [--force]" : ""}`);

  if (kind === "agent" && !force) {
    const { workflows = [] } = await api("/api/workflows");
    const used = workflows.filter((wf) => (wf.nodes ?? []).some((n) => n.type === "agent" && n.agent === id));
    if (used.length) {
      die(`agent "${id}" is used by ${used.map((wf) => wf.id).join(", ")} — those stop loading; pass --force`);
    }
  }

  const collection = kind === "agent" ? "agents" : "workflows";
  const result = await api(`/api/${collection}/${id}`, { method: "DELETE" });
  if (result?.deleted === false) die(`no ${kind} "${id}"`);
  console.log(`deleted ${kind} ${id}`);
  return 0;
}

async function cmdRun(argv) {
  const input = {};
  const rest = [];
  let watch = false;
  let timeout = 1800;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--watch") watch = true;
    else if (arg === "--timeout") timeout = Number(argv[++i]) || timeout;
    else if (arg === "--input") {
      const kv = argv[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq < 1) die(`--input wants key=value, got "${kv}"`);
      input[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else rest.push(arg);
  }

  const id = rest.shift();
  if (!id) die("usage: gate-workflow run <workflow-id> [task text] [--input key=value] [--watch]");

  const { workflows } = await listWorkflows();
  const wf = workflows.find((w) => w.id === id);
  if (!wf) die(`no workflow "${id}"; defined: ${workflows.map((w) => w.id).join(", ") || "(none)"}`);

  // A workflow that takes its repository per run defaults to where the caller
  // is: that is the whole point of not pinning one — the same pipeline works on
  // whatever project you happen to be in.
  const required = wf.inputs ?? [];
  if (required.includes("repo") && input.repo === undefined) input.repo = process.cwd();

  // Free text is only placed automatically when there is exactly one empty slot
  // to put it in; anything else has to be named, so a run is never started with
  // the task in the wrong field.
  const free = rest.join(" ").trim();
  let missing = required.filter((k) => input[k] === undefined);
  if (free) {
    if (missing.length === 1) input[missing[0]] = free;
    else if (missing.length > 1) die(`"${id}" needs several inputs (${missing.join(", ")}); pass them with --input key=value`);
    else console.error(`note: "${id}" takes no further input; ignoring "${free}"`);
    missing = required.filter((k) => input[k] === undefined);
  }
  if (missing.length) die(`"${id}" needs ${missing.join(", ")}; pass with --input key=value`);

  const { executionId } = await api("/api/executions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflowId: id, input }),
  });
  console.log(`started ${id} · ${executionId}`);
  if (input.repo) console.log(`  worktree of ${input.repo}`);
  console.log(`  ${BASE}/executions/${executionId}`);
  return watch ? await follow(executionId, timeout) : 0;
}

/**
 * Asks a run to stop. The engine settles it; this only sends the request, so
 * the status is read back rather than assumed.
 */
async function cmdCancel(argv) {
  const id = argv[0];
  if (!id) die("usage: gate-workflow cancel <execution-id>");
  const result = await api(`/api/executions/${id}/cancel`, { method: "POST" });
  if (!result?.cancelled) die(result?.reason ? `not cancelled: ${result.reason}` : "not cancelled");
  console.log(`cancelling ${id}`);
  const { execution } = await api(`/api/executions/${id}`);
  // A cancelled run settles as failed; that is the outcome asked for, so the
  // command itself succeeded.
  if (execution.status !== "running") printOutcome(execution);
  return 0;
}

async function cmdWatch(argv) {
  const rest = [];
  let timeout = 1800;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--timeout") timeout = Number(argv[++i]) || timeout;
    else rest.push(argv[i]);
  }
  if (!rest[0]) die("usage: gate-workflow watch <execution-id> [--timeout seconds]");
  return follow(rest[0], timeout);
}

/** Polls the run until it stops, printing each step as it lands. */
async function follow(executionId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let printed = 0;
  for (;;) {
    const { execution, steps = [] } = await api(`/api/executions/${executionId}`);
    for (const step of steps.slice(printed)) printStep(step, ++printed);
    if (execution.status !== "running") return printOutcome(execution);
    if (Date.now() > deadline) {
      console.log(`still running after ${timeoutSeconds}s — follow it at ${BASE}/executions/${executionId}`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function printStep(step, n) {
  const usage = step.usage ? ` · ${step.usage.model} ${step.usage.inputTokens}→${step.usage.outputTokens} tok` : "";
  const tools = step.toolCalls?.length ? ` · ${step.toolCalls.length} tool calls` : "";
  const visit = step.visit > 1 ? ` (visit ${step.visit})` : "";
  console.log(`  ${String(n).padStart(2)} ${step.nodeId}${visit} — ${step.status} ${duration(step.finishedAt - step.startedAt)}${usage}${tools}`);
  if (step.error) console.log(`     ${step.error.code}: ${step.error.message}`);
}

function printOutcome(execution) {
  const took = duration((execution.finishedAt ?? Date.now()) - execution.startedAt);
  console.log(`${execution.status} in ${took} · ${execution.stepCount} steps`);
  if (execution.error) console.log(`  ${execution.error.code}: ${execution.error.message}`);
  const ws = execution.workspace;
  if (ws) {
    const changed = ws.changedFiles?.length ? `${ws.changedFiles.length} files changed` : "no file changes";
    console.log(`  branch ${ws.branch} in ${ws.repo} · ${changed}`);
    console.log(`  git -C ${ws.repo} diff ${ws.baseRef}...${ws.branch}`);
  }
  console.log(`  ${BASE}/executions/${execution.id}`);
  return execution.status === "completed" ? 0 : 1;
}

/**
 * Copies the admin secret this checkout can already see into ~/.gate, so a
 * plugin installed elsewhere — a cache copy with no .env beside it — can log in
 * without the secret having to live in your shell profile. Same plaintext the
 * .env holds, kept 0600.
 */
function cmdLogin() {
  const secret = adminSecret();
  if (!secret) die("no admin secret to store: run this from a gate checkout, or set GATE_ADMIN_SECRET first");
  const file = secretFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  console.log(`stored the admin secret in ${file}\n/gate-run now works from any project`);
  return 0;
}

/**
 * Writes /gate-run as a plain user command for anyone not installing the
 * plugin: the same command file, with the plugin path resolved rather than
 * left to Claude Code to expand.
 */
function cmdInstall() {
  const home = process.env.HOME;
  if (!home) die("HOME is not set");
  const dir = join(home, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  const source = join(PLUGIN_ROOT, "commands", "gate-run.md");
  const body = readFileSync(source, "utf8").split("${CLAUDE_PLUGIN_ROOT}").join(PLUGIN_ROOT);
  const target = join(dir, "gate-run.md");
  writeFileSync(target, body);
  console.log(`installed ${target}\n  → ${PLUGIN_ROOT}\nUse it from any project: /gate-run`);
  return 0;
}

function usage() {
  console.log(`gate-workflow — run gate agent workflows from a shell

  list                                    what workflows are defined, and what input each needs
  agents                                  what agents are defined, and what each reads and returns
  run <id> [task] [--input k=v] [--watch] start a run
  watch <execution-id>                    follow a run to the end
  cancel <execution-id>                   stop a run (the worktree it made is kept)
  save-agent <id> <file> [--replace]      create or replace an agent (the server validates it)
  save-workflow <id> <file> [--replace]   create or replace a workflow (the server validates it)
  delete-agent <id> [--force]             remove an agent (refused while a workflow names it)
  delete-workflow <id>                    remove a workflow (its recorded runs are kept)
  login                                   let an installed plugin log in: stores the secret in ~/.gate
  install                                 write /gate-run as a user command (not needed with the plugin)

Environment: GATE_URL (default http://127.0.0.1:4141), GATE_ADMIN_SECRET, GATE_DIR (a gate checkout to read .env from)`);
  return 0;
}

const [command, ...argv] = process.argv.slice(2);
const run =
  command === "list" ? cmdList(argv)
  : command === "agents" ? cmdAgents(argv)
  : command === "save-agent" ? cmdSave("agent", argv)
  : command === "save-workflow" ? cmdSave("workflow", argv)
  : command === "delete-agent" ? cmdDelete("agent", argv)
  : command === "delete-workflow" ? cmdDelete("workflow", argv)
  : command === "run" ? cmdRun(argv)
  : command === "watch" ? cmdWatch(argv)
  : command === "cancel" ? cmdCancel(argv)
  : command === "login" ? cmdLogin()
  : command === "install" ? cmdInstall()
  : usage();
process.exit(await run);
