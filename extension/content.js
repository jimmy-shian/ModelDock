/**
 * WebChat to Local Bridge - Main Content Script
 * Connects gemini.google.com and chatgpt.com to the local Python gateway and MCP engine.
 */

let ws = null;
let reconnectTimer = null;
let activeTurnId = null;
let isGeneratingResponse = false;
let rawForwarded = false;
let netAccumulated = "";
let lastApiTurnTimestamp = 0;
// True once the page was observed generating for this turn. When set, a
// later extraction failure must NOT be retried: a second attempt would push
// the total past the bridge's 180s timeout and the answer would be discarded.
let turnGenerationObserved = false;
const TURN_DEADLINE_MS = 120000;
const pendingMcpCalls = new Map();

// --- Transport noise detection / stripping (shared with backend _is_transport_noise) ---
const CONDUIT_RE = /\{[^{}]*"conduit_(?:token|uuid)"[^{}]*\}/ig;
function looksLikeTransportNoise(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  if (CONDUIT_RE.test(t)) return true;
  if (/^(?:https?:)?\/\/\S+$/i.test(t)) return true;
  if (/^[A-Za-z0-9_.-]{16,}$/.test(t)) return true;
  if (/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(t)) return true;
  if (/根據您的\s*(?:IP|位置|過去活動)|Based on your (?:IP|location)/i.test(t)) return true;
  return false;
}
// Strip conduit token JSON from text, returning only the real content.
function stripConduitToken(s) {
  return String(s || "").replace(CONDUIT_RE, "").trim();
}

const isChatGPT = window.location.hostname.includes("chatgpt.com");
const isGemini = window.location.hostname.includes("gemini.google.com");
const currentPlatform = isChatGPT ? "chatgpt" : (isGemini ? "gemini" : "unknown");

function getActiveController() {
  if (isChatGPT) return window.ChatGptController;
  return window.GeminiController;
}

function getActiveExtractor() {
  if (isChatGPT) return window.ChatGptExtractor;
  return window.GeminiExtractor;
}

// 擴充套件重載後，舊分頁的 content script 會變成孤兒：chrome.storage
// 的回調永遠不回來。這裡加雙保險：context 失效立刻用預設值，
// 正常情況也只等 1.5 秒，絕不讓整輪 turn 卡死在這一行。
function isContextValid() {
  try {
    return !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
  } catch (_) {
    return false;
  }
}

function getStoredSettings() {
  const fallback = { autoReload: isChatGPT, forceNewChat: false, autoDismissModals: true };
  if (!isContextValid()) {
    console.warn("[WebChat Bridge] Extension context invalidated (舊分頁＋擴充套件剛重載？). 使用預設值，請重載本分頁。");
    return Promise.resolve({ ...fallback });
  }
  return Promise.race([
    new Promise((resolve) => {
      try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get({
            cleanSession: null, // 新版 popup 單一開關（同時寫入舊 key 以相容）
            autoReload: isChatGPT, // Default true for ChatGPT guest mode
            forceNewChat: true,
            autoDismissModals: true
          }, (res) => {
            // 新版優先：cleanSession 同時代表「回合前開新對話＋回合後重載」
            if (res && (res.cleanSession === true || res.cleanSession === false)) {
              resolve({
                autoReload: !!res.cleanSession,
                forceNewChat: !!res.cleanSession,
                autoDismissModals: res.autoDismissModals !== false,
              });
              return;
            }
            resolve(res);
          });
        } else {
          resolve({ autoReload: isChatGPT, forceNewChat: true, autoDismissModals: true });
        }
      } catch (_) {
        resolve({ autoReload: isChatGPT, forceNewChat: true, autoDismissModals: true });
      }
    }),
    sleep(1500).then(() => fallback),
  ]);
}

