import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import {
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_SSE_HEARTBEAT_MS,
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  LOCAL_API_KEY,
  MODEL_HEADER,
  PROVIDER_ID,
  REQUEST_KIND_HEADER,
  SESSION_HEADER,
  envNumber,
} from "./constants.js";
import { streamCodex, type CodexEvent } from "./agent.js";
import { getCodexModels, refreshModels, resolveCodexModel, type CodexModel } from "./models.js";
import { buildCodexPrompt, isUtility, type OpenAIMessage } from "./prompt.js";
import { runInSession, sessionKey } from "./session.js";

import { log } from "./log.js";

type AnthropicMessageRequest = {
  model?: unknown;
  messages?: unknown;
  system?: unknown;
  stream?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  [key: string]: unknown;
};

type Runtime = {
  directory: string;
  models: CodexModel[];
};

type OrderedSegment = {
  kind: "text" | "thinking";
  text: string;
};

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

let server: ReturnType<typeof Bun.serve> | null = null;
let proxyPort: number | null = null;
let runtime: Runtime | null = null;
let starting: Promise<number> | undefined;
const workspaceRoots = new Set<string>();

function requestedPort(): number {
  const value = envNumber("OPENCODE_CODEX_PROXY_PORT", 0, 0);
  return value < 65_536 ? Math.floor(value) : 0;
}

function readHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value || undefined;
}

function authorized(request: Request): boolean {
  const bearer = request.headers.get("authorization")?.trim();
  const apiKey = request.headers.get("x-api-key")?.trim();
  return bearer === `Bearer ${LOCAL_API_KEY}` || apiKey === LOCAL_API_KEY;
}

function withinWorkspace(directory: string): boolean {
  const candidate = resolve(directory);
  return [...workspaceRoots].some((root) => {
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
  });
}

async function readJson(request: Request): Promise<AnthropicMessageRequest> {
  const max = Math.floor(envNumber("OPENCODE_CODEX_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES, 1_024));
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new Error("The request body is too large");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > max) throw new Error("The request body is too large");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The request body must be an object");
  return parsed as AnthropicMessageRequest;
}

function errorResponse(message: string, status = 502): Response {
  const lower = message.toLowerCase();
  const authentication = /not authenticated|authentication|login required|logged in/.test(lower);
  return Response.json(
    {
      type: "error",
      error: {
        type: authentication ? "authentication_error" : "api_error",
        message,
      },
    },
    { status: authentication ? 401 : status },
  );
}

function zeroAnthropicUsage(): Record<string, number> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function completionId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

function stopReason(value: string): "end_turn" | "max_tokens" {
  return /max_turns|max[_-]?tokens|length/i.test(value) ? "max_tokens" : "end_turn";
}

function responseModel(bodyModel: unknown, selected: string): string {
  return typeof bodyModel === "string" && bodyModel ? bodyModel : selected;
}

function contentBlock(kind: "text" | "thinking", text = ""): Record<string, unknown> {
  return kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text };
}

function appendSegment(segments: OrderedSegment[], kind: OrderedSegment["kind"], text: string): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else segments.push({ kind, text });
}

type ProbedEvents = { events: AsyncIterable<CodexEvent> } | { error: Error };

