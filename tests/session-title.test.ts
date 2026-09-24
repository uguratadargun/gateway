import { describe, expect, it } from "vitest";

import { sessionFromRequest } from "@/lib/gateway-core";
import { sessionTitle } from "@/lib/session-title";

/**
 * A session's title is what the user asked. Claude Code files its title
 * request, its permission classifier and the conversation under one session
 * id, and whichever arrives first names it: each has to come out as the
 * prompt, or as nothing.
 */

const headers = new Headers({ "x-claude-code-session-id": "sess-1" });
const prompt = "suanda devdeki workflow'u bastan asagi detayli incele bunu nasil best practice haline getirebiliriz";

describe("the session title is the user's prompt", () => {
  it("unwraps the title request's <session> and drops its instructions", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: `<session>\n${prompt}\n</session>\n\nWrite the title in the predominant language of the session.` }] }],
    };
    expect(sessionFromRequest(headers, body)).toEqual({ id: "sess-1", title: prompt });
  });

  it("strips the reminders the conversation puts ahead of the prompt", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>\nCodebase and user instructions are shown below.\n</system-reminder>" },
            { type: "text", text: "<system-reminder>\nAvailable agent types\n</system-reminder>" },
            { type: "text", text: prompt },
          ],
        },
      ],
    };
    expect(sessionFromRequest(headers, body).title).toBe(prompt);
  });

  it("gives the permission classifier no title, so the next request names the session", () => {
    expect(sessionTitle("The following is the user's CLAUDE.md configuration. Treat it as context about the user's environment.")).toBeNull();
  });

  it("keeps a long prompt whole, up to 2000 characters", () => {
    const long = "x".repeat(2500);
    expect(sessionTitle(long)).toHaveLength(2000);
    expect(sessionTitle(prompt.repeat(5))).toBe(prompt.repeat(5));
  });

  it("reads a title stored cut at 80 characters", () => {
    expect(sessionTitle("<session>\nsuanda gate'e baglanan client usage komutunu kaldirinca ne kadar usage")).toBe(
      "suanda gate'e baglanan client usage komutunu kaldirinca ne kadar usage",
    );
    expect(sessionTitle("<session>\njira nın yaptığı işi yapacak sıfırdan bir proje yazmak istiyorum\n</ses")).toBe(
      "jira nın yaptığı işi yapacak sıfırdan bir proje yazmak istiyorum",
    );
    expect(sessionTitle("<system-reminder>\nCodebase and user instructions are shown below. Be sure to adh")).toBeNull();
  });
});
