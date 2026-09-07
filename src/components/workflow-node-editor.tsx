"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ApiWorkflowNode } from "@/components/workflow-graph";
import { incomingLinks } from "@/workflows/routing";
import { cn } from "@/lib/utils";

/**
 * The inspector for one node. It edits the draft graph the page holds; nothing
 * here validates the result — the workflow file is re-parsed on save, so the
 * editor is free to pass through a half-finished node and show the real error.
 */

export interface WorkflowNodeEditorProps {
  node: ApiWorkflowNode;
  nodes: ApiWorkflowNode[];
  agents: string[];
  isEntry: boolean;
  onSelectNode?: (id: string) => void;
  onChange: (patch: Partial<ApiWorkflowNode>) => void;
  onRename: (nextId: string) => void;
  onSetEntry: () => void;
  onDelete: () => void;
}

const fieldClass = "h-8 text-xs";
const selectClass =
  "flex h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * The argv editor.
 *
 * Held as text rather than derived from the array on every render: trimming
 * each line as it was typed meant a controlled textarea swallowed the space
 * the moment you pressed it, so "npm test" could never be typed at all — the
 * caret snapped back after "npm". The array is still what leaves here; only
 * the trimming waits until the line is whole.
 */
function CommandLines({
  nodeId,
  value,
  onChange,
}: {
  nodeId: string;
  value: string[];
  onChange: (command: string[]) => void;
}) {
  const [text, setText] = useState(() => value.join("\n"));

  // Re-seed when the inspector moves to another node, but never while typing
  // in this one — that is the snap-back all over again.
  useEffect(() => {
    setText(value.join("\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  return (
    <Textarea
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
        );
      }}
      spellCheck={false}
      placeholder={"npm\ntest"}
      className="h-20 resize-none font-mono text-xs"
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

export function WorkflowNodeEditor({
  node,
  nodes,
  agents,
  isEntry,
  onSelectNode,
  onChange,
  onRename,
  onSetEntry,
  onDelete,
}: WorkflowNodeEditorProps) {
  // The id is committed on blur: half-typed ids would rename every reference
  // in the graph on each keystroke.
  const [idDraft, setIdDraft] = useState(node.id);
  useEffect(() => setIdDraft(node.id), [node.id]);

  const others = nodes.filter((n) => n.id !== node.id);
  const edges = node.edges ?? [];
  const incoming = incomingLinks(nodes, node.id);

  function setEdge(index: number, patch: Partial<{ to: string; when: string; label: string }>) {
    onChange({ edges: edges.map((e, i) => (i === index ? { ...e, ...patch } : e)) });
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="text-[10px] uppercase">
          {node.type}
        </Badge>
        <div className="flex items-center gap-1">
          {!isEntry && node.type !== "terminal" && (
            <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={onSetEntry}>
              Set as entry
            </Button>
          )}
          {isEntry && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">entry</span>}
          <Button variant="ghost" size="icon" className="size-7" onClick={onDelete} aria-label="Delete node">
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <Field label="id">
        <Input
          value={idDraft}
          onChange={(e) => setIdDraft(e.target.value)}
          onBlur={() => onRename(idDraft)}
          onKeyDown={(e) => e.key === "Enter" && onRename(idDraft)}
          spellCheck={false}
          className={cn(fieldClass, "font-mono")}
        />
      </Field>

      <Field label="label">
        <Input
          value={node.label ?? ""}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder={node.id}
          className={fieldClass}
        />
      </Field>

      <Field label={isEntry ? "arrives from (entry node)" : "arrives from"}>
        {incoming.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {isEntry ? "Nothing — the run starts here." : "Nothing routes here yet; this node would be unreachable."}
          </p>
        ) : (
          <ul className="space-y-1">
            {incoming.map((l, i) => (
              <li key={i} className="text-[11px]">
                <button
                  className="font-mono underline-offset-2 hover:underline"
                  onClick={() => onSelectNode?.(l.from)}
                  type="button"
                >
                  {l.from}
                </button>
                <span className="text-muted-foreground">
                  {l.kind === "branch"
                    ? " — as a parallel branch"
                    : l.kind === "join"
                      ? " — once its branches finish"
                      : l.label
                        ? ` — ${l.label}`
                        : l.when
                          ? ` — when ${l.when}`
                          : " — otherwise"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Field>

      {node.type === "agent" && (
        <Field label="agent">
          <select
            value={node.agent ?? ""}
            onChange={(e) => onChange({ agent: e.target.value })}
            className={cn(selectClass, "font-mono")}
          >
            <option value="">— pick an agent —</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
            {node.agent && !agents.includes(node.agent) && <option value={node.agent}>{node.agent} (missing)</option>}
          </select>
        </Field>
      )}

      {node.type === "command" && (
        <>
          <Field label="command — one argument per line">
            <CommandLines nodeId={node.id} value={node.command ?? []} onChange={(command) => onChange({ command })} />
            <p className="text-[10px] leading-snug text-muted-foreground">
              Run without a shell, so no pipes, <code>&amp;&amp;</code> or globbing — and{" "}
              <code className="text-foreground/80">npm test</code> is two lines, not one. An argument may itself contain
              spaces: put the whole <code className="text-foreground/80">--exclude &#123;a,b&#125;</code> value on its own line.
            </p>
          </Field>
          <Field label="cwd (optional, inside the workspace)">
            <Input
              value={node.cwd ?? ""}
              onChange={(e) => onChange({ cwd: e.target.value })}
              spellCheck={false}
              className={cn(fieldClass, "font-mono")}
            />
          </Field>
        </>
      )}

      {node.type === "terminal" && (
        <Field label="status">
          <select
            value={node.status ?? "completed"}
            onChange={(e) => onChange({ status: e.target.value })}
            className={selectClass}
          >
            <option value="completed">completed</option>
            <option value="failed">failed</option>
          </select>
        </Field>
      )}

      {node.type === "parallel" && (
        <>
          <Field label="branches (run together)">
            <div className="space-y-1">
              {(node.branches ?? []).map((b, i) => (
                <div key={`${b}-${i}`} className="flex items-center gap-1">
                  <select
                    value={b}
                    onChange={(e) =>
                      onChange({ branches: (node.branches ?? []).map((x, j) => (j === i ? e.target.value : x)) })
                    }
                    className={cn(selectClass, "font-mono")}
                  >
                    {others.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.id}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label={`Remove branch ${b}`}
                    onClick={() => onChange({ branches: (node.branches ?? []).filter((_, j) => j !== i) })}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-full text-[11px]"
                disabled={!others.length}
                onClick={() =>
                  onChange({ branches: [...(node.branches ?? []), others.find((n) => !(node.branches ?? []).includes(n.id))?.id ?? others[0].id] })
                }
              >
                <Plus className="size-3" /> Branch
              </Button>
              <p className="text-[10px] text-muted-foreground">
                Or drag from this node&rsquo;s right handle to a node on the canvas.
              </p>
            </div>
          </Field>
          <Field label="join (where the branches meet)">
            <select
              value={node.join ?? ""}
              onChange={(e) => onChange({ join: e.target.value })}
              className={cn(selectClass, "font-mono")}
            >
              <option value="">— pick a node —</option>
              {others.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.id}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}

      {node.type !== "terminal" && node.type !== "parallel" && (
        <Field label="edges">
          <div className="space-y-2">
            {edges.map((e, i) => (
              <div key={i} className="space-y-1 rounded-md border p-2">
                <div className="flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">→</span>
                  <select
                    value={e.to}
                    onChange={(ev) => setEdge(i, { to: ev.target.value })}
                    className={cn(selectClass, "font-mono")}
                  >
                    {nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.id}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label={`Remove edge to ${e.to}`}
                    onClick={() => onChange({ edges: edges.filter((_, j) => j !== i) })}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <Input
                  value={e.when ?? ""}
                  onChange={(ev) => setEdge(i, { when: ev.target.value })}
                  placeholder='when — e.g. outputs.tester.passed == true'
                  spellCheck={false}
                  className={cn(fieldClass, "font-mono")}
                />
                <Input
                  value={e.label ?? ""}
                  onChange={(ev) => setEdge(i, { label: ev.target.value })}
                  placeholder="label (shown on the canvas)"
                  className={fieldClass}
                />
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full text-[11px]"
              disabled={!others.length}
              onClick={() => onChange({ edges: [...edges, { to: others[0].id }] })}
            >
              <Plus className="size-3" /> Edge
            </Button>
            <p className="text-[10px] text-muted-foreground">
              An edge without a condition is the fallback; the engine takes the first edge whose condition holds.
            </p>
          </div>
        </Field>
      )}
    </div>
  );
}
