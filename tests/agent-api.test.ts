import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET, PUT } from "@/app/api/agents/[id]/route";

/**
 * The editor's two API contracts, exercised through the real handlers: the
 * vocabularies the form renders from, and a save that arrives as a form rather
 * than as Markdown. Both matter because nothing else in the app assembles YAML
 * any more — if the frontmatter path here breaks, the editor silently writes a
 * different agent than the one on screen.
 */

const previousHome = process.env.GATE_HOME;

beforeAll(() => {
  process.env.GATE_HOME = mkdtempSync(join(tmpdir(), "gate-agent-api-"));
});
afterAll(() => {
  process.env.GATE_HOME = previousHome;
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("the agent detail API", () => {
  it("serves the vocabularies the form's controls are built from", async () => {
    // "planner" is one of the agents gate seeds on first access.
    const res = await GET(new Request("http://x/api/agents/planner"), params("planner"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.options.executors).toEqual(["gate", "claude-code"]);
    expect(body.options.efforts).toContain("high");
    expect(body.options.fieldTypes).toContain("object[]");
    expect(body.options.gateTools.length).toBeGreaterThan(0);
    expect(body.options.models.length).toBeGreaterThan(0);
    expect(body.options.modelTiers).toContain("sonnet");
  });

  it("saves a form the same way it saves Markdown, and hands back both", async () => {
    const res = await PUT(
      new Request("http://x/api/agents/planner", {
        method: "PUT",
        body: JSON.stringify({
          frontmatter: {
            name: "Planner",
            model: "opus",
            effort: "high",
            executor: "claude-code",
            inputs: ["input.task"],
            output: { type: "json", schema: { plan: "string", risks: "string[]?" } },
            timeoutMs: 1_800_000,
            maxTokens: 32_000,
          },
          prompt: "Plan {{input.task}}.",
        }),
      }),
      params("planner"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.agent.executor).toBe("claude-code");
    expect(body.agent.maxTokens).toBe(32_000);
    expect(body.agent.output).toEqual({ type: "json", schema: { plan: "string", risks: "string[]?" } });
    // The source comes back too, so the editor's Markdown view is not left a
    // save behind the file it is showing.
    expect(body.source).toContain("executor: claude-code");
    expect(body.source).toContain("Plan {{input.task}}.");
  });

  it("refuses an invalid form without writing it", async () => {
    const before = await (await GET(new Request("http://x"), params("planner"))).json();
    const res = await PUT(
      new Request("http://x", {
        method: "PUT",
        // A prompt that reads something it never declared: the same check a
        // hand-edited file gets, because both go through parseAgent.
        body: JSON.stringify({ frontmatter: { name: "Planner" }, prompt: "{{inputs.nobody.field}}" }),
      }),
      params("planner"),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/undeclared input/);
    const after = await (await GET(new Request("http://x"), params("planner"))).json();
    expect(after.source).toBe(before.source);
  });
});