async function probeFirstEvent(events: AsyncIterable<CodexEvent>): Promise<ProbedEvents> {
  const iterator = events[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    if (first.done) return { error: new Error("Codex ended without a response") };
    if (first.value.kind === "error") {
      await iterator.return?.();
      return { error: new Error(first.value.text) };
    }
    return { events: replayEvents(first.value, iterator) };
  } catch (error) {
    await iterator.return?.();
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function* replayEvents(
  first: CodexEvent,
  rest: AsyncIterator<CodexEvent>,
): AsyncGenerator<CodexEvent, void, unknown> {
  yield first;
  try {
    while (true) {
      const next = await rest.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await rest.return?.();
  }
}

async function handleMessages(request: Request, body: AnthropicMessageRequest): Promise<Response> {
  if (!runtime) return errorResponse("Codex proxy is not initialized", 500);
  const directory = resolve(readHeader(request, DIRECTORY_HEADER) || runtime.directory);
  if (!withinWorkspace(directory)) return errorResponse("The requested workspace is outside the plugin workspace", 403);

  if (!Array.isArray(body.messages)) throw new Error("`messages` must be an array");
  const messages = body.messages as OpenAIMessage[];
  const allMessages: OpenAIMessage[] = body.system === undefined
    ? messages
    : [{ role: "system", content: body.system }, ...messages];
  const model = resolveCodexModel(
    readHeader(request, MODEL_HEADER) || (typeof body.model === "string" ? body.model : undefined),
  );
  const sessionId = readHeader(request, SESSION_HEADER);
  const titleRequest = ["title", "summary"].includes(readHeader(request, REQUEST_KIND_HEADER) || "") || isUtility(allMessages);
  const key = sessionKey(directory, sessionId, JSON.stringify(allMessages));
  const prompt = titleRequest ? buildCodexPrompt(allMessages, { includeHistory: true, utility: true }) : "";
  const effort = readHeader(request, EFFORT_HEADER);
  if (effort && !getCodexModels().find(m => m.id === model)?.efforts.includes(effort)) throw new Error("Unsupported Codex reasoning effort");
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  if (request.signal.aborted) abort.abort();
  const events: AsyncIterable<CodexEvent> = titleRequest
    ? streamCodex({
        cwd: directory,
        prompt,
        model,
        effort,
        noSession: true,
        signal: abort.signal,
      })
    : runInSession(key, {
        cwd: directory,
        prompt,
        model,
        effort,
        messages: allMessages,
        requestId: readHeader(request, "x-opencode-codex-message"),
        readOnly: readHeader(request, "x-opencode-codex-mode") === "plan",
        signal: abort.signal,
      });

  if (body.stream !== true) {
    const segments: OrderedSegment[] = [];
    let finish = "end_turn";
    try {
      for await (const event of events) {
        if (event.kind === "text") appendSegment(segments, "text", event.text);
        else if (event.kind === "reasoning") appendSegment(segments, "thinking", event.text);
        else if (event.kind === "activity") segments.push({ kind: "thinking", text: event.text });
        else if (event.kind === "finish") {
          finish = stopReason(event.finishReason);

        } else if (event.kind === "error") return errorResponse(event.text);
      }
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error));
    }
    return Response.json({
      id: completionId(),
      type: "message",
      role: "assistant",
      model: responseModel(body.model, model),
      content: segments.map((segment, index) => segment.kind === "text"
        ? { type: "text", text: segment.text }
        : { type: "thinking", thinking: segment.text, signature: `codex-${index}` }),
      stop_reason: finish,
      stop_sequence: null,
      // Deliberately zero. The real CLI usage never crosses the provider wire.
      usage: zeroAnthropicUsage(),
    });
  }

  const probed = await probeFirstEvent(events);
  if ("error" in probed) return errorResponse(probed.error.message);
  return streamAnthropic(probed.events, responseModel(body.model, model), key, titleRequest, abort.signal, abort);
}

function streamAnthropic(
  events: AsyncIterable<CodexEvent>,
  model: string,
  session: string,
  titleRequest: boolean,
  signal: AbortSignal,
  abort: AbortController,
): Response {
  const id = completionId();
  const encoder = new TextEncoder();
  let closed = false;
  let iterator: AsyncIterator<CodexEvent> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      iterator = events[Symbol.asyncIterator]();
      const send = (payload: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      let nextBlockIndex = 0;
      let active: { index: number; kind: "text" | "thinking" } | undefined;
      let finish: "end_turn" | "max_tokens" = "end_turn";

      const closeBlock = () => {
        if (!active) return;
        if (active.kind === "thinking") {
          send({
            type: "content_block_delta",
            index: active.index,
            delta: { type: "signature_delta", signature: `codex-${id}-${active.index}` },
          });
        }
        send({ type: "content_block_stop", index: active.index });
        active = undefined;
      };
      const openBlock = (kind: "text" | "thinking") => {
        if (active?.kind === kind) return;
        closeBlock();
        active = { index: nextBlockIndex++, kind };
        send({ type: "content_block_start", index: active.index, content_block: contentBlock(kind) });
      };
      const emitBlock = (kind: "text" | "thinking", text: string, separate = false) => {
        if (!text) return;
        if (separate) closeBlock();
        openBlock(kind);
        send({
          type: "content_block_delta",
          index: active!.index,
          delta: kind === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text },
        });
        if (separate) closeBlock();
      };

      const handleEvent = (event: CodexEvent): boolean => {
        if (event.kind === "text") emitBlock("text", event.text);
        else if (event.kind === "reasoning") emitBlock("thinking", event.text);
        else if (event.kind === "activity") emitBlock("thinking", event.text, true);
        else if (event.kind === "finish") {
          finish = stopReason(event.finishReason);

        } else if (event.kind === "error") {
          closeBlock();
          send({ type: "error", error: { type: "api_error", message: event.text } });
          return true;
        }
        return false;
      };

      send({
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: zeroAnthropicUsage(),
        },
      });
      heartbeat = setInterval(() => send({ type: "ping" }), DEFAULT_SSE_HEARTBEAT_MS);
      heartbeat.unref?.();

      try {
        if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
        let next = await iterator.next();
        if (!next.done && handleEvent(next.value)) return;
        while (!next.done) {
          if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
          next = await iterator.next();
          if (!next.done && handleEvent(next.value)) return;
        }
        closeBlock();
        send({ type: "message_delta", delta: { stop_reason: finish, stop_sequence: null }, usage: zeroAnthropicUsage() });
        send({ type: "message_stop" });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          closeBlock();
          send({ type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : String(error) } });
        }
      } finally {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        await iterator?.return?.();
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    async cancel() {
      abort.abort();
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      await iterator?.return?.();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const protectedRoute =
    (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) ||
    (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages"));
  if (protectedRoute && !authorized(request)) return errorResponse("Invalid local proxy API key", 401);
  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
    return Response.json({ ok: true, provider: PROVIDER_ID, proxy: "loopback", port: proxyPort });
  }
  if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    return Response.json({ object: "list", data: (runtime?.models ?? getCodexModels()).map((entry) => ({ id: entry.id, object: "model", owned_by: "codex-app-server", name: entry.name, description: entry.description, family: entry.family, release_date: entry.releaseDate, limit: { context: entry.contextWindow, output: entry.maxOutput }, reasoning_efforts: entry.efforts, native_input_modalities: entry.nativeInputModalities, metadata_sources: entry.sources })) });
  }
  if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
    try {
      return await handleMessages(request, await readJson(request));
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : String(error), 400);
    }
  }
  return new Response("Not Found", { status: 404 });
}

