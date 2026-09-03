/**
 * OpenAI Responses API <-> Anthropic Messages translation. Codex CLI and the
 * newer OpenAI SDKs speak this instead of Chat Completions. Stateless:
 * `previous_response_id` is not supported — send the full input each turn.
 */

type AnyObj = Record<string, unknown>;

// ---- Request: Responses -> Anthropic ---------------------------------------

function partToBlock(part: AnyObj): AnyObj | null {
  switch (part.type) {
    case "input_text":
    case "output_text":
    case "text":
      return typeof part.text === "string" ? { type: "text", text: part.text } : null;
    case "input_image": {
      const url = typeof part.image_url === "string" ? part.image_url : (part.image_url as AnyObj)?.url;
      if (typeof url !== "string") return null;
      if (url.startsWith("data:")) {
        const [meta, data] = url.split(",");
        return { type: "image", source: { type: "base64", media_type: meta.slice(5).split(";")[0], data } };
      }
      return { type: "image", source: { type: "url", url } };
    }
    default:
      return null;
  }
}

function contentToBlocks(content: unknown): AnyObj[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return (content as AnyObj[]).map(partToBlock).filter((b): b is AnyObj => b !== null);
}

function pushMerged(out: AnyObj[], role: "user" | "assistant", blocks: AnyObj[]): void {
  if (blocks.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    (last.content as AnyObj[]).push(...blocks);
  } else {
    out.push({ role, content: blocks });
  }
}

export function responsesToAnthropic(req: AnyObj): { body: AnyObj; effort: string | null } {
  const out: AnyObj[] = [];
  const input = req.input;

  if (typeof input === "string") {
    pushMerged(out, "user", [{ type: "text", text: input }]);
  } else if (Array.isArray(input)) {
    for (const item of input as AnyObj[]) {
      const type = item.type ?? "message";
      if (type === "message") {
        const role = item.role === "assistant" ? "assistant" : item.role === "system" || item.role === "developer" ? "system" : "user";
        if (role === "system") continue; // folded into instructions below
        pushMerged(out, role, contentToBlocks(item.content));
      } else if (type === "function_call") {
        let args: unknown = {};
        try {
          args = typeof item.arguments === "string" && item.arguments ? JSON.parse(item.arguments) : {};
        } catch {
          args = {};
        }
        pushMerged(out, "assistant", [{ type: "tool_use", id: item.call_id ?? item.id, name: item.name, input: args }]);
      } else if (type === "function_call_output") {
        pushMerged(out, "user", [
          {
            type: "tool_result",
            tool_use_id: item.call_id,
            content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
          },
        ]);
      }
      // reasoning / other item types are dropped
    }
  }

  const systemParts: string[] = [];
  if (typeof req.instructions === "string" && req.instructions) systemParts.push(req.instructions);
  if (Array.isArray(input)) {
    for (const item of input as AnyObj[]) {
      if ((item.type ?? "message") === "message" && (item.role === "system" || item.role === "developer")) {
        const text = contentToBlocks(item.content).map((b) => b.text).join("\n");
        if (text) systemParts.push(text);
      }
    }
  }

  const body: AnyObj = {
    model: req.model,
    messages: out,
    max_tokens: Number(req.max_output_tokens ?? 4096),
    stream: req.stream === true,
  };
  if (systemParts.length) body.system = systemParts.join("\n\n");
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.top_p != null) body.top_p = req.top_p;

  if (Array.isArray(req.tools)) {
    const tools = (req.tools as AnyObj[])
      .filter((t) => t.type === "function" && typeof t.name === "string")
      .map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.parameters ?? { type: "object" } }));
    if (tools.length) body.tools = tools;
  }
  const tc = req.tool_choice;
  if (tc === "auto") body.tool_choice = { type: "auto" };
  else if (tc === "required") body.tool_choice = { type: "any" };
  else if (tc === "none") body.tool_choice = { type: "none" };
  else if (tc && typeof tc === "object" && (tc as AnyObj).type === "function") {
    body.tool_choice = { type: "tool", name: (tc as AnyObj).name };
  }

  const effort = typeof (req.reasoning as AnyObj)?.effort === "string" ? ((req.reasoning as AnyObj).effort as string) : null;
  return { body, effort };
}

// ---- Response (non-stream): Anthropic -> Responses -------------------------

function usageOf(u: AnyObj | undefined): AnyObj {
  const input = Number(u?.input_tokens ?? 0);
  const cached = Number(u?.cache_read_input_tokens ?? 0);
  const output = Number(u?.output_tokens ?? 0);
  return {
    input_tokens: input + cached,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + cached + output,
  };
}