// ---------- Pending-turn persistence (survive MPA reload mid-turn) ----------
const PENDING_KEY = "w2l_pending_turn";
function _pendingStore() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage) {
      return chrome.storage.session || chrome.storage.local || null;
    }
  } catch (_) {}
  return null;
}
function savePendingTurn(t) {
  try { const s = _pendingStore(); if (s) s.set({ [PENDING_KEY]: t }); } catch (_) {}
}
function clearPendingTurn() {
  try { const s = _pendingStore(); if (s) s.remove(PENDING_KEY); } catch (_) {}
}
function loadPendingTurn() {
  return new Promise((resolve) => {
    try {
      const s = _pendingStore();
      if (!s) return resolve(null);
      s.get( [PENDING_KEY], (r) => {
        try { resolve((r && r[PENDING_KEY]) || null); }
        catch (_) { resolve(null); }
      });
    } catch (_) { resolve(null); }
  });
}
function waitForWsOpen(maxMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function poll() {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) return resolve(true);
      } catch (_) {}
      if (Date.now() - t0 > (maxMs || 10000)) return resolve(false);
      setTimeout(poll, 200);
    })();
  });
}
function armInterceptor(turnId) {
  try {
    window.postMessage({
      source: "webchat2local-content",
      type: "W2L_SET_ACTIVE_REQUEST",
      request_id: turnId,
    }, "*");
  } catch (_) {}
}

function callLocalMcpTool(toolName, args) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error("WebSocket to WebChat2Local is not connected"));
    }
    const callId = "mcp_" + Math.random().toString(36).substring(2, 10);
    const timer = setTimeout(() => {
      pendingMcpCalls.delete(callId);
      reject(new Error(`MCP tool '${toolName}' call timed out after 60s`));
    }, 60000);

    pendingMcpCalls.set(callId, { resolve, reject, timer, toolName });
    ws.send(JSON.stringify({
      type: "call_mcp_tool",
      call_id: callId,
      tool: toolName,
      arguments: args || {}
    }));
    console.log(`[WebChat Tunnel] Dispatched MCP tool '${toolName}' to local bridge (id=${callId})`);
  });
}

// Window message listener for MAIN-world interceptor (used on Gemini)
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || event.data.source !== "webchat2local-network") return;

  const msg = event.data;
  if (msg.type === "W2L_INTERCEPTOR_PONG") {
    console.log(`[WebChat Bridge] MAIN-world interceptor ready (${msg.version}).`);
    return;
  }

  if (!activeTurnId) return;
  if (msg.request_id && msg.request_id !== activeTurnId) return;

  if (msg.type === "capture_attempt") {
    console.log(`[WebChat Bridge][LOCAL-TRACE] capture_attempt turn=${activeTurnId} transport=${msg.transport || "?"} rpcids=${msg.rpcids || "-"}`);
    return;
  }

  // 抓取證據直通 bridge /v1/logs（回答「GPT 網頁到底回什麼」）。
  if (msg.type === "debug") {
    console.log(`[WebChat Bridge][CAPTURE] ${(msg.scope || "")} ${(msg.text || "").slice(0, 220)}`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "debug", scope: msg.scope || "capture", text: msg.text || "" }));
      } catch (_) {}
    }
    return;
  }

  if (msg.type === "chunk" && typeof msg.accumulated === "string" && msg.accumulated.length > 0) {
    const stripped = stripConduitToken(msg.accumulated);
    if (!stripped) return;
    const delta = typeof msg.delta === "string" ? msg.delta : "";
    netAccumulated = stripped;
    console.log(`[WebChat Bridge][NET-CHUNK] delta=${delta.length} total=${stripped.length} rawFwd=${rawForwarded}`);
    if (delta.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      rawForwarded = true;
      ws.send(JSON.stringify({
        type: "chunk",
        turn_id: activeTurnId,
        text: stripped,
        delta,
        thought: "",
        thought_delta: "",
      }));
    }
    return;
  }

  if (msg.type === "stream_error") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "error", turn_id: activeTurnId, error: msg.error || "Network stream error" }));
    }
    return;
  }

  if (msg.type === "done") {
    const stripped = stripConduitToken(msg.full_text);
    console.log(`[WebChat Bridge][NET-DONE] raw_len=${(msg.full_text||"").length} stripped_len=${stripped.length}`);
    if (!stripped) return;
    // Telemetry ACKs ({"success":true} etc.) are never the answer. Drop them
    // so a stray telemetry stream can't complete the turn with garbage; the
    // real answer stream (or DOM fallback) still owns completion.
    if (/^\{\s*"(success|status|ok)"\s*:/.test(stripped) && stripped.length < 300) {
      console.log(`[WebChat Bridge][NET-DONE] telemetry ACK suppressed, waiting for real stream...`);
      return;
    }
    rawForwarded = true;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "done",
        turn_id: activeTurnId,
        text: stripped,
        thought: "",
      }));
    }
    isGeneratingResponse = false;
  }
});

