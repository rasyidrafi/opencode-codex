# opencode-codex

Use Codex inside OpenCode while Codex runs its own coding loop, commands, file edits, MCP tools, and context compaction.

```text
OpenCode → local Anthropic Messages proxy → JSON-RPC over stdio → codex app-server
```

Codex tool activity appears as ordered reasoning/status blocks. OpenCode does not execute those tools. Assistant commentary and final answers appear as ordinary text.

## Install

Requires Bun, OpenCode, and an installed, authenticated Codex CLI. Tested with OpenCode 1.18.29, Codex CLI 0.153.4, and Bun 1.4.1.

Authenticate Codex once with `codex login`, then add the npm package to your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@rasyid_rafi/opencode-codex@0.1.4"]
}
```

OpenCode installs the plugin automatically. The npm package includes compiled JavaScript; users do not need to clone this repository or build it.

For development from a checkout:

```sh
npm install
npm run build
```

This checkout uses the published npm package by default. To test local changes interactively, replace the plugin entry in `opencode.json` with `./opencode-codex.js` after building. Other projects can reference the absolute path to that entrypoint.

Restart OpenCode, select the **Codex** provider, and choose a model. The plugin reads the model list and supported reasoning efforts from your installed Codex app-server. To inspect the available IDs:

```sh
opencode models codex
opencode run --model codex/YOUR_MODEL_ID --thinking "Explain this repository"
```

Codex reads its existing configuration and credentials. The plugin only stores a fixed, non-secret local provider marker in OpenCode. It does not copy OAuth tokens or call the model API directly.

## Behavior

- Each active turn runs an isolated app-server process. Codex keeps running its tools until the turn finishes. The process closes afterward; the Codex thread persists.
- Workspace and OpenCode session ID identify the saved Codex thread. Later turns resume that thread, including after OpenCode restarts.
- Completed provider retries replay the cached response. Interrupted or uncertain requests cannot automatically run again. Send a new message to continue. Response caches are limited to 2 MB; larger responses also require a new message instead of automatic replay.
- Turns in a conversation run sequentially. A file lock prevents another OpenCode process from editing through the same thread concurrently.
- Stop/disconnect sends `turn/interrupt`, then closes the worker.
- Title and summary requests use separate ephemeral, read-only threads.
- OpenCode's plan agent uses Codex's read-only sandbox. Normal coding uses `danger-full-access` by default.
- Codex retains its native instructions and project configuration. OpenCode's provider tool instructions are not forwarded. Custom OpenCode system prompts are not currently translated; put persistent coding instructions in Codex's configuration or project instructions.
- Provider usage is zero so OpenCode does not use Codex's token usage to trigger its own compaction. Real token counts are never returned through the proxy, and there is no usage endpoint. The Anthropic protocol carries only required zero-valued usage fields, including its final streaming event. Every model advertises a 272,000-token context window.
- Tool calls show useful arguments, such as `[Codex Tool: Read src/agent.ts, lines 1–180]`, `[Codex Tool: Search "delta" in src/]`, or `[Codex Tool: Shell npm run check]`. Each call gets its own thinking block, separate from other calls and actual reasoning. Call IDs deduplicate lifecycle updates; successful completion messages and tool output are omitted. Failures get a short notice. Long arguments are truncated, and structured file bodies and credential fields are omitted.
- Assistant text is forwarded as Codex emits deltas, without waiting for turn completion. Some Codex responses arrive from app-server as a burst of deltas at message completion; the wrapper cannot display that text before it arrives.

The adapter accepts text input and forwards image attachments to Codex models that advertise image input. Text files, audio, and document attachments are still rejected. Reference workspace files by path when possible. OpenCode conversation forks import visible conversation history into a fresh Codex thread; they do not clone hidden Codex history or undo file changes.

## Model metadata

Metadata precedence is field-specific:

1. The explicit adapter context policy is 272,000 tokens. Generic 1M or 400k API windows never override it. This changes the OpenCode catalog, not your Codex configuration.
2. Live Codex `model/list` owns available model IDs, names, descriptions, default selection, native input modalities, and supported reasoning efforts.
3. Exact OpenAI model records from Models.dev supply family, release date, update date, and output limit where available. These are generic model metadata, not evidence of a different Codex context window.
4. Missing output metadata uses a conservative 32,768-token display fallback. Missing descriptive fields stay absent. Metadata fetch failures do not block Codex.

The local models endpoint includes per-field source labels. The provider still advertises text-only input and no host tool calling because those are adapter capabilities. Set `OPENCODE_CODEX_METADATA=off` to disable the optional Models.dev fetch.

## Permissions

The adapter sets Codex's approval policy to `never`. Codex executes operations allowed by the selected sandbox and refuses operations requiring approval. Unexpected command/file approval requests are declined; permission-extension requests receive no added permissions. Interactive questionnaires are unsupported, and the adapter instructs Codex to ask ordinary chat questions instead.

This version does not bridge OpenCode permission dialogs to Codex. OpenCode tool permissions do not govern Codex's internal tools.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_CODEX_BIN` | `codex` | Codex executable path |
| `OPENCODE_CODEX_SANDBOX` | `danger-full-access` | `read-only`, `workspace-write`, or `danger-full-access` |
| `OPENCODE_CODEX_DATA_DIR` | `~/.local/share/opencode-codex` | Thread mappings, retry caches, and locks |
| `OPENCODE_CODEX_PROXY_PORT` | random available port | Local proxy port |
| `OPENCODE_CODEX_MAX_REQUEST_BYTES` | 8388608 | Request size limit |
| `OPENCODE_CODEX_STALL_MS` | 600000 | Time without Codex events before interruption |
| `OPENCODE_CODEX_DEBUG` | unset | Set to `1` for adapter startup logging |

The proxy binds to `127.0.0.1`. Its protected endpoints require `x-api-key: opencode-codex-local`: `GET /v1/models` and `POST /v1/messages`. `GET /health` is public. The marker distinguishes adapter requests; it is not a secret protecting against other local processes.

Session caches contain assistant output and tool activity. They use owner-only file permissions. Codex maintains its own thread storage separately.

## Development and verification

```sh
npm run check
npm run test:live
npm run test:e2e
npm run test:package
```

The deterministic tests use a fake JSON-RPC process. The live test uses the installed Codex to edit and read a temporary file, then resumes the thread to verify memory. The E2E test loads this plugin through the installed OpenCode CLI, verifies file creation and reasoning blocks, checks zero provider usage and absence of host tool calls, then starts another OpenCode process to resume the same conversation. Live tests use the catalog default model unless `OPENCODE_CODEX_TEST_MODEL` is set.

Live tests use your existing Codex authentication and consume model usage. They remove their temporary workspaces and adapter mappings afterward; Codex and OpenCode retain their normal conversation records.

Request/model types under `src/generated` were generated by Codex CLI 0.153.4 using `codex app-server generate-ts`. App-server remains experimental. Test a new Codex version before adopting it.

## References

- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex SDK](https://developers.openai.com/codex/sdk)
- [Codex noninteractive mode](https://developers.openai.com/codex/noninteractive)

The HTTP/SSE adapter was adapted from the sibling opencode-commandcode-cli project. The session/protocol design also follows the sibling opencode-agy wrapper.

The package test installs an npm tarball in a clean temporary directory and runs the OpenCode E2E test against that installed copy.
