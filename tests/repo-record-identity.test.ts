import { describe, expect, it } from "vitest";

import { createRepo, getRepo, repoByIdentity, setRepoRemote } from "@/repos/store";

/**
 * What the repo record does with an identity once it has one.
 *
 * The record is where the identity stops being a parsing question and starts
 * being a promise: everything written under `repoId` — decisions, touches,
 * objections — means what it means because that id kept pointing at the same
 * codebase. So the one thing this must never do is move it quietly.
 */

let n = 0;
function repo(source: string, remoteUrl: string | null) {
  const id = `ident-${++n}`;
  return createRepo({
    id,
    name: id,
    source,
    root: `/tmp/${id}`,
    cloned: false,
    baseRef: null,
    setup: [],
    prepare: [],
    remoteUrl,
  });
}

describe("the identity a repo record keeps", () => {
  it("takes its identity from the remote and not from what was typed", () => {
    // Registered by path, but the checkout knows where it came from.
    const byPath = repo("/Users/ugur/Projects/gateway", "git@github.com:ulak/gateway.git");
    expect(byPath.repoId).toBe("github.com/ulak/gateway");
    expect(byPath.remoteUrl).toBe("git@github.com:ulak/gateway.git");

    // And a checkout with no remote is a repository gate cannot name. The
    // path is right there and is still not used: it names a directory on one
    // machine, and an identity has to mean something on another.
    const orphan = repo("/Users/ugur/Projects/scratch", null);
    expect(orphan.repoId).toBeNull();
    expect(repoByIdentity("github.com/ulak/gateway")!.id).toBe(byPath.id);
  });

  it("refuses to move an identity that is already set, and says which two disagree", () => {
    const r = repo("/tmp/api", "git@github.com:desktop/api.git");
    const moved = setRepoRemote(r.id, "git@github.com:server/api.git");

    expect(moved.ok).toBe(false);
    if (!moved.ok) {
      expect(moved.was).toBe("github.com/desktop/api");
      expect(moved.now).toBe("github.com/server/api");
    }
    // Nothing was written: the memory already filed under the old identity
    // still means what it meant.
    expect(getRepo(r.id)!.repoId).toBe("github.com/desktop/api");
  });

  it("lets a way of writing the same remote change without calling it a different repo", () => {
    const r = repo("/tmp/gw", "git@github.com:ulak/gateway.git");
    const rewritten = setRepoRemote(r.id, "https://github.com/ulak/gateway");

    expect(rewritten.ok).toBe(true);
    expect(getRepo(r.id)!.repoId).toBe("github.com/ulak/gateway");
    // The new spelling is kept as what origin actually says now.
    expect(getRepo(r.id)!.remoteUrl).toBe("https://github.com/ulak/gateway");
  });

  it("does not revoke an identity when the remote goes away", () => {
    // A checkout that has gone offline, or lost its origin, is still the same
    // repository — and everything recorded under it still is too.
    const r = repo("/tmp/offline", "git@github.com:ulak/gateway.git");
    expect(setRepoRemote(r.id, null).ok).toBe(true);
    expect(getRepo(r.id)!.repoId).toBe("github.com/ulak/gateway");
    expect(getRepo(r.id)!.remoteUrl).toBeNull();
  });

  it("names an unnamed repo the first time its remote can be read", () => {
    const r = repo("/tmp/late", null);
    expect(r.repoId).toBeNull();
    expect(setRepoRemote(r.id, "git@gitlab.com:ulak/mobile/ios.git").ok).toBe(true);
    expect(getRepo(r.id)!.repoId).toBe("gitlab.com/ulak/mobile/ios");
  });
});
