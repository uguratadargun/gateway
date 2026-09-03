import { loadSettings } from "./settings";

/**
 * Lightweight, lossless-ish context compression applied before a request is
 * sent upstream. Trims oversized blocks and drops exact-duplicate adjacent
 * blocks to save tokens. Returns an estimate of characters removed.
 */

export interface CompressionStats {
  applied: boolean;
  charsBefore: number;
  charsAfter: number;
  removed: number;
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (block && typeof block === "object" && typeof (block as any).text === "string") {
    return (block as any).text;
  }
  return "";
}

export function compressBody(body: Record<string, unknown>): CompressionStats {
  const cfg = loadSettings().compression;
  const before = estimateChars(body);
  if (!cfg.enabled || !Array.isArray(body.messages)) {
    return { applied: false, charsBefore: before, charsAfter: before, removed: 0 };
  }

  const messages = body.messages as Array<Record<string, unknown>>;
  let lastSig = "";

  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      msg.content = truncate(content, cfg.maxBlockChars);
      continue;
    }
    if (!Array.isArray(content)) continue;

    const kept: unknown[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      // Truncate long text / tool_result blocks.
      if (typeof b.text === "string" && b.text.length > cfg.maxBlockChars) {
        b.text = truncate(b.text, cfg.maxBlockChars);
      }
      if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > cfg.maxBlockChars) {
        b.content = truncate(b.content, cfg.maxBlockChars);
      }
      // Drop exact-duplicate adjacent text blocks.
      if (cfg.dedupe) {
        const sig = `${b.type ?? "text"}:${blockText(b)}`;
        if (sig && sig === lastSig && blockText(b).length > 40) continue;
        lastSig = sig;
      }
      kept.push(block);
    }
    msg.content = kept;
  }

  const after = estimateChars(body);
  return { applied: true, charsBefore: before, charsAfter: after, removed: Math.max(0, before - after) };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[${s.length - max} chars trimmed by gate]…\n${s.slice(-tail)}`;
}

function estimateChars(body: Record<string, unknown>): number {
  let n = 0;
  if (typeof body.system === "string") n += body.system.length;
  else if (Array.isArray(body.system)) n += JSON.stringify(body.system).length;
  if (Array.isArray(body.messages)) n += JSON.stringify(body.messages).length;
  return n;
}
