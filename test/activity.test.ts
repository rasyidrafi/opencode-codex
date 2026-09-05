import { test, expect } from "bun:test";
import { ActivityTranslator } from "../src/activity";

test("shows arguments once per call, retaining separate calls and failures", () => {
  const a = new ActivityTranslator();
  const item = { id: "1", type: "commandExecution", command: "/bin/bash -lc 'npm run check'" };
  expect(a.item("item/started", item)).toBe("[Codex Tool: Shell npm run check]\n");
  expect(a.item("item/started", item)).toBeUndefined();
  expect(a.item("item/completed", { ...item, status: "completed", exitCode: 0 })).toBeUndefined();
  expect(a.item("item/started", { ...item, id: "2" })).toBe("[Codex Tool: Shell npm run check]\n");
  expect(a.item("item/completed", { ...item, id: "2", status: "completed", exitCode: 1 })).toBe("[Codex Tool failed: Shell npm run check, exit 1]\n");
  expect(a.item("item/completed", { ...item, id: "2", exitCode: 1 })).toBeUndefined();
});

test("summarizes structured paths, ranges, searches, patches and MCP arguments", () => {
  const a = new ActivityTranslator();
  const show = (item: any) => a.item("item/started", { id: JSON.stringify(item), ...item });
  expect(show({ type: "commandExecution", commandActions: [{ type: "read", path: "src/agent.ts", command: "sed -n '1,180p' src/agent.ts" }] })).toBe("[Codex Tool: Read src/agent.ts, lines 1–180]\n");
  expect(show({ type: "commandExecution", commandActions: [{ type: "search", query: "delta", path: "src/" }] })).toBe('[Codex Tool: Search "delta" in src/]\n');
  expect(show({ type: "commandExecution", commandActions: [{ type: "listFiles", path: "src/" }] })).toBe("[Codex Tool: List src/]\n");
  expect(show({ type: "fileChange", changes: [{ path: "src/activity.ts", diff: "PRIVATE BODY" }] })).toBe("[Codex Tool: Edit src/activity.ts]\n");
  expect(show({ type: "webSearch", query: "Codex streaming" })).toBe("[Codex Tool: Web search: Codex streaming]\n");
  expect(show({ type: "mcpToolCall", server: "docs", tool: "search", arguments: { query: "streaming", content: "PRIVATE BODY", token: "SECRET" } })).toBe('[Codex Tool: docs/search: {"query":"streaming","content":"[omitted]","token":"[omitted]"}]\n');
  expect(show({ type: "collabAgentToolCall", tool: "spawnAgent" })).toBe("[Codex Tool: spawnAgent]\n");
  expect(show({ type: "commandExecution", command: "x".repeat(1000) })).toHaveLength(255);
  expect(show({ type: "futureEvent" })).toBeUndefined();
});

test("completion-only calls remain visible", () => {
  const a = new ActivityTranslator();
  expect(a.item("item/completed", { id: "1", type: "imageView", path: "plot.png" })).toBe("[Codex Tool: View image plot.png]\n");
  expect(a.item("item/completed", { id: "1", type: "imageView", path: "plot.png" })).toBeUndefined();
});
