type Item = {
  id: string;
  type: string;
  status?: string;
  tool?: string;
  server?: string;
  text?: string;
  commandActions?: Array<{ type: string }>;
};

function safeName(value: string): string {
  return value.replace(/[\x00-\x1f\x7f\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function toolName(item: Item): string | undefined {
  switch (item.type) {
    case "commandExecution": {
      const actions = item.commandActions || [];
      if (actions.length && actions.every(a => a.type === "read")) return "read";
      if (actions.length && actions.every(a => a.type === "listFiles")) return "list";
      if (actions.length && actions.every(a => a.type === "search")) return "search";
      return "shell";
    }
    case "fileChange": return "apply_patch";
    case "webSearch": return "web_search";
    case "imageView": return "view_image";
    case "mcpToolCall": return [item.server, item.tool || "mcp"].filter((value): value is string => !!value).map(safeName).join("/");
    case "dynamicToolCall": return safeName(item.tool || "tool");
    case "collabToolCall": return safeName(item.tool || "agent");
    default: return undefined;
  }
}

/**
 * Render one compact activity per Codex item ID, as the sibling wrappers do.
 * Tool output, arguments and successful lifecycle updates stay inside Codex.
 */
export class ActivityTranslator {
  private tools = new Map<string, { name: string; failureShown: boolean }>();
  private notices = new Set<string>();

  item(method: "item/started" | "item/completed", item: Item): string | undefined {
    const name = toolName(item);
    if (name) {
      const known = this.tools.get(item.id);
      const failed = ["failed", "declined", "cancelled", "canceled"].includes(item.status || "");
      if (failed) {
        if (known?.failureShown) return;
        this.tools.set(item.id, { name: known?.name || name, failureShown: true });
        const status = item.status === "canceled" ? "cancelled" : item.status;
        return `[Codex tool ${status}: ${known?.name || name}]\n`;
      }
      if (known) return;
      this.tools.set(item.id, { name, failureShown: false });
      return `[Codex tool: ${name}]\n`;
    }

    // These are agent events, not executable tools. Suppress their lifecycle pairs too.
    if (this.notices.has(item.id)) return;
    if (item.type === "contextCompaction") {
      this.notices.add(item.id);
      return "[Codex: Compacting context]\n";
    }
    if (item.type === "plan" && method === "item/completed" && item.text) {
      this.notices.add(item.id);
      return `[Codex plan]\n${item.text}\n`;
    }
    return;
  }
}
