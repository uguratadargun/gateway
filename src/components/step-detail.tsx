"use client";

import { useState } from "react";
import { Check, Copy, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { stepFailure } from "@/executions/failure";
import type { ExecutionStepRecord } from "@/executions/types";
import { formatDuration } from "@/lib/duration";
import { stripAnsi } from "@/lib/utils";

/**
 * One step, in full.
 *
 * The step list has to stay skimmable, so it truncates — which is fine until a
 * gate fails and the twenty lines that say why are the ones cut off. This shows
 * the whole thing: a command's real stdout and stderr, an agent's real input,
 * output and tool calls, untruncated and copyable.
 */

function asText(value: unknown): string {
  if (value == null) return "";
  return stripAnsi(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          // Clipboard needs a secure context; the text is still on screen.
        }
      }}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />}
      {done ? "copied" : "copy"}
    </button>
  );
}

function Block({ title, text, tone }: { title: string; text: string; tone?: "bad" }) {
  if (!text.trim()) return null;
  return (
    <section>
      <div className="flex items-center gap-2">
        <h3
          className={`text-[10px] uppercase tracking-wide ${tone === "bad" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {title}
        </h3>
        <span className="text-[10px] text-muted-foreground/60 tabular-nums">{text.length.toLocaleString()} chars</span>
        <CopyButton text={text} />
      </div>
      <pre className="mt-1 max-h-[45vh] overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
        {text}
      </pre>
    </section>
  );
}

/** A command node's output, which is the shape worth special-casing. */
function commandParts(output: unknown): { exitCode: number | null; stdout: string; stderr: string } | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (typeof o.ok !== "boolean") return null;
  return {
    exitCode: typeof o.exitCode === "number" ? o.exitCode : null,
    stdout: asText(o.stdout),
    stderr: asText(o.stderr),
  };
}

export function StepDetailDialog({ step, onClose }: { step: ExecutionStepRecord | null; onClose: () => void }) {
  const failure = step ? stepFailure(step.output, 12) : null;
  const command = step ? commandParts(step.output) : null;

  return (
    <Dialog
      open={Boolean(step)}
      onClose={onClose}
      title={
        step ? (
          <span className="flex items-center gap-2">
            <span className="font-mono">{step.nodeId}</span>
            {step.visit > 1 && <span className="text-xs text-muted-foreground">visit {step.visit}</span>}
            <Badge variant={failure || step.status === "failed" ? "destructive" : "success"} className="text-[10px]">
              {step.status === "failed" ? "failed" : failure ? (failure.headline ?? "refused") : "completed"}
            </Badge>
          </span>
        ) : (
          ""
        )
      }
      subtitle={
        step ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono">
            <span>step {step.stepIndex + 1}</span>
            <span>{formatDuration(step.finishedAt - step.startedAt)}</span>
            {command?.exitCode != null && <span>exit {command.exitCode}</span>}
            {step.usage && (
              <span>
                {step.usage.model} · {step.usage.inputTokens.toLocaleString()} in /{" "}
                {step.usage.outputTokens.toLocaleString()} out
                {step.usage.cacheReadTokens > 0 && ` · ${step.usage.cacheReadTokens.toLocaleString()} cached`}
              </span>
            )}
          </span>
        ) : undefined
      }
    >
      {step && (
        <div className="space-y-4">
          {step.error && (
            <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs">
              <span className="font-mono text-destructive">{step.error.code}</span>
              <span className="text-muted-foreground"> — {step.error.message}</span>
            </div>
          )}

          {failure && failure.lines.length > 0 && (
            <section>
              <h3 className="text-[10px] uppercase tracking-wide text-destructive">why it refused</h3>
              <ul className="mt-1 space-y-0.5 rounded border border-destructive/30 bg-destructive/5 p-2">
                {failure.lines.map((l, i) => (
                  <li key={i} className="whitespace-pre-wrap break-words font-mono text-[11px]">
                    {l}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {step.toolCalls && step.toolCalls.length > 0 && (
            <section>
              <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">
                tool calls ({step.toolCalls.length})
              </h3>
              <div className="mt-1 space-y-1">
                {step.toolCalls.map((c, i) => (
                  <details key={i} className="rounded border bg-muted/20 open:bg-muted/40">
                    <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[11px]">
                      <Wrench className={c.ok ? "size-3 shrink-0 text-muted-foreground" : "size-3 shrink-0 text-destructive"} />
                      <span className="shrink-0 font-mono">{c.tool}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                        {asText(c.input).replace(/\s+/g, " ")}
                      </span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">{formatDuration(c.durationMs)}</span>
                    </summary>
                    <div className="space-y-2 border-t px-2 py-2">
                      <Block title="input" text={asText(c.input)} />
                      <Block title="result" text={asText(c.result)} tone={c.ok ? undefined : "bad"} />
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}

          {/* A command's two streams are the point; anything else reads as one output. */}
          {command ? (
            <>
              <Block title="stderr" text={command.stderr} tone="bad" />
              <Block title="stdout" text={command.stdout} />
            </>
          ) : (
            <Block title="output" text={asText(step.output)} />
          )}

          <Block title="input" text={asText(step.input)} />
        </div>
      )}
    </Dialog>
  );
}
