import { describe, expect, it } from "vitest";

import { createExecution, finishExecution } from "@/executions/store";
import { createTeam, createUser, getTeam } from "@/lib/teams";
import { announceOverlap, inFlight, overlap, overlapsOf, taskTerms } from "@/memory/activity";
import { LocalMemoryAccess } from "@/memory/access";
import { describeSearch } from "@/memory/cards";
import { memoryScopeFor, replaceDecisions } from "@/memory/store";
import { createState } from "@/runtime/state";
import { createLinkCode, redeemLinkCode } from "@/telegram/store";

/**
 * What the tree is doing right now. A run is invisible to every other team
 * until it ends and is recorded; these hold down that a run going now is
 * found by the words of its task, by the rest of the tree only, and that the
 * two people on either side of the same work hear about it once.
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

describe("telling the two people", () => {
  it("finds another team's run already on the same work, and never the run's own team", () => {
    const { a, b } = tree();
    const first = start("ac-android", "Read receipts: show when each message was read by the recipient", a);
    const teammate = start("ac-desktop", "Read receipts: show when each message was read by the recipient");
    const second = start("ac-desktop", "Show read receipts so the sender sees when a message was read", b);
    const notices = overlapsOf(second);
    expect(notices.map((x) => x.other.id)).toContain(first);
    expect(notices.map((x) => x.other.id)).not.toContain(teammate);
    for (const id of [first, teammate, second]) finish(id, "x");
  });

  it("finds another team's work taught as unfinished", () => {
    tree();
    replaceDecisions(
      { executionId: "ac-wip", teamId: "ac-android", userId: null, featureId: null, repoId: null, baseCommit: null, headCommit: null, outcome: "in-progress", validFrom: 1 },
      [{ title: "Message reactions stored as a per-message emoji map", context: "", decision: "Reactions live on the message as an emoji map.", rationale: "", alternatives: "", how: "", consequences: "", touches: [] }],
    );
    const run = start("ac-desktop", "Add message reactions with an emoji picker on each message");
    expect(overlapsOf(run).some((x) => x.other.kind === "decision" && x.other.id.startsWith("ac-wip-1-"))).toBe(true);
    finish(run, "x");
  });

  it("messages both people once, where they linked gate", async () => {
    const { a, b } = tree();
    const chatA = redeemLinkCode(createLinkCode(a).code, { chatId: "ac-chat-a", username: null })!;
    const chatB = redeemLinkCode(createLinkCode(b).code, { chatId: "ac-chat-b", username: null })!;
    const sent: Array<{ chat: string; text: string }> = [];
    const g = globalThis as unknown as { __gateTelegram?: { bot: unknown; token: string | null } };
    const before = g.__gateTelegram;
    g.__gateTelegram = { token: "t", bot: { notify: async (chat: string, text: string) => void sent.push({ chat, text }) } };
    try {
      const first = start("ac-android", "Group calls: invite up to eight people into one voice call", a);
      const second = start("ac-desktop", "Group voice calls with up to eight people invited", b);
      const notices = await announceOverlap(second);
      expect(notices).toHaveLength(1);
      expect(sent.map((s) => s.chat).sort()).toEqual([chatA.chatId, chatB.chatId].sort());
      expect(sent[0].text).toContain("Same work, two teams");
      // Once per pair.
      expect(await announceOverlap(second)).toEqual([]);
      for (const id of [first, second]) finish(id, "x");
    } finally {
      g.__gateTelegram = before;
    }
  });
});
