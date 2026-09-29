/**
 * What a ref or a commit has to look like before gate hands it to git.
 *
 * A run's publication is reported by the client that pushed it, and an ask
 * names its branch in the asker's words. Both end up as arguments to
 * `git fetch` and `git ls-remote` on the server, where a value that starts
 * with `-` is read as an option — `--upload-pack=<command>` runs a command.
 * `--end-of-options` in front of them is the first guard; these are the
 * second, so a value that is not a ref or a commit is refused where it
 * arrives rather than trusted where it is used.
 */

/** A full object name: sha-1 or sha-256. An abbreviation cannot be fetched by. */
export function isFullCommit(value: string | null | undefined): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

/**
 * `refs/heads/<name>`, with a name git itself would accept as a branch —
 * `git check-ref-format`'s rules, which is what a push of a real branch
 * produces and all a publication ever is.
 */
export function isBranchRef(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !value.startsWith("refs/heads/")) return false;
  const name = value.slice("refs/heads/".length);
  if (!name || name === "@" || name.length > 250) return false;
  // Control characters, space and the characters git reserves for revisions.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.endsWith("/") || name.endsWith(".")) return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