function init() {
  if (window.GeminiStatusHUD) {
    window.GeminiStatusHUD.init();
  }
  if (!isContextValid()) {
    console.error("[WebChat Bridge] 此分頁的擴充套件腳本已失效（擴充套件重載過）。請按 F5 重載本分頁，否則訊息送得出去但永遠收不到回傳。");
  }
  connectWebSocket();

  // Adopt a turn orphaned by a mid-turn reload (see savePendingTurn).
  (async () => {
    try {
      const p = await loadPendingTurn();
      if (!p || !p.turnId) return;
      if (Date.now() - (p.t || 0) > 150000) { clearPendingTurn(); return; }
      if (activeTurnId || isGeneratingResponse) { clearPendingTurn(); return; }
      const ok = await waitForWsOpen(10000);
      if (!ok) { clearPendingTurn(); return; }
      resumeTurnFlow(p.turnId, p.prompt || "", p.model || "").catch(() => {
        isGeneratingResponse = false;
        activeTurnId = null;
        clearPendingTurn();
      });
    } catch (_) {}
  })();

  // Watch for in-page chat completions to execute in-page MCP Tunnel (Gemini only)
  if (isGemini) {
    let lastObservedResponse = null;
    let observerDebounce = null;
    const observer = new MutationObserver(() => {
      if (isGeneratingResponse || activeTurnId) return;
      if (Date.now() - lastApiTurnTimestamp < 300000) return;
      if (observerDebounce) clearTimeout(observerDebounce);
      observerDebounce = setTimeout(() => {
        const controller = getActiveController();
        const isGen = controller ? controller.isGenerating() : false;
        const extractor = getActiveExtractor();
        if (!isGen && extractor) {
          const respEl = extractor.findCurrentTurnResponseElement();
          if (respEl && respEl !== lastObservedResponse) {
            lastObservedResponse = respEl;
            runInPageMcpTunnelLoop(respEl);
          }
        }
      }, 500);
    });

    try {
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
  }
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket("ws://127.0.0.1:8765/ws");

    ws.onopen = () => {
      console.log(`[WebChat Bridge] WebSocket Connected to 127.0.0.1:8765 (${currentPlatform})`);
      if (window.GeminiStatusHUD) window.GeminiStatusHUD.setConnected();

      ws.send(JSON.stringify({
        type: "ready",
        meta: {
          url: window.location.href,
          platform: currentPlatform,
          model: isChatGPT ? "ChatGPT Web (Guest)" : "Google Gemini Web",
        }
      }));
    };

    ws.onmessage = async (event) => {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        console.error("[WebChat Bridge] Error parsing WS message:", err);
        return;
      }
      try {
        await handleIncomingMessage(msg);
      } catch (err) {
        // Never let an unexpected error die silently: report it back to the
        // bridge so the waiting turn fails fast with a visible reason.
        console.error("[WebChat Bridge] Unhandled error in message handler:", err);
        if (msg && msg.turn_id && ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: "error",
              turn_id: msg.turn_id,
              error: `擴充套件內部錯誤: ${err && err.message ? err.message : String(err)}`,
            }));
          } catch (_) {}
        }
      }
    };

    ws.onclose = () => {
      if (window.GeminiStatusHUD) window.GeminiStatusHUD.setDisconnected();
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (window.GeminiStatusHUD) window.GeminiStatusHUD.setDisconnected();
      ws.close();
    };
  } catch (err) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, 2000);
}

