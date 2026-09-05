import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshModels } from "../src/models";
import { streamCodex } from "../src/agent";
test("real Codex edits, executes, streams and resumes a thread", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-codex-live-"));
  const models = await refreshModels(cwd);
  const model = process.env.OPENCODE_CODEX_TEST_MODEL || models.find(m => m.isDefault)!.id;
  let threadId: string | undefined;
  try {
    const events = [];
    for await (const event of streamCodex({ cwd, model, prompt: "Create proof.txt containing exactly codex-wrapper-ok. Run a shell command to read it back. Remember the secret word marigold for my next message. Reply DONE.", onThread: async id => { threadId = id; } })) events.push(event);
    expect(events.filter(e => e.kind === "error")).toEqual([]);
    expect(await readFile(join(cwd, "proof.txt"), "utf8")).toContain("codex-wrapper-ok");
    expect(events.some(e => e.kind === "activity")).toBe(true);
    expect(events.some(e => e.kind === "finish")).toBe(true);
    let reply = "";
    for await (const event of streamCodex({ cwd, model, threadId, prompt: "What secret word did I ask you to remember? Reply with just that word." })) {
      if (event.kind === "error") throw new Error(event.text);
      if (event.kind === "text") reply += event.text;
    }
    expect(reply.toLowerCase()).toContain("marigold");
    console.log("Live model:", model, "events:", events.map(e => e.kind).join(","));
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 240000);

test("real Codex turn can be interrupted during a running command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-codex-cancel-"));
  const models = await refreshModels(cwd);
  const model = process.env.OPENCODE_CODEX_TEST_MODEL || models.find(m => m.isDefault)!.id;
  const controller = new AbortController();
  let abortedAt = 0;
  const fallback = setTimeout(() => controller.abort(), 60000);
  try {
    for await (const event of streamCodex({ cwd, model, noSession: true, signal: controller.signal, prompt: "Run the shell command sleep 30 now. Do not run any other commands." })) {
      if (event.kind === "activity" && event.text === "[Codex tool: shell]\n") {
        abortedAt = Date.now();
        controller.abort();
      }
    }
    expect(abortedAt).toBeGreaterThan(0);
    expect(Date.now() - abortedAt).toBeLessThan(5000);
  } finally { clearTimeout(fallback); await rm(cwd, { recursive: true, force: true }); }
}, 90000);
