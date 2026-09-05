import type { UserInput } from "./generated/v2/UserInput.js";
import type { ImageDetail } from "./generated/ImageDetail.js";

export type OpenAIMessage = { role?: unknown; content?: unknown };
type ContentPart = Record<string, unknown>;

function partType(part: ContentPart): string {
  return typeof part.type === "string" ? part.type : "unknown";
}

function imageUrl(part: ContentPart): string {
  const imageUrlPart = part.image_url && typeof part.image_url === "object" ? part.image_url as ContentPart : undefined;
  const direct = [part.url, part.image_url, imageUrlPart?.url].find(value => typeof value === "string" && value);
  if (typeof direct === "string") return direct;

  const source = part.source && typeof part.source === "object" ? part.source as ContentPart : undefined;
  const sourceUrl = source && typeof source.url === "string" ? source.url : undefined;
  if (sourceUrl) return sourceUrl;

  const data = source?.data ?? part.data;
  if (typeof data === "string" && data) {
    if (data.startsWith("data:")) return data;
    const mediaType = source?.media_type ?? source?.mediaType ?? part.mime ?? part.mediaType ?? part.media_type;
    if (typeof mediaType === "string" && mediaType) return `data:${mediaType};base64,${data}`;
  }

  throw new Error("Image input must include a URL or base64 data");
}

function imageDetail(part: ContentPart): ImageDetail | undefined {
  const imageUrlPart = part.image_url && typeof part.image_url === "object" ? part.image_url as ContentPart : undefined;
  const detail = part.detail ?? imageUrlPart?.detail;
  return detail === "auto" || detail === "low" || detail === "high" || detail === "original" ? detail : undefined;
}

function isImagePart(part: ContentPart): boolean {
  if (partType(part) === "image" || partType(part) === "image_url") return true;
  if (partType(part) !== "file") return false;
  const mime = part.mime ?? part.mediaType ?? part.media_type;
  return typeof mime === "string" && mime.toLowerCase().startsWith("image/");
}

function contentInputs(content: unknown): UserInput[] {
  if (typeof content === "string") return [{ type: "text", text: content, text_elements: [] }];
  if (!Array.isArray(content)) return [];

  const inputs: UserInput[] = [];
  for (const value of content) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Unsupported input block: unknown. This version accepts text and images; reference workspace files by path.");
    }
    const part = value as ContentPart;
    if (partType(part) === "text") {
      if (typeof part.text === "string") inputs.push({ type: "text", text: part.text, text_elements: [] });
      continue;
    }
    if (partType(part) === "thinking") continue;
    if (isImagePart(part)) {
      const detail = imageDetail(part);
      inputs.push({ type: "image", url: imageUrl(part), ...(detail ? { detail } : {}) });
      continue;
    }
    throw new Error(`Unsupported input block: ${partType(part)}. This version accepts text and images; reference workspace files by path.`);
  }
  return inputs;
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(p => {
    if (p.type === "text") return p.text || "";
    if (p.type === "thinking") return "";
    throw new Error(`Unsupported input block: ${p.type}. This version accepts text; reference workspace files by path.`);
  }).join("\n");
}

function appendText(inputs: UserInput[], value: string): void {
  if (!value) return;
  const previous = inputs.at(-1);
  if (previous?.type === "text") previous.text += value;
  else inputs.push({ type: "text", text: value, text_elements: [] });
}

function appendContent(inputs: UserInput[], content: unknown): void {
  const parts = contentInputs(content);
  parts.forEach((input, index) => {
    if (index && parts[index - 1]?.type === "text" && input.type === "text") appendText(inputs, "\n");
    if (input.type === "text") appendText(inputs, input.text);
    else inputs.push(input);
  });
}

export function buildCodexInput(messages: OpenAIMessage[], options: { includeHistory: boolean; utility?: boolean }): UserInput[] {
  const users = messages.filter(m => m.role === "user");
  if (!users.length) throw new Error("At least one user message is required");
  const inputs: UserInput[] = [];

  if (options.utility) {
    messages.forEach((message, index) => {
      if (index) appendText(inputs, "\n\n");
      appendText(inputs, `[${message.role}]\n`);
      appendContent(inputs, message.content);
    });
  } else if (!options.includeHistory) {
    appendContent(inputs, users.at(-1)!.content);
  } else {
    const prior = messages.filter(m => m.role === "user" || m.role === "assistant").slice(0, -1);
    if (prior.length) {
      appendText(inputs, "<quoted-conversation>\n");
      prior.forEach((message, index) => {
        appendText(inputs, `[${message.role}]\n`);
        appendContent(inputs, message.content);
        if (index < prior.length - 1) appendText(inputs, "\n\n");
      });
      appendText(inputs, "\n</quoted-conversation>\n\n");
    }
    appendContent(inputs, users.at(-1)!.content);
  }

  return inputs.length ? inputs : [{ type: "text", text: "", text_elements: [] }];
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
