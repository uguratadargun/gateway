import { describe, it, expect } from "vitest";
import { DEFAULT_AGENTS } from "@/agents/defaults";
import { parseAgent } from "@/agents/loader";
import { DEFAULT_WORKFLOWS } from "@/workflows/defaults";
import { parseWorkflow } from "@/workflows/loader";
import { missingRunInputs, requiredRunInputs } from "@/workflows/inputs";

const agent = (id: string) => parseAgent(id, DEFAULT_AGENTS[id], { sourcePath: `${id}.md`, updatedAt: 0 });
const ask = () => parseWorkflow("ask", DEFAULT_WORKFLOWS.ask, { sourcePath: "ask.yaml", updatedAt: 0, agentExists: () => true });

describe("the shipped ask pipeline", () => {
  it("asks for exactly what the route sends", () => {
    const required = requiredRunInputs(ask(), agent);
    expect(required).toEqual(["commit", "memory", "question", "repo"]);
    expect(
      missingRunInputs(required, { question: "q", repo: "/r", commit: "abc1234", memory: "none", baseRef: "abc1234" }),
    ).toEqual([]);
  });

  it("cannot write or run anything", () => {
    const tools = agent("source-review").tools;
    for (const forbidden of ["write_file", "edit_file", "run_command"]) expect(tools).not.toContain(forbidden);
    expect(tools).toContain("read_file");
  });
});
