import { describe, it, expect } from "vitest";
import { DEFAULT_AGENTS } from "@/agents/defaults";
import { parseAgent } from "@/agents/loader";
import { DEFAULT_WORKFLOWS } from "@/workflows/defaults";
import { parseWorkflow } from "@/workflows/loader";
import { missingRunInputs, requiredRunInputs } from "@/workflows/inputs";

const agent = (id: string) => parseAgent(id, DEFAULT_AGENTS[id], { sourcePath: `${id}.md`, updatedAt: 0 });
const ask = () => parseWorkflow("ask", DEFAULT_WORKFLOWS.ask, { sourcePath: "ask.yaml", updatedAt: 0, agentExists: () => true });

describe("the shipped ask pipeline", () => {
  it("asks for exactly what `gate ask` sends", () => {
    const required = requiredRunInputs(ask(), agent);
    expect(required).toEqual(["ask", "commit", "memory", "question", "ref", "source"]);
    expect(
      missingRunInputs(required, { question: "q", source: "github.com/a/b", ref: "main", commit: "abc1234", ask: "a1", memory: "none" }),
    ).toEqual([]);
  });

  it("cannot write or run anything, and reads the source only through the gate", () => {
    const reviewer = agent("source-review");
    for (const forbidden of ["write_file", "edit_file", "run_command", "read_file", "list_files", "search_files"]) {
      expect(reviewer.tools).not.toContain(forbidden);
    }
    expect(reviewer.prompt).toContain("gate source tree {{input.ask}}");
  });
});
