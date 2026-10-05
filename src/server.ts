import { ChatGptError, ChatGptSession, NotLoggedInError } from "./chatgpt";
import { applySettings, saveSettings, toSettingsView, type AppConfig } from "./config";
import { chatCompletionObject, chunkText, parseChatCompletions, sseChunk, sseDone } from "./openai";
import { renderUi } from "./ui";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function authorized(request: Request, config: AppConfig): boolean {
  if (!config.apiKey) return true;
  const header = request.headers.get("x-api-key")
    ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  // UI 設定頁用的 key 也允許放在 query ?key=（方便瀏覽器直接開），正式呼叫仍建議用 header
  const queryKey = new URL(request.url).searchParams.get("key");
  return header === config.apiKey || (queryKey !== null && queryKey === config.apiKey);
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

      // CORS preflight（給 OpenAI SDK / 瀏覽器用）
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type, authorization, x-api-key",
          },
        });
      }

      // ---- 公開：就緒探針（給桌面包裝/托盤輪詢，不碰瀏覽器，免驗證） ----
      if (request.method === "GET" && url.pathname === "/ready") {
        return json({ ok: true, service: "gpt-web-port" });
      }

      // ---- 公開頁：UI（免驗證，裡面的 API 呼叫仍要帶 key） ----
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
        const accept = request.headers.get("accept") ?? "";
        // curl 預設拿 JSON，瀏覽器拿 UI
        if (url.pathname === "/" && !accept.includes("text/html") && accept.includes("application/json")) {
          return json({
            service: "gpt-web-port",
            endpoints: {
              "POST /chat": '{ "prompt": "...", "continue": false } 或純文字 body',
              "GET /health": "服務與登入狀態",
              "GET /v1/models": "OpenAI 相容模型列表",
              "POST /v1/chat/completions": '{ "model": "gpt-web-port", "messages": [...] }',
            },
          });
        }
        return html(renderUi());
      }
      if (request.method === "GET" && url.pathname === "/help") {
        return json({
          service: "gpt-web-port",
          endpoints: {
            "POST /chat": '{ "prompt": "...", "continue": false } 或純文字 body',
            "GET /health": "服務與登入狀態",
            "GET /v1/models": "OpenAI 相容模型列表",
            "POST /v1/chat/completions": '{ "model": "gpt-web-port", "messages": [...] }',
          },
        });
      }

      if (!authorized(request, config)) {
        return json({ error: "unauthorized", message: "需要正確的 x-api-key（或 Authorization: Bearer）。" }, 401);
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
          loginBusy: session.isLoginBusy,
          ...(checkError ? { error: checkError } : {}),
        });
      }

      // ---- 設定 API（UI 用） ----
      if (request.method === "GET" && url.pathname === "/api/settings") {
        return json(toSettingsView(config));
      }
      if ((request.method === "POST" || request.method === "PUT") && url.pathname === "/api/settings") {
        let patch: Record<string, unknown>;
        try {
          patch = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ error: "bad_request", message: "JSON 格式錯誤。" }, 400);
        }
        const port = patch.port !== undefined ? Number(patch.port) : undefined;
        const timeoutSec = patch.turnTimeoutSec !== undefined
          ? Number(patch.turnTimeoutSec)
          : patch.turnTimeoutMs !== undefined ? Number(patch.turnTimeoutMs) / 1000 : undefined;
        if (port !== undefined && (!Number.isFinite(port) || port < 1 || port > 65535)) {
          return json({ error: "bad_request", message: "port 必須是 1-65535。" }, 400);
        }
        if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec < 10 || timeoutSec > 1800)) {
          return json({ error: "bad_request", message: "等待逾時必須是 10-1800 秒。" }, 400);
        }
        const fresh = saveSettings({
          ...(typeof patch.host === "string" ? { host: patch.host } : {}),
          ...(port !== undefined ? { port } : {}),
          ...(typeof patch.headless === "boolean" ? { headless: patch.headless } : {}),
          ...(typeof patch.headless === "string" ? { headless: patch.headless === "true" } : {}),
          ...(timeoutSec !== undefined ? { turnTimeoutSec: timeoutSec } : {}),
          ...(typeof patch.profileDir === "string" ? { profileDir: patch.profileDir } : {}),
          ...(typeof patch.storageStatePath === "string" ? { storageStatePath: patch.storageStatePath } : {}),
          ...(typeof patch.chromeExecutablePath === "string" ? { chromeExecutablePath: patch.chromeExecutablePath } : {}),
          ...(typeof patch.apiKey === "string" ? { apiKey: patch.apiKey } : {}),
        });
        const { needsRestart } = applySettings(config, fresh);
        // headless 切換要重開分頁才乾淨
        if (typeof patch.headless === "boolean" || typeof patch.headless === "string") {
          await session.close().catch(() => {});
        }
        return json({ ok: true, settings: toSettingsView(config), needsRestart });
      }

      // ---- 登入 API（v2：開真 Chrome，關掉即完成，不佔 profile） ----
      if (request.method === "POST" && url.pathname === "/api/login/open") {
        if (session.isLoginBusy) {
          return json({ ok: false, error: "login_busy", message: "登入視窗已經開著。" }, 409);
        }
        try {
          const state = await session.openLoginWindow();
          return json({ ok: true, loggedIn: true, pageUrl: state.url, message: "登入完成，狀態已存到 storageState。把 Chrome 完全關掉後即可自動問答。" });
        } catch (error) {
          return json({
            ok: false,
            error: "login_failed",
            message: error instanceof Error ? error.message : String(error),
          }, 502);
        }
      }
      if (request.method === "POST" && url.pathname === "/api/login/logout") {
        await session.logout().catch(() => {});
        return json({ ok: true, message: "已清除登入狀態。" });
      }
      if (request.method === "GET" && url.pathname === "/api/login/status") {
        return json({ loginBusy: session.isLoginBusy, browserStarted: session.started });
      }

      // ---- OpenAI Compatible ----
      if (request.method === "GET" && url.pathname === "/v1/models") {
        const now = Math.floor(Date.now() / 1000);
        return json({
          object: "list",
          data: [
            { id: "gpt-web-port", object: "model", created: now, owned_by: "chatgpt-web" },
            { id: "chatgpt-web", object: "model", created: now, owned_by: "chatgpt-web" },
            { id: config.apiKey ? "gpt-web" : "gpt-web-port", object: "model", created: now, owned_by: "local" },
          ],
        });
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/v1/chat/completions" ||
          url.pathname === "/v1/completions" ||
          url.pathname === "/chat/completions")
      ) {
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ error: { message: "JSON 格式錯誤。", type: "invalid_request_error" } }, 400);
        }
        let parsed: { prompt: string; model: string; stream: boolean; continueConversation: boolean };
        try {
          parsed = parseChatCompletions(body);
        } catch (error) {
          return json({ error: { message: (error as Error).message, type: "invalid_request_error" } }, 400);
        }

        const controller = new AbortController();
        const onAbort = () => controller.abort();
        request.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const result = await session.ask(parsed.prompt, {
            continueConversation: parsed.continueConversation,
            signal: controller.signal,
          });

          if (parsed.stream) {
            const id = `chatcmpl-web-${Date.now().toString(36)}`;
            const created = Math.floor(Date.now() / 1000);
            const chunks = chunkText(result.reply, 24);
            const stream = new ReadableStream({
              start(streamController) {
                // 先送 role，再逐塊送，最後送 stop + [DONE]
                streamController.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({
                      id,
                      object: "chat.completion.chunk",
                      created,
                      model: parsed.model,
                      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
                    })}\n\n`,
                  ),
                );
                for (const piece of chunks) {
                  streamController.enqueue(new TextEncoder().encode(sseChunk(id, created, parsed.model, piece)));
                }
                streamController.enqueue(new TextEncoder().encode(sseDone(id, created, parsed.model)));
                streamController.close();
              },
            });
            return new Response(stream, {
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
                connection: "keep-alive",
                "access-control-allow-origin": "*",
              },
            });
          }

          return json(chatCompletionObject(parsed.model, result.reply, result.conversationUrl, result.durationMs));
        } catch (error) {
          if (error instanceof NotLoggedInError) {
            return json({ error: { message: error.message, type: "authentication_error" } }, 401);
          }
          return json({
            error: { message: error instanceof Error ? error.message : String(error), type: "server_error" },
          }, 502);
        } finally {
          request.signal.removeEventListener("abort", onAbort);
        }
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
