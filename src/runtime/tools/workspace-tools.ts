import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { resolveInWorkspace } from "./paths";
import { ToolError, type AgentTool, type ToolContext } from "./types";

/** The tools an agent can be given. All of them stay inside the run workspace. */

const MAX_READ_BYTES = 200_000;
const MAX_WRITE_BYTES = 2_000_000;
const MAX_LIST_ENTRIES = 500;
const MAX_MATCHES = 100;
const MAX_COMMAND_OUTPUT = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "__pycache__", ".turbo"]);

function str(input: Record<string, unknown>, key: string, required = true): string {
  const v = input[key];
  if (typeof v === "string" && v.length) return v;
  if (required) throw new ToolError(`"${key}" is required`);
  return "";
}

function truncate(s: string, max: number, what: string): string {
  return s.length > max ? `${s.slice(0, max)}\n… [${what} truncated at ${max} characters]` : s;
}

const readFile: AgentTool = {
  name: "read_file",
  description: "Read a file from the workspace. Returns its content with 1-based line numbers.",
  mutates: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      offset: { type: "integer", description: "1-based line to start at (optional)." },
      limit: { type: "integer", description: "How many lines to read (optional)." },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const file = resolveInWorkspace(ctx.root, input.path);
    if (!existsSync(file)) throw new ToolError(`no such file: ${str(input, "path")}`);
    if (statSync(file).isDirectory()) throw new ToolError(`"${str(input, "path")}" is a directory; use list_files`);
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n");
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Math.max(1, Number(input.limit ?? lines.length));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
    return truncate(numbered, MAX_READ_BYTES, "file");
  },
};

const writeFile: AgentTool = {
  name: "write_file",
  description: "Create a file or replace its whole content. Parent directories are created as needed.",
  mutates: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      content: { type: "string", description: "The complete new file content." },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx) {
    const file = resolveInWorkspace(ctx.root, input.path);
    const content = typeof input.content === "string" ? input.content : "";
    if (content.length > MAX_WRITE_BYTES) throw new ToolError(`content is larger than ${MAX_WRITE_BYTES} bytes`);
    if (existsSync(file) && statSync(file).isDirectory()) throw new ToolError(`"${str(input, "path")}" is a directory`);
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, content);
    return `wrote ${content.length} characters to ${relative(ctx.root, file)}`;
  },
};

const editFile: AgentTool = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. The old string must appear exactly once unless replace_all is true — read the file first.",
  mutates: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace, including indentation." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, ctx) {
    const file = resolveInWorkspace(ctx.root, input.path);
    if (!existsSync(file)) throw new ToolError(`no such file: ${str(input, "path")}`);
    const oldString = str(input, "old_string");
    const newString = typeof input.new_string === "string" ? input.new_string : "";
    const raw = readFileSync(file, "utf8");
    const count = raw.split(oldString).length - 1;
    if (count === 0) throw new ToolError("old_string was not found in the file");
    if (count > 1 && input.replace_all !== true) {
      throw new ToolError(`old_string appears ${count} times; pass replace_all or include more context`);
    }
    // split/join in both modes: String.replace would interpret $&, $`, $' and
    // $$ in the replacement and silently corrupt shell scripts and regexes.
    const parts = raw.split(oldString);
    const updated = input.replace_all === true ? parts.join(newString) : [parts[0], parts.slice(1).join(oldString)].join(newString);
    writeFileSync(file, updated);
    return `edited ${relative(ctx.root, file)} (${input.replace_all === true ? count : 1} replacement${count > 1 && input.replace_all === true ? "s" : ""})`;
  },
};

function walk(root: string, dir: string, depth: number, out: string[]): void {
  if (out.length >= MAX_LIST_ENTRIES || depth < 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_LIST_ENTRIES) return;
    if (SKIP_DIRS.has(entry) || entry.startsWith(".DS_Store")) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      // lstat, not stat: a symlink is never followed, so listing and searching
      // cannot walk out of the workspace the way resolveInWorkspace forbids.
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      isDir = st.isDirectory();
    } catch {
      continue;
    }
    out.push(relative(root, full) + (isDir ? "/" : ""));
    if (isDir) walk(root, full, depth - 1, out);
  }
}

