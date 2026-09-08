import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  anthropicToOpenAIRequest,
  openAIStreamToAnthropic,
  openAIToAnthropicResponse,
} from "@/lib/anthropic-openai";
import { getDb } from "@/lib/db";
import {
  canonicalModelRef,
  catalogueRequest,
  createProvider,
  formatProviderRef,
  isSelfHostedBaseUrl,
  listProviderModels,
  listProviders,
  parseProviderRef,
  providerApiKey,
  updateProvider,
} from "@/lib/providers";
import {
  sanitizeForAnthropicProvider,
  sendToAnthropicProvider,
  sendToOpenAIProvider,
  sendToProvider,
} from "@/lib/provider-exec";
import { routeModel } from "@/lib/router";

// ── request translation ─────────────────────────────────────────────────────

describe("anthropic → openai request", () => {
  it("hoists the system blocks into a system message", () => {
    const out = anthropicToOpenAIRequest(
      { system: [{ type: "text", text: "be terse" }, { type: "text", text: "and kind" }], messages: [{ role: "user", content: "hi" }] },
      "qwen3",
    );
    expect(out.messages).toEqual([
      { role: "system", content: "be terse\n\nand kind" },
      { role: "user", content: "hi" },
    ]);
    expect(out.model).toBe("qwen3");
  });

  it("turns tool_use into tool_calls and tool_result into a tool message", () => {
    const out = anthropicToOpenAIRequest(
      {
        messages: [
          { role: "user", content: "weather?" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Ankara" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "12C" }, { type: "text", text: "thanks" }] },
        ],
      },
      "qwen3",
    );
    expect(out.messages).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "get_weather", arguments: '{"city":"Ankara"}' } }],
      },
      // The result has to come before the prose that followed it, or OpenAI
      // rejects the tool message for not answering the preceding call.
      { role: "tool", tool_call_id: "t1", content: "12C" },
      { role: "user", content: "thanks" },
    ]);
  });

  it("translates tools and tool_choice, and drops thinking blocks", () => {
    const out = anthropicToOpenAIRequest(
      {
        messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "ok" }] }],
        tools: [{ name: "search", description: "find", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
        tool_choice: { type: "any" },
        max_tokens: 512,
        stop_sequences: ["</done>"],
      },
      "qwen3",
    );
    expect(out.messages).toEqual([{ role: "assistant", content: "ok" }]);
    expect(out.tools).toEqual([
      { type: "function", function: { name: "search", description: "find", parameters: { type: "object", properties: { q: { type: "string" } } } } },
    ]);
    expect(out.tool_choice).toBe("required");
    expect(out.max_tokens).toBe(512);
    expect(out.stop).toEqual(["</done>"]);
  });

  it("carries an image through as a data URL", () => {
    const out = anthropicToOpenAIRequest(
      { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] }] },
      "qwen3",
    );
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
    ]);
  });
});

// ── response translation ────────────────────────────────────────────────────

describe("openai → anthropic response", () => {
  it("maps content, tool calls, finish reason and usage", () => {
    const out = openAIToAnthropicResponse(
      {
        id: "chatcmpl-1",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "let me look",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 10 } },
      },
      "local:ollama/qwen3",
    );
    expect(out.content).toEqual([
      { type: "text", text: "let me look" },
      { type: "tool_use", id: "call_1", name: "search", input: { q: "x" } },
    ]);
    expect(out.stop_reason).toBe("tool_use");
    expect(out.model).toBe("local:ollama/qwen3");
    expect(out.usage).toEqual({
      input_tokens: 30,
      output_tokens: 7,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 0,
    });
  });

  it("keeps malformed tool arguments instead of throwing them away", () => {
    const out = openAIToAnthropicResponse(
      { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c", function: { name: "f", arguments: "{not json" } }] } }] },
      "m",
    );
    expect((out.content as Array<Record<string, unknown>>)[0].input).toEqual({ _raw: "{not json" });
  });

  it("maps a length stop to max_tokens", () => {
    expect(openAIToAnthropicResponse({ choices: [{ finish_reason: "length", message: { content: "…" } }] }, "m").stop_reason).toBe("max_tokens");
  });
});

// ── stream translation ──────────────────────────────────────────────────────

function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

