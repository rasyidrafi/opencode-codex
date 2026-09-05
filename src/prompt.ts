export type OpenAIMessage = { role?: unknown; content?: unknown };
function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(p => {
    if (p.type === "text") return p.text || "";
    if (p.type === "thinking") return "";
    throw new Error(`Unsupported input block: ${p.type}. This version accepts text; reference workspace files by path.`);
  }).join("\n");
}
export function buildCodexPrompt(messages: OpenAIMessage[], options: { includeHistory: boolean; utility?: boolean }) {
  const users = messages.filter(m => m.role === "user");
  if (!users.length) throw new Error("At least one user message is required");
  const current = text(users.at(-1)!.content);
  if (options.utility) return messages.map(m => `[${m.role}]\n${text(m.content)}`).join("\n\n");
  if (!options.includeHistory) return current;
  const prior = messages.filter(m => m.role === "user" || m.role === "assistant").slice(0, -1);
  return (prior.length ? "<quoted-conversation>\n" + prior.map(m => `[${m.role}]\n${text(m.content)}`).join("\n\n") + "\n</quoted-conversation>\n\n" : "") + current;
}
export function isUtility(messages: OpenAIMessage[]) {
  const system = messages.filter(m => m.role === "system").map(m => text(m.content)).join("\n");
  return /title generator|generate a (short|brief) title|summarizing conversations|summarizing, compacting|anchored context summarization|write like a pull request description/i.test(system);
}
