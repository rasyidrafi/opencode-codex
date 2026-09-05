import { loadMetadata, modelMetadata, type ModelMetadata } from "./metadata.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import { CodexRpc } from "./rpc.js";
export type CodexModel = { id: string; name: string; efforts: string[]; isDefault: boolean; description: string; nativeInputModalities: string[] } & ModelMetadata;
let catalog: CodexModel[] = [];
let loading: Promise<CodexModel[]> | undefined;
export function getCodexModels() { return catalog; }
export async function refreshModels(cwd: string) {
  if (catalog.length) return catalog;
  if (loading) return loading;
  loading = (async () => {
    const rpc = new CodexRpc(cwd);
    try {
      const metadata = loadMetadata();
      await rpc.initialize();
      let cursor: string | undefined;
      do {
        const result: ModelListResponse = await rpc.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        const enrichment = await metadata;
        catalog.push(...result.data.map((m) => ({ ...modelMetadata(m.model || m.id, enrichment), id: m.model || m.id, name: m.displayName, description: m.description || "", nativeInputModalities: m.inputModalities || ["text"], efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort), isDefault: m.isDefault })));
        cursor = result.nextCursor || undefined;
      } while (cursor);
      if (!catalog.length) throw new Error("Codex returned no available models");
      return catalog;
    } catch (e) { catalog = []; throw e; } finally { rpc.close(); loading = undefined; }
  })();
  return loading;
}
export function resolveCodexModel(id?: string) {
  const model = id ? catalog.find(m => m.id === id) : catalog.find(m => m.isDefault) || catalog[0];
  if (!model) throw new Error(`Unknown Codex model: ${id || "(default)"}`);
  return model.id;
}
