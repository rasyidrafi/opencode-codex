import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  listeners = new Set<(method: string, params: any) => void>();
  closed = false;
  constructor(cwd: string, executable = process.env.OPENCODE_CODEX_BIN || "codex", args = ["app-server", "--listen", "stdio://"]) {
    this.child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume(); // Never forward credential-bearing server diagnostics into the UI.
    createInterface({ input: this.child.stdout }).on("line", line => {
      try { this.receive(JSON.parse(line)); } catch { this.fail(new Error("Invalid Codex app-server protocol message")); }
    });
    this.child.on("error", e => this.fail(e));
    this.child.on("exit", (code) => this.fail(new Error(`Codex app-server exited (${code})`)));
    this.child.stdin.on("error", e => this.fail(e));
  }
  private send(value: unknown) {
    if (this.closed) throw new Error("Codex app-server is closed");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  private receive(msg: any) {
    if (msg.method && msg.id !== undefined) {
      // V1 uses a noninteractive policy. Never leave an unexpected approval hanging.
      if (msg.method === "item/permissions/requestApproval") this.send({ id: msg.id, result: { permissions: {}, scope: "turn" } });
      else if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(msg.method)) this.send({ id: msg.id, result: { decision: "decline" } });
      else this.send({ id: msg.id, error: { code: -32601, message: "Interactive requests are not supported by this provider. Use a normal chat question." } });
      for (const listener of this.listeners) listener("adapter/requestDeclined", { ...msg.params, method: msg.method });
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    } else if (msg.method) {
      for (const listener of this.listeners) listener(msg.method, msg.params);
    }
  }
  request(method: string, params: unknown = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC timed out: ${method}`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async initialize() {
    await this.request("initialize", { clientInfo: { name: "opencode_codex", title: "OpenCode Codex", version: "0.1.0" } });
    this.send({ method: "initialized" });
  }
  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener("adapter/error", { message: error.message });
  }
  close() {
    this.fail(new Error("Codex app-server stopped"));
    this.child.stdin.end(); this.child.kill();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000); timer.unref();
  }
}