async function events(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, any>>> {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5).trim()));
}

describe("openai → anthropic stream", () => {
  it("rebuilds the message/content-block event sequence", async () => {
    const out = await events(
      openAIStreamToAnthropic(
        sse([
          { choices: [{ delta: { role: "assistant" } }] },
          { choices: [{ delta: { content: "Hel" } }] },
          { choices: [{ delta: { content: "lo" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } },
        ]),
        "local:ollama/qwen3",
      ),
    );
    expect(out.map((e) => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(out[2].delta).toEqual({ type: "text_delta", text: "Hel" });
    // Usage arrives on the trailing chunk; gate's accounting reads it from
    // message_delta, so a stream that lost it would bill zero tokens.
    expect(out[5].usage).toMatchObject({ input_tokens: 11, output_tokens: 2 });
    expect(out[5].delta.stop_reason).toBe("end_turn");
  });

  it("opens a tool_use block and streams its arguments as input_json_delta", async () => {
    const out = await events(
      openAIStreamToAnthropic(
        sse([
          { choices: [{ delta: { content: "sure" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]),
        "m",
      ),
    );
    const types = out.map((e) => e.type);
    // The text block must close before the tool block opens: Anthropic content
    // blocks never overlap.
    expect(types.indexOf("content_block_stop")).toBeLessThan(types.lastIndexOf("content_block_start"));
    const toolStart = out.find((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use")!;
    expect(toolStart.content_block).toMatchObject({ id: "call_1", name: "search" });
    expect(toolStart.index).toBe(1);
    const json = out.filter((e) => e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join("");
    expect(json).toBe('{"q":"x"}');
    expect(out.at(-2)!.delta.stop_reason).toBe("tool_use");
  });

  it("still emits a well-formed empty message when the upstream says nothing", async () => {
    const out = await events(openAIStreamToAnthropic(sse([]), "m"));
    expect(out.map((e) => e.type)).toEqual(["message_start", "message_delta", "message_stop"]);
  });
});

// ── provider registry ───────────────────────────────────────────────────────

describe("provider registry", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM providers");
  });

  it("recognises endpoints on our own network", () => {
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://192.168.1.9:8000/v1", "http://ollama:11434/v1", "http://box.local/v1"]) {
      expect(isSelfHostedBaseUrl(url), url).toBe(true);
    }
    for (const url of ["https://api.openai.com/v1", "https://models.example.com/v1", "not a url"]) {
      expect(isSelfHostedBaseUrl(url), url).toBe(false);
    }
  });

  it("parses and formats provider model references", () => {
    expect(parseProviderRef("provider:ollama/qwen3")).toEqual({ provider: "ollama", model: "qwen3" });
    // The model half may carry slashes and tags of its own.
    expect(parseProviderRef("provider:ollama/library/qwen3:8b")).toEqual({ provider: "ollama", model: "library/qwen3:8b" });
    expect(parseProviderRef("claude-sonnet-5")).toBeNull();
    expect(parseProviderRef("provider:ollama")).toBeNull();
    expect(formatProviderRef("ollama", "qwen3")).toBe("provider:ollama/qwen3");
  });

  it("still reads the `local:` prefix it used to write", () => {
    // Every routing.json and agent definition written before the rename holds
    // one of these; they have to keep resolving to the same endpoint.
    expect(parseProviderRef("local:ollama/qwen3")).toEqual({ provider: "ollama", model: "qwen3" });
    expect(canonicalModelRef("local:ollama/qwen3")).toBe("provider:ollama/qwen3");
    expect(canonicalModelRef("provider:zai/glm-4.6")).toBe("provider:zai/glm-4.6");
    // A Claude id is not a provider ref and is handed back untouched.
    expect(canonicalModelRef("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("slugifies the name, trims the base URL, and seals the key", () => {
    const p = createProvider({ name: "My Ollama!", baseUrl: "http://localhost:11434/v1///", apiKey: "secret" });
    expect(p.name).toBe("my-ollama");
    expect(p.baseUrl).toBe("http://localhost:11434/v1");
    expect(p.selfHosted).toBe(true);
    expect(p.hasApiKey).toBe(true);
    // The key is readable through the store, and only through the store.
    expect(providerApiKey(p.id)).toBe("secret");
    expect((p as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    const raw = getDb().prepare("SELECT api_key_sealed FROM providers WHERE id = ?").get(p.id) as { api_key_sealed: string };
    expect(raw.api_key_sealed).not.toContain("secret");
    // An empty string clears it; undefined leaves it alone.
    expect(updateProvider(p.id, { apiKey: "" })?.hasApiKey).toBe(false);
    expect(updateProvider(p.id, { label: "renamed" })?.hasApiKey).toBe(false);
  });

  it("reports why an endpoint is unreachable instead of an empty catalogue", async () => {
    const p = createProvider({ name: "down", baseUrl: "http://127.0.0.1:1/v1" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const result = await listProviderModels(p, { force: true });
    expect(result.models).toEqual([]);
    expect(result.error).toContain("ECONNREFUSED");
    vi.unstubAllGlobals();
  });

  it("routes an explicit provider reference straight through", () => {
    createProvider({ name: "ollama", baseUrl: "http://localhost:11434/v1" });
    const route = routeModel("provider:ollama/qwen3", { messages: [{ role: "user", content: "hi" }] });
    expect(route.model).toBe("provider:ollama/qwen3");
    expect(route.reason).toBe("explicit provider model");
    expect(listProviders().length).toBe(1);
  });

  it("routes a legacy `local:` reference to the same endpoint, canonicalised", () => {
    createProvider({ name: "ollama", baseUrl: "http://localhost:11434/v1" });
    const route = routeModel("local:ollama/qwen3", { messages: [{ role: "user", content: "hi" }] });
    expect(route.model).toBe("provider:ollama/qwen3");
    expect(route.reason).toBe("explicit provider model");
  });

  it("declared models are the catalogue, and nothing is probed", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const p = createProvider({
      name: "zai",
      kind: "anthropic-compat",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKey: "zai-key",
      models: "glm-4.6, glm-4.5-air",
    });
    expect(p.kind).toBe("anthropic-compat");
    expect(p.selfHosted).toBe(false);
    expect(await listProviderModels(p, { force: true })).toEqual({
      models: ["glm-4.6", "glm-4.5-air"],
      error: null,
    });
    // An endpoint that serves no catalogue must not be asked for one.
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("asks each dialect for its catalogue at the address that dialect uses", () => {
    const openai = createProvider({ name: "ollama", baseUrl: "http://localhost:11434/v1" });
    expect(catalogueRequest(openai, "k").url).toBe("http://localhost:11434/v1/models");
    expect(catalogueRequest(openai, "k").headers.Authorization).toBe("Bearer k");

    const anthropic = createProvider({ name: "zai", kind: "anthropic-compat", baseUrl: "https://api.z.ai/api/anthropic" });
    const req = catalogueRequest(anthropic, "k");
    expect(req.url).toBe("https://api.z.ai/api/anthropic/v1/models");
    expect(req.headers["x-api-key"]).toBe("k");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("sendToOpenAIProvider", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM providers");
  });

  it("posts OpenAI, answers Anthropic, and asks for streamed usage", async () => {
    const p = createProvider({ name: "ollama", baseUrl: "http://localhost:11434/v1" });
    let seen: { url: string; body: any } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen = { url, body: JSON.parse(init.body as string) };
        return new Response(
          JSON.stringify({ id: "c1", choices: [{ finish_reason: "stop", message: { content: "hey" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const res = await sendToOpenAIProvider({
      provider: p,
      model: "qwen3",
      body: { model: "local:ollama/qwen3", system: "be terse", messages: [{ role: "user", content: "hi" }] },
      stream: false,
    });
    expect(seen!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(seen!.body.model).toBe("qwen3");
    expect(seen!.body.stream).toBe(false);
    const json = (await res.json()) as Record<string, any>;
    expect(json.type).toBe("message");
    expect(json.content).toEqual([{ type: "text", text: "hey" }]);
    expect(json.model).toBe("provider:ollama/qwen3");
    vi.unstubAllGlobals();
  });

  it("asks for usage on the trailing chunk when streaming", async () => {
    const p = createProvider({ name: "ollama", baseUrl: "http://localhost:11434/v1" });
    let body: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(init.body as string);
        return new Response(sse([{ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] }]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    const res = await sendToOpenAIProvider({ provider: p, model: "qwen3", body: { messages: [] }, stream: true });
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await new Response(res.body).text()).toContain("event: message_start");
    vi.unstubAllGlobals();
  });

  it("turns an unreachable box into an Anthropic-shaped error", async () => {
    const p = createProvider({ name: "ollama", baseUrl: "http://127.0.0.1:1/v1" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));
    const res = await sendToOpenAIProvider({ provider: p, model: "qwen3", body: { messages: [] }, stream: false });
    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, any>;
    expect(json.error.message).toContain("unreachable");
    vi.unstubAllGlobals();
  });
});

// ── anthropic-compat: forwarded, not translated ─────────────────────────────

describe("sendToAnthropicProvider", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM providers");
  });

  const zai = () =>
    createProvider({
      name: "zai",
      kind: "anthropic-compat",
      baseUrl: "https://api.z.ai/api/anthropic",
      apiKey: "zai-key",
      models: "glm-4.6",
    });

  it("posts the Messages API verbatim, with the model unprefixed and the key attached", async () => {
    const p = zai();
    let seen: { url: string; headers: Record<string, string>; body: any } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
        return new Response(JSON.stringify({ type: "message", model: "glm-4.6", content: [{ type: "text", text: "hey" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const res = await sendToAnthropicProvider({
      provider: p,
      model: "glm-4.6",
      body: {
        model: "provider:zai/glm-4.6",
        system: "be terse",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read_file", description: "read", input_schema: { type: "object" } }],
      },
      stream: false,
    });

    expect(seen!.url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(seen!.headers["x-api-key"]).toBe("zai-key");
    expect(seen!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen!.body.model).toBe("glm-4.6");
    expect(seen!.body.stream).toBe(false);
    // Untranslated is the whole point: the tool block reaches the model in the
    // shape the client wrote it, not as an OpenAI function.
    expect(seen!.body.tools).toEqual([{ name: "read_file", description: "read", input_schema: { type: "object" } }]);
    expect(seen!.body.system).toBe("be terse");
    const json = (await res.json()) as Record<string, any>;
    expect(json.content).toEqual([{ type: "text", text: "hey" }]);
    vi.unstubAllGlobals();
  });

  it("drops the parameters only Anthropic's own models take", () => {
    const body = sanitizeForAnthropicProvider({
      messages: [],
      output_config: { effort: "high" },
      thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_thinking_20250101" }] },
      tools: [{ name: "Read" }],
    });
    expect(body.output_config).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.context_management).toBeUndefined();
    // Ordinary Messages API survives untouched.
    expect(body.tools).toEqual([{ name: "Read" }]);
  });

  it("keeps a thinking block the Messages API has always had", () => {
    const body = sanitizeForAnthropicProvider({ thinking: { type: "enabled", budget_tokens: 2048 } });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("hands a stream back as it came, without rebuilding it", async () => {
    const p = zai();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("event: message_start\ndata: {}\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );
    const res = await sendToAnthropicProvider({ provider: p, model: "glm-4.6", body: { messages: [] }, stream: true });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await new Response(res.body).text()).toBe("event: message_start\ndata: {}\n\n");
    vi.unstubAllGlobals();
  });

  it("turns an unreachable endpoint into an Anthropic-shaped error", async () => {
    const p = zai();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));
    const res = await sendToAnthropicProvider({ provider: p, model: "glm-4.6", body: { messages: [] }, stream: false });
    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, any>).error.message).toContain("unreachable");
    vi.unstubAllGlobals();
  });

  it("sendToProvider picks the dialect from the provider, not the caller", async () => {
    const anthropic = zai();
    const openai = createProvider({ name: "ollama", baseUrl: "http://localhost:11434/v1" });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ type: "message", content: [], choices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await sendToProvider({ provider: anthropic, ref: { provider: "zai", model: "glm-4.6" }, body: { messages: [] }, stream: false });
    await sendToProvider({ provider: openai, ref: { provider: "ollama", model: "qwen3" }, body: { messages: [] }, stream: false });
    expect(urls).toEqual([
      "https://api.z.ai/api/anthropic/v1/messages",
      "http://localhost:11434/v1/chat/completions",
    ]);
    vi.unstubAllGlobals();
  });
});
