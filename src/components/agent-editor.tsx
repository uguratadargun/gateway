"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { minutesOf, num, type AgentEditorOptions, type AgentForm, type OutputField } from "@/agents/form";

/**
 * The form half of the agent editor.
 *
 * Everything above the prompt used to be YAML you typed into a textarea, which
 * meant the fields that decide what an agent costs and how it is run —
 * `executor`, `effort`, `maxTokens`, `timeoutMs` — were invisible unless you
 * already knew they existed. They are controls now, with the vocabularies
 * served by the API rather than guessed at here, so a wrong value is not
 * typeable rather than being caught on save.
 *
 * The prompt body stays a textarea: it is prose, and prose is what a textarea
 * is for.
 */

const selectClass =
  "flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const fieldClass = "h-8 text-xs";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-3 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </Card>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
      {hint && <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function AgentEditor({
  form,
  options,
  onChange,
}: {
  form: AgentForm;
  options: AgentEditorOptions;
  onChange: (patch: Partial<AgentForm>) => void;
}) {
  const claudeCode = form.executor === "claude-code";
  const timeoutNum = num(form.timeoutMs);

  return (
    <div className="space-y-4">
      <Section title="Definition">
        <Field label="name">
          <Input value={form.name} onChange={(e) => onChange({ name: e.target.value })} className={fieldClass} />
        </Field>
        <Field label="description" hint="One line, shown in the agents list.">
          <Input
            value={form.description}
            onChange={(e) => onChange({ description: e.target.value })}
            className={fieldClass}
            placeholder="What this agent is for."
          />
        </Field>
      </Section>

      <Section title="Model">
        <Field
          label="model"
          hint={
            options.modelSource === "live"
              ? "A tier is resolved per run by the router; a concrete id pins it."
              : "Model list is the built-in fallback — the account could not be queried."
          }
        >
          <select
            value={form.model}
            onChange={(e) => onChange({ model: e.target.value })}
            className={selectClass}
          >
            <optgroup label="tier">
              {options.modelTiers.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </optgroup>
            <optgroup label="exact model">
              {options.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </optgroup>
            {/* A model the account no longer lists must still be selectable, or
                opening the file would silently rewrite it to something else. */}
            {form.model && ![...options.modelTiers, ...options.models].includes(form.model) && (
              <option value={form.model}>{form.model} (not in the current list)</option>
            )}
          </select>
        </Field>

        <Field label="effort" hint="Unset uses the API default, which is high — the expensive one.">
          <select value={form.effort} onChange={(e) => onChange({ effort: e.target.value })} className={selectClass}>
            <option value="">unset</option>
            {options.efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="executor"
          hint={
            claudeCode
              ? "Claude Code holds the loop in the worktree: its own tools, and it compacts instead of re-sending the whole context each round. Needs a workspace."
              : "Gate holds the conversation and serves its own tools, appending every result to one message list."
          }
        >
          <select
            value={form.executor}
            onChange={(e) => onChange({ executor: e.target.value })}
            className={selectClass}
          >
            {options.executors.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </Field>

        <Field label="max tokens" hint="Per model call, thinking included. Blank = 8192.">
          <Input
            type="number"
            min={1024}
            max={200000}
            step={1024}
            value={form.maxTokens}
            onChange={(e) => onChange({ maxTokens: e.target.value })}
            className={fieldClass}
            placeholder="8192"
          />
        </Field>
      </Section>

      <Section title="Limits">
        <Field
          label="timeout (minutes)"
          hint={
            timeoutNum === 0
              ? "0 — no timeout at all. A wedged node hangs the run until someone stops it."
              : `Covers one whole visit, every tool round included. Blank = 60. Written as ${
                  timeoutNum === undefined ? "nothing" : `${timeoutNum} ms`
                }.`
          }
        >
          <Input
            type="number"
            min={0}
            step={5}
            value={minutesOf(form.timeoutMs)}
            onChange={(e) => {
              const m = e.target.value.trim();
              onChange({ timeoutMs: m === "" ? "" : String(Math.round(Number(m) * 60_000)) });
            }}
            className={fieldClass}
            placeholder="60"
          />
        </Field>
        <Field label="max tool rounds" hint="0 or blank = no cap. The timeout is the real backstop.">
          <Input
            type="number"
            min={0}
            value={form.maxToolIterations}
            onChange={(e) => onChange({ maxToolIterations: e.target.value })}
            className={fieldClass}
            placeholder="no cap"
          />
        </Field>
      </Section>

      <Section title="Inputs">
        <p className="text-[10px] leading-snug text-muted-foreground">
          What this agent may read: <span className="font-mono">nodeId.field</span> from an upstream node,{" "}
          <span className="font-mono">input.key</span> from the run, or <span className="font-mono">visits.nodeId</span>{" "}
          for the attempt it is on. A trailing <span className="font-mono">?</span> makes it optional — that is what
          lets a retry read what the first pass had not produced yet.
        </p>
        {form.inputs.length === 0 && <p className="text-xs text-muted-foreground">None declared.</p>}
        {form.inputs.map((value, i) => (
          <div key={i} className="flex items-center gap-1">
            <Input
              value={value}
              onChange={(e) => onChange({ inputs: form.inputs.map((v, j) => (j === i ? e.target.value : v)) })}
              className={`${fieldClass} font-mono`}
              placeholder="planner.plan"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={`Remove input ${i + 1}`}
              onClick={() => onChange({ inputs: form.inputs.filter((_, j) => j !== i) })}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => onChange({ inputs: [...form.inputs, ""] })}>
          <Plus /> Add input
        </Button>
      </Section>

      <Section title="Output">
        <Field label="type" hint="json is validated on every answer; a mismatch costs a correction round.">
          <select
            value={form.outputType}
            onChange={(e) => onChange({ outputType: e.target.value === "json" ? "json" : "text" })}
            className={selectClass}
          >
            <option value="text">text</option>
            <option value="json">json</option>
          </select>
        </Field>

        {form.outputType === "json" && (
          <>
            {form.outputFields.length === 0 && (
              <p className="text-xs text-muted-foreground">No fields yet — a json output with no fields accepts anything.</p>
            )}
            {form.outputFields.map((f, i) => {
              const set = (patch: Partial<OutputField>) =>
                onChange({ outputFields: form.outputFields.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                <div key={i} className="flex items-center gap-1">
                  <Input
                    value={f.field}
                    onChange={(e) => set({ field: e.target.value })}
                    className={`${fieldClass} font-mono`}
                    placeholder="summary"
                  />
                  <select value={f.type} onChange={(e) => set({ type: e.target.value })} className={`${selectClass} w-28`}>
                    {options.fieldTypes.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <label className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                    <input type="checkbox" checked={f.optional} onChange={(e) => set({ optional: e.target.checked })} />
                    opt
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label={`Remove field ${i + 1}`}
                    onClick={() => onChange({ outputFields: form.outputFields.filter((_, j) => j !== i) })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange({ outputFields: [...form.outputFields, { field: "", type: "string", optional: false }] })}
            >
              <Plus /> Add field
            </Button>
            <p className="text-[10px] leading-snug text-muted-foreground">
              A list of things is <span className="font-mono">object[]</span>, not{" "}
              <span className="font-mono">string[]</span>, unless one line each is genuinely what you want — a reviewer
              asked for findings returns objects, and declaring strings makes every run argue with it.
            </p>
          </>
        )}
      </Section>

      <Section title="Tools">
        {claudeCode ? (
          <p className="text-xs leading-snug text-muted-foreground">
            Claude Code brings its own tools, and this list is not passed to it. Nothing is written to the file while
            this executor is selected.
          </p>
        ) : (
          <>
            <p className="text-[10px] leading-snug text-muted-foreground">
              Only exist when the workflow declares a workspace; the same file runs without one, reasoning over what it
              is handed. An agent holding a write tool is one that is expected to change the worktree.
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {options.gateTools.map((t) => (
                <label key={t} className="flex items-center gap-1.5 font-mono text-[11px]">
                  <input
                    type="checkbox"
                    checked={form.tools.includes(t)}
                    onChange={(e) =>
                      onChange({
                        tools: e.target.checked ? [...form.tools, t] : form.tools.filter((x) => x !== t),
                      })
                    }
                  />
                  {t}
                </label>
              ))}
            </div>
            {/* A file written by hand can name a tool this gate does not have;
                it would otherwise vanish silently the first time you saved. */}
            {form.tools.filter((t) => !options.gateTools.includes(t)).length > 0 && (
              <p className="text-[10px] text-destructive">
                Unknown to this gate, and rejected on save:{" "}
                <span className="font-mono">{form.tools.filter((t) => !options.gateTools.includes(t)).join(", ")}</span>
              </p>
            )}
          </>
        )}
      </Section>
    </div>
  );
}

/** The prompt body — the one part of an agent file that really is prose. */
export function PromptEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      className="h-[70vh] resize-none font-mono text-xs leading-relaxed"
    />
  );
}
