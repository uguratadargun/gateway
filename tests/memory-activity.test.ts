import { describe, expect, it } from "vitest";

import { createExecution, finishExecution } from "@/executions/store";
import { createTeam, createUser, getTeam } from "@/lib/teams";
import { inFlight, overlap, taskTerms } from "@/memory/activity";
import { LocalMemoryAccess } from "@/memory/access";
import { describeSearch } from "@/memory/cards";
import { memoryScopeFor, replaceDecisions } from "@/memory/store";
import { createState } from "@/runtime/state";

/**
 * What the tree is doing right now. A run is invisible to every other team
 * until it ends and is recorded; these hold down that a run going now is
 * found by the words of its task, and by the rest of the tree only.
 */

let users: { a: string; b: string } | null = null;

function tree(): { a: string; b: string } {
  if (!getTeam("ac-ulak")) {
    createTeam("AC Ulak", "ac-ulak");
    createTeam("AC Android", "ac-android", "ac-ulak");
    createTeam("AC Desktop", "ac-desktop", "ac-ulak");
    createTeam("AC Other", "ac-other");
  }
  users ??= {
    a: createUser({ email: "ayse@ac.test", name: "Ayşe", teamId: "ac-android" }).id,
    b: createUser({ email: "bora@ac.test", name: "Bora", teamId: "ac-desktop" }).id,
  };
  return users;
}

let n = 0;

function start(teamId: string, task: string, userId: string | null = null): string {
  const id = `ac-run-${++n}`;
  createExecution(id, "dev", { task }, Date.now(), null, { teamId, userId, origin: "local" });
  return id;
}

function finish(id: string, task: string): void {
  const state = createState(id, "dev", { task });
  state.status = "completed";
  finishExecution(state, null);
}

describe("the words of a task", () => {
  it("meet across suffixes and languages' filler", () => {
    const a = taskTerms("Add push notifications for new messages");
    const b = taskTerms("push notification when a message arrives");
    expect(overlap(a, b).shared).toEqual(expect.arrayContaining(["push", "notifi", "messag"]));
    expect(taskTerms("bildirimleri ekle").has("bildir")).toBe(true);
    expect([...taskTerms("bildirim")]).toEqual([...taskTerms("bildirimler")]);
    expect(taskTerms("bir ve ile için").size).toBe(0);
  });
});

describe("work in flight", () => {
  it("finds another team's run on the same words, and not a run on something else or outside the tree", () => {
    const { a, b } = tree();
    const same = start("ac-android", "Offline sync: queue edits locally and flush when the network returns", a);
    const unrelated = start("ac-android", "Rename the settings screen title", a);
    const outside = start("ac-other", "Offline sync: queue edits locally and flush when the network returns");
    const scope = memoryScopeFor("ac-desktop");
    const found = inFlight(scope, { query: "queue offline edits and flush them when back online" });
    const ids = found.map((x) => x.executionId);
    expect(ids).toContain(same);
    expect(ids).not.toContain(unrelated);
    expect(ids).not.toContain(outside);
    expect(found.find((x) => x.executionId === same)).toMatchObject({ team: "ac-android", person: "Ayşe", status: "running" });

    // A person's own runs are not somebody else's work to coordinate with.
    expect(inFlight(memoryScopeFor("ac-android"), { query: "offline sync queue edits flush", excludeUserId: a }).map((x) => x.executionId)).not.toContain(same);
    // A run that ended is not in flight.
    finish(same, "Offline sync");
    expect(inFlight(scope, { query: "queue offline edits and flush them when back online" }).map((x) => x.executionId)).not.toContain(same);
    void b;
  });

  it("reaches recall first in the search result", async () => {
    const { a } = tree();
    const id = start("ac-android", "Voice messages: record, upload and play inline in the chat", a);
    const result = await new LocalMemoryAccess("ac-desktop").search({ query: "voice messages recording upload chat" });
    expect(result.inFlight?.map((x) => x.executionId)).toContain(id);
    const text = describeSearch(result);
    expect(text.indexOf("Running right now elsewhere in the tree")).toBeLessThan(text.indexOf("Nothing in memory") === -1 ? Infinity : text.indexOf("Nothing in memory"));
    finish(id, "voice");
  });
});