async function handleIncomingMessage(msg) {
  if (msg.type === "ping") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "pong" }));
    }
    return;
  }

  if (msg.type === "mcp_tool_result") {
    const callId = msg.call_id;
    if (pendingMcpCalls.has(callId)) {
      const { resolve, timer, toolName } = pendingMcpCalls.get(callId);
      clearTimeout(timer);
      pendingMcpCalls.delete(callId);
      console.log(`[WebChat Tunnel] Received MCP tool result for '${toolName}' (id=${callId})`);
      resolve(msg.result);
    }
    return;
  }

  if (msg.type === "cancel_turn" || msg.type === "reset") {
    console.log("[WebChat Bridge] Received cancel/reset command.");
    isGeneratingResponse = false;
    activeTurnId = null;
    try {
      const stopBtns = document.querySelectorAll("button[aria-label*='Stop'], button[aria-label*='停止'], [data-testid='stop-button'], .stop-button");
      stopBtns.forEach(b => { if (b.offsetParent !== null) b.click(); });
    } catch (_) {}
    if (window.GeminiStatusHUD) window.GeminiStatusHUD.setConnected();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "reset_ack" }));
    }
    return;
  }

  if (msg.type === "submit_prompt") {
    const turnId = msg.turn_id;
    const promptText = msg.prompt;
    const model = msg.model || (isChatGPT ? "chatgpt-web/auto" : "gemini-web/flash");

    const controller = getActiveController();
    const extractor = getActiveExtractor();

    if (!controller || !extractor) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "error",
          turn_id: turnId,
          error: `無法載入控制器 (${currentPlatform})，請確認擴充套件已正確載入腳本。`
        }));
      }
      return;
    }

    // Auto-recovery & turn sequencing
    if (isGeneratingResponse || activeTurnId) {
      const isStillGenerating = controller.isGenerating ? controller.isGenerating() : false;
      if (!isStillGenerating) {
        isGeneratingResponse = false;
        activeTurnId = null;
      } else {
        console.warn("[WebChat Bridge] Previous turn still generating on webpage, waiting...");
        let cleared = false;
        for (let i = 0; i < 40; i++) {
          await sleep(100);
          if (!controller.isGenerating()) {
            cleared = true;
            break;
          }
        }
        if (cleared) {
          isGeneratingResponse = false;
          activeTurnId = null;
        } else {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "error",
              turn_id: turnId,
              error: "已有對話正在執行；為避免頁面競態，已拒絕本次要求。"
            }));
          }
          return;
        }
      }
    }

    activeTurnId = turnId;
    rawForwarded = false;
    netAccumulated = "";

    // Arm MAIN-world interceptor (Gemini batchexecute / ChatGPT conversation stream)
    armInterceptor(turnId);
    // Persist so a mid-turn MPA reload can resume instead of hanging the bridge.
    savePendingTurn({ turnId, prompt: promptText, model, submitted: false, t: Date.now() });

    lastApiTurnTimestamp = Date.now();
    const isNewSession = msg.is_new_session !== false;
    const sessionTag = isNewSession ? "新任務" : "接續會話";

    if (window.GeminiStatusHUD) window.GeminiStatusHUD.setGenerating(turnId, model, sessionTag);

    const settings = await getStoredSettings();

    // Execution with single-retry on failure (retry only when the prompt
    // never got the page generating; once generation was observed a retry
    // would exceed the bridge timeout and the late answer gets discarded).
    let attempt = 0;
    let turnSuccess = false;
    let lastError = null;
    turnGenerationObserved = false;

    while (attempt < 2 && !turnSuccess) {
      attempt++;
      try {
        // Step A: Auto-dismiss modals on ChatGPT guest mode
        if (settings.autoDismissModals && controller.dismissLoginModals) {
          controller.dismissLoginModals();
        }

        // Step B: New chat if requested or preferred
        if ((settings.forceNewChat || msg.force_new_chat) && controller.startNewChatIfAvailable) {
          console.log("[WebChat Bridge] Opening fresh chat before turn...");
          controller.startNewChatIfAvailable();
          await sleep(attempt === 1 ? 800 : 1500);
        }

        // Step C: Wait for idle & ready
        if (controller.waitForIdleAndReady) {
          await controller.waitForIdleAndReady(6000);
        }

        // Step D: Snapshot prior responses
        extractor.snapshotBeforeTurn(turnId);

        // Step E: Model switch if supported
        if (controller.switchModelIfAvailable) {
          await controller.switchModelIfAvailable(model);
        }

        // Step F: Inject prompt and click send
        await controller.submitPromptWithRetry(promptText);
        savePendingTurn({ turnId, prompt: promptText, model, submitted: true, t: Date.now() });

        // Step G: Stream response
        await streamResponseTurn(turnId, promptText, controller, extractor);

        turnSuccess = true;
      } catch (err) {
        lastError = err;
        console.warn(`[WebChat Bridge] Attempt ${attempt} failed:`, err);
        if (turnGenerationObserved) {
          console.warn("[WebChat Bridge] Generation was observed; skipping retry to stay within bridge timeout.");
          break;
        }
        if (attempt === 1) {
          console.log("[WebChat Bridge] Attempting auto-retry once after 1s debounce...");
          await sleep(1000);
        }
      }
    }

    // After turns finish - delay clearing active request to ensure stream capture completes
    setTimeout(() => {
      try {
        window.postMessage({ source: "webchat2local-content", type: "W2L_CLEAR_ACTIVE_REQUEST" }, "*");
      } catch (_) {}
      isGeneratingResponse = false;
      activeTurnId = null;
    }, 500);

    clearPendingTurn();
    if (!turnSuccess) {
      console.error("[WebChat Bridge] Turn execution failed after retry:", lastError);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "error",
          turn_id: turnId,
          error: lastError.message || String(lastError),
        }));
      }
      if (window.GeminiStatusHUD) window.GeminiStatusHUD.setConnected();
    } else {
      // Step H: Mandatory single-turn reload if configured (for unlogged-in guest hygiene)
      if (settings.autoReload) {
        console.log("[WebChat Bridge] Auto Reload enabled. Cleaning up page state in 600ms...");
        setTimeout(() => {
          if (controller.reloadPageCleanly) {
            controller.reloadPageCleanly();
          } else {
            window.location.reload();
          }
        }, 600);
      }
    }
  }
}