const listFiles: AgentTool = {
  name: "list_files",
  description: "List files and directories in the workspace. Skips .git, node_modules and build output.",
  mutates: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list, relative to the workspace root (default: the root)." },
      depth: { type: "integer", description: "How deep to recurse (default 2)." },
    },
  },
  async execute(input, ctx) {
    const dir = input.path ? resolveInWorkspace(ctx.root, input.path) : ctx.root;
    if (!existsSync(dir)) throw new ToolError(`no such directory: ${String(input.path)}`);
    const out: string[] = [];
    walk(ctx.root, dir, Math.max(0, Number(input.depth ?? 2) - 1), out);
    if (!out.length) return "(empty)";
    const capped = out.length >= MAX_LIST_ENTRIES ? `\n… [listing truncated at ${MAX_LIST_ENTRIES} entries]` : "";
    return out.join("\n") + capped;
  },
};

const searchFiles: AgentTool = {
  name: "search_files",
  description: "Search file contents with a regular expression. Returns path:line:text for each match.",
  mutates: false,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression." },
      path: { type: "string", description: "Directory to search in (default: the workspace root)." },
      extension: { type: "string", description: 'Only search files with this extension, e.g. "ts" (optional).' },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    const dir = input.path ? resolveInWorkspace(ctx.root, input.path) : ctx.root;
    let re: RegExp;
    try {
      re = new RegExp(str(input, "pattern"));
    } catch (e) {
      throw new ToolError(`invalid regular expression: ${(e as Error).message}`);
    }
    const ext = typeof input.extension === "string" ? input.extension.replace(/^\./, "") : null;
    const files: string[] = [];
    walk(ctx.root, dir, 12, files);
    const matches: string[] = [];
    for (const rel of files) {
      if (rel.endsWith("/")) continue;
      if (ext && !rel.endsWith(`.${ext}`)) continue;
      if (matches.length >= MAX_MATCHES) break;
      let content: string;
      try {
        const full = join(ctx.root, rel);
        if (statSync(full).size > MAX_READ_BYTES) continue;
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      content.split("\n").forEach((line, i) => {
        if (matches.length >= MAX_MATCHES || !re.test(line)) return;
        matches.push(`${rel}:${i + 1}:${line.trim().slice(0, 200)}`);
      });
    }
    return matches.length ? matches.join("\n") : "(no matches)";
  },
};

const runCommandTool: AgentTool = {
  name: "run_command",
  description:
    "Run a command in the workspace. Pass argv as an array (no shell string). Returns the exit code with stdout and stderr.",
  mutates: true,
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "array",
        items: { type: "string" },
        description: 'Program and arguments, e.g. ["npm", "test"].',
      },
      cwd: { type: "string", description: "Directory to run in, relative to the workspace root (optional)." },
      timeout_ms: { type: "integer", description: "Timeout in milliseconds (default 300000)." },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const argv = Array.isArray(input.command) ? input.command.map(String).filter(Boolean) : [];
    if (!argv.length) throw new ToolError("command must be a non-empty array of strings");
    const cwd = input.cwd ? resolveInWorkspace(ctx.root, input.cwd) : ctx.root;
    const timeout = Math.min(Math.max(Number(input.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS), 1000), 600_000);
    const [file, ...args] = argv;
    return new Promise<string>((resolvePromise, reject) => {
      execFile(file, args, { cwd, timeout, maxBuffer: 10_000_000, shell: false }, (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
        if (err?.killed) {
          reject(new ToolError(`command timed out after ${timeout}ms`));
          return;
        }
        if (err && typeof err.code !== "number") {
          reject(new ToolError(err.message));
          return;
        }
        const exitCode = typeof err?.code === "number" ? err.code : 0;
        const out = truncate(String(stdout).trim(), MAX_COMMAND_OUTPUT, "stdout");
        const errOut = truncate(String(stderr).trim(), MAX_COMMAND_OUTPUT, "stderr");
        resolvePromise(
          [`exit code: ${exitCode}`, out && `stdout:\n${out}`, errOut && `stderr:\n${errOut}`].filter(Boolean).join("\n\n"),
        );
      });
    });
  },
};

export const WORKSPACE_TOOLS: AgentTool[] = [readFile, writeFile, editFile, listFiles, searchFiles, runCommandTool];
