/**
 * Anthropic Messages → OpenAI Chat Completions, and back.
 *
 * gate speaks Anthropic natively end to end: clients post /v1/messages, the
 * router, prompt cache and usage accounting all read that shape. Routing a
 * request to a local OpenAI-compatible box therefore needs the *inverse* of
 * openai-compat.ts — the request translated out, and the answer (JSON or SSE)
 * translated back, so nothing downstream can tell which upstream served it.
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

/** A tool_result's payload — text blocks or a raw string — as flat text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  const parts = asArr(content).map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b)));
  return parts.join("\n");
}

/**
 * Translate one Anthropic messages array. Tool results are the awkward part:
 * Anthropic carries them as blocks inside a *user* message, while OpenAI wants
 * one `role: "tool"` message each, immediately after the assistant turn that
 * called them — so a user turn holding both tool results and prose is split.
 */
function translateMessages(messages: AnyObj[]): AnyObj[] {
  const out: AnyObj[] = [];

  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;

    if (typeof content === "string") {
      if (content) out.push({ role, content });
      continue;
    }

    const blocks = asArr(content);
    const parts: AnyObj[] = [];
    const toolCalls: AnyObj[] = [];
    const toolResults: AnyObj[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case "text":
          if (typeof block.text === "string" && block.text) parts.push({ type: "text", text: block.text });
          break;
        case "image": {
          const part = imagePart(asObj(block.source));
          if (part) parts.push(part);
          break;
        }
        case "tool_use":
          toolCalls.push({
            id: String(block.id ?? ""),
            type: "function",
            function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        case "tool_result":
          toolResults.push({
            role: "tool",
            tool_call_id: String(block.tool_use_id ?? ""),
            content: toolResultText(block.content),
          });
          break;
        // thinking / redacted_thinking have no OpenAI equivalent and carry
        // signatures that only Anthropic can verify. Dropped, not forwarded.
        default:
          break;
      }
    }

    // Tool results first: OpenAI rejects a `tool` message that does not follow
    // the assistant turn whose call it answers.
    out.push(...toolResults);

    if (role === "assistant") {
      if (parts.length || toolCalls.length) {
        const msg: AnyObj = { role: "assistant", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts.length ? parts : null };
        if (toolCalls.length) msg.tool_calls = toolCalls;
        out.push(msg);
      }
      continue;
    }
    if (parts.length) {
      out.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    }
  }

  return out;
}

function translateToolChoice(choice: unknown): unknown {
  const tc = asObj(choice);
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: tc.name } };
    default:
      return undefined;
  }
}

/**
 * Build the OpenAI chat/completions body. `model` is the upstream's own model
 * id (the `local:<provider>/` prefix is already stripped by the caller).
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

  const tools = asArr(body.tools)
    // Anthropic server-side tools (computer_20241022, web_search…) have no
    // OpenAI form; only plain function tools cross over.
    .filter((t) => typeof t.name === "string" && (t.input_schema || t.type === undefined))
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  if (tools.length) {
    out.tools = tools;
    const choice = translateToolChoice(body.tool_choice);
    if (choice !== undefined) out.tool_choice = choice;
  }

  return out;
}

// ---- Response (non-stream): OpenAI -> Anthropic -----------------------------

function stopReason(finish: unknown): string {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop":
    default:
      return "end_turn";
  }
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // A model that emits malformed JSON should surface as a tool call
    // with the raw text, not crash the response path.
    return { _raw: raw };
  }
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

  for (const call of asArr(message.tool_calls)) {
    const fn = asObj(call.function);
    content.push({
      type: "tool_use",
      id: String(call.id ?? `toolu_${Math.random().toString(36).slice(2)}`),
      name: String(fn.name ?? ""),
      input: parseArguments(fn.arguments),
    });
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

// ---- Response (stream): OpenAI SSE -> Anthropic SSE -------------------------

/**
 * Rebuild the Anthropic event sequence from OpenAI chunks. The shape matters
 * beyond the client: gate's own usage accounting reads `message_start`'s
 * `message.usage` and `message_delta`'s `usage`, so a stream that skipped them
 * would be billed as zero tokens.
 */
export function openAIStreamToAnthropic(
  input: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const messageId = `msg_${Date.now().toString(36)}`;

  let started = false;
  let textOpen = false;
  let nextIndex = 0;
  let textIndex = -1;
  /** OpenAI tool_call index → the Anthropic content-block index it opened. */
  const toolBlocks = new Map<number, number>();
  let finish: unknown = "stop";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

  const frame = (type: string, payload: AnyObj): Uint8Array =>
    enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);

  const ensureStarted = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (started) return;
    started = true;
    controller.enqueue(
      frame("message_start", {
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: cachedTokens, cache_creation_input_tokens: 0 },
        },
      }),
    );
  };

  const closeText = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!textOpen) return;
    controller.enqueue(frame("content_block_stop", { index: textIndex }));
    textOpen = false;
  };

  const readUsage = (chunk: AnyObj) => {
    const usage = asObj(chunk.usage);
    if (typeof usage.prompt_tokens === "number") inputTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number") outputTokens = usage.completion_tokens;
    const cached = asObj(usage.prompt_tokens_details).cached_tokens;
    if (typeof cached === "number") cachedTokens = cached;
  };

  const handle = (chunk: AnyObj, controller: ReadableStreamDefaultController<Uint8Array>) => {
    readUsage(chunk);
    const choice = asObj(asArr(chunk.choices)[0]);
    if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    const delta = asObj(choice.delta);

    const text = delta.content;
    if (typeof text === "string" && text) {
      ensureStarted(controller);
      if (!textOpen) {
        textIndex = nextIndex++;
        textOpen = true;
        controller.enqueue(frame("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } }));
      }
      controller.enqueue(frame("content_block_delta", { index: textIndex, delta: { type: "text_delta", text } }));
    }

    for (const call of asArr(delta.tool_calls)) {
      ensureStarted(controller);
      const slot = Number(call.index ?? 0);
      const fn = asObj(call.function);
      let index = toolBlocks.get(slot);
      if (index === undefined) {
        // A tool call ends any open text block: Anthropic blocks never overlap.
        closeText(controller);
        index = nextIndex++;
        toolBlocks.set(slot, index);
        controller.enqueue(
          frame("content_block_start", {
            index,
            content_block: {
              type: "tool_use",
              id: String(call.id ?? `toolu_${messageId}_${slot}`),
              name: String(fn.name ?? ""),
              input: {},
            },
          }),
        );
      }
      if (typeof fn.arguments === "string" && fn.arguments) {
        controller.enqueue(
          frame("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: fn.arguments } }),
        );
      }
    }
  };

  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = input.getReader();
      try {
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
              handle(JSON.parse(payload) as AnyObj, controller);
            } catch {
              // skip a malformed frame rather than tearing down the stream
            }
          }
        }

        // An upstream that answered with nothing at all still owes the client
        // a well-formed, empty message.
        ensureStarted(controller);
        closeText(controller);
        for (const index of toolBlocks.values()) controller.enqueue(frame("content_block_stop", { index }));
        controller.enqueue(
          frame("message_delta", {
            delta: { stop_reason: stopReason(finish), stop_sequence: null },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cachedTokens },
          }),
        );
        controller.enqueue(frame("message_stop", {}));
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}