// Resume a turn orphaned by a mid-turn page reload: the server may still be
// waiting on it. Never resubmits (would duplicate the user message) and
// never auto-reloads (would loop). Fresh DOM → snapshot now, then stream.
async function resumeTurnFlow(turnId, promptText, model) {
  const controller = getActiveController();
  const extractor = getActiveExtractor();
  if (!controller || !extractor) { clearPendingTurn(); return; }
  if (isGeneratingResponse || activeTurnId) return;
  console.log(`[WebChat Bridge] Resuming orphaned turn ${turnId} after reload.`);
  activeTurnId = turnId;
  rawForwarded = false;
  netAccumulated = "";
  turnGenerationObserved = false;
  armInterceptor(turnId);
  lastApiTurnTimestamp = Date.now();
  if (window.GeminiStatusHUD) window.GeminiStatusHUD.setGenerating(turnId, model, "斷點續跑");
  try {
    // 注意：不要 snapshot。重載後的 DOM 若已有完整答案，snapshot 會把它
    // 標成 prior 反而找不到；留空 prior，新est 的 assistant 元素即目標。
    await streamResponseTurn(turnId, promptText, controller, extractor);
    // streamResponseTurn sends done/chunk itself on success.
  } catch (err) {
    console.warn(`[WebChat Bridge] Resume turn ${turnId} failed:`, err);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: "error",
          turn_id: turnId,
          error: (err && err.message ? err.message : String(err)) + "（頁面曾重載，已嘗試續跑）",
        }));
      } catch (_) {}
    }
    if (window.GeminiStatusHUD) window.GeminiStatusHUD.setConnected();
  } finally {
    clearPendingTurn();
    try {
      window.postMessage({ source: "webchat2local-content", type: "W2L_CLEAR_ACTIVE_REQUEST" }, "*");
    } catch (_) {}
    isGeneratingResponse = false;
    activeTurnId = null;
  }
}

