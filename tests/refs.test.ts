import { describe, expect, it } from "vitest";

import { POST as report } from "@/app/api/v1/executions/[id]/events/route";
import { createExecution, getExecution } from "@/executions/store";
import { createKey } from "@/lib/apikeys";
import { createTeam, createUser } from "@/lib/teams";
import { isBranchRef, isFullCommit } from "@/repos/refs";

/**
 * A run's publication is the client's word, and it ends up as arguments to
 * `git fetch` on the server when another team asks about the run. So it is
 * held to what a real push reports — a branch ref and a full commit — where
 * it arrives.
 */

const SHA = "a".repeat(40);

describe("what a publication may say", () => {
  it("takes a branch ref git would accept, and nothing that reads as an option", () => {
    expect(isBranchRef("refs/heads/gate/run-1a2b3c4d")).toBe(true);
    expect(isBranchRef("refs/heads/feature/pq-rekey")).toBe(true);
    for (const bad of ["--upload-pack=touch /tmp/x", "gate/run-1", "refs/tags/v1", "refs/heads/", "refs/heads/a..b", "refs/heads/a b", "refs/heads/.hidden", "refs/heads/x.lock", "refs/heads/a@{1}", "refs/heads/-x/../y"]) {
      expect(isBranchRef(bad)).toBe(false);
    }
  });

  it("takes a full commit only", () => {
    expect(isFullCommit(SHA)).toBe(true);
    expect(isFullCommit("b".repeat(64))).toBe(true);
    for (const bad of ["abcdef1", "--output=/tmp/x", SHA.toUpperCase(), `${SHA}0`]) expect(isFullCommit(bad)).toBe(false);
  });
});

describe("the events route", () => {
  createTeam("Refs", "refs-team");
  const user = createUser({ email: "pub@refs.test", name: "Pub", teamId: "refs-team" });
  const key = createKey({ name: "pub laptop", userId: user.id, teamId: "refs-team" }).plaintext;
  const send = (id: string, published: Record<string, unknown>) =>
    report(
      new Request(`http://gate.test/api/v1/executions/${id}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ published }),
      }),
      { params: Promise.resolve({ id }) },
    );

  it("stores a publication a real push would report", async () => {
    createExecution("pub-ok", "dev", {}, Date.now(), null, { origin: "local", driver: "session", userId: user.id, teamId: "refs-team" });
    expect((await send("pub-ok", { ref: "refs/heads/gate/run-ok", commit: SHA, at: 1 })).status).toBe(200);
    expect(getExecution("pub-ok")).toMatchObject({ publishedRef: "refs/heads/gate/run-ok", publishedCommit: SHA });
  });

  it("records a publication that could become a git option as a failed one", async () => {
    createExecution("pub-bad", "dev", {}, Date.now(), null, { origin: "local", driver: "session", userId: user.id, teamId: "refs-team" });
    expect((await send("pub-bad", { ref: "--upload-pack=touch /tmp/x", commit: SHA, at: 1 })).status).toBe(200);
    const stored = getExecution("pub-bad")!;
    expect(stored.publishedRef).toBeNull();
    expect(stored.publishedCommit).toBeNull();
    expect(stored.publishError).toContain("not a branch ref");
  });
});
