type LogValue = unknown;

function write(level: "info" | "warn" | "error", message: string, value?: LogValue): void {
  if (process.env.OPENCODE_CODEX_DEBUG !== "1" && level === "info") return;
  const suffix = value === undefined ? "" : ` ${safeJson(value)}`;
  process.stderr.write(`[opencode-codex] ${level}: ${message}${suffix}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info(message: string, value?: LogValue): void {
    write("info", message, value);
  },
  warn(message: string, value?: LogValue): void {
    write("warn", message, value);
  },
  error(message: string, value?: LogValue): void {
    write("error", message, value);
  },
};
