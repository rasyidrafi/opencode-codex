import { ActivityTranslator } from "./activity.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import { CodexRpc } from "./rpc.js";
export type CodexUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd?: number };
export type CodexEvent =
 | { kind: "text" | "reasoning" | "activity"; text: string }
 | { kind: "error"; text: string }
 | { kind: "finish"; usage: CodexUsage; finishReason: string; sessionId?: string };
export type RunOptions = { cwd: string; prompt: string; model: string; effort?: string; signal?: AbortSignal; noSession?: boolean; readOnly?: boolean; threadId?: string; onThread?: (id: string) => Promise<void>; onActivity?: () => void };
export async function* streamCodex(options: RunOptions): AsyncGenerator<CodexEvent> {
  const rpc = new CodexRpc(options.cwd);
  const queue: CodexEvent[] = [];
  let wake: (() => void) | undefined;
  let threadId = options.threadId;
  let turnId: string | undefined;
  let finished = false;
  let interruption: Promise<unknown> | undefined;
  const seen = new Map<string, string>();
  const activity = new ActivityTranslator();
  let usage: CodexUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const push = (e: CodexEvent) => { queue.push(e); wake?.(); };
  const interrupt = () => {
    if (threadId && turnId) interruption ||= rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    else rpc.close();
    finished = true; wake?.();
  };
  const configuredTimeout = Number(process.env.OPENCODE_CODEX_STALL_MS || 600000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 600000;
  let lastActivity = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - lastActivity > timeoutMs) { push({ kind: "error", text: "Codex stopped sending activity" }); interrupt(); }
  }, Math.min(timeoutMs, 5000));
  rpc.listeners.add((method, p) => {
    if (method === "adapter/error") { push({ kind: "error", text: p.message }); finished = true; return; }
    if (p?.threadId !== threadId) return;
    lastActivity = Date.now();
    options.onActivity?.();
    if (method === "turn/started") { turnId = p.turn.id; if (options.signal?.aborted) interrupt(); }
    if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta") {
      seen.set(p.itemId, (seen.get(p.itemId) || "") + p.delta);
      push({ kind: method.includes("agentMessage") ? "text" : "reasoning", text: p.delta });
    }
    if (method === "item/started" || method === "item/completed") {
      const i = p.item;
      if (i.type === "agentMessage" && method === "item/completed") {
        const sent = seen.get(i.id) || "";
        if (!sent && i.text) push({ kind: "text", text: i.text });
        else if (i.text?.startsWith(sent) && i.text.length > sent.length) push({ kind: "text", text: i.text.slice(sent.length) });
      } else if (i.type === "reasoning" && method === "item/completed" && !seen.has(i.id)) {
        const summary = (i.summary || []).join("\n");
        if (summary) push({ kind: "reasoning", text: summary });
      } else {
        const text = activity.item(method, i);
        if (text) push({ kind: "activity", text });
      }
    }
    if (method === "adapter/requestDeclined") push({ kind: "activity", text: `Codex requested unsupported interaction: ${p.method}. Declined.\n` });
    if (method === "thread/tokenUsage/updated") {
      const u = p.tokenUsage.last;
      usage = { inputTokens: Math.max(0, u.inputTokens - u.cachedInputTokens), outputTokens: u.outputTokens, cacheReadTokens: u.cachedInputTokens, cacheWriteTokens: 0 };
    }
    if (method === "turn/completed") {
      if (p.turn.status === "failed") push({ kind: "error", text: p.turn.error?.message || "Codex turn failed" });
      else if (p.turn.status === "interrupted") push({ kind: "error", text: "Codex turn was interrupted" });
      else push({ kind: "finish", usage, finishReason: p.turn.status, sessionId: threadId });
      finished = true; wake?.();
    }
  });
  options.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    if (options.signal?.aborted) return;
    await rpc.initialize();
    const sandbox = options.noSession || options.readOnly ? "read-only" : process.env.OPENCODE_CODEX_SANDBOX || "danger-full-access";
    if (!["read-only", "workspace-write", "danger-full-access"].includes(sandbox)) throw new Error("Invalid OPENCODE_CODEX_SANDBOX");
    const params: ThreadStartParams = { cwd: options.cwd, model: options.model, approvalPolicy: "never", sandbox: sandbox as ThreadStartParams["sandbox"] };
    const result = threadId
      ? await rpc.request("thread/resume", { ...params, threadId })
      : await rpc.request("thread/start", { ...params, ephemeral: !!options.noSession, developerInstructions: "You are running inside OpenCode. Use your own Codex tools to complete the user's task. Tool activity is displayed by the host. Ask any questions as ordinary assistant text. The host cannot answer interactive tool questionnaires." });
    threadId = result.thread.id;
    await options.onThread?.(threadId!);
    if (options.signal?.aborted) return;
    const turnParams: TurnStartParams = { threadId: threadId!, input: [{ type: "text", text: options.prompt, text_elements: [] }], model: options.model, ...(options.effort ? { effort: options.effort as TurnStartParams["effort"] } : {}) };
    const started = await rpc.request("turn/start", turnParams);
    turnId = started.turn.id;
    if (options.signal?.aborted) interrupt();
    while (!finished || queue.length) {
      if (queue.length) yield queue.shift()!;
      else await new Promise<void>(r => { wake = r; });
    }
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener("abort", interrupt);
    if (!finished && threadId && turnId) interruption ||= rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    if (interruption) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([interruption, new Promise(r => { timer = setTimeout(r, 2000); })]);
      clearTimeout(timer);
    }
    rpc.close();
  }
}
