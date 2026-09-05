import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { WorkflowError } from "@/runtime/errors";
import type { WorkflowNode } from "@/workflows/types";

/**
 * Runs a command node. The argv comes from the workflow file (author-written)
 * and is passed to execFile as a fixed array — never a shell string, and never
 * assembled from model output, so an agent cannot inject a command.
 */

export interface CommandNodeResult {
  exitCode: number;
  ok: boolean;
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;

export interface CommandRunOptions {
  /** The run's workspace, when the workflow has one: commands run there. */
  defaultCwd?: string;
  /** Cancels the run: the child process is killed, not merely abandoned. */
  signal?: AbortSignal;
}

export type CommandRunner = (
  node: Extract<WorkflowNode, { type: "command" }>,
  options?: CommandRunOptions,
) => Promise<CommandNodeResult>;

/** A node's own cwd is relative to the workspace when there is one. */
function cwdFor(node: Extract<WorkflowNode, { type: "command" }>, options?: CommandRunOptions): string | undefined {
  if (!node.cwd) return options?.defaultCwd;
  if (isAbsolute(node.cwd)) return node.cwd;
  return options?.defaultCwd ? resolve(options.defaultCwd, node.cwd) : node.cwd;
}

export const runCommand: CommandRunner = (node, options) =>
  new Promise((resolvePromise, reject) => {
    const [file, ...args] = node.command;
    execFile(
      file,
      args,
      {
        cwd: cwdFor(node, options),
        timeout: node.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        signal: options?.signal,
      },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
        // A kill from the abort signal looks the same as a timeout kill; the
        // signal is what tells them apart.
        if (options?.signal?.aborted) {
          reject(new WorkflowError("RUN_CANCELLED", `node "${node.id}" was cancelled`, { nodeId: node.id }));
          return;
        }
        if (err?.killed) {
          reject(new WorkflowError("NODE_TIMEOUT", `node "${node.id}" command timed out`, { nodeId: node.id }));
          return;
        }
        // A non-zero exit is data, not a failure: workflows branch on it
        // (a failing test suite routes back to the implementation node).
        if (err && typeof err.code !== "number") {
          reject(new WorkflowError("COMMAND_EXECUTION_ERROR", `node "${node.id}": ${err.message}`, { nodeId: node.id }));
          return;
        }
        const exitCode = typeof err?.code === "number" ? err.code : 0;
        resolvePromise({ exitCode, ok: exitCode === 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
