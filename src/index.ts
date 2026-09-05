import { CodexRpc } from "./rpc.js";
import type { Plugin } from "@opencode-ai/plugin";
import { refreshModels, type CodexModel } from "./models.js";
import { startProxy, stopProxy, getProxyBaseUrl } from "./proxy.js";
import { PROVIDER_ID, LOCAL_API_KEY, ANTHROPIC_NPM, MODEL_HEADER, EFFORT_HEADER, DIRECTORY_HEADER, SESSION_HEADER, REQUEST_KIND_HEADER } from "./constants.js";
function variants(m: CodexModel) {
  return Object.fromEntries([...new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", ...m.efforts])].map(e => [e, m.efforts.includes(e) ? { effort: e } : { disabled: true }]));
}
export function configModel(m: CodexModel) {
  return { name: m.name, family: m.family, release_date: m.releaseDate || "", reasoning: m.efforts.length > 0, interleaved: true, temperature: false, tool_call: false, attachment: false,
    modalities: { input: ["text"], output: ["text"] }, limit: { context: m.contextWindow, output: m.maxOutput },
    options: { includeUsage: false }, variants: variants(m) };
}
export const CodexPlugin: Plugin = async input => {
  return {
    async config(config) {
      await startProxy(input.directory);
      const models = await refreshModels(input.directory);
      config.provider ||= {};
      const existing = config.provider[PROVIDER_ID];
      config.provider[PROVIDER_ID] = {
        ...existing, name: "Codex", npm: ANTHROPIC_NPM,
        options: { ...existing?.options, baseURL: getProxyBaseUrl(), apiKey: LOCAL_API_KEY, includeUsage: false },
        models: Object.fromEntries(models.map(m => [m.id, configModel(m)])),
      } as any;
      await input.client.auth.set({ path: { id: PROVIDER_ID }, body: { type: "api", key: LOCAL_API_KEY } });
    },
    "chat.headers": async (hook, output) => {
      if (hook.model.providerID !== PROVIDER_ID) return;
      output.headers[MODEL_HEADER] = hook.model.id;
      output.headers[DIRECTORY_HEADER] = input.directory;
      output.headers[SESSION_HEADER] = hook.sessionID;
      output.headers["x-opencode-codex-message"] = hook.message.id;
      if (hook.agent === "plan") output.headers["x-opencode-codex-mode"] = "plan";
      const variant = (hook.message as any).variant || (hook.message.model as any)?.variant;
      if (variant) output.headers[EFFORT_HEADER] = variant;
      if (["title", "summary", "compaction"].includes(hook.agent)) output.headers[REQUEST_KIND_HEADER] = hook.agent === "title" ? "title" : "summary";
    },
    "chat.params": async (hook, output) => {
      if (hook.model.providerID !== PROVIDER_ID) return;
      delete output.options.reasoningEffort;
      delete output.options.temperature;
    },
    provider: {
      id: PROVIDER_ID,
      async models() {
        await startProxy(input.directory);
        return Object.fromEntries((await refreshModels(input.directory)).map(m => [m.id, {
          ...configModel(m), id: m.id, providerID: PROVIDER_ID,
          api: { id: m.id, url: getProxyBaseUrl(), npm: ANTHROPIC_NPM },
          capabilities: { temperature: false, reasoning: m.efforts.length > 0, attachment: false, toolcall: false,
            input: { text: true, image: false, audio: false, video: false, pdf: false },
            output: { text: true, image: false, audio: false, video: false, pdf: false }, interleaved: true },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, status: "active", headers: {}, release_date: m.releaseDate || "",
        }])) as any;
      },
    },
    auth: { provider: PROVIDER_ID, methods: [{ type: "api", label: "Use Codex CLI login", async authorize() {
      const rpc = new CodexRpc(input.directory);
      try {
        await rpc.initialize();
        const account = await rpc.request("account/read");
        if (!account.account && account.requiresOpenaiAuth !== false) return { type: "failed" as const };
        return { type: "success" as const, key: LOCAL_API_KEY, provider: PROVIDER_ID };
      } catch { return { type: "failed" as const }; }
      finally { rpc.close(); }
    } }] },
    async dispose() { await stopProxy(input.directory); },
  };
};
export default CodexPlugin;
