"use client";

import { useState } from "react";
import { Check, Copy, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { DiffView } from "@/components/diff-view";
import { Dialog } from "@/components/ui/dialog";
import { stepFailure } from "@/executions/failure";
import type { ExecutionStepRecord } from "@/executions/types";
import { formatDuration } from "@/lib/duration";
import { cn, stripAnsi } from "@/lib/utils";

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

/**
 * An agent's input and output, read as data rather than dumped as JSON.
 *
 * A reviewer returns `{verdict, findings: [{file, what, fix}, …]}` and takes a
 * whole `git diff` as input. Rendered as one pretty-printed blob that is a wall
 * of quotes and \n — the findings are unreadable and the diff is worse. Each
 * field gets the shape it actually is instead: a diff renders as a diff, a list
 * of findings as cards, prose as prose.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** One finding, or any small object: its fields as labelled rows. */
function ObjectCard({ value }: { value: Record<string, unknown> }) {
  return (
    <div className="rounded border bg-background p-2">
      {Object.entries(value).map(([k, v]) => {
        if (v == null || v === "") return null;
        return (
          <div key={k} className="flex gap-2 py-0.5 text-[11px]">
            <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{k}</span>
            <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", k === "file" && "font-mono")}>
              {typeof v === "string" ? stripAnsi(v) : JSON.stringify(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ValueBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null || value === "") return null;

  // A diff is the one input worth rendering as what it is.
  if (typeof value === "string" && value.startsWith("diff --git ")) {
    return (
      <section>
        <h3 className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</h3>
        <DiffView diff={value} />
      </section>
    );
  }
  if (typeof value === "string") return <Block title={label} text={stripAnsi(value)} />;

  if (Array.isArray(value)) {
    if (!value.length) return null;
    return (
      <section>
        <div className="flex items-center gap-2">
          <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</h3>
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">{value.length}</span>
          <CopyButton text={JSON.stringify(value, null, 2)} />
        </div>
        <ol className="mt-1 space-y-1">
          {value.map((v, i) => (
            <li key={i} className="flex gap-2">
              <span className="pt-2 text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                {isPlainObject(v) ? (
                  <ObjectCard value={v} />
                ) : (
                  <div className="rounded border bg-background p-2 text-[11px] whitespace-pre-wrap break-words">
                    {typeof v === "string" ? stripAnsi(v) : JSON.stringify(v)}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
    );
  }

  // One level down is where an agent's declared inputs live: planner.plan,
  // diff.stdout, implementer.summary.
  if (isPlainObject(value)) {
    return (
      <>
        {Object.entries(value).map(([k, v]) => (
          <ValueBlock key={k} label={`${label}.${k}`} value={v} />
        ))}
      </>
    );
  }
  return <Block title={label} text={String(value)} />;
}

/** The whole of a step's input or output, field by field. */
function Structured({ label, value }: { label: string; value: unknown }) {
  if (!isPlainObject(value)) return <Block title={label} text={asText(value)} />;
  const { verdict, ...rest } = value;
  return (
    <section className="space-y-3">
      {typeof verdict === "string" && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">verdict</span>
          <Badge variant={verdict === "approved" ? "success" : "destructive"} className="text-[10px]">
            {verdict}
          </Badge>
        </div>
      )}
      {Object.entries(rest).map(([k, v]) => (
        <ValueBlock key={k} label={k} value={v} />
      ))}
      <details className="text-[10px] text-muted-foreground">
        <summary className="cursor-pointer">raw {label}</summary>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 font-mono">
          {asText(value)}
        </pre>
      </details>
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

          {/* A command's two streams are the point; an agent's output is data. */}
          {command ? (
            <>
              <Block title="stderr" text={command.stderr} tone="bad" />
              <Block title="stdout" text={command.stdout} />
              <Block title="input" text={asText(step.input)} />
            </>
          ) : (
            <>
              <Structured label="output" value={step.output} />
              <Structured label="input" value={step.input} />
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
