import { test, expect } from "bun:test";
import { ActivityTranslator } from "../src/activity";

test("a shell call's repeated start, output and completion produce one compact marker", () => {
  const activity = new ActivityTranslator();
  const item = { id: "call-1", type: "commandExecution", command: "/bin/bash -lc 'cat README.md package.json'" };
  expect(activity.item("item/started", item)).toBe("[Codex tool: shell]\n");
  expect(activity.item("item/started", item)).toBeUndefined();
  expect(activity.item("item/completed", { ...item, status: "completed" })).toBeUndefined();
  expect(activity.item("item/started", { ...item, id: "call-2" })).toBe("[Codex tool: shell]\n");
});

test("normalizes structured command actions and Codex tool kinds", () => {
  const activity = new ActivityTranslator();
  for (const [type, name] of [["read", "read"], ["listFiles", "list"], ["search", "search"], ["unknown", "shell"]]) {
    expect(activity.item("item/started", { id: type!, type: "commandExecution", commandActions: [{ type: type! }] })).toBe(`[Codex tool: ${name}]\n`);
  }
  for (const [type, name] of [["fileChange", "apply_patch"], ["webSearch", "web_search"], ["imageView", "view_image"]]) {
    expect(activity.item("item/started", { id: type!, type: type! })).toBe(`[Codex tool: ${name}]\n`);
  }
  expect(activity.item("item/started", { id: "mcp", type: "mcpToolCall", server: "docs", tool: "search" })).toBe("[Codex tool: docs/search]\n");
  expect(activity.item("item/started", { id: "agent", type: "collabToolCall", tool: "spawn_agent" })).toBe("[Codex tool: spawn_agent]\n");
});

test("completion-only calls remain visible, failures appear once, unknown events stay hidden", () => {
  const activity = new ActivityTranslator();
  expect(activity.item("item/completed", { id: "a", type: "fileChange", status: "completed" })).toBe("[Codex tool: apply_patch]\n");
  expect(activity.item("item/completed", { id: "a", type: "fileChange", status: "completed" })).toBeUndefined();
  expect(activity.item("item/started", { id: "b", type: "commandExecution" })).toBe("[Codex tool: shell]\n");
  expect(activity.item("item/completed", { id: "b", type: "commandExecution", status: "failed" })).toBe("[Codex tool failed: shell]\n");
  expect(activity.item("item/completed", { id: "b", type: "commandExecution", status: "failed" })).toBeUndefined();
  expect(activity.item("item/completed", { id: "c", type: "futureInternalEvent" })).toBeUndefined();
});
