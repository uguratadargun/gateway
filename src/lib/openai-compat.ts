/**
 * OpenAI Chat Completions <-> Anthropic Messages translation, so OpenAI SDK
 * clients can use the gateway. Covers text, vision parts, tool calling, and
 * streaming.
 */

type AnyObj = Record<string, unknown>;

function finishReason(stop: string | null | undefined): string {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

// ---- Request: OpenAI -> Anthropic -----------------------------------------

function translateContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: AnyObj[] = [];
  for (const part of content as AnyObj[]) {
    if (part?.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part?.type === "image_url") {
      const url = (part.image_url as AnyObj)?.url;
      if (typeof url === "string" && url.startsWith("data:")) {
        const [meta, data] = url.split(",");
        const media = meta.slice(5).split(";")[0];
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: media, data },
        });
      } else if (typeof url === "string") {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  return blocks;
}

export function openaiToAnthropic(req: AnyObj): AnyObj {
  const messages = Array.isArray(req.messages) ? (req.messages as AnyObj[]) : [];
  const systemParts: string[] = [];
  const out: AnyObj[] = [];

  for (const m of messages) {
    const role = m.role;
    if (role === "system" || role === "developer") {
      if (typeof m.content === "string") systemParts.push(m.content);
      continue;
    }
    if (role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          },
        ],
      });
      continue;
    }
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      const blocks: AnyObj[] = [];
      if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls as AnyObj[]) {
        const fn = tc.function as AnyObj;
        let input: unknown = {};
        try {
          input = fn?.arguments ? JSON.parse(fn.arguments as string) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: fn?.name, input });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: role === "assistant" ? "assistant" : "user", content: translateContent(m.content) });
  }

  const body: AnyObj = {
    model: req.model,
    messages: out,
    max_tokens: Number(req.max_tokens ?? req.max_completion_tokens ?? 4096),
    stream: req.stream === true,
  };
  if (systemParts.length) body.system = systemParts.join("\n\n");
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.top_p != null) body.top_p = req.top_p;
  if (req.stop != null) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  if (Array.isArray(req.tools)) {
    body.tools = (req.tools as AnyObj[])
      .filter((t) => t.type === "function" && t.function)
      .map((t) => {
        const fn = t.function as AnyObj;
        return { name: fn.name, description: fn.description ?? "", input_schema: fn.parameters ?? { type: "object" } };
      });
  }
  if (req.tool_choice) {
    const tc = req.tool_choice;
    if (tc === "auto") body.tool_choice = { type: "auto" };
    else if (tc === "required") body.tool_choice = { type: "any" };
    else if (tc === "none") body.tool_choice = { type: "none" };
    else if (typeof tc === "object" && (tc as AnyObj).function) {
      body.tool_choice = { type: "tool", name: ((tc as AnyObj).function as AnyObj).name };
    }
  }
  return body;
}

// ---- Response (non-stream): Anthropic -> OpenAI ----------------------------

export function anthropicToOpenAI(resp: AnyObj, model: string): AnyObj {
  const content = Array.isArray(resp.content) ? (resp.content as AnyObj[]) : [];
  let text = "";
  const toolCalls: AnyObj[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const usage = (resp.usage as AnyObj) ?? {};
  const message: AnyObj = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: resp.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason(resp.stop_reason as string) }],
    usage: {
      prompt_tokens: Number(usage.input_tokens ?? 0),
      completion_tokens: Number(usage.output_tokens ?? 0),
      total_tokens: Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0),
    },
  };
}

// ---- Response (stream): Anthropic SSE -> OpenAI SSE ------------------------

export function anthropicStreamToOpenAI(
  input: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const chunkBytes = (delta: AnyObj, finish: string | null = null) =>
    enc.encode(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );

  let buffer = "";
  let finish = "stop";
  // Maps an Anthropic content-block index to an OpenAI tool_call index.
  const toolBlocks = new Map<number, number>();
  let nextToolIndex = 0;

  const handle = (evt: AnyObj, controller: ReadableStreamDefaultController<Uint8Array>) => {
    const type = evt.type;
    if (type === "content_block_start" && (evt.content_block as AnyObj)?.type === "tool_use") {
      const cb = evt.content_block as AnyObj;
      const idx = nextToolIndex++;
      toolBlocks.set(Number(evt.index), idx);
      controller.enqueue(
        chunkBytes({
          tool_calls: [
            { index: idx, id: cb.id, type: "function", function: { name: cb.name, arguments: "" } },
          ],
        }),
      );
    } else if (type === "content_block_delta") {
      const delta = evt.delta as AnyObj;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        controller.enqueue(chunkBytes({ content: delta.text }));
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const idx = toolBlocks.get(Number(evt.index)) ?? 0;
        controller.enqueue(
          chunkBytes({
            tool_calls: [{ index: idx, function: { arguments: delta.partial_json } }],
          }),
        );
      }
    } else if (type === "message_delta") {
      const sr = (evt.delta as AnyObj)?.stop_reason;
      if (typeof sr === "string") finish = finishReason(sr);
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunkBytes({ role: "assistant" }));
    },
    async pull(controller) {
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
              // skip malformed event
            }
          }
        }
        controller.enqueue(chunkBytes({}, finish));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
  });
}
