import { describe, expect, it } from "vitest";

import { createTeam, getTeam } from "@/lib/teams";
import { memoryScopeFor, searchFeatures, upsertFeature } from "@/memory/store";

/**
 * Does the catalogue find a feature when it is asked for in other words?
 *
 * A labelled set: each feature as a recorder would file it (a name, the
 * aliases it collected, a one-line summary), and the way a person on another
 * team might ask for it. The score is how often the right feature is the
 * first hit, and how often it is in the first three. Full-text search alone
 * is expected to miss the pure synonyms; the floor asserted here is what it
 * does today, so that a change to the query building or a semantic layer
 * later can be measured against it rather than felt.
 */

const CATALOGUE: Array<{ name: string; aliases: string[]; summary: string; asks: string[] }> = [
  { name: "Offline sync", aliases: ["background sync"], summary: "Keeps local edits and pushes them when the network is back.", asks: ["make edits survive losing the connection", "offline mode for notes", "sync queue when back online"] },
  { name: "Login with SSO", aliases: ["single sign-on", "OIDC login"], summary: "Sign in through the company identity provider.", asks: ["let people log in with their corporate account", "add sso", "authenticate via the identity provider"] },
  { name: "Push notifications", aliases: ["alerts"], summary: "Server-sent notifications delivered to the device.", asks: ["notify users when a message arrives", "push alerts for new events", "device notifications"] },
  { name: "Dark mode", aliases: ["dark theme", "night mode"], summary: "A dark colour scheme following the system setting.", asks: ["add a night theme", "support the system dark appearance", "dark colour scheme toggle"] },
  { name: "File upload", aliases: ["attachments"], summary: "Attach files to a message, with resumable upload in chunks.", asks: ["let users attach documents to messages", "resumable chunked uploads", "send a file in chat"] },
  { name: "Search", aliases: ["full-text search", "find in messages"], summary: "Search across messages and files with filters.", asks: ["find old messages by keyword", "search the chat history", "filter search results by date"] },
  { name: "Message reactions", aliases: ["emoji reactions"], summary: "React to a message with an emoji; counts shown inline.", asks: ["thumbs up on a message", "emoji reactions on messages", "react to chat messages"] },
  { name: "Read receipts", aliases: ["seen status", "delivery status"], summary: "Show whether a message was delivered and read.", asks: ["show when a message has been seen", "delivered and read ticks", "read status indicator"] },
  { name: "Voice messages", aliases: ["audio messages"], summary: "Record and send short audio clips with a waveform.", asks: ["send a recorded voice note", "audio clip messages", "record and send audio"] },
  { name: "Crash reporting", aliases: ["error reporting"], summary: "Uploads crash reports with symbolicated stack traces.", asks: ["report app crashes to the server", "collect stack traces from crashes", "error reporting pipeline"] },
  { name: "Deep links", aliases: ["universal links", "app links"], summary: "Open a message or room from a URL.", asks: ["open the app to a specific room from a link", "universal links support", "handle links into the app"] },
  { name: "Rate limiting", aliases: ["throttling"], summary: "Limit requests per client per minute at the gateway.", asks: ["throttle clients that send too many requests", "requests per minute cap", "limit api calls per user"] },
  { name: "Export to PDF", aliases: ["print conversation"], summary: "Export a conversation as a PDF.", asks: ["save a chat as pdf", "print a conversation", "export messages to a document"] },
  { name: "Two-factor authentication", aliases: ["2FA", "MFA", "one-time codes"], summary: "A second factor at login: TOTP or SMS codes.", asks: ["add 2fa", "require a one-time code at login", "multi-factor auth"] },
  { name: "Message editing", aliases: ["edit sent messages"], summary: "Edit a sent message within a window; history kept.", asks: ["let users fix typos in sent messages", "edit a message after sending", "message edit history"] },
];

const ASK_COUNT = CATALOGUE.reduce((n, f) => n + f.asks.length, 0);

describe("finding a feature in other words", () => {
  it("finds the right catalogue entry from a paraphrase most of the time, and says how often", () => {
    if (!getTeam("para-org")) createTeam("Paraphrase org", "para-org");
    const scope = memoryScopeFor("para-org");
    const ids = new Map<string, string>();
    for (const f of CATALOGUE) ids.set(f.name, upsertFeature({ orgId: "para-org", name: f.name, aliases: f.aliases, summary: f.summary }).id);

    let top1 = 0;
    let top3 = 0;
    const misses: string[] = [];
    for (const f of CATALOGUE) {
      for (const ask of f.asks) {
        const hits = searchFeatures(scope, ask, 3).map((h) => h.id);
        if (hits[0] === ids.get(f.name)) top1++;
        if (hits.includes(ids.get(f.name)!)) top3++;
        else misses.push(`"${ask}" → ${hits.join(", ") || "(nothing)"} (wanted ${ids.get(f.name)})`);
      }
    }
    console.log(
      `catalogue paraphrase set: ${ASK_COUNT} asks over ${CATALOGUE.length} features · top-1 ${top1}/${ASK_COUNT} (${Math.round((100 * top1) / ASK_COUNT)}%) · top-3 ${top3}/${ASK_COUNT} (${Math.round((100 * top3) / ASK_COUNT)}%)` +
        (misses.length ? `\nmissed:\n  ${misses.join("\n  ")}` : ""),
    );
    // Where full-text search stands today. Lower these only with a reason.
    expect(top1 / ASK_COUNT).toBeGreaterThanOrEqual(0.6);
    expect(top3 / ASK_COUNT).toBeGreaterThanOrEqual(0.7);
  });
});
