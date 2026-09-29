/**
 * Anthropic Messages → OpenAI Chat Completions, and back.
 *
 * gate speaks Anthropic: the recorder builds a Messages request and reads a
 * Messages answer. Sending it to an OpenAI-compatible box therefore needs the
 * request translated out, and the JSON answer translated back, so nothing
 * downstream can tell which upstream served it. The recorder's calls are plain
 * text chat — a system prompt, user and assistant turns, no tools — and this
 * translates exactly that, plus images.
 */

type AnyObj = Record<string, unknown>;

const asObj = (v: unknown): AnyObj => (v && typeof v === "object" && !Array.isArray(v) ? (v as AnyObj) : {});
const asArr = (v: unknown): AnyObj[] => (Array.isArray(v) ? (v as AnyObj[]) : []);

// ---- Request: Anthropic -> OpenAI ------------------------------------------

/** Anthropic system (string or text blocks) → one flat string. */
function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  return asArr(system)
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

function imagePart(source: AnyObj): AnyObj | null {
  if (source.type === "base64" && typeof source.data === "string") {
    return { type: "image_url", image_url: { url: `data:${source.media_type ?? "image/png"};base64,${source.data}` } };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

/** Translate one Anthropic messages array: text and image blocks cross over, nothing else does. */
function translateMessages(messages: AnyObj[]): AnyObj[] {
  const out: AnyObj[] = [];

  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;

    if (typeof content === "string") {
      if (content) out.push({ role, content });
      continue;
    }

    const parts: AnyObj[] = [];
    for (const block of asArr(content)) {
      if (block.type === "text") {
        if (typeof block.text === "string" && block.text) parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const part = imagePart(asObj(block.source));
        if (part) parts.push(part);
      }
      // thinking / redacted_thinking have no OpenAI equivalent and carry
      // signatures that only Anthropic can verify. Dropped, not forwarded.
    }

    if (parts.length) {
      out.push({ role, content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    }
  }

  return out;
}

/**
 * Build the OpenAI chat/completions body. `model` is the upstream's own model
 * id (the `provider:<name>/` prefix is already stripped by the caller).
 */
export function anthropicToOpenAIRequest(body: AnyObj, model: string): AnyObj {
  const messages = translateMessages(asArr(body.messages));
  const system = systemText(body.system);
  if (system) messages.unshift({ role: "system", content: system });

  const out: AnyObj = { model, messages };

  const maxTokens = Number(body.max_tokens ?? 0);
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_tokens = maxTokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;

  return out;
}

// ---- Response: OpenAI -> Anthropic -----------------------------------------

function stopReason(finish: unknown): string {
  return finish === "length" ? "max_tokens" : "end_turn";
}

export function openAIToAnthropicResponse(resp: AnyObj, model: string): AnyObj {
  const choice = asObj(asArr(resp.choices)[0]);
  const message = asObj(choice.message);
  const content: AnyObj[] = [];

  const text = message.content;
  if (typeof text === "string" && text) content.push({ type: "text", text });
  else if (Array.isArray(text)) {
    const joined = asArr(text)
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    if (joined) content.push({ type: "text", text: joined });
  }

  const usage = asObj(resp.usage);
  const cached = Number(asObj(usage.prompt_tokens_details).cached_tokens ?? 0);
  return {
    id: typeof resp.id === "string" ? resp.id : `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
      cache_read_input_tokens: Number.isFinite(cached) ? cached : 0,
      cache_creation_input_tokens: 0,
    },
  };
}
