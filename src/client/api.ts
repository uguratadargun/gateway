import { hostname } from "node:os";

import { GATE_VERSION, isOlderThan, VERSION_HEADERS } from "@/lib/protocol";
import type { FeatureDetail, MemorySearchRequest, MemorySearchResult } from "@/memory/cards";

import type { ClientConfig } from "./config";

/**
 * The client half of `/api/v1`.
 *
 * Every call carries the person's API key and the machine's name — the key
 * says who, the host says where, and the dashboard needs both to make sense of
 * a run it did not itself execute. Failures are reported in the server's own
 * words: a revoked key, a workflow that needs an input, a team that is gone are
 * all things the person can act on, and inventing a friendlier sentence for
 * them only hides which one happened.
 */

/** This build's version. The server's own copy of the same constant is what it
 *  is compared against — see src/lib/protocol.ts. */
export const CLI_VERSION = GATE_VERSION;

export class GateApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "GateApiError";
  }
}

export interface BundleWorkflow {
  id: string;
  name: string;
  description: string | null;
  inputs: string[];
  nodeCount: number;
  workspace: { repo?: string; baseRef?: string; branchPrefix?: string } | null;
  source: string;
  sha: string;
}

/** A skill travels as its whole directory: prose plus whatever it points at. */
export interface BundleSkill {
  id: string;
  name: string;
  files: Array<{ path: string; base64: string }>;
  sha: string;
}

export interface Bundle {
  team: string;
  hash: string;
  agents: Array<{ id: string; name: string; source: string; sha: string }>;
  skills?: BundleSkill[];
  workflows: BundleWorkflow[];
  errors: Array<{ id: string; message: string }>;
}

export class GateClient {
  private warnedAboutVersion = false;

  constructor(private readonly config: ClientConfig) {}

  get url(): string {
    return this.config.url;
  }

  get gatewayUrl(): string {
    return `${this.config.url}/api/gateway`;
  }

