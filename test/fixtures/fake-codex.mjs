#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = x => process.stdout.write(JSON.stringify(x) + "\n");
const notify = (method, params) => send({ method, params: { threadId: "thread-test", ...params } });
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "model/list") result = { data: [{ id: "fake-model", model: "fake-model", displayName: "Fake", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null };
  if (m.method === "thread/start" || m.method === "thread/resume") result = { thread: { id: "thread-test" } };
  if (m.method === "turn/start") {
    result = { turn: { id: "turn-test" } };
    send({ id: m.id, result });
    notify("turn/started", { turn: { id: "turn-test" } });
    if (m.params.input.some(item => item.type === "image" && item.url === "data:image/png;base64,AAAA")) {
      notify("item/agentMessage/delta", { itemId: "message", delta: "Image received." });
      notify("item/completed", { item: { id: "message", type: "agentMessage", text: "Image received." } });
      notify("turn/completed", { turn: { status: "completed" } });
      return;
    }
    if (m.params.input[0].text.includes("WAIT_FOREVER")) return;
    if (m.params.input[0].text.includes("FAIL_TURN")) {
      notify("turn/completed", { turn: { status: "failed", error: { message: "fixture failure" } } }); return;
    }
    if (m.params.input[0].text.includes("DELAYED_STREAM")) {
      notify("item/agentMessage/delta", { itemId: "message", delta: "First fragment." });
      setTimeout(() => {
        notify("item/agentMessage/delta", { itemId: "message", delta: " Second fragment." });
        notify("item/completed", { item: { id: "message", type: "agentMessage", text: "First fragment. Second fragment." } });
        for (const [id, path] of [["read1", "a.ts"], ["read2", "b.ts"]]) {
          const item = { id, type: "commandExecution", commandActions: [{ type: "read", path }] };
          notify("item/started", { item });
          notify("item/completed", { item: { ...item, status: "completed" } });
        }
        notify("turn/completed", { turn: { status: "completed" } });
      }, 800);
      return;
    }
    notify("item/agentMessage/delta", { itemId: "message", delta: "Working." });
    notify("item/completed", { item: { id: "message", type: "agentMessage", text: "Working." } });
    notify("item/reasoning/summaryTextDelta", { itemId: "reason", delta: "Checking the file." });
    notify("item/started", { item: { id: "cmd", type: "commandExecution", command: "cat proof.txt" } });
    notify("item/started", { item: { id: "cmd", type: "commandExecution", command: "cat proof.txt" } });
    notify("item/commandExecution/outputDelta", { itemId: "cmd", delta: "RAW_TOOL_OUTPUT\n" });
    notify("item/completed", { item: { id: "cmd", type: "commandExecution", command: "cat proof.txt", status: "completed", exitCode: 0 } });
    notify("item/completed", { item: { id: "final", type: "agentMessage", text: "Done." } });
    notify("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 } } });
    notify("turn/completed", { turn: { status: "completed" } });
    return;
  }
  if (m.method === "turn/interrupt") notify("turn/completed", { turn: { status: "interrupted" } });
  send({ id: m.id, result });
});
