import { describe, expect, it } from "vitest";

import { canonicalRepoId, parseRemote, sameRepo } from "@/repos/identity";

/**
 * The name every clone of a repository agrees on.
 *
 * Two things are being held apart here, and they pull in opposite directions:
 * every way of writing the same remote must land on one identity, and two
 * different repositories must never land on the same one. The second is the
 * one that costs something when it is wrong — a shared identity silently
 * merges two codebases' memory — so anything the parser cannot be sure of is
 * unknown rather than guessed.
 */

describe("the identity a remote gives a repository", () => {
  it("reads the same identity out of every way git writes one remote", () => {
    const written = [
      "git@github.com:ulak/gateway.git",
      "git@github.com:ulak/gateway",
      "https://github.com/ulak/gateway.git",
      "https://github.com/ulak/gateway",
      "ssh://git@github.com/ulak/gateway.git",
      "ssh://git@github.com:22/ulak/gateway.git",
      "https://ugur@github.com/ulak/gateway.git",
      "git://github.com/ulak/gateway.git",
      "https://GitHub.com/Ulak/Gateway.git",
      "  git@github.com:ulak/gateway.git  ",
      "https://github.com/ulak/gateway/",
    ];
    for (const remote of written) {
      expect(canonicalRepoId(remote), remote).toBe("github.com/ulak/gateway");
    }
  });

  it("keeps two repositories apart however alike their names are", () => {
    // The case the whole identity exists for: the last path segment is not a
    // name, it is a coincidence waiting to happen.
    expect(canonicalRepoId("git@github.com:desktop/api.git")).not.toBe(canonicalRepoId("git@github.com:server/api.git"));
    expect(canonicalRepoId("git@github.com:ulak/api.git")).not.toBe(canonicalRepoId("git@gitlab.com:ulak/api.git"));
    expect(sameRepo("git@github.com:ulak/gateway.git", "https://github.com/ulak/gateway")).toBe(true);
    expect(sameRepo("git@github.com:ulak/gateway.git", "git@github.com:ulak/gateway-cli.git")).toBe(false);
  });

  it("keeps a nested group whole, because that is where the repository lives", () => {
    // GitLab subgroups: ulak/mobile/ios and ulak/ios are different projects.
    expect(canonicalRepoId("git@gitlab.com:ulak/mobile/ios.git")).toBe("gitlab.com/ulak/mobile/ios");
    expect(parseRemote("git@gitlab.com:ulak/mobile/ios.git")).toEqual({ host: "gitlab.com", owner: "ulak/mobile", name: "ios" });
    expect(canonicalRepoId("git@gitlab.com:ulak/mobile/ios.git")).not.toBe(canonicalRepoId("git@gitlab.com:ulak/ios.git"));
  });

  it("says unknown rather than inventing an identity it cannot stand behind", () => {
    // A path names a directory on one machine. The point of an identity is
    // that a second machine can use it, so a path is never one.
    const notIdentities = [
      "/Users/ugur/Projects/ulak/gateway",
      "~/Projects/gateway",
      "../gateway",
      "file:///Users/ugur/Projects/gateway",
      "C:/Users/ugur/gateway",
      "gateway",
      "",
      "   ",
      // A host with no owner is half an answer, and half is not enough.
      "https://github.com/gateway",
      "git@github.com:gateway.git",
      // A host with no dot is whatever one machine's ssh_config says it is.
      // Two laptops can point `github-work` at two different servers, and a
      // shared identity between two repositories is the one mistake that
      // merges memory without anybody being told.
      "git@localhost:ulak/gateway.git",
      "ssh://localhost/ulak/gateway.git",
      "git@github-work:ulak/gateway.git",
      "git@gitbox:ulak/gateway.git",
    ];
    for (const source of notIdentities) {
      expect(canonicalRepoId(source), source).toBeNull();
    }
    // And unknown is not equal to unknown: two repositories nobody could
    // identify are not thereby the same repository.
    expect(sameRepo("/Users/ugur/desktop", "/Users/ugur/server")).toBe(false);
    expect(sameRepo("/Users/ugur/desktop", "/Users/ugur/desktop")).toBe(false);
  });
});
