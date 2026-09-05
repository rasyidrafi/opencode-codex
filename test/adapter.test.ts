import { test, expect, afterAll } from "bun:test";
import { resolve } from "node:path";
import { streamCodex } from "../src/agent";
import { startProxy, stopProxy, getProxyBaseUrl } from "../src/proxy";
import { LOCAL_API_KEY } from "../src/constants";
import { buildCodexPrompt } from "../src/prompt";
process.env.OPENCODE_CODEX_METADATA = "off";
process.env.OPENCODE_CODEX_BIN = resolve("test/fixtures/fake-codex.mjs");
afterAll(async () => { await stopProxy(); delete process.env.OPENCODE_CODEX_BIN; });
test("translates tool events, deduplicates final text, and counts cache correctly", async () => {
  const events = await Array.fromAsync(streamCodex({ cwd: process.cwd(), model: "fake-model", prompt: "hi", noSession: true }));
  expect(events.filter(e => e.kind === "text").map(e => e.text).join("")).toBe("Working.Done.");
  expect(events.filter(e => e.kind === "activity")).toEqual([{ kind: "activity", text: "[Codex Tool: Shell cat proof.txt]\n" }]);
  expect(events.at(-1)).toMatchObject({ kind: "finish", usage: { inputTokens: 80, cacheReadTokens: 20, outputTokens: 10 } });
});
test("propagates failed turns", async () => {
  const events = await Array.fromAsync(streamCodex({ cwd: process.cwd(), model: "fake-model", prompt: "FAIL_TURN", noSession: true }));
  expect(events.at(-1)).toEqual({ kind: "error", text: "fixture failure" });
  expect(events.some(e => e.kind === "finish")).toBe(false);
});
test("aborts a stalled backend", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const start = Date.now();
  await Array.fromAsync(streamCodex({ cwd: process.cwd(), model: "fake-model", prompt: "WAIT_FOREVER", signal: controller.signal }));
  expect(Date.now() - start).toBeLessThan(2000);
});
test("proxy emits ordered thinking blocks, zero usage, and no native tool calls", async () => {
  await startProxy();
  const response = await fetch(getProxyBaseUrl() + "/messages", {
    method: "POST", headers: { "x-api-key": LOCAL_API_KEY, "content-type": "application/json", "x-opencode-codex-request-kind": "title" },
    body: JSON.stringify({ model: "fake-model", stream: true, messages: [{ role: "user", content: "hello" }], tools: [{ name: "do_not_execute" }] }),
  });
  expect(response.status).toBe(200);
  const wire = await response.text();
  expect(wire).toContain("thinking_delta");
  expect(wire).not.toContain('"tool_use"');
  expect(wire).toContain('"input_tokens":0');
  expect(wire.indexOf("Working.")).toBeLessThan(wire.indexOf("[Codex Tool: Shell cat proof.txt]"));
  expect(wire).toContain("message_stop");
  expect(wire.match(/\[Codex Tool: Shell cat proof.txt\]/g)).toHaveLength(1);
  expect(wire).toContain("cat proof.txt");
  expect(wire).not.toContain("commandExecution");
  expect(wire).not.toContain("RAW_TOOL_OUTPUT");
  const denied = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", body: "{}" });
  expect(denied.status).toBe(401);
});
test("does not inject OpenCode tool instructions or replay history on resumed turns", () => {
  const messages = [{ role: "system", content: "Use OpenCode's imaginary tool" }, { role: "user", content: "old" }, { role: "assistant", content: "old reply" }, { role: "user", content: "new" }];
  expect(buildCodexPrompt(messages, { includeHistory: false })).toBe("new");
  const fresh = buildCodexPrompt(messages, { includeHistory: true });
  expect(fresh).toContain("old reply");
  expect(fresh).not.toContain("imaginary tool");
});

