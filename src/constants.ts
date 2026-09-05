export const PROVIDER_ID = "codex";
export const PROVIDER_NAME = "Codex";
export const ANTHROPIC_NPM = "@ai-sdk/anthropic";
export const LOCAL_API_KEY = "opencode-codex-local";


export const MODEL_HEADER = "x-opencode-codex-model";
export const EFFORT_HEADER = "x-opencode-codex-effort";
export const SESSION_HEADER = "x-opencode-codex-session";
export const DIRECTORY_HEADER = "x-opencode-codex-directory";
export const REQUEST_KIND_HEADER = "x-opencode-codex-request-kind";

export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SSE_HEARTBEAT_MS = 5_000;

export function envNumber(name: string, fallback: number, minimum = 0): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}