  get key(): string {
    return this.config.key;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.key}`,
      "x-gate-host": hostname(),
      [VERSION_HEADERS.client]: CLI_VERSION,
      ...extra,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    let res: Response;
    try {
      res = await fetch(`${this.config.url}${path}`, {
        ...init,
        headers: this.headers(init.body ? { "content-type": "application/json" } : {}),
      });
    } catch (e) {
      // fetch reports almost everything as the same three words; the cause is
      // where the actual reason lives — a refused connection, DNS, a bad
      // certificate, or a port the Fetch spec refuses to dial at all.
      const cause = (e as { cause?: { message?: string } }).cause?.message;
      throw new GateApiError(
        `cannot reach gate at ${this.config.url} (${(e as Error).message}${cause ? `: ${cause}` : ""})`,
        0,
        "UNREACHABLE",
      );
    }
    this.noteVersions(res);
    if (res.status === 304) return { status: 304, body: null as T };
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON — the status and the raw text are what is left to report.
    }
    // A gate answers in JSON. Anything else — a proxy, a sign-in page, a URL
    // that was never a gate — is that, and saying so beats both a wall of
    // markup and the crash that used to follow a 200 with no JSON in it.
    const notGate = () =>
      new GateApiError(
        `${this.config.url} answered with a web page, not gate's API (HTTP ${res.status}) — check the URL in your token`,
        res.status,
        "NOT_A_GATE",
      );

    if (!res.ok) {
      if (json?.error) throw new GateApiError(json.error, res.status, json.code);
      if (text.trimStart().startsWith("<")) throw notGate();
      throw new GateApiError(text.slice(0, 200) || `HTTP ${res.status}`, res.status);
    }
    if (text && json === null) throw notGate();
    return { status: res.status, body: json as T };
  }

  /**
   * Notices, once, that this CLI is behind the gate it is talking to.
   *
   * Only a warning: being a version behind is the normal state of a tool
   * installed on a dozen machines, and refusing on that alone would stop work
   * for nothing. The server refuses the versions it genuinely cannot serve.
   */
  private noteVersions(res: Response): void {
    if (this.warnedAboutVersion) return;
    const server = res.headers.get(VERSION_HEADERS.server);
    if (!server || !isOlderThan(CLI_VERSION, server)) return;
    this.warnedAboutVersion = true;
    console.error(
      `# gate ${CLI_VERSION} here, ${server} on ${this.config.url} — run \`/gate:update\` in Claude Code when convenient`,
    );
  }

  async me(): Promise<{
    user: { id: string; email: string; name: string | null } | null;
    team: { id: string; name: string };
    scopes: string[];
    gatewayUrl: string;
    server?: { version: string; minClientVersion: string };
  }> {
    return (await this.request<any>("/api/v1/me")).body;
  }

  /**
   * What the gate's account pool has left. The shape is `PoolQuota` from
   * src/lib/account-pool.ts, restated here because the CLI is bundled on its
   * own and an older gate may answer without the newer fields.
   */
  async usage(): Promise<{
    windows: Array<{ name: string; remaining: number; resetsAt: string | null; label?: string }>;
    accounts: { total: number; enabled: number; available: number; coolingDown: number; quotaBlocked: number };
    plan: string | null;
    updatedAt: number | null;
    floorPercent: number;
    reason: string | null;
  }> {
    return (await this.request<any>("/api/v1/usage")).body;
  }

  /** null when the bundle has not changed since `etag`. */
  async bundle(etag?: string | null): Promise<Bundle | null> {
    const res = await this.request<Bundle>("/api/v1/bundle", {
      headers: etag ? { "if-none-match": `"${etag}"` } : undefined,
    } as RequestInit);
    return res.status === 304 ? null : res.body;
  }

  async startRun(input: {
    workflowId: string;
    input: Record<string, unknown>;
    client: { host?: string; repo?: string; branch?: string; version?: string; session?: string };
    /** Who walks the graph — see the execution's `driver`. */
    driver?: "engine" | "session";
  }): Promise<string> {
    const res = await this.request<{ executionId: string }>("/api/v1/executions", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.body.executionId;
  }

  /**
   * Reopens a session-driven run that failed, so the node it failed on can be
   * tried again in the same worktree. The server drops the failed attempt from
   * the run's history; the walk then lands on that node as if it had never run.
   */
  async continueRun(executionId: string): Promise<{ continued: boolean; reason?: string; retried?: string[] }> {
    const res = await this.request<{ continued: boolean; reason?: string; retried?: string[] }>(
      `/api/v1/executions/${executionId}/continue`,
      { method: "POST", body: "{}" },
    );
    return res.body;
  }

  /** Reports progress; the reply says whether someone asked the run to stop. */
  async report(
    executionId: string,
    payload: { events: unknown[]; steps: unknown[]; workspace?: unknown },
  ): Promise<{ cancelRequested: boolean }> {
    const res = await this.request<{ cancelRequested: boolean }>(`/api/v1/executions/${executionId}/events`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return res.body;
  }

  async finish(executionId: string, payload: Record<string, unknown>): Promise<void> {
    await this.request(`/api/v1/executions/${executionId}/finish`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /** Asks a run to stop; it settles on its own next report. */
  async cancel(executionId: string): Promise<{ requested: boolean; reason?: string }> {
    const res = await this.request<{ requested: boolean; reason?: string }>(
      `/api/v1/executions/${executionId}/cancel`,
      { method: "POST", body: "{}" },
    );
    return res.body;
  }

  /** Writes one definition into the caller's team. Needs a key with `author`. */
  async saveDefinition(input: {
    kind: "agent" | "workflow";
    id: string;
    source: string;
    replace?: boolean;
  }): Promise<{ saved: boolean; replaced: boolean; name: string }> {
    const res = await this.request<{ saved: boolean; replaced: boolean; name: string }>("/api/v1/definitions", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.body;
  }

  /** One run and its steps — the memory a session-driven walk replays. */
  async execution(executionId: string): Promise<{ execution: any; steps: any[] }> {
    return (await this.request<{ execution: any; steps: any[] }>(`/api/v1/executions/${executionId}`)).body;
  }

  /** The team's memory: decisions and features matching words, paths, or a time. */
  async memorySearch(req: MemorySearchRequest): Promise<MemorySearchResult> {
    const params = new URLSearchParams();
    if (req.query) params.set("q", req.query);
    for (const p of req.paths ?? []) params.append("path", p);
    if (req.featureId) params.set("feature", req.featureId);
    if (req.asOf != null) params.set("asOf", String(req.asOf));
    if (req.since != null) params.set("since", String(req.since));
    if (req.limit != null) params.set("limit", String(req.limit));
    return (await this.request<MemorySearchResult>(`/api/v1/memory/search?${params}`)).body;
  }

  /** One feature in full; null when the team's catalogue has no such id. */
  async memoryFeature(id: string): Promise<FeatureDetail | null> {
    try {
      return (await this.request<FeatureDetail>(`/api/v1/memory/features/${encodeURIComponent(id)}`)).body;
    } catch (e) {
      if (e instanceof GateApiError && e.status === 404) return null;
      throw e;
    }
  }

  async listRuns(limit = 20): Promise<Array<Record<string, any>>> {
    const res = await this.request<{ executions: Array<Record<string, any>> }>(`/api/v1/executions?limit=${limit}`);
    return res.body.executions;
  }
}
