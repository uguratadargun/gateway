import { describe, expect, it } from "vitest";

import { anthropicStreamToResponses, anthropicToResponses, responsesToAnthropic } from "@/lib/openai-responses";

describe("responsesToAnthropic", () => {
  it("handles string input + instructions", () => {
    const { body, effort } = responsesToAnthropic({ model: "auto", instructions: "Be brief.", input: "hi", reasoning: { effort: "high" } });
    expect(body.system).toBe("Be brief.");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(body.max_tokens).toBe(4096);
    expect(effort).toBe("high");
  });

  it("translates message items, function calls, and outputs; merges same-role turns", () => {
    const { body } = responsesToAnthropic({
      model: "auto",
      tools: [{ type: "function", name: "get_weather", description: "w", parameters: { type: "object" } }],
      tool_choice: "required",
      max_output_tokens: 100,
      input: [
        { role: "developer", content: [{ type: "input_text", text: "sys" }] },
        { role: "user", content: [{ type: "input_text", text: "weather?" }] },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"x"}' },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
        { role: "user", content: "thanks" },
      ],
    });
    expect(body.system).toBe("sys");
    expect(body.tools).toEqual([{ name: "get_weather", description: "w", input_schema: { type: "object" } }]);
    expect(body.tool_choice).toEqual({ type: "any" });
    expect(body.max_tokens).toBe(100);
    const msgs = body.messages as any[];
    expect(msgs[0]).toEqual({ role: "user", content: [{ type: "text", text: "weather?" }] });
    expect(msgs[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "x" } }] });
    // tool_result and the following user text merge into one user turn
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "call_1", content: "sunny" });
    expect(msgs[2].content[1]).toEqual({ type: "text", text: "thanks" });
    expect(msgs.length).toBe(3);
  });
});

describe("anthropicToResponses", () => {
  it("emits a message item and function_call items with usage", () => {
    const out = anthropicToResponses(
      {
        id: "msg_1",
        content: [
          { type: "text", text: "Sure." },
          { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "x" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 },
      },
      "claude-sonnet-5",
    ) as any;
    expect(out.object).toBe("response");
    expect(out.status).toBe("completed");
    expect(out.output[0].type).toBe("message");
    expect(out.output[0].content[0]).toEqual({ type: "output_text", text: "Sure.", annotations: [] });
    expect(out.output[1]).toMatchObject({ type: "function_call", call_id: "tu_1", name: "get_weather", arguments: '{"city":"x"}' });
    expect(out.usage).toMatchObject({ input_tokens: 14, output_tokens: 5, total_tokens: 19, input_tokens_details: { cached_tokens: 4 } });
  });
});

function sse(events: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < text.length; i += 11) c.enqueue(enc.encode(text.slice(i, i + 11)));
      c.close();
    },
  });
}

describe("anthropicStreamToResponses", () => {
  it("streams the Responses event sequence and completes with output + usage", async () => {
    const text = await new Response(
      anthropicStreamToResponses(
        sse([
          { type: "message_start", message: { usage: { input_tokens: 3 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "f" } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a":' } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "1}" } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
          { type: "message_stop" },
        ]),
        "claude-sonnet-5",
      ),
    ).text();
    const events = text
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_item.added");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types).toContain("response.function_call_arguments.done");
    expect(types.at(-1)).toBe("response.completed");
    const deltas = events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("");
    expect(deltas).toBe("Hello");
    const done = events.at(-1);
    expect(done.response.output[0].content[0].text).toBe("Hello");
    expect(done.response.output[1]).toMatchObject({ type: "function_call", call_id: "tu_1", name: "f", arguments: '{"a":1}' });
    expect(done.response.usage.output_tokens).toBe(9);
    // sequence numbers strictly increase
    for (let i = 1; i < events.length; i++) expect(events[i].sequence_number).toBe(events[i - 1].sequence_number + 1);
  });
});
