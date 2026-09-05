import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamCodex, type RunOptions, type CodexEvent } from "./agent.js";
import { buildCodexPrompt, type OpenAIMessage } from "./prompt.js";
const tails = new Map<string, Promise<void>>();
type Record = { threadId?: string; request?: string; state?: "started" | "completed"; events?: CodexEvent[] };
export function sessionKey(directory: string, sessionId: string | undefined, _prompt?: string) {
  return createHash("sha256").update(directory + "\0" + (sessionId || randomUUID())).digest("hex");
}
function path(key: string) {
  return join(process.env.OPENCODE_CODEX_DATA_DIR || join(homedir(), ".local", "share", "opencode-codex"), key + ".json");
}
async function save(file: string, record: Record) {
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
  await rename(temp, file);
}
// The in-process queue handles ordinary concurrent requests. The file lock
// prevents two OpenCode processes from mutating the same Codex thread.
async function lock(file: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file + ".lock", "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(await readFile(file + ".lock", "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid Codex session lock");
      try { process.kill(pid, 0); }
      catch (error: any) {
        if (error.code === "ESRCH") { await unlink(file + ".lock"); continue; }
        throw error;
      }
      throw new Error("This Codex session is busy in another OpenCode process");
    }
  }
  throw new Error("Could not acquire Codex session lock");
}
export async function* runInSession(key: string, options: RunOptions & { messages: OpenAIMessage[]; requestId?: string }): AsyncGenerator<CodexEvent> {
  const previous = tails.get(key) || Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(r => { release = r; });
  tails.set(key, tail);
  await previous;
  let locked = false;
  const file = path(key);
  try {
    if (options.signal?.aborted) return;
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    await lock(file); locked = true;
    let record: Record = {};
    try { record = JSON.parse(await readFile(file, "utf8")); }
    catch (e: any) { if (e.code !== "ENOENT") throw new Error("Could not read Codex session mapping"); }
    const request = createHash("sha256").update(options.requestId || JSON.stringify(options.messages)).digest("hex");
    if (record.request === request) {
      if (record.state === "completed" && record.events) { yield* record.events; return; }
      throw new Error("This request already started in Codex. Send a new message to continue; automatic replay could repeat workspace changes.");
    }
    const events: CodexEvent[] = [];
    let cachedBytes = 0;
    let cacheable = true;
    let completed = false;
    yield* (async function* () {
      for await (const event of streamCodex({
        ...options, threadId: record.threadId,
        prompt: buildCodexPrompt(options.messages, { includeHistory: !record.threadId }),
        onThread: async id => {
          record = { threadId: id, request, state: "started" };
          await save(file, record);
        },
      })) {
        if (event.kind === "finish") completed = event.finishReason === "completed";
        cachedBytes += JSON.stringify(event).length;
        if (cachedBytes <= 2_000_000) events.push(event); else cacheable = false;
        yield event;
      }
    })();
    if (completed) await save(file, { ...record, state: "completed", ...(cacheable ? { events } : {}) });
  } finally {
    try { if (locked) await unlink(file + ".lock"); }
    finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }
}
