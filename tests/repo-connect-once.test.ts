import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { POST as connectRoute } from "@/app/api/repos/route";
import { pullRepo } from "@/repos/setup";
import { createRepo, listRepos } from "@/repos/store";

/**
 * One remote is one repository on a gate. Its owner, its publication remote
 * and the memory filed under it are all looked up by that name, so a second
 * record of the same remote under another id would make each lookup pick one
 * of the two at random.
 */

const connect = (body: Record<string, unknown>) =>
  connectRoute(
    new Request("http://gate.test/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ install: false, ...body }),
    }),
  );

describe("pulling a connected checkout", () => {
  it("moves it to its upstream branch, whatever FETCH_HEAD was last written with", async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const work = mkdtempSync(join(tmpdir(), "gate-pull-work-"));
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "one");
    const remote = mkdtempSync(join(tmpdir(), "gate-pull-remote-"));
    git(remote, "init", "-q", "--bare");
    git(work, "push", "-q", remote, "main");
    const root = mkdtempSync(join(tmpdir(), "gate-pull-checkout-"));
    git(root, "clone", "-q", remote, root);
    // Another team's question fetched a run's branch in here: FETCH_HEAD now
    // names a commit that is not the base branch's.
    git(work, "checkout", "-q", "-b", "gate/run-x");
    git(work, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "a run");
    git(work, "push", "-q", remote, "gate/run-x");
    git(root, "fetch", "-q", "--no-tags", remote, "gate/run-x");
    git(work, "checkout", "-q", "main");
    git(work, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "two");
    git(work, "push", "-q", remote, "main");

    createRepo({ id: "pull-me", name: "pull-me", source: root, root, cloned: false, baseRef: "main", setup: [] });
    expect((await pullRepo("pull-me"))?.status).toBe("ready");
    expect(git(root, "rev-parse", "HEAD")).toBe(git(work, "rev-parse", "main"));
  });
});

describe("connecting a remote that is already connected", () => {
  createRepo({
    id: "once-first",
    name: "first",
    source: "/tmp/once-first",
    root: "/tmp/once-first",
    remoteUrl: "git@github.com:ulak/connected-once.git",
    cloned: false,
    baseRef: null,
    setup: [],
  });

  it("refuses the same remote by URL before cloning it", async () => {
    const res = await connect({ id: "once-by-url", source: "https://github.com/ulak/connected-once.git" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('"once-first"');
    expect(listRepos().some((r) => r.id === "once-by-url")).toBe(false);
  });

  it("refuses a local checkout whose origin is that remote", async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-once-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/ulak/connected-once"], { cwd: root });
    const res = await connect({ id: "once-by-path", source: root });
    expect(res.status).toBe(409);
    expect(listRepos().some((r) => r.id === "once-by-path")).toBe(false);
  });
});
