import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { GET as fileRoute } from "@/app/api/v1/ask/[id]/file/route";
import { GET as grepRoute } from "@/app/api/v1/ask/[id]/grep/route";
import { GET as treeRoute } from "@/app/api/v1/ask/[id]/tree/route";
import { createKey } from "@/lib/apikeys";
import { createTeam, getTeam } from "@/lib/teams";
import type { AskSource } from "@/orchestration/ask";
import { ASK_TTL_MS, askFile, askGrep, askTree, createAsk, openAsk } from "@/orchestration/ask-source";
import { createRepo, updateRepo, type RepoRecord } from "@/repos/store";

/**
 * Another team's code, read by the asker's own machine through the gate.
 *
 * The server holds the checkout and hands out three read-only views of one
 * commit. What has to hold is what the ask fixed: that commit and no other,
 * that team's family and no other, for a day and no longer — and that the
 * answers are git's own reading of that commit, not of whatever the checkout
 * happens to have checked out now.
 */

const temps: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A checkout with two commits: `first` has the handshake, the second rewrote it. */
function checkout(): { root: string; first: string; second: string } {
  const root = mkdtempSync(join(tmpdir(), "gate-ask-src-"));
  temps.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  mkdirSync(join(root, "src", "sync"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "src", "sync", "handshake.ts"), "export function handshake() {\n  return 'v1';\n}\n");
  writeFileSync(join(root, "README.md"), "desktop\n");
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "first");
  const first = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "src", "sync", "handshake.ts"), "export function handshake() {\n  return 'v2';\n}\n");
  git(root, "commit", "-qam", "second");
  return { root, first, second: git(root, "rev-parse", "HEAD") };
}

let n = 0;

function tree(): void {
  if (getTeam("as-ulak")) return;
  createTeam("Ulak", "as-ulak");
  createTeam("Server", "as-srv", "as-ulak");
  createTeam("Desktop", "as-desktop", "as-ulak");
  createTeam("Other Co", "as-other");
}

function connected(root: string, teamId = "as-desktop"): RepoRecord {
  tree();
  const id = `as-repo-${++n}`;
  return createRepo({ id, name: id, source: root, root, remoteUrl: `git@github.com:ulak/${id}.git`, cloned: false, baseRef: null, setup: [], teamId });
}

function source(repo: RepoRecord, commit: string): AskSource {
  return { repo, repoId: repo.repoId, teamId: repo.teamId, ref: "main", commit, remote: "origin", via: "commit" };
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("an ask", () => {
  it("reads the commit it fixed, not the one the checkout is on now", () => {
    const { root, first } = checkout();
    const repo = connected(root);
    const ask = createAsk(source(repo, first), "how is the handshake done?", { teamId: "as-srv", userId: null });

    const opened = openAsk(ask.id, "as-srv");
    expect(askFile(opened.ask, opened.repo, "src/sync/handshake.ts", undefined, undefined)).toContain("2\t  return 'v1';");
    expect(askGrep(opened.ask, opened.repo, "return '", "src", undefined)).toBe("src/sync/handshake.ts:2:  return 'v1';");
    expect(askGrep(opened.ask, opened.repo, "nothing-like-this", undefined, undefined)).toBe("no matches");
  });

  it("lists a directory the way a worktree listing reads, without dependency folders", () => {
    const { root, first } = checkout();
    const repo = connected(root);
    const ask = createAsk(source(repo, first), "q", { teamId: "as-srv", userId: null });
    const listing = askTree(ask, repo, "", undefined).split("\n");
    expect(listing).toContain("src/");
    expect(listing).toContain("src/sync/");
    expect(listing).toContain("src/sync/handshake.ts");
    expect(listing).toContain("README.md");
    expect(listing.some((l) => l.includes("node_modules"))).toBe(false);
    // One level only, when that is what was asked for.
    expect(askTree(ask, repo, "", 0).split("\n")).toEqual(["README.md", "src/"]);
  });

  it("refuses a path that leaves the repository, and says a directory is one", () => {
    const { root, first } = checkout();
    const repo = connected(root);
    const ask = createAsk(source(repo, first), "q", { teamId: "as-srv", userId: null });
    expect(() => askFile(ask, repo, "../etc/passwd", undefined, undefined)).toThrow(/not a path in the repository/);
    expect(() => askFile(ask, repo, "/etc/passwd", undefined, undefined)).toThrow(/not a path in the repository/);
    expect(() => askTree(ask, repo, "src/../..", undefined)).toThrow(/not a path in the repository/);
    expect(() => askFile(ask, repo, "src", undefined, undefined)).toThrow(/is a directory/);
    expect(() => askFile(ask, repo, "src/missing.ts", undefined, undefined)).toThrow(/no such file/);
  });

  it("keeps a pattern that starts with a dash a pattern", () => {
    const { root, first } = checkout();
    const repo = connected(root);
    const ask = createAsk(source(repo, first), "q", { teamId: "as-srv", userId: null });
    expect(askGrep(ask, repo, "--no-index", undefined, undefined)).toBe("no matches");
  });

  it("is the asking team's alone, for a day, and only while the repository is still in its family", () => {
    const { root, first } = checkout();
    const repo = connected(root);
    const now = Date.now();
    const ask = createAsk(source(repo, first), "q", { teamId: "as-srv", userId: null }, now);

    expect(() => openAsk(ask.id, "as-desktop", now)).toThrow(/no ask/);
    expect(() => openAsk(ask.id, "as-srv", now + ASK_TTL_MS + 1)).toThrow(/no ask/);
    expect(() => openAsk("nope", "as-srv", now)).toThrow(/no ask/);
    expect(openAsk(ask.id, "as-srv", now).ask.commit).toBe(first);

    // The repository changes hands to a company outside the family.
    updateRepo(repo.id, { teamId: "as-other" });
    expect(() => openAsk(ask.id, "as-srv", now)).toThrow(/no ask/);
  });
});

describe("the ask's read routes", () => {
  it("answer the asking team's key, and nobody else's, with the same words for every refusal", async () => {
    const { root, first } = checkout();
    const repo = connected(root);
    const ask = createAsk(source(repo, first), "q", { teamId: "as-srv", userId: null });
    const mine = createKey({ name: "srv", teamId: "as-srv" }).plaintext;
    const theirs = createKey({ name: "other", teamId: "as-other" }).plaintext;
    const call = (route: typeof fileRoute, key: string, query: string) =>
      route(new Request(`http://gate.test/api/v1/ask/${ask.id}/x?${query}`, { headers: { authorization: `Bearer ${key}` } }), {
        params: Promise.resolve({ id: ask.id }),
      });

    const read = await call(fileRoute, mine, "path=src/sync/handshake.ts&offset=2&limit=1");
    expect(read.status).toBe(200);
    expect((await read.json()).text).toBe("2\t  return 'v1';");
    expect((await (await call(treeRoute, mine, "path=src")).json()).text).toContain("src/sync/handshake.ts");
    expect((await (await call(grepRoute, mine, "pattern=handshake&ext=ts")).json()).text).toContain("src/sync/handshake.ts:1:");

    const refused = await call(fileRoute, theirs, "path=src/sync/handshake.ts");
    expect(refused.status).toBe(404);
    expect((await refused.json()).error).toMatch(/no ask/);
    expect((await call(fileRoute, mine, "path=../x")).status).toBe(400);
  });
});
