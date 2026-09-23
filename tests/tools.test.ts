import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { getTool, knownToolNames, toolsFor } from "@/runtime/tools/registry";
import { ToolError, type ToolContext } from "@/runtime/tools/types";

/**
 * The tools are the only way an agent reaches the outside world, so the tests
 * that matter most here are the ones about what they refuse to do.
 */

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gate-ws-"));
  ctx = { root, nodeId: "implementation", executionId: "exec-1" };
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
});

const run = (name: string, input: Record<string, unknown>) => getTool(name)!.execute(input, ctx);

describe("workspace tools", () => {
  it("reads a file with line numbers", async () => {
    expect(await run("read_file", { path: "src/a.ts" })).toBe("1\texport const a = 1;\n2\texport const b = 2;\n3\t");
  });

  it("writes and edits files", async () => {
    await run("write_file", { path: "src/new/b.ts", content: "export const c = 3;\n" });
    expect(readFileSync(join(root, "src/new/b.ts"), "utf8")).toBe("export const c = 3;\n");

    await run("edit_file", { path: "src/a.ts", old_string: "const a = 1", new_string: "const a = 42" });
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toContain("const a = 42");
  });

  it("refuses an ambiguous edit rather than guessing", async () => {
    writeFileSync(join(root, "dup.ts"), "x\nx\n");
    await expect(run("edit_file", { path: "dup.ts", old_string: "x", new_string: "y" })).rejects.toThrow(/appears 2 times/);
    expect(await run("edit_file", { path: "dup.ts", old_string: "x", new_string: "y", replace_all: true })).toContain("edited");
  });

  it("lists and searches", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "junk.js"), "noise");
    const listing = await run("list_files", {});
    expect(listing).toContain("src/a.ts");
    expect(listing).not.toContain("node_modules");
    expect(await run("search_files", { pattern: "const b", extension: "ts" })).toContain("src/a.ts:2:");
  });

  it("runs a command and reports its exit code", async () => {
    const ok = await run("run_command", { command: ["node", "-e", "console.log('hi')"] });
    expect(ok).toContain("exit code: 0");
    expect(ok).toContain("hi");
    const bad = await run("run_command", { command: ["node", "-e", "process.exit(3)"] });
    expect(bad).toContain("exit code: 3");
  });

  it("keeps every tool inside the workspace", async () => {
    await expect(run("read_file", { path: "../../etc/passwd" })).rejects.toThrow(ToolError);
    await expect(run("read_file", { path: "/etc/passwd" })).rejects.toThrow(/outside the workspace/);
    await expect(run("write_file", { path: "../escape.txt", content: "x" })).rejects.toThrow(/outside the workspace/);
    await expect(run("run_command", { command: ["node", "-v"], cwd: "/tmp" })).rejects.toThrow(/outside the workspace/);

    // A symlink pointing out of the workspace is not a way around it either.
    const outside = mkdtempSync(join(tmpdir(), "gate-outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    await expect(run("read_file", { path: "link.txt" })).rejects.toThrow(/outside the workspace/);
  });
});

describe("tool registry", () => {
  it("exposes the known names and gates tools on having a workspace", () => {
    expect(knownToolNames()).toEqual([
      "edit_file",
      "list_files",
      "memory_feature",
      "memory_history",
      "memory_search",
      "read_file",
      "run_command",
      "search_files",
      "write_file",
    ]);
    expect(toolsFor(["read_file", "nope"], true).map((t) => t.name)).toEqual(["read_file"]);
    // No workspace, no file tools — the same agent file still runs, in prose
    // mode. The memory tools need no worktree and stay.
    expect(toolsFor(["read_file"], false)).toEqual([]);
    expect(toolsFor(["read_file", "memory_search", "memory_feature", "memory_history"], false).map((t) => t.name)).toEqual([
      "memory_search",
      "memory_feature",
      "memory_history",
    ]);
  });
});

