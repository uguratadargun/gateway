"use client";

import { useRef, useState } from "react";
import { Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Msg {
  role: "user" | "assistant";
  content: string;
  model?: string;
  tier?: string;
}

export default function Playground() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("auto");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const history = [...messages, { role: "user" as const, content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setBusy(true);

    try {
      const res = await fetch("/api/gateway/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          stream: true,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      const routedModel = res.headers.get("x-gate-model") ?? undefined;
      const routedTier = res.headers.get("x-gate-tier") ?? undefined;

      if (!res.body) {
        setMessages((m) => updateLast(m, "(no response body)", routedModel, routedTier));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buffer = "";
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              acc += evt.delta.text;
              setMessages((m) => updateLast(m, acc, routedModel, routedTier));
            } else if (evt.type === "error") {
              acc += `\n[error: ${evt.error?.message ?? "unknown"}]`;
              setMessages((m) => updateLast(m, acc, routedModel, routedTier));
            }
          } catch {
            // skip
          }
        }
      }
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    } catch (e) {
      setMessages((m) => updateLast(m, `(request failed: ${e instanceof Error ? e.message : e})`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-semibold">Playground</h1>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto rounded-lg border bg-muted/20 p-4">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Send a message — it routes through the gateway. The badge shows which model answered.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                m.role === "user" ? "bg-primary text-primary-foreground" : "border bg-background"
              }`}
            >
              {m.content || (busy ? "…" : "")}
            </div>
            {m.role === "assistant" && m.tier && (
              <div className="mt-1">
                <Badge variant="secondary">{m.tier}</Badge>{" "}
                <span className="text-[11px] text-muted-foreground">{m.model}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-end gap-2">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="h-10 rounded-md border border-input bg-transparent px-2 text-sm"
        >
          <option value="auto">auto</option>
          <option value="haiku">haiku</option>
          <option value="sonnet">sonnet</option>
          <option value="opus">opus</option>
          <option value="fable">fable</option>
        </select>
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message… (Enter to send, Shift+Enter for newline)"
          className="min-h-[44px] flex-1"
        />
        <Button onClick={send} disabled={busy || !input.trim()} size="icon" className="h-10 w-10">
          <Send />
        </Button>
      </div>
    </main>
  );
}

function updateLast(messages: Msg[], content: string, model?: string, tier?: string): Msg[] {
  const copy = [...messages];
  const last = copy[copy.length - 1];
  if (last && last.role === "assistant") copy[copy.length - 1] = { ...last, content, model, tier };
  return copy;
}
