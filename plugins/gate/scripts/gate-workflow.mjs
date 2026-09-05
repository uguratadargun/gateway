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
  return null;
}

let cookie = null;

async function login() {
  const secret = adminSecret();
  if (!secret) die("no admin secret: export GATE_ADMIN_SECRET, or point GATE_DIR at your gate checkout");
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

  list                                    what is defined, and what input each needs
  run <id> [task] [--input k=v] [--watch] start a run
  watch <execution-id>                    follow a run to the end
  install                                 write /gate-run as a user command (not needed with the plugin)

Environment: GATE_URL (default http://127.0.0.1:4141), GATE_ADMIN_SECRET, GATE_DIR (a gate checkout to read .env from)`);
  return 0;
}

const [command, ...argv] = process.argv.slice(2);
const run =
  command === "list" ? cmdList(argv)
  : command === "run" ? cmdRun(argv)
  : command === "watch" ? cmdWatch(argv)
  : command === "install" ? cmdInstall()
  : usage();
process.exit(await run);
