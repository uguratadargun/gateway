/**
 * What makes two checkouts the same repository.
 *
 * A path is not an identity. `/Users/ugur/work/api` on one laptop and
 * `/home/ci/build/api` on a runner are the same repository; `~/desktop/api`
 * and `~/server/api` are not, and both slug to "api". Until now gate only had
 * those paths and that slug, which is why the same relative file path could
 * silently join two teams' decisions about two different codebases.
 *
 * The identity used here is the git remote, normalised to `host/owner/name`:
 * the one name every clone of a repository agrees on, and the only one a
 * second machine can be asked about. Transport, credentials, port, a trailing
 * `.git` and letter case are all ways of writing the same remote, so they are
 * normalised away; anything else is left alone rather than tidied into a
 * neighbour's identity.
 *
 * Nothing here guesses. A source that cannot be parsed into a host and a path
 * returns null, and null means unknown — never a fallback, never the slug. A
 * wrong identity merges two codebases' memory, which is worse than no identity
 * at all, and worse the longer it goes unnoticed.
 */

/** A git remote written any of the ways git accepts it. */
export interface ParsedRemote {
  /** Lowercased host, without a port. */
  host: string;
  /** Everything between host and the repository name, lowercased, no leading or trailing slash. */
  owner: string;
  /** The repository name, lowercased, without a trailing `.git`. */
  name: string;
}

/** `host/owner/name`, or null when the remote does not say. */
export function canonicalRepoId(remote: string): string | null {
  const parsed = parseRemote(remote);
  return parsed ? `${parsed.host}/${parsed.owner}/${parsed.name}` : null;
}

/**
 * Splits a remote into host, owner and name.
 *
 * The three shapes git takes on the command line:
 *
 *   scheme://[user@]host[:port]/owner/name[.git]   https, ssh, git, git+ssh
 *   [user@]host:owner/name[.git]                   scp-like, no scheme
 *   /an/absolute/path                              a local clone — not an identity
 *
 * A local path is deliberately not parsed. It names a directory on one
 * machine, and the whole point of this identity is that a second machine can
 * use it.
 */
export function parseRemote(remote: string): ParsedRemote | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;

  let host: string;
  let path: string;

  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(trimmed);
  if (scheme) {
    // file:// is a path wearing a scheme, and so is the absence of a host.
    if (/^file$/i.test(scheme[1])) return null;
    const rest = scheme[2];
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    host = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else {
    // scp-like: exactly one colon, and what follows is a path, not a port.
    // `host:22/owner/name` is ambiguous by design in git; it reads the digits
    // as a path there too, and so do we.
    const scp = /^([^/]+?):(.+)$/.exec(trimmed);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
    // A Windows drive letter or an absolute path is not a remote.
    if (/^[a-z]$/i.test(host) || trimmed.startsWith("/")) return null;
  }

  // user@host[:port] — the credential and the port are ways of reaching the
  // host, not part of which repository this is.
  host = host.replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
  // A host with no dot is a local alias: `localhost`, a LAN machine, or —
  // most often — an ssh_config entry like `github-work`. It resolves to
  // whatever that one machine's config says, which means two laptops can
  // point the same alias at two different servers. That is the one failure
  // this identity must not have: two repositories answering to one name
  // merges their memory, and nothing downstream would report it. An alias
  // that cannot be resolved from anywhere else is not an identity.
  if (!host || !host.includes(".")) return null;

  const segments = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return null;

  const name = segments[segments.length - 1].replace(/\.git$/i, "").toLowerCase();
  const owner = segments.slice(0, -1).join("/").toLowerCase();
  if (!name || !owner) return null;

  return { host, owner, name };
}

/**
 * Whether two remotes name the same repository.
 *
 * Used where a record already carries an identity and a fresh checkout offers
 * another: they must agree before anything is written under the old one.
 */
export function sameRepo(a: string, b: string): boolean {
  const left = canonicalRepoId(a);
  return left !== null && left === canonicalRepoId(b);
}
