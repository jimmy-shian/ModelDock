import { ChatGptError, ChatGptSession, NotLoggedInError } from "./chatgpt";
import { type AppConfig } from "./config";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function authorized(request: Request, config: AppConfig): boolean {
  if (!config.apiKey) return true;
  const header = request.headers.get("x-api-key")
    ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return header === config.apiKey;
}

/** 支援 JSON body 與純文字 body，後者方便 shell 直接 pipe。 */
async function readPrompt(request: Request): Promise<{ prompt: string; continueConversation: boolean }> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw new ChatGptError("JSON 格式錯誤。");
    }
    if (typeof payload === "string") return { prompt: payload, continueConversation: false };
    if (!payload || typeof payload !== "object") throw new ChatGptError("body 必須是物件或字串。");

    const body = payload as Record<string, unknown>;
    const prompt = body.prompt ?? body.message ?? body.input ?? body.text ?? body.q;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new ChatGptError("缺少 prompt。");
    }
    return {
      prompt,
      continueConversation: body.continue === true || body.continueConversation === true,
    };
  }

  const prompt = await request.text();
  if (prompt.trim().length === 0) throw new ChatGptError("缺少 prompt。");
  return { prompt, continueConversation: request.headers.get("x-continue") === "1" };
}

export function createServer(config: AppConfig, session: ChatGptSession): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Bun.serve 上限 255 秒，避免長時間作答時連線被 server 端斷掉。
    idleTimeout: 255,
    fetch: async request => {
      const url = new URL(request.url);

      if (!authorized(request, config)) {
        return json({ error: "unauthorized", message: "需要正確的 x-api-key。" }, 401);
      }

      if (request.method === "GET" && url.pathname === "/health") {
        let state: { loggedIn: boolean; url: string } | null = null;
        let checkError: string | undefined;
        try {
          state = await session.checkLogin();
        } catch (error) {
          checkError = error instanceof Error ? error.message : String(error);
        }
        return json({
          ok: true,
          browserStarted: session.started,
          loggedIn: state?.loggedIn ?? false,
          pageUrl: state?.url,
          ...(checkError ? { error: checkError } : {}),
        });
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/help")) {
        return json({
          service: "gpt-web-port",
          endpoints: {
            "POST /chat": '{ "prompt": "...", "continue": false } 或純文字 body',
            "GET /health": "服務與登入狀態",
          },
        });
      }

      if (request.method === "POST" && (url.pathname === "/chat" || url.pathname === "/")) {
        let prompt: string;
        let continueConversation: boolean;
        try {
          ({ prompt, continueConversation } = await readPrompt(request));
        } catch (error) {
          return json({ error: "bad_request", message: (error as Error).message }, 400);
        }

        const controller = new AbortController();
        const onAbort = () => controller.abort();
        request.signal.addEventListener("abort", onAbort, { once: true });

        try {
          const result = await session.ask(prompt, { continueConversation, signal: controller.signal });
          return json({
            reply: result.reply,
            conversationUrl: result.conversationUrl,
            durationMs: result.durationMs,
          });
        } catch (error) {
          if (error instanceof NotLoggedInError) {
            return json({ error: "not_logged_in", message: error.message }, 401);
          }
          return json({
            error: "chatgpt_error",
            message: error instanceof Error ? error.message : String(error),
          }, 502);
        } finally {
          request.signal.removeEventListener("abort", onAbort);
        }
      }

      return json({ error: "not_found", message: `沒有這個路徑：${request.method} ${url.pathname}` }, 404);
    },
  });

  return { port: server.port ?? config.port, stop: () => void server.stop(true) };
}
