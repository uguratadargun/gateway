import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * What this machine knows about the gate it connects to.
 *
 * One file, ~/.gate/client.json, holding the server URL and the person's API
 * key — and, separately, which workflow versions this person has agreed to let
 * run here. That second part is not a cache: a workflow can run commands on
 * this machine, so the approval is a decision, and it is recorded against the
 * exact source hash that was approved.
 */

export interface ClientConfig {
  url: string;
  key: string;
  /** Filled in from /api/v1/me at login, for messages that name who you are. */
  team?: string;
  user?: string;
  /** workflow id -> the definition hash this machine has approved. */
  trusted?: Record<string, string>;
  /**
   * Connected-repo id -> this machine's checkout of it.
   *
   * A workflow pinned to a repository names it by an id the server resolves to
   * a checkout it manages. That checkout is not on this machine; what is, is
   * the person's own clone, and only they can say where.
   */
  repos?: Record<string, string>;
}

export function gateHome(): string {
  return process.env.GATE_HOME || join(homedir(), ".gate");
}

export function configPath(): string {
  return join(gateHome(), "client.json");
}

export function readConfig(): ClientConfig | null {
  // The environment wins, so CI and one-off runs need no file on disk.
  const url = process.env.GATE_URL;
  const key = process.env.GATE_KEY;
  if (url && key) return { url: url.replace(/\/+$/, ""), key };

  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as ClientConfig;
    if (!raw?.url || !raw?.key) return null;
    return { ...raw, url: raw.url.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

export function writeConfig(config: ClientConfig): void {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // 0600: this file is a credential.
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** What the file holds, ignoring any environment override. */
function readConfigFile(): ClientConfig | null {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as ClientConfig;
  } catch {
    return null;
  }
}

/**
 * Records that this machine's owner approved a workflow at this exact version.
 *
 * Approvals are written to the file even when the connection came from
 * GATE_URL/GATE_KEY, so an approval given once holds — but the key from the
 * environment is never written down with it. A credential that was deliberately
 * kept out of a file does not get put into one by an unrelated action.
 */
export function trustWorkflow(id: string, sha: string): void {
  const onDisk = readConfigFile();
  const trusted = { ...(onDisk?.trusted ?? {}), [id]: sha };
  if (onDisk) {
    writeConfig({ ...onDisk, trusted });
    return;
  }
  writeConfig({ url: "", key: "", trusted });
}

export function isTrusted(id: string, sha: string): boolean {
  return readConfigFile()?.trusted?.[id] === sha;
}

/** Points a connected repository's id at this machine's clone of it. */
export function setRepoPath(id: string, path: string): void {
  const onDisk = readConfigFile();
  const repos = { ...(onDisk?.repos ?? {}), [id]: path };
  writeConfig(onDisk ? { ...onDisk, repos } : { url: "", key: "", repos });
}

export function repoPaths(): Record<string, string> {
  return readConfigFile()?.repos ?? {};
}