export function anthropicToResponses(resp: AnyObj, model: string): AnyObj {
  const id = typeof resp.id === "string" ? resp.id.replace(/^msg_/, "resp_") : `resp_${Date.now()}`;
  const content = Array.isArray(resp.content) ? (resp.content as AnyObj[]) : [];
  const output: AnyObj[] = [];
  let text = "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "tool_use") {
      output.push({
        type: "function_call",
        id: `fc_${block.id}`,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
        status: "completed",
      });
    }
  }
  if (text || output.length === 0) {
    output.unshift({
      type: "message",
      id: `msg_${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: resp.stop_reason === "max_tokens" ? "incomplete" : "completed",
    model,
    output,
    usage: usageOf(resp.usage as AnyObj),
  };
}

// ---- Response (stream): Anthropic SSE -> Responses SSE ---------------------

export function anthropicStreamToResponses(
  input: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const responseId = `resp_${Date.now()}`;
  let seq = 0;
  let buffer = "";
  let outputIndex = -1;
  // Anthropic block index -> our output item state.
  const items = new Map<number, { index: number; id: string; kind: "message" | "function_call"; text: string; args: string; callId?: string; name?: string }>();
  const finished: AnyObj[] = [];
  let usage: AnyObj = usageOf(undefined);
  let stopReason: string | null = null;

  const emit = (type: string, payload: AnyObj) =>
    enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);

  const handle = (evt: AnyObj, c: ReadableStreamDefaultController<Uint8Array>) => {
    switch (evt.type) {
      case "message_start": {
        const u = (evt.message as AnyObj)?.usage as AnyObj | undefined;
        if (u) usage = usageOf(u);
        break;
      }
      case "content_block_start": {
        const cb = evt.content_block as AnyObj;
        const idx = Number(evt.index);
        if (cb?.type === "text") {
          const index = ++outputIndex;
          const id = `msg_${responseId}_${index}`;
          items.set(idx, { index, id, kind: "message", text: "", args: "" });
          c.enqueue(emit("response.output_item.added", { output_index: index, item: { id, type: "message", role: "assistant", status: "in_progress", content: [] } }));
          c.enqueue(emit("response.content_part.added", { output_index: index, item_id: id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
        } else if (cb?.type === "tool_use") {
          const index = ++outputIndex;
          const id = `fc_${cb.id}`;
          items.set(idx, { index, id, kind: "function_call", text: "", args: "", callId: String(cb.id), name: String(cb.name) });
          c.enqueue(emit("response.output_item.added", { output_index: index, item: { id, type: "function_call", call_id: cb.id, name: cb.name, arguments: "", status: "in_progress" } }));
        }
        break;
      }
      case "content_block_delta": {
        const it = items.get(Number(evt.index));
        if (!it) break;
        const delta = evt.delta as AnyObj;
        if (it.kind === "message" && delta?.type === "text_delta" && typeof delta.text === "string") {
          it.text += delta.text;
          c.enqueue(emit("response.output_text.delta", { output_index: it.index, item_id: it.id, content_index: 0, delta: delta.text }));
        } else if (it.kind === "function_call" && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          it.args += delta.partial_json;
          c.enqueue(emit("response.function_call_arguments.delta", { output_index: it.index, item_id: it.id, delta: delta.partial_json }));
        }
        break;
      }
      case "content_block_stop": {
        const it = items.get(Number(evt.index));
        if (!it) break;
        if (it.kind === "message") {
          c.enqueue(emit("response.output_text.done", { output_index: it.index, item_id: it.id, content_index: 0, text: it.text }));
          const part = { type: "output_text", text: it.text, annotations: [] };
          c.enqueue(emit("response.content_part.done", { output_index: it.index, item_id: it.id, content_index: 0, part }));
          const item = { id: it.id, type: "message", role: "assistant", status: "completed", content: [part] };
          finished.push(item);
          c.enqueue(emit("response.output_item.done", { output_index: it.index, item }));
        } else {
          c.enqueue(emit("response.function_call_arguments.done", { output_index: it.index, item_id: it.id, arguments: it.args }));
          const item = { id: it.id, type: "function_call", call_id: it.callId, name: it.name, arguments: it.args, status: "completed" };
          finished.push(item);
          c.enqueue(emit("response.output_item.done", { output_index: it.index, item }));
        }
        break;
      }
      case "message_delta": {
        const u = evt.usage as AnyObj | undefined;
        if (u && typeof u.output_tokens === "number") {
          usage = { ...usage, output_tokens: u.output_tokens, total_tokens: Number(usage.input_tokens) + u.output_tokens };
        }
        const sr = (evt.delta as AnyObj)?.stop_reason;
        if (typeof sr === "string") stopReason = sr;
        break;
      }
      default:
        break;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(emit("response.created", { response: { id: responseId, object: "response", status: "in_progress", model, output: [] } }));
    },
    async pull(c) {
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
              handle(JSON.parse(payload) as AnyObj, c);
            } catch {
              // skip malformed event
            }
          }
        }
        c.enqueue(
          emit("response.completed", {
            response: {
              id: responseId,
              object: "response",
              status: stopReason === "max_tokens" ? "incomplete" : "completed",
              model,
              output: finished,
              usage,
            },
          }),
        );
        c.close();
      } finally {
        reader.releaseLock();
      }
    },
  });
}
