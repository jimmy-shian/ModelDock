/** OpenAI Compatible 轉接層：把 messages 壓成一段 prompt 丟給 ChatGPT 網頁版。 */

export interface ChatMessage {
  role?: string;
  content?: unknown;
  name?: string;
}

export interface ChatCompletionsBody {
  model?: string;
  messages?: ChatMessage[];
  prompt?: unknown;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  continue?: boolean;
  continueConversation?: boolean;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // OpenAI vision/content parts: [{type:"text",text:"..."}]
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

function labelFor(role: string | undefined, index: number, total: number): string {
  const lower = (role ?? (index === total - 1 ? "user" : "user")).toLowerCase();
  if (lower === "system") return "System";
  if (lower === "assistant") return "Assistant";
  if (lower === "developer") return "System";
  if (lower === "tool" || lower === "function") return "Tool";
  return "User";
}

/** messages -> 單段 prompt。單輪 user 直傳，多輪則保留角色標籤。 */
export function messagesToPrompt(messages: ChatMessage[]): string {
  const texts = messages.map(m => contentToText(m.content).trim()).filter(Boolean);
  if (texts.length === 0) return "";
  if (messages.length === 1) return contentToText(messages[0]?.content).trim();
  return messages
    .map((message, index) => {
      const text = contentToText(message.content).trim();
      if (!text) return "";
      return `${labelFor(message.role, index, messages.length)}: ${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

export function parseChatCompletions(body: Record<string, unknown>): {
  prompt: string;
  model: string;
  stream: boolean;
  continueConversation: boolean;
} {
  const typed = body as ChatCompletionsBody;
  const model = typeof typed.model === "string" && typed.model ? typed.model : "gpt-web-port";
  const stream = typed.stream === true;
  const continueConversation = typed.continue === true || typed.continueConversation === true;

  if (Array.isArray(typed.messages) && typed.messages.length > 0) {
    const prompt = messagesToPrompt(typed.messages as ChatMessage[]);
    if (!prompt) throw new Error("缺少 messages 內容。");
    return { prompt, model, stream, continueConversation };
  }

  // 相容直接帶 prompt 的呼叫
  const fallback = typed.prompt ?? (body as Record<string, unknown>).input;
  if (typeof fallback === "string" && fallback.trim()) {
    return { prompt: fallback, model, stream, continueConversation };
  }
  throw new Error("缺少 messages（或 prompt）。");
}

export function chatCompletionObject(model: string, reply: string, conversationUrl?: string, durationMs?: number): Record<string, unknown> {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl-web-${Date.now().toString(36)}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      },
    ],
    ...(conversationUrl ? { conversation_url: conversationUrl } : {}),
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

/** 把完整回覆切成 SSE chunks，假串流（網頁版本身只能等整段回來）。 */
export function chunkText(text: string, size = 40): string[] {
  if (!text) return [""];
  const chunks: string[] = [];
  // 盡量按行切，太長的行再按字數切
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.length <= size) {
      chunks.push(chunks.length === 0 ? line : "\n" + line);
      continue;
    }
    for (let i = 0; i < line.length; i += size) {
      const piece = line.slice(i, i + size);
      chunks.push(chunks.length === 0 && i === 0 ? piece : (i === 0 ? "\n" + piece : piece));
    }
  }
  return chunks;
}

export function sseChunk(id: string, created: number, model: string, content: string): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`;
}

export function sseDone(id: string, created: number, model: string): string {
  const last = `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;
  return last;
}