async function streamResponseTurn(turnId, promptSnippet, controller, extractor) {
  isGeneratingResponse = true;
  const deadline = Date.now() + TURN_DEADLINE_MS;
  let lastText = "";
  let lastThought = "";
  let targetEl = null;

  console.log(`[WebChat Bridge] Waiting for turn ${turnId} to start on ${currentPlatform}...`);

  let turnStarted = false;
  for (let i = 0; i < 200; i++) {
    await sleep(100);

    // Check for error banners (Rate limit, Cloudflare, etc.)
    if (extractor.detectErrorBanner) {
      const errBanner = extractor.detectErrorBanner();
      if (errBanner) {
        throw new Error(`${currentPlatform.toUpperCase()} 介面顯示錯誤: ${errBanner}`);
      }
    } else {
      const domErr = document.querySelector("div[role='alert'], .error-message, [data-test-id*='error'], .toast-error, .banner-error");
      if (domErr && domErr.offsetParent !== null) {
        const errText = (domErr.innerText || "").trim();
        if (/發生錯誤|Something went wrong|error\s*\d+|無法處理|Too many requests/i.test(errText)) {
          throw new Error(`介面顯示錯誤: ${errText}`);
        }
      }
    }

    targetEl = extractor.findCurrentTurnResponseElement();
    const generating = controller.isGenerating();

    // The network interceptor may already be streaming the answer even before
    // the DOM renders any assistant element (e.g. ChatGPT guest HTML stream).
    if (targetEl || generating || rawForwarded) {
      turnStarted = true;
      turnGenerationObserved = true;
      break;
    }
  }

  if (!turnStarted && !targetEl) {
    throw new Error(`${currentPlatform.toUpperCase()} 尚未開始生成回應，請確認網頁輸入框或網路狀態。`);
  }

  // Phase 2: If generation started but container element is still loading, wait for it
  if (!targetEl) {
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      targetEl = extractor.findCurrentTurnResponseElement();
      if (targetEl) break;
    }
  }

  let idleRounds = 0;
  const maxIdleRounds = isChatGPT ? 15 : 12;

  // Phase 3: Streaming loop
  // ChatGPT: network interceptor IS the primary source. DOM extraction uses
  // GeminiMarkdownSerializer which mangles ChatGPT tables, and DOM snapshots
  // get sent as full-text deltas causing duplication in the bridge. Once the
  // network stream delivers any real content, STOP DOM polling entirely and
  // wait for the network done event. Fall back to DOM only if the network
  // interceptor never delivered anything (e.g. request blocked before stream).
  while (isGeneratingResponse) {
    if (Date.now() >= deadline) throw new Error(`回應逾時 (${TURN_DEADLINE_MS / 1000}s)`);
    await sleep(80);

    // Network done already arrived → exit immediately.
    if (rawForwarded && !isGeneratingResponse) break;

    // ChatGPT network-active mode: once we have ANY network content,
    // skip all DOM extraction — the network data is clean and complete.
    if (isChatGPT && (rawForwarded || netAccumulated.length > 0)) {
      // Just wait for generation to finish; network path owns the output.
      continue;
    }

    if (!targetEl) {
      targetEl = extractor.findCurrentTurnResponseElement();
    }
    if (!targetEl) {
      // On ChatGPT, if we have network data but no DOM element yet, that's fine.
      if (isChatGPT && netAccumulated.length > 0) continue;
      continue;
    }

    const state = extractor.extractCurrentState(targetEl);
    const currentCandidateText = state.text || "";
    const currentCandidateThought = state.thought || "";

    // Gemini: replacement semantics for DOM snapshots (tables reflow mid-stream).
    let deltaText = "", deltaThought = "";
    if (currentCandidateText.startsWith(lastText)) {
      deltaText = currentCandidateText.slice(lastText.length);
    } else if (currentCandidateText.length > 0 && currentCandidateText !== lastText) {
      deltaText = currentCandidateText;
    }
    if (currentCandidateThought.startsWith(lastThought)) {
      deltaThought = currentCandidateThought.slice(lastThought.length);
    } else if (currentCandidateThought.length > 0 && currentCandidateThought !== lastThought) {
      deltaThought = currentCandidateThought;
    }

    if (deltaText.length > 0 || deltaThought.length > 0) {
      idleRounds = 0;
      // NEVER send DOM-sourced chunks for ChatGPT — the network interceptor
      // handles it. DOM is only used for Gemini where it's the primary source.
      // Also block if netAccumulated has content (network path is active but
      // rawForwarded flag hasn't flipped yet — race window).
      const netActive = isChatGPT && (rawForwarded || netAccumulated.length > 0);
      if (!netActive && !rawForwarded && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "chunk",
          turn_id: turnId,
          text: currentCandidateText,
          delta: deltaText,
          thought: currentCandidateThought,
          thought_delta: deltaThought,
        }));
      }
      lastText = currentCandidateText;
      lastThought = currentCandidateThought;
    } else {
      const isGen = controller.isGenerating();
      const hasActionButtons = isChatGPT && targetEl && !!targetEl.querySelector("button[data-testid*='copy'], button[aria-label*='Copy'], button[aria-label*='複製']");
      if ((!isGen || hasActionButtons) && (lastText.length > 0 || lastThought.length > 0)) {
        idleRounds += (hasActionButtons ? 3 : 1);
        if (idleRounds >= maxIdleRounds) {
          break;
        }
      }
    }
  }

  // ChatGPT: network interceptor done already sent its own done event.
  // Just clean up and exit.
  if (isChatGPT && (rawForwarded || netAccumulated.length > 0)) {
    if (window.GeminiStatusHUD) window.GeminiStatusHUD.setConnected();
    return;
  }

  // Gemini (or ChatGPT fallback if network never delivered):
  // Network-first final text selection.
  const netClean = stripConduitToken(netAccumulated || "");
  if (netClean.trim().length > 0 && netClean.trim().length >= lastText.trim().length) {
    isGeneratingResponse = false;
    activeTurnId = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "done",
        turn_id: turnId,
        text: netClean,
        thought: "",
      }));
    }
    console.log(`[WebChat Bridge] Turn ${turnId} completed via network capture (${netClean.length} chars).`);
    if (window.GeminiStatusHUD) window.GeminiStatusHUD.setConnected();
    return;
  }

  if (lastText.trim().length === 0) {
    throw new Error("生成完畢，但未能擷取到文字回應。");
  }

  // Phase 4: Emit completion (DOM fallback for Gemini)
  isGeneratingResponse = false;
  activeTurnId = null;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "done",
      turn_id: turnId,
      text: lastText,
      thought: lastThought,
    }));
  }

  console.log(`[WebChat Bridge] Turn ${turnId} completed (${lastText.length} chars).`);
  if (window.GeminiStatusHUD) window.GeminiStatusHUD.setConnected();
}

