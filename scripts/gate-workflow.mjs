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
const ROOT = resolve(HERE, "..");
const BASE = (process.env.GATE_URL || "http://127.0.0.1:4141").replace(/\/+$/, "");

function die(message) {
  console.error(message);
  process.exit(1);
}

function adminSecret() {
  if (process.env.GATE_ADMIN_SECRET) return process.env.GATE_ADMIN_SECRET;
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      if (!line.startsWith("GATE_ADMIN_SECRET=")) continue;
      const value = line.slice("GATE_ADMIN_SECRET=".length).trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  } catch {
    // No .env here; the environment variable is the other way in.
  }
  return null;
}

let cookie = null;

async function login() {
  const secret = adminSecret();
  if (!secret) die(`no admin secret: set GATE_ADMIN_SECRET, or keep it in ${join(ROOT, ".env")}`);
  let res;
  try {
    res = await fetch(`${BASE}/api/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
  } catch {
    die(`cannot reach gate at ${BASE} — start it with \`npm run dev\` in ${ROOT}`);
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
    const where = wf.workspace?.repo ? `git worktree of ${wf.workspace.repo}` : "no workspace (agents cannot touch files)";
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

  // Free text is only placed automatically when there is exactly one empty slot
  // to put it in; anything else has to be named, so a run is never started with
  // the task in the wrong field.
  const free = rest.join(" ").trim();
  const required = wf.inputs ?? [];
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

/** Writes the /gate-run slash command, pointed at this checkout. */
function cmdInstall() {
  const home = process.env.HOME;
  if (!home) die("HOME is not set");
  const dir = join(home, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  const self = join(HERE, "gate-workflow.mjs");
  const template = readFileSync(join(HERE, "gate-run.md"), "utf8").replaceAll("__GATE_CLI__", self);
  const target = join(dir, "gate-run.md");
  writeFileSync(target, template);
  console.log(`installed ${target}\n  → ${self}\nUse it from any project: /gate-run`);
  return 0;
}

function usage() {
  console.log(`gate-workflow — run gate agent workflows from a shell

  list                                    what is defined, and what input each needs
  run <id> [task] [--input k=v] [--watch] start a run
  watch <execution-id>                    follow a run to the end
  install                                 write the /gate-run slash command for Claude Code

Environment: GATE_URL (default http://127.0.0.1:4141), GATE_ADMIN_SECRET (default: this checkout's .env)`);
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
