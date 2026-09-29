import { describe, expect, it } from "vitest";

import { shippingWarnings } from "@/client/preflight";
import { DEFAULT_WORKFLOWS } from "@/workflows/defaults";
import { parseWorkflow } from "@/workflows/loader";

/**
 * A run that will need `gh` at its end is told so at its start.
 *
 * Checked against the shipped `dev`, not a fixture: the node that opens the
 * pull request is a shell string, and a rewrite of it that stops matching
 * would silently turn this warning off for every team.
 */

const dev = parseWorkflow("dev", DEFAULT_WORKFLOWS.dev, { sourcePath: "dev.yaml", updatedAt: 0 });
const signedIn = () => true;
const signedOut = () => false;

describe("shippingWarnings", () => {
  it("warns when the remote is GitHub and gh is not signed in", () => {
    const warnings = shippingWarnings(dev, "git@github.com:acme/app.git", signedOut);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("gh auth login");
  });

  it("says nothing when gh is signed in", () => {
    expect(shippingWarnings(dev, "https://github.com/acme/app.git", signedIn)).toEqual([]);
  });

  it("says nothing for a GitLab remote, which falls back to push options", () => {
    expect(shippingWarnings(dev, "git@gitlab.example.com:acme/app.git", signedOut)).toEqual([]);
  });

  it("says nothing for a workflow that opens no pull request", () => {
    const quiet = parseWorkflow(
      "q",
      `name: Q
entry: test
nodes:
  - id: test
    type: command
    command: [npm, test]
    next: done
  - id: done
    type: terminal
    status: completed
`,
      { sourcePath: "q.yaml", updatedAt: 0 },
    );
    expect(shippingWarnings(quiet, "git@github.com:acme/app.git", signedOut)).toEqual([]);
  });

  it("says nothing when the pull request node is switched off", () => {
    const off = {
      ...dev,
      nodes: dev.nodes.map((n) => (n.type === "command" && n.command.join(" ").includes("gh pr create") ? { ...n, disabled: true } : n)),
    };
    expect(shippingWarnings(off, "git@github.com:acme/app.git", signedOut)).toEqual([]);
  });
});
