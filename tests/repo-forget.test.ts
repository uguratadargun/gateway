import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { connectRepo, removeRepoCheckout, reposDir } from "@/repos/setup";
import { createRepo } from "@/repos/store";

/**
 * What forgetting a repository does to the checkout behind it.
 *
 * Forgetting used to leave every checkout on disk, which made an id single
 * use: the same repository, connected and forgotten, could never be connected
 * back — the clone landed on a directory nothing claimed any more and the
 * connect failed on it. So a checkout gate cloned is now gate's to remove, and
 * a checkout still standing is taken over rather than refused.
 *
 * The two things it must never do are here too: delete somebody's own working
 * copy, and delete a checkout a run's worktree is still branched from — that
 * `.git` is the only copy of the worktree's history.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A checkout where gate's clone of `id` would be, with `origin` set. */
function checkoutAt(id: string, origin: string): string {
  const root = join(reposDir(), id);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  git(root, "remote", "add", "origin", origin);
  writeFileSync(join(root, "readme.md"), "x\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  return root;
}

function record(id: string, root: string, cloned: boolean) {
  return createRepo({
    id,
    name: id,
    source: root,
    root,
    cloned,
    baseRef: null,
    setup: [],
    prepare: [],
    remoteUrl: null,
  });
}

describe("forgetting a repository gate cloned", () => {
  it("removes the checkout, so the same id connects again", () => {
    const root = checkoutAt("forget-clone", "git@github.com:ulak/desktop.git");

    expect(removeRepoCheckout(record("forget-clone", root, true))).toEqual({ removed: true, root });
    expect(existsSync(root)).toBe(false);
  });

  it("keeps a checkout a worktree still branches from, and says which", () => {
    const root = checkoutAt("forget-held", "git@github.com:ulak/held.git");
    const worktree = join(reposDir(), "held-worktree");
    git(root, "worktree", "add", "-q", "-b", "gate/run", worktree);

    const kept = removeRepoCheckout(record("forget-held", root, true));
    expect(kept.removed).toBe(false);
    // Not a shrug: the run holding it is named, because `gate clean` is what
    // ends that run and the person has to know which one.
    expect(kept.kept).toContain(worktree);
    expect(existsSync(join(root, ".git"))).toBe(true);
  });

  it("never touches a checkout gate did not clone", () => {
    // Registered by path: somebody's own working copy, and "remove from the
    // list" is not permission to delete it.
    const root = checkoutAt("forget-theirs", "git@github.com:ulak/theirs.git");
    const kept = removeRepoCheckout(record("forget-theirs", root, false));

    expect(kept.removed).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("calls a checkout that is already gone removed", () => {
    const root = join(reposDir(), "forget-missing");
    expect(removeRepoCheckout(record("forget-missing", root, true))).toEqual({ removed: true, root });
  });
});

describe("connecting onto a checkout that is already there", () => {
  it("takes over one that is the same repository, without cloning", () => {
    const root = checkoutAt("adopt-same", "git@github.com:ulak/desktop.git");
    const head = git(root, "rev-parse", "HEAD");

    // A URL, so this is the clone path — and it must not reach the network.
    const connected = connectRepo("https://github.com/ulak/desktop.git", "adopt-same");

    expect(connected.root).toBe(root);
    expect(connected.cloned).toBe(true);
    expect(connected.remoteUrl).toBe("git@github.com:ulak/desktop.git");
    // The same checkout, at the commit it stood on. The first pull moves it.
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  it("refuses one that holds a different repository", () => {
    checkoutAt("adopt-other", "git@github.com:ulak/something-else.git");

    expect(() => connectRepo("https://github.com/ulak/desktop.git", "adopt-other")).toThrow(
      /already holds github\.com\/ulak\/something-else/,
    );
  });

  it("refuses a directory that is not a checkout of it at all", () => {
    const root = join(reposDir(), "adopt-junk");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "stray.txt"), "x\n");

    expect(() => connectRepo("https://github.com/ulak/desktop.git", "adopt-junk")).toThrow(/already holds/);
  });
});