describe("tool regressions", () => {
  it("edit_file writes replacement text literally, dollar signs and all", async () => {
    writeFileSync(join(root, "run.sh"), "echo PLACEHOLDER\n");
    await run("edit_file", { path: "run.sh", old_string: "PLACEHOLDER", new_string: "pid=$$ and $& and $`" });
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo pid=$$ and $& and $`\n");

    writeFileSync(join(root, "all.txt"), "A A\n");
    await run("edit_file", { path: "all.txt", old_string: "A", new_string: "$&", replace_all: true });
    expect(readFileSync(join(root, "all.txt"), "utf8")).toBe("$& $&\n");
  });

  it("never walks through a symlinked directory out of the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "gate-outside-"));
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET-VALUE\n");
    symlinkSync(outside, join(root, "linked"));

    expect(await run("list_files", { depth: 5 })).not.toContain("linked/secret.txt");
    expect(await run("search_files", { pattern: "TOPSECRET" })).toBe("(no matches)");
  });

  it("search_files searches the one file a path names", async () => {
    expect(await run("search_files", { pattern: "const b", path: "src/a.ts" })).toBe("src/a.ts:2:export const b = 2;");
  });

  it("search_files reaches files past the listing cap", async () => {
    // Alphabetically before the target, and more of them than list_files shows.
    mkdirSync(join(root, "assets"));
    for (let i = 0; i < 600; i++) writeFileSync(join(root, "assets", `icon-${i}.svg`), "<svg/>");
    mkdirSync(join(root, "ts"));
    writeFileSync(join(root, "ts", "receiver.ts"), "function handleSyncMessage() {}\n");
    expect(await run("search_files", { pattern: "handleSyncMessage" })).toBe("ts/receiver.ts:1:function handleSyncMessage() {}");
  });

  it("search_files says where it stopped and what it did not read", async () => {
    writeFileSync(join(root, "many.txt"), Array.from({ length: 150 }, (_, i) => `hit ${i}`).join("\n"));
    const many = await run("search_files", { pattern: "hit", path: "many.txt" });
    expect(many.split("\n").filter((l) => l.startsWith("many.txt:"))).toHaveLength(100);
    expect(many).toContain("stopped at 100 matches");

    writeFileSync(join(root, "src", "huge.ts"), `const needle = 1;\n${"x".repeat(250_000)}\n`);
    const huge = await run("search_files", { pattern: "needle", path: "src" });
    expect(huge).toContain("(no matches)");
    expect(huge).toContain("src/huge.ts");
  });

  it("list_files shows every top-level entry before it runs out", async () => {
    // A deep directory early in the alphabet used to eat the whole listing.
    mkdirSync(join(root, "assets", "icons"), { recursive: true });
    for (let i = 0; i < 600; i++) writeFileSync(join(root, "assets", "icons", `icon-${i}.svg`), "<svg/>");
    mkdirSync(join(root, "ts"));
    writeFileSync(join(root, "ts", "receiver.ts"), "");
    const listing = (await run("list_files", { depth: 3 })).split("\n");
    expect(listing).toContain("ts/");
    expect(listing).toContain("ts/receiver.ts");
    expect(listing).toContain("src/a.ts");
    expect(listing.at(-1)).toMatch(/listing truncated at 500 entries.*depth 2/);
  });

  it("list_files on a file says so instead of listing nothing", async () => {
    await expect(run("list_files", { path: "src/a.ts" })).rejects.toThrow(/is a file; use read_file/);
  });

  it("run_command keeps the end of a long output, where the summary is", async () => {
    const script = "for (let i = 0; i < 5000; i++) console.log('line ' + i + ' ' + 'x'.repeat(20)); console.log('SUMMARY: 3 failed');";
    const out = await run("run_command", { command: ["node", "-e", script] });
    expect(out).toContain("line 0 ");
    expect(out).toContain("SUMMARY: 3 failed");
    expect(out).toMatch(/characters of stdout cut from the middle/);
  });
});
