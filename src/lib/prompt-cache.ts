/**
 * Anthropic prompt-cache optimizer. Places `cache_control` breakpoints on the
 * stable prefix of a request — end of system, end of tools, and the end of the
 * conversation so far — so the next turn hits the prompt cache. Cached reads
 * bill at 10% and count far less against the account's window.
 *
 * Never overrides breakpoints the client already placed. Blocks the identity
 * layer prepends (billing/sentinel) are never touched because we only mark the
 * LAST block of each section.
 */

type Block = Record<string, unknown>;

export type CacheTtl = "5m" | "1h";

function control(ttl: CacheTtl): Block {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function hasCacheControl(blocks: unknown): boolean {
  if (!Array.isArray(blocks)) return false;
  return blocks.some((b) => b && typeof b === "object" && "cache_control" in (b as Block));
}

function toBlocks(content: unknown): Block[] | null {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : null;
  if (Array.isArray(content)) return content as Block[];
  return null;
}

/** Mark the last block of a block list; returns true if a mark was placed. */
function markLast(blocks: Block[], ttl: CacheTtl): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    // Only text/tool blocks may carry cache_control; skip thinking etc.
    const t = b?.type;
    if (t === "text" || t === "tool_use" || t === "tool_result" || t === "image" || t === "document") {
      b.cache_control = control(ttl);
      return true;
    }
  }
  return false;
}

export interface PromptCacheResult {
  applied: boolean;
  breakpoints: number;
}

/** True when the client placed cache_control anywhere in the request. */
export function clientManagesCache(body: Record<string, unknown>): boolean {
  if (hasCacheControl(body.system) || hasCacheControl(body.tools)) return true;
  const messages = body.messages;
  return Array.isArray(messages) && messages.some((m) => hasCacheControl((m as Block)?.content));
}

export function applyPromptCaching(body: Record<string, unknown>, ttl: CacheTtl = "5m"): PromptCacheResult {
  // A client that already places breakpoints (Claude Code does, with a 1h TTL)
  // manages caching itself. Adding ours would mix TTLs across sections, and
  // Anthropic rejects a 1h block after a 5m one (order: tools, system,
  // messages). So the whole request is left alone.
  if (clientManagesCache(body)) return { applied: false, breakpoints: 0 };

  let breakpoints = 0;

  // 1. System prompt.
  const sys = toBlocks(body.system);
  if (sys && !hasCacheControl(sys)) {
    if (markLast(sys, ttl)) {
      body.system = sys;
      breakpoints++;
    }
  }

  // 2. Tool definitions.
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0 && !hasCacheControl(tools)) {
    (tools[tools.length - 1] as Block).cache_control = control(ttl);
    breakpoints++;
  }

  // 3. Conversation so far — the last message's last block, so the next turn's
  //    prefix (everything up to here) is a cache hit.
  const messages = body.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const anyMarked = messages.some((m) => hasCacheControl((m as Block)?.content));
    if (!anyMarked) {
      const last = messages[messages.length - 1] as Block;
      const blocks = toBlocks(last?.content);
      if (blocks && markLast(blocks, ttl)) {
        last.content = blocks;
        breakpoints++;
      }
    }
  }

  return { applied: breakpoints > 0, breakpoints };
}
