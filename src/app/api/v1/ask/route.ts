import { NextResponse } from "next/server";

import { startExecution } from "@/executions/runner";
import { askSchema } from "@/lib/client-api-schemas";
import { requireClient, scopeForPrincipal } from "@/lib/tenancy";
import { fetchAskSource, memoryAt, resolveAskSource, type AskSource, type MemoryCoverage } from "@/orchestration/ask";
import { WorkflowError } from "@/runtime/errors";
import { workflowExists } from "@/workflows/registry";

export const runtime = "nodejs";

/** The workflow a question is answered by; shipped, and replaceable by a team. */
const ASK_WORKFLOW = "ask";

/**
 * One team's question about another team's code, answered from a fixed commit.
 *
 * The route's whole job is to turn "how does desktop do X" into a commit and a
 * run that reads it. What it will not do is answer from anything else: not
 * from the model's impression of the repository, not from a branch name, and
 * not from a decision that was recorded on work this commit has never seen.
 *
 * An unreachable source comes back 200 with a status, not as an HTTP error.
 * It is not a failure of the request — the request was fine, and the answer to
 * it is "somebody has to publish that branch first". Saying that in a 404 puts
 * it in the pile of things clients print as "request failed" and people read as
 * "gate is broken".
 */
export async function POST(req: Request) {
  const auth = requireClient(req);
  if (auth instanceof Response) return auth;

  const parsed = askSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid ask", issues: parsed.error.issues }, { status: 400 });
  }

  const resolved = resolveAskSource(parsed.data, auth.teamId);
  if (!resolved.ok) {
    return NextResponse.json(resolved.status === "not_found" ? { status: "not_found", reason: resolved.reason } : resolved, {
      status: 200,
    });
  }
  const source = resolved.source;

  const fetched = fetchAskSource(source);
  if (!fetched.ok) {
    return NextResponse.json({ status: "source_unavailable", reason: fetched.reason, source: wire(source) }, { status: 200 });
  }

  // The shipped `ask` pipeline is only written when a team's workflow
  // directory is first created, so a gate that predates this feature does not
  // have it. Said plainly, and before any work is done: the alternative is
  // "workflow not found" for a command the person has just been told about,
  // with nothing saying it is the server that is behind rather than the
  // question that is wrong.
  if (!workflowExists(ASK_WORKFLOW, scopeForPrincipal(auth))) {
    return NextResponse.json(
      {
        status: "source_unavailable",
        reason: `this gate has no "${ASK_WORKFLOW}" pipeline yet — restore the shipped workflows from the Workflows page, then ask again`,
        source: wire(source),
      },
      { status: 200 },
    );
  }

  // Memory is read here rather than by the run, because it is read at a
  // commit and only this side knows which one. What comes back is split: the
  // decisions whose work is in this commit's history, and the ones that are
  // about later or unmerged work. Both go to the reviewer, labelled — the
  // second kind is often the answer to "why does it look like that", and it
  // must never be quoted as if it described the code being read.
  let memory: MemoryCoverage = { covering: [], elsewhere: [], issues: [] };
  try {
    memory = await memoryAt(source, parsed.data.question, auth.teamId);
  } catch {
    // Memory being unavailable makes the answer thinner, not wrong. The
    // reviewer still reads the source, which is the part that cannot be
    // skipped.
  }

  // The source is read even when memory covers the question. A search that
  // ranks a decision highly has found words in common with the question, not
  // an answer to it, and the one thing this feature cannot afford is a
  // confident answer nobody can check against a file. So memory arrives as a
  // brief for the reviewer, and the reviewer answers from the code with the
  // decision ids beside it.
  try {
    const { executionId } = startExecution(
      ASK_WORKFLOW,
      {
        question: parsed.data.question,
        // The path, not the connected id: this run reads another team's
        // checkout and must not inherit its publication — there is nothing
        // here to publish, and a branch pushed into their remote for a
        // question would be a strange thing to find.
        repo: source.repo.root,
        baseRef: source.commit,
        commit: source.commit,
        memory: brief(memory),
      },
      scopeForPrincipal(auth),
    );
    return NextResponse.json({ status: "reviewing", executionId, source: wire(source) }, { status: 202 });
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** What the answer quotes: enough to ask the same question again and get the same source. */
function wire(source: AskSource) {
  return { repo: source.repo.id, repoId: source.repoId, ref: source.ref, commit: source.commit, via: source.via };
}

/**
 * Memory as the reviewer reads it.
 *
 * Always a sentence, never an empty one. The prompt names this input, and a
 * run is refused for an input given as "" exactly as for one not given at all
 * — but more than that, "memory has nothing near this" is worth the reviewer
 * knowing. It is the difference between a repository whose reasons were never
 * written down and one whose reasons say something else.
 */
function brief(memory: MemoryCoverage): string {
  const lines: string[] = [];
  if (memory.covering.length) {
    lines.push("**Decisions that hold at this commit** — their work is in its history:");
    for (const d of memory.covering) lines.push(`- ${d.id} (${d.team}): ${d.title} — ${d.decision}`);
  }
  if (memory.elsewhere.length) {
    lines.push(
      "",
      "**Decisions about this repository from elsewhere** — recorded on work this commit does not contain, so they describe something other than what you are reading. Cite one only to explain a direction, never as the state of this code:",
    );
    for (const d of memory.elsewhere) lines.push(`- ${d.id} (${d.team}): ${d.title} — ${d.decision}`);
  }
  if (memory.issues.length) {
    lines.push("", "**Objections standing against those decisions:**");
    for (const i of memory.issues) lines.push(`- ${i.id} (${i.from} → ${i.target}, ${i.status}): ${i.title} — ${i.why}`);
  }
  return lines.length
    ? `What this team's memory holds near the question:\n\n${lines.join("\n")}`
    : "This team's memory has nothing recorded near the question; the source is all there is to read.";
}
