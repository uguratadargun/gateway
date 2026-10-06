import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createKey, deleteKey, listKeys, resolveKey, revokeKey } from "@/lib/apikeys";
import { forgetSkillSources, forgetTheGateway, getDb } from "@/lib/db";
import { apiEquivalentCost, tierOf } from "@/lib/pricing";
import { loadSettings, saveSettings } from "@/lib/settings";

const kvSet = (key: string, value: string) =>
  getDb().prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
const kvGet = (key: string): string | null => (getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key)?.value as string) ?? null;

describe("pricing", () => {
  it("infers tiers from model ids", () => {
    expect(tierOf("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(tierOf("claude-sonnet-5")).toBe("sonnet");
    expect(tierOf("claude-opus-5")).toBe("opus");
    expect(tierOf("claude-fable-5-1")).toBe("fable");
  });
  it("prices a Claude model at list price", () => {
    // Sept-2026 list prices: haiku 1/5, opus 5/25 per MTok.
    expect(apiEquivalentCost("claude-haiku-4-5-20251001", { input: 10_000, output: 2_000 })).toBeCloseTo(0.02);
    expect(apiEquivalentCost("claude-opus-5-5", { input: 10_000, output: 2_000 })).toBeCloseTo(0.1);
  });
});

describe("api keys (sqlite)", () => {
  it("creates, resolves, revokes, and deletes keys; hides the hash", () => {
    const { key, plaintext } = createKey("cli");
    expect(plaintext.startsWith("gate_")).toBe(true);
    expect(resolveKey(plaintext)?.keyId).toBe(key.id);
    expect(resolveKey("gate_wrong")).toBeNull();
    const listed = listKeys().find((k) => k.id === key.id)!;
    expect((listed as any).hash).toBeUndefined();
    expect(listed.lastUsedAt).not.toBeNull();
    expect(revokeKey(key.id)).toBe(true);
    expect(resolveKey(plaintext)).toBeNull();
    expect(deleteKey(key.id)).toBe(true);
    expect(listKeys().find((k) => k.id === key.id)).toBeUndefined();
  });
});

describe("what gate kept while it served models", () => {
  it("is dropped on open — the logins first — and a Telegram link's key is revoked with it", () => {
    const d = getDb();
    d.exec("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, sealed TEXT NOT NULL)");
    d.exec("INSERT INTO accounts (id, sealed) VALUES ('a1', 'sealed-token')");
    d.exec("CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, ts INTEGER)");
    d.exec("CREATE TABLE IF NOT EXISTS traffic (id INTEGER PRIMARY KEY, ts INTEGER)");
    const { key } = createKey("telegram chat");
    d.exec("CREATE TABLE IF NOT EXISTS telegram_links (chat_id TEXT PRIMARY KEY, key_id TEXT NOT NULL)");
    d.prepare("INSERT INTO telegram_links (chat_id, key_id) VALUES ('c1', ?)").run(key.id);
    kvSet("ratelimit", "{}");
    kvSet("telegram.botToken", "t");
    kvSet("memory.index.last", "keep");

    forgetTheGateway(d);

    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const gone of ["accounts", "usage", "traffic", "telegram_links", "ratelimit_history", "cache", "sessions"]) {
      expect(tables).not.toContain(gone);
    }
    expect(listKeys().find((k) => k.id === key.id)!.revoked).toBe(true);
    expect(kvGet("ratelimit")).toBeNull();
    expect(kvGet("telegram.botToken")).toBeNull();
    expect(kvGet("memory.index.last")).toBe("keep");
    // Twice is the same as once.
    forgetTheGateway(d);
  });
});

describe("what gate kept while agents followed skills", () => {
  it("drops the skill libraries and gate's clones of them on open", () => {
    const d = getDb();
    d.exec("CREATE TABLE IF NOT EXISTS skill_sources (id TEXT PRIMARY KEY)");
    const clones = join(process.env.GATE_HOME!, "skill-sources", "superpowers");
    mkdirSync(clones, { recursive: true });

    forgetSkillSources(d);

    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).not.toContain("skill_sources");
    expect(existsSync(join(process.env.GATE_HOME!, "skill-sources"))).toBe(false);
    // Twice is the same as once.
    forgetSkillSources(d);
  });
});

describe("settings", () => {
  it("keeps a recorder on a provider model, and reads a Claude tier left from before as no model", () => {
    expect(saveSettings({ memory: { model: "provider:vllm/Qwen3.8-27B" } }).memory.model).toBe("provider:vllm/Qwen3.8-27B");
    expect(saveSettings({ memory: { model: "sonnet" } }).memory.model).toBe("");
    expect(saveSettings({ memory: { model: "" } }).memory.model).toBe("");
    // A settings file from the gateway days still loads; what it said about the gateway is dropped.
    const loaded = loadSettings() as unknown as Record<string, unknown>;
    expect(Object.keys(loaded).sort()).toEqual(["memory", "plugin"]);
  });
});
