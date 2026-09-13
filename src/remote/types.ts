/**
 * What `/api/v1/remote` says, in the words the cockpit already uses.
 *
 * A remote session is shown by the same cockpit panels as a session on the
 * person's own machine, so these are the cockpit's shapes (src/shared/types.ts
 * there) with the one difference a server has to name: the terminal is a
 * handle on this server, not a pty in the person's window.
 */

export type RemoteStatus = "working" | "idle" | "waiting" | "blocked" | "exited";

/** `~/.gate/sessions/<session>.json` as the child's own `gate` CLI wrote it. */
export interface RemoteRunPointer {
  executionId: string;
  state: "agent" | "wait" | "delegate" | "done" | "failed" | "stopped";
  nodeId: string | null;
  agent: string | null;
  asks: "question" | "approval" | null;
  at: number;
}

export interface RemoteRepo {
  id: string;
  name: string;
  source: string;
  status: "new" | "installing" | "ready" | "failed";
}

export interface RemoteInfo {
  /** The caller's key carries the `remote` scope. */
  allowed: boolean;
  /** This server can host terminals at all. */
  available: boolean;
  reason: string | null;
  repos: RemoteRepo[];
}

export interface RemoteSession {
  /** Claude Code's session id once a hook has named it; `remote:<handle>` before. */
  id: string;
  /** The live terminal; null while the session is asleep on disk. */
  handle: string | null;
  repo: string | null;
  /** A path on this server. */
  cwd: string;
  title: string | null;
  startedAt: number;
  lastActiveAt: number;
  presence: "live" | "asleep";
  status: RemoteStatus;
  run: RemoteRunPointer | null;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface PendingBase {
  id: string;
  sessionId: string;
  handle: string | null;
  repo: string | null;
  executionId: string | null;
  nodeId: string | null;
  cwd: string;
  askedAt: number;
}

export interface RemotePendingAsk extends PendingBase {
  kind: "question" | "approval";
  questions: Question[];
  context: string | null;
}

export interface RemotePendingPermission extends PendingBase {
  kind: "permission";
  toolName: string;
  toolInput: Record<string, unknown>;
  summary: string;
  suggestions: unknown[];
}

export type RemotePending = RemotePendingAsk | RemotePendingPermission;

export interface AskAnswer {
  answers: Record<string, string | string[]>;
  response?: string;
}

export type PermissionDecision = { behavior: "allow"; always?: boolean } | { behavior: "deny"; message: string };

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
}

/** One frame of `/api/v1/remote/stream`. */
export type RemoteFrame =
  | { type: "hello"; at: number; sessions: RemoteSession[]; pending: RemotePending[] }
  | { type: "screen"; handle: string; data: string }
  | { type: "sessions"; at: number; sessions: RemoteSession[] }
  | { type: "pending"; at: number; pending: RemotePending[] }
  | { type: "data"; handle: string; data: string }
  | { type: "exit"; handle: string; code: number };