export async function startProxy(directory = process.cwd()): Promise<number> {
  workspaceRoots.add(resolve(directory));
  if (server && proxyPort) return proxyPort;
  if (starting) return starting;
  starting = (async () => {
  runtime = { directory: resolve(directory), models: await refreshModels(directory) };
  server = Bun.serve({ hostname: "127.0.0.1", port: requestedPort(), idleTimeout: 0, fetch: handleRequest });
  proxyPort = server.port ?? null;
  if (!proxyPort) throw new Error("Codex proxy did not receive a port");
  log.info("Codex loopback proxy listening", { port: proxyPort });
  return proxyPort;
  })();
  try { return await starting; } finally { starting = undefined; }
}

export async function stopProxy(directory?: string): Promise<void> {
  if (starting) await starting.catch(() => {});
  if (directory) workspaceRoots.delete(resolve(directory));
  else workspaceRoots.clear();
  if (workspaceRoots.size > 0) return;
  if (server) server.stop(true);
  server = null;
  proxyPort = null;
  runtime = null;
}

export function getProxyPort(): number | null {
  return proxyPort;
}

export function getProxyBaseUrl(): string {
  if (!proxyPort) throw new Error("Codex proxy is not running");
  return `http://127.0.0.1:${proxyPort}/v1`;
}

export function setRuntimeModels(models: CodexModel[]): void {
  if (runtime) runtime.models = models;
}
