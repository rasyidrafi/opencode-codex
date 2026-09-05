type Action = { type: string; command?: string; path?: string | null; query?: string | null };
type Item = {
  id: string; type: string; status?: string; tool?: string; server?: string;
  text?: string; command?: string; commandActions?: Action[]; path?: string;
  query?: string; changes?: Array<{ path: string }>; arguments?: unknown;
  exitCode?: number | null; success?: boolean | null;
};

function compact(value: string, max = 240): string {
  const text = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function command(value = ""): string {
  // Unwrap only the simple shell envelope; preserve compound commands verbatim.
  return value.replace(/^(?:\/[^ ]*\/)?(?:bash|sh|zsh) -[a-z]*c '([^']*)'$/, "$1");
}

function actionTitle(action: Action): string {
  if (action.type === "read" && action.path) {
    const lines = action.command?.match(/\bsed\s+-n\s+['"]?(\d+),(\d+)p/);
    return `Read ${action.path}${lines ? `, lines ${lines[1]}–${lines[2]}` : ""}`;
  }
  if (action.type === "listFiles") return `List ${action.path || "."}`;
  if (action.type === "search") return `Search${action.query ? ` ${JSON.stringify(action.query)}` : ""}${action.path ? ` in ${action.path}` : ""}`;
  return `Shell${action.command ? ` ${command(action.command)}` : ""}`;
}

function argumentSummary(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return compact(String(value));
  // Keep parameters useful for identifying a call, without embedding file bodies.
  return compact(JSON.stringify(value, (key, val) => /^(content|contents|body|patch|diff|token|password|authorization|api_?key)$/i.test(key) ? "[omitted]" : val));
}

function title(item: Item): string | undefined {
  switch (item.type) {
    case "commandExecution": return compact(item.commandActions?.length
      ? [...new Set(item.commandActions.map(actionTitle))].join("; ")
      : `Shell${item.command ? ` ${command(item.command)}` : ""}`);
    case "fileChange": return compact(`Edit${item.changes?.length ? ` ${item.changes.map(c => c.path).join(", ")}` : ""}`);
    case "webSearch": return compact(`Web search${item.query ? `: ${item.query}` : ""}`);
    case "imageView": return compact(`View image${item.path ? ` ${item.path}` : ""}`);
    case "mcpToolCall":
    case "dynamicToolCall": {
      const args = argumentSummary(item.arguments);
      return compact(`${[item.server, item.tool || "tool"].filter(Boolean).join("/")}${args ? `: ${args}` : ""}`);
    }
    case "collabAgentToolCall":
    case "collabToolCall": return compact(item.tool || "Agent");
    default: return;
  }
}

/** One argument summary per call ID, followed only by a failure notice if needed. */
export class ActivityTranslator {
  private tools = new Map<string, { title: string; failureShown: boolean }>();
  private notices = new Set<string>();

  item(method: "item/started" | "item/completed", item: Item): string | undefined {
    const description = title(item);
    if (description) {
      const known = this.tools.get(item.id);
      const failed = ["failed", "declined", "cancelled", "canceled"].includes(item.status || "") || item.success === false || (typeof item.exitCode === "number" && item.exitCode !== 0);
      if (failed) {
        if (known?.failureShown) return;
        this.tools.set(item.id, { title: known?.title || description, failureShown: true });
        const status = item.status === "canceled" ? "cancelled" : failed && (!item.status || item.status === "completed") ? "failed" : item.status;
        return `[Codex Tool ${status}: ${known?.title || description}${typeof item.exitCode === "number" ? `, exit ${item.exitCode}` : ""}]\n`;
      }
      if (known) return;
      this.tools.set(item.id, { title: description, failureShown: false });
      return `[Codex Tool: ${description}]\n`;
    }
    if (this.notices.has(item.id)) return;
    if (item.type === "contextCompaction") {
      this.notices.add(item.id);
      return "Codex: Compacting context\n";
    }
    if (item.type === "plan" && method === "item/completed" && item.text) {
      this.notices.add(item.id);
      return `Codex plan\n${item.text}\n`;
    }
  }
}
