import { describe, expect, it } from "vitest";

import { anthropicStreamToOpenAI, anthropicToOpenAI, openaiToAnthropic } from "@/lib/openai-compat";

describe("openaiToAnthropic", () => {
  it("lifts system messages into `system` and maps roles", () => {
    const body = openaiToAnthropic({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(body.system).toBe("You are terse.");
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(body.max_tokens).toBe(4096);
    expect(body.stream).toBe(false);
  });

  it("translates function tools, tool_choice, and tool results", () => {
    const body = openaiToAnthropic({
      model: "gpt-4o",
      tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "get_weather" } },
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"x"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    });
    expect(body.tools).toEqual([{ name: "get_weather", description: "w", input_schema: { type: "object" } }]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "get_weather" });
    const msgs = body.messages as any[];
    expect(msgs[1].content[0]).toEqual({ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "x" } });
    expect(msgs[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }],
    });
  });

  it("converts data-URL image parts to Anthropic image blocks", () => {
    const body = openaiToAnthropic({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    const content = (body.messages as any[])[0].content;
    expect(content[0]).toEqual({ type: "text", text: "what is this" });
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  });
});

describe("anthropicToOpenAI", () => {
  it("joins text blocks and maps tool_use to tool_calls", () => {
    const out = anthropicToOpenAI(
      {
        id: "msg_1",
        content: [
          { type: "text", text: "Sure." },
          { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "x" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "claude-sonnet-5",
    ) as any;
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.content).toBe("Sure.");
    expect(out.choices[0].message.tool_calls[0]).toEqual({
      id: "tu_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"x"}' },
    });
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("maps stop reasons", () => {
    const mk = (stop_reason: string) =>
      (anthropicToOpenAI({ content: [], stop_reason, usage: {} }, "m") as any).choices[0].finish_reason;
    expect(mk("end_turn")).toBe("stop");
    expect(mk("max_tokens")).toBe("length");
    expect(mk("tool_use")).toBe("tool_calls");
  });
});

function sse(events: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(c) {
      // Split into odd-sized chunks to exercise line buffering.
      for (let i = 0; i < text.length; i += 7) c.enqueue(enc.encode(text.slice(i, i + 7)));
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const text = await new Response(stream).text();
  return text
    .split("\n\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^data: /, ""));
}

describe("anthropicStreamToOpenAI", () => {
  it("emits role, content deltas, tool_call deltas, finish, and [DONE]", async () => {
    const out = await collect(
      anthropicStreamToOpenAI(
        sse([
          { type: "message_start", message: { usage: { input_tokens: 3 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "f" } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
          { type: "message_stop" },
        ]),
        "claude-sonnet-5",
      ),
    );
    const chunks = out.filter((l) => l !== "[DONE]").map((l) => JSON.parse(l));
    expect(out.at(-1)).toBe("[DONE]");
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" });
    const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    expect(text).toBe("Hello");
    const toolStart = chunks.find((c) => c.choices[0].delta.tool_calls?.[0]?.id === "tu_1");
    expect(toolStart.choices[0].delta.tool_calls[0].function.name).toBe("f");
    const args = chunks
      .flatMap((c) => c.choices[0].delta.tool_calls ?? [])
      .map((t: any) => t.function?.arguments ?? "")
      .join("");
    expect(args).toBe('{"a":1}');
    expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls");
    expect(chunks.every((c) => c.object === "chat.completion.chunk")).toBe(true);
  });
});