test("persists thread mapping, replays completed retries and rejects uncertain retries", async () => {
  const { mkdtemp, rm, readdir, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runInSession, sessionKey } = await import("../src/session");
  const dir = await mkdtemp(join(tmpdir(), "codex-session-test-"));
  process.env.OPENCODE_CODEX_DATA_DIR = dir;
  try {
    const key = sessionKey(process.cwd(), "test-session");
    const options = { cwd: process.cwd(), model: "fake-model", prompt: "", messages: [{ role: "user", content: "hello" }], requestId: "message-1" };
    const first = await Array.fromAsync(runInSession(key, options));
    const file = (await readdir(dir)).find(f => f.endsWith(".json"))!;
    expect(JSON.parse(await readFile(join(dir, file), "utf8")).threadId).toBe("thread-test");
    // If a retry tried to spawn again this deliberately missing binary would fail.
    process.env.OPENCODE_CODEX_BIN = "/missing-codex-fixture";
    expect(await Array.fromAsync(runInSession(key, options))).toEqual(first);
    process.env.OPENCODE_CODEX_BIN = resolve("test/fixtures/fake-codex.mjs");
    const failed = { ...options, requestId: "message-2", messages: [{ role: "user", content: "FAIL_TURN" }] };
    expect((await Array.fromAsync(runInSession(key, failed))).at(-1)?.kind).toBe("error");
    await expect(Array.fromAsync(runInSession(key, failed))).rejects.toThrow("already started");
    expect((await readdir(dir)).some(f => f.endsWith(".lock"))).toBe(false);
  } finally {
    process.env.OPENCODE_CODEX_BIN = resolve("test/fixtures/fake-codex.mjs");
    delete process.env.OPENCODE_CODEX_DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
test("nonstreaming responses retain thinking and reject unsupported media", async () => {
  const headers = { "x-api-key": LOCAL_API_KEY, "content-type": "application/json", "x-opencode-codex-request-kind": "title" };
  const result = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hello" }] }) });
  const body = await result.json() as any;
  expect(body.content.some((p: any) => p.type === "thinking")).toBe(true);
  expect(body.stop_reason).toBe("end_turn");
  const media = await fetch(getProxyBaseUrl() + "/messages", { method: "POST", headers, body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }) });
  expect(media.status).toBe(400);
});

test("context policy overrides generic windows; metadata cannot replace Codex capabilities", async () => {
  const { modelMetadata } = await import("../src/metadata");
  const { configModel } = await import("../src/index");
  for (const context of [400000, 1050000]) {
    const meta = modelMetadata("gpt-fixture", { "openai/gpt-fixture": { family: "gpt", release_date: "2026-01-01", limit: { context, output: 128000 } } });
    expect(meta.contextWindow).toBe(272000);
    expect(meta.maxOutput).toBe(128000);
    const config = configModel({ ...meta, id: "gpt-fixture", name: "Official CLI name", description: "", nativeInputModalities: ["text", "image"], efforts: ["low"], isDefault: true });
    expect(config.limit.context).toBe(272000);
    expect(config.name).toBe("Official CLI name");
    expect(config.modalities.input).toEqual(["text"]);
    expect(config.tool_call).toBe(false);
    expect(config.options.includeUsage).toBe(false);
  }
  expect(modelMetadata("gpt-fixture", { "other/gpt-fixture": { limit: { output: 999999 } } }).maxOutput).toBe(32768);
});
test("every usage field on the provider wire is zero, and no usage endpoint exists", async () => {
  const response = await fetch(getProxyBaseUrl() + "/messages", {
    method: "POST", headers: { "x-api-key": LOCAL_API_KEY, "x-opencode-codex-request-kind": "title" },
    body: JSON.stringify({ model: "fake-model", stream: true, messages: [{ role: "user", content: "hello" }] }),
  });
  const wire = await response.text();
  const events = wire.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
  for (const event of events) {
    const usage = event.usage || event.message?.usage;
    if (usage) expect(Object.values(usage).every(n => n === 0)).toBe(true);
  }
  expect(events.find(e => e.type === "message_delta").usage.output_tokens).toBe(0);
  expect((await fetch(getProxyBaseUrl() + "/usage", { headers: { "x-api-key": LOCAL_API_KEY } })).status).toBe(404);
  const models = await (await fetch(getProxyBaseUrl() + "/models", { headers: { "x-api-key": LOCAL_API_KEY } })).json() as any;
  expect(models.data[0].limit.context).toBe(272000);
});

test("streams text before completion and separates every tool summary", async () => {
  await startProxy();
  const response = await fetch(getProxyBaseUrl() + "/messages", {
    method: "POST", headers: { "x-api-key": LOCAL_API_KEY, "x-opencode-codex-request-kind": "title" },
    body: JSON.stringify({ model: "fake-model", stream: true, messages: [{ role: "user", content: "DELAYED_STREAM" }] }),
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let wire = "";
  while (!wire.includes("First fragment.")) {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    wire += decoder.decode(chunk.value, { stream: true });
  }
  expect(wire).not.toContain("Second fragment.");
  expect(wire).not.toContain("message_stop");
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    wire += decoder.decode(chunk.value, { stream: true });
  }
  const events = wire.split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
  expect(events.filter(e => e.type === "content_block_start" && e.content_block.type === "thinking")).toHaveLength(2);
  expect(events.filter(e => e.delta?.type === "text_delta").map(e => e.delta.text).join("")).toBe("First fragment. Second fragment.");
  expect(events.filter(e => e.delta?.type === "thinking_delta").map(e => e.delta.thinking).join("")).toBe("[Codex Tool: Read a.ts]\n[Codex Tool: Read b.ts]\n");
});

test("nonstreaming responses also separate consecutive tool calls", async () => {
  const response = await fetch(getProxyBaseUrl() + "/messages", {
    method: "POST", headers: { "x-api-key": LOCAL_API_KEY, "x-opencode-codex-request-kind": "title" },
    body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "DELAYED_STREAM" }] }),
  });
  const body = await response.json() as any;
  expect(body.content.filter((p: any) => p.type === "thinking").map((p: any) => p.thinking)).toEqual([
    "[Codex Tool: Read a.ts]\n", "[Codex Tool: Read b.ts]\n",
  ]);
});
