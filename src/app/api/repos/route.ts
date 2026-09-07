import { NextResponse } from "next/server";
import { z } from "zod";

import { detectRepoCommands } from "@/repos/detect";
import { connectRepo, isPathLike, runRepoSetup, slugFor } from "@/repos/setup";
import { createRepo, getRepo, listRepos } from "@/repos/store";
import { WorkflowError } from "@/runtime/errors";

export const runtime = "nodejs";

const argv = z.array(z.array(z.string().min(1)).min(1)).max(20);

const connectSchema = z
  .object({
    /** A local path or a git URL; which one it is, is worked out from its shape. */
    source: z.string().min(1).max(500),
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes")
      .optional(),
    name: z.string().min(1).max(80).optional(),
    baseRef: z.string().max(200).optional(),
    setup: argv.optional(),
    prepare: argv.optional(),
    /** Run the setup commands straight away; off when the caller wants to edit first. */
    install: z.boolean().default(true),
  })
  .strict();

export async function GET() {
  return NextResponse.json({ repos: listRepos() });
}

/**
 * Connect a repository: resolve or clone it, work out what it needs, store it,
 * and (unless asked not to) install it. The install is awaited rather than
 * backgrounded — a repo that says "ready" without having run its install is
 * worse than one that took a minute to answer.
 */
export async function POST(req: Request) {
  const parsed = connectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid repository", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const id = body.id ?? slugFor(body.source);
  if (getRepo(id)) return NextResponse.json({ error: `a repository "${id}" is already connected` }, { status: 409 });

  try {
    const { root, cloned, commands } = connectRepo(body.source, id);
    const repo = createRepo({
      id,
      name: body.name?.trim() || id,
      source: body.source.trim(),
      root,
      cloned,
      baseRef: body.baseRef?.trim() || null,
      setup: body.setup ?? commands.setup,
      prepare: body.prepare ?? commands.prepare,
    });
    const after = body.install ? await runRepoSetup(id) : repo;
    return NextResponse.json({ repo: after, detected: commands }, { status: 201 });
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    throw e;
  }
}

/**
 * What gate would propose, before anything is stored.
 *
 * Local paths only, and deliberately: this is reached by a button labelled
 * "Inspect", and reading a repository that is already on disk is free. A URL
 * cannot be inspected without fetching it, and routing that through here once
 * cloned 239MB as the side effect of a look — with nothing recorded, so the
 * checkout was orphaned the moment it landed. Connecting does the clone, where
 * the cost is what the button says it is, and answers with the same detection.
 */
export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  const source = typeof body?.source === "string" ? body.source.trim() : "";
  if (!source) return NextResponse.json({ error: "give a path" }, { status: 400 });
  if (!isPathLike(source)) {
    return NextResponse.json(
      { needsClone: true, note: "Connect will clone it first, then say what it found." },
      { status: 200 },
    );
  }
  try {
    const { root, cloned } = connectRepo(source, slugFor(source));
    return NextResponse.json({ root, cloned, detected: detectRepoCommands(root) });
  } catch (e) {
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
