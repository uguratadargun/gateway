import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ToolError } from "./types";

/**
 * Path confinement. Every tool resolves user- and model-supplied paths through
 * here, so "../../.ssh/id_rsa" and a symlink pointing out of the workspace are
 * both refused rather than silently followed.
 */
export function resolveInWorkspace(root: string, input: unknown, label = "path"): string {
  if (typeof input !== "string" || !input.trim()) throw new ToolError(`${label} is required`);
  const candidate = isAbsolute(input) ? input : resolve(root, input);
  const full = resolve(candidate);
  assertInside(root, full, input);
  // A path that exists must also resolve inside the workspace after symlinks.
  const real = realPathIfExists(full);
  if (real) assertInside(realPathIfExists(root) ?? root, real, input);
  return full;
}

function assertInside(root: string, full: string, shown: string): void {
  const rel = relative(root, full);
  if (rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new ToolError(`"${shown}" is outside the workspace`);
  }
}

function realPathIfExists(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
