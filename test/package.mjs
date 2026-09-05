import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), "opencode-codex-package-"));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 480000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || command + " failed");
  return result.stdout;
}
try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temp]));
  await writeFile(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temp, packed[0].filename)], { cwd: temp });
  const entry = join(temp, "node_modules", "@rasyid_rafi", "opencode-codex", "opencode-codex.js");
  const result = run("bun", ["test", resolve("test/e2e.ts")], { env: { ...process.env, OPENCODE_CODEX_TEST_PLUGIN: entry } });
  console.log(result);
  console.log("Installed tarball E2E passed:", packed[0].filename);
} finally { await rm(temp, { recursive: true, force: true }); }