/**
 * Extract tool calls from text response for in-page MCP Tunnel (Gemini only)
 */
function extractInPageToolCalls(text) {
  const tools = [];
  if (!text || typeof text !== "string") return tools;

  const jsonMatches = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)];
  for (const match of jsonMatches) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        tools.push({
          name: parsed.name,
          arguments: parsed.arguments || parsed.parameters || parsed.input || {}
        });
      }
    } catch (_) {}
  }
  return tools;
}

async function runInPageMcpTunnelLoop(responseEl) {
  if (!responseEl || isGeneratingResponse || activeTurnId) return;
  const extractor = getActiveExtractor();
  const state = extractor ? extractor.extractCurrentState(responseEl) : null;
  const text = state ? state.text : (responseEl.innerText || "");
  const toolCalls = extractInPageToolCalls(text);

  if (toolCalls.length === 0) return;

  for (const tc of toolCalls) {
    try {
      if (window.GeminiStatusHUD) {
        window.GeminiStatusHUD.setStatus("generating", `🔧 [Tunnel MCP] 執行 ${tc.name}...`);
      }
      const result = await callLocalMcpTool(tc.name, tc.arguments);
      const resultText = `<tool_result name="${tc.name}">\n${typeof result === "object" ? JSON.stringify(result, null, 2) : String(result)}\n</tool_result>`;
      
      await sleep(500);
      const controller = getActiveController();
      if (controller) {
        const editor = controller.setInputText(resultText);
        await sleep(300);
        controller.clickSendButton(editor);
        if (window.GeminiStatusHUD) {
          window.GeminiStatusHUD.setConnected(`✅ [Tunnel MCP] ${tc.name} 結果已送回`);
        }
      }
    } catch (err) {
      console.error(`[WebChat Tunnel] Failed to execute in-page MCP tool ${tc.name}:`, err);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Start content script
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
