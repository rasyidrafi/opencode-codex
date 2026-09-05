export const CODEX_CONTEXT_WINDOW = 272_000;
export type ModelMetadata = {
  contextWindow: number;
  maxOutput: number;
  family?: string;
  releaseDate?: string;
  lastUpdated?: string;
  sources: { context: string; output: string; catalog: string; name?: string; descriptive?: string };
};
type JsonRecord = Record<string, any>;
function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
// Exact OpenAI IDs only: never borrow another provider's serving limits.
export function findMetadata(payload: unknown, id: string): JsonRecord | undefined {
  const data = record(payload);
  const bare = id.replace(/^openai\//, "");
  return record(data?.["openai/" + bare])
    || record(data?.openai?.models?.[bare])
    || (record(data?.[bare])?.id === bare ? record(data?.[bare]) : undefined);
}
// Codex sometimes returns the slug, including an uppercased slug, as displayName.
// Only an exact OpenAI record may replace that placeholder with a catalog label.
export function modelDisplayName(id: string, displayName: string | undefined, payload: unknown): { name: string; source: string } {
  const label = displayName?.trim();
  const bare = id.replace(/^openai\//, "");
  const isId = label && [id, bare].some(value => value.toLowerCase() === label.toLowerCase());
  if (label && !isId) return { name: label, source: "codex-app-server:model/list" };
  const metadataName = findMetadata(payload, id)?.name;
  if (typeof metadataName === "string" && metadataName.trim()) {
    return { name: metadataName.trim(), source: "models.dev:exact-openai-id" };
  }
  return { name: label || id, source: label ? "codex-app-server:model/list" : "model-id" };
}
export function modelMetadata(id: string, payload: unknown): ModelMetadata {
  const m = findMetadata(payload, id);
  const output = m?.limit?.output;
  const validOutput = typeof output === "number" && Number.isFinite(output) && output > 0;
  return {
    // Explicit adapter policy wins over generic API windows such as 1M/400k.
    contextWindow: CODEX_CONTEXT_WINDOW,
    maxOutput: validOutput ? Math.min(output, CODEX_CONTEXT_WINDOW) : 32_768,
    ...(typeof m?.family === "string" ? { family: m.family } : {}),
    ...(typeof m?.release_date === "string" ? { releaseDate: m.release_date } : {}),
    ...(typeof m?.last_updated === "string" ? { lastUpdated: m.last_updated } : {}),
    sources: {
      context: "adapter-policy:272000",
      output: validOutput ? "models.dev:exact-openai-id" : "adapter-fallback:32768",
      catalog: "codex-app-server:model/list",
      ...(m ? { descriptive: "models.dev:exact-openai-id" } : {}),
    },
  };
}
export async function loadMetadata(): Promise<unknown> {
  if (process.env.OPENCODE_CODEX_METADATA === "off") return {};
  try {
    const response = await fetch("https://models.dev/models.json", { signal: AbortSignal.timeout(5000) });
    return response.ok ? await response.json() : {};
  } catch { return {}; }
}
