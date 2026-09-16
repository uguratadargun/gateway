import { describe, expect, it } from "vitest";

import { PATCH as patchRepoRoute } from "@/app/api/repos/[id]/route";
import { createTeam, teamAncestors } from "@/lib/teams";
import { createRepo, getRepo } from "@/repos/store";

/**
 * Whose repository it is. The field decides who may ask about the code, so the
 * two ways of getting it wrong are the ones worth pinning: an owner that names
 * no team, and a change that silently did nothing.
 */

function tree() {
  if (!teamAncestors("repoteam-android").length) {
    createTeam("Repo Team Co", "repoteamco");
    createTeam("Android", "repoteam-android", "repoteamco");
  }
}

function connect(id: string, teamId: string | null) {
  return createRepo({
    id,
    name: id,
    source: `/tmp/${id}`,
    root: `/tmp/${id}`,
    cloned: false,
    baseRef: null,
    setup: [],
    prepare: [],
    teamId,
  });
}

const patch = (id: string, body: unknown) =>
  patchRepoRoute(
    new Request(`http://gate.test/api/repos/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

describe("assigning a repository to a team", () => {
  it("hands it to a team, and back to nobody", async () => {
    tree();
    connect("repoteam-owned", null);

    const given = await patch("repoteam-owned", { teamId: "repoteam-android" });
    expect(given.status).toBe(200);
    expect(getRepo("repoteam-owned")?.teamId).toBe("repoteam-android");

    // Null is a value here: it is "nobody has said", which every repository
    // connected before teams reached this table already is.
    const taken = await patch("repoteam-owned", { teamId: null });
    expect(taken.status).toBe(200);
    expect(getRepo("repoteam-owned")?.teamId).toBeNull();
  });

  it("refuses a team that does not exist, and leaves the owner alone", async () => {
    tree();
    connect("repoteam-kept", "repoteam-android");

    const res = await patch("repoteam-kept", { teamId: "repoteam-ghost" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("repoteam-ghost");
    // The repository would otherwise be outside every asker's family — owned
    // in the record, readable by nobody, with nothing saying why.
    expect(getRepo("repoteam-kept")?.teamId).toBe("repoteam-android");
  });
});
