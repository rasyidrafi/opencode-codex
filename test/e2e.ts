import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { refreshModels } from "../src/models";
test("OpenCode loads plugin, edits through Codex and resumes across processes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencode-codex-e2e-"));
  const catalog = await refreshModels(cwd);
  const model = process.env.OPENCODE_CODEX_TEST_MODEL || catalog.find(m => m.isDefault)!.id;
  const config = join(cwd, "opencode.json");
  await writeFile(config, JSON.stringify({ plugin: [resolve(process.env.OPENCODE_CODEX_TEST_PLUGIN || "opencode-codex.js")], model: "codex/" + model }));
  const env = { ...process.env, OPENCODE_CONFIG: config, OPENCODE_CODEX_DATA_DIR: join(cwd, "sessions"), OPENCODE_DISABLE_DEFAULT_PLUGINS: "true" };
  async function run(prompt: string, session?: string) {
    const p = Bun.spawn(["opencode", "run", "--dir", cwd, "--model", "codex/" + model, "--format", "json", "--thinking", ...(session ? ["--session", session] : []), prompt], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => p.kill(), 180000);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timeout);
    expect(code, stderr + stdout).toBe(0);
    const events = stdout.split("\n").filter(l => l.startsWith("{")).map(l => JSON.parse(l));
    expect(events.some(e => e.type === "error"), stdout + stderr).toBe(false);
    return { events, stdout };
  }
  try {
    const listing = Bun.spawn(["opencode", "models", "codex", "--verbose"], { cwd, env, stdout: "pipe", stderr: "pipe" });
    const [listed, listingErrors, listingCode] = await Promise.all([new Response(listing.stdout).text(), new Response(listing.stderr).text(), listing.exited]);
    expect(listingCode, listingErrors).toBe(0);
    expect(listed).toContain("codex/" + model);
    expect(listed).toMatch(/"context":\s*272000/);
    expect(listed).not.toMatch(/"context":\s*(1000000|1050000|400000)/);
    const first = await run("Create e2e-proof.txt containing exactly opencode-codex-e2e-ok. Read it using a shell command to verify. Remember the secret word juniper for my next message. Reply DONE.");
    expect(await readFile(join(cwd, "e2e-proof.txt"), "utf8")).toContain("opencode-codex-e2e-ok");
    expect(first.events.some(e => e.type === "reasoning"), first.stdout).toBe(true);
    expect(first.events.some(e => e.type === "tool_use"), first.stdout).toBe(false);
    const finish = first.events.find(e => e.type === "step_finish");
    expect(finish?.part?.tokens?.input, first.stdout).toBe(0);
    expect(finish?.part?.tokens?.output, first.stdout).toBe(0);
    const session = first.events.find(e => e.sessionID)?.sessionID;
    expect(session).toBeTruthy();
    const second = await run("What secret word did I ask you to remember? Reply only with the word.", session);
    expect(second.stdout.toLowerCase()).toContain("juniper");
    console.log("OpenCode E2E passed:", model, session);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 420000);
