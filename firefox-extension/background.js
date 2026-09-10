(function () {
  "use strict";

  let workerTabId = null;
  const STATE_KEY = "tfcStateV4";
  const WORKER_KEY = "tfcWorkerTabId";
  const LOG_KEY = "tfcLogsV1";
  const LOG_LIMIT = 500;
  let logChain = Promise.resolve();

  function safePath(value) {
    try { return new URL(String(value)).pathname.slice(0, 180); } catch (_) { return ""; }
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value));
      return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 240);
    } catch (_) {
      return String(value || "").slice(0, 240);
    }
  }

  function bgLog(level, message, details = {}) {
    const record = { at: new Date().toISOString(), role: "background", path: "service-worker", level, message, details };
    logChain = logChain.then(async () => {
      const stored = await chrome.storage.local.get(LOG_KEY);
      const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY].slice(-LOG_LIMIT + 1) : [];
      logs.push(record);
      await chrome.storage.local.set({ [LOG_KEY]: logs });
    }).catch(() => undefined);
  }

  async function readWorkerId() {
    if (workerTabId != null) return workerTabId;
    const stored = await chrome.storage.session.get(WORKER_KEY);
    workerTabId = stored[WORKER_KEY] ?? null;
    return workerTabId;
  }

  async function writeWorkerId(value) {
    workerTabId = value;
    if (value == null) await chrome.storage.session.remove(WORKER_KEY);
    else await chrome.storage.session.set({ [WORKER_KEY]: value });
    bgLog("info", "Worker tab id actualizado", { tabId: value });
  }

  async function getExistingWorker() {
    await readWorkerId();
    if (workerTabId == null) return null;
    try {
      await chrome.tabs.get(workerTabId);
      return workerTabId;
    } catch (_) {
      bgLog("warn", "La pestaña worker ya no existe", { tabId: workerTabId });
      await writeWorkerId(null);
      return null;
    }
  }

  async function ensureWorkerContent(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "TFC_PING" });
      bgLog("debug", "Content script del worker respondió al ping", { tabId });
      return;
    } catch (error) {
      bgLog("warn", "El worker no respondió al ping; intentaré inyectar content.js", { tabId, error: String(error && error.message || error) });
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      bgLog("info", "content.js inyectado explícitamente en el worker", { tabId });
    } catch (error) {
      bgLog("error", "No pude inyectar content.js en el worker", { tabId, error: String(error && error.message || error) });
    }
  }

  function respondAsync(sendResponse, operation) {
    operation().then(sendResponse).catch(error => {
      bgLog("error", "Operación del service worker falló", { error: String(error && error.message || error) });
      sendResponse({ ok: false, error: String(error && error.message || error) });
    });
    return true;
  }

  function trustedClick(tabId, x, y) {
    return (async () => {
      if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) {
        bgLog("info", "La API debugger no está disponible; se usará el clic DOM", { tabId, method: "dom-fallback", browserLimitation: true });
        return { ok: false, error: "Firefox no implementa la API debugger de Chrome.", method: "dom-fallback" };
      }
      const debuggee = { tabId };
      let attached = false;
      let pressed = false;
      try {
        await chrome.debugger.attach(debuggee, "1.3");
        attached = true;
        await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x, y
        });
        await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
          type: "mousePressed", x, y, button: "left", clickCount: 1
        });
        pressed = true;
        await new Promise(resolve => setTimeout(resolve, 45));
        await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x, y, button: "left", clickCount: 1
        });
        pressed = false;
        bgLog("info", "Clic de navegador enviado", { tabId, x: Math.round(x), y: Math.round(y), method: "debugger-input" });
        return { ok: true, method: "debugger-input" };
      } catch (error) {
        const message = String(error && error.message || error);
        bgLog("warn", "No pude enviar clic de navegador; se usará respaldo DOM", { tabId, x: Math.round(x), y: Math.round(y), error: message });
        return { ok: false, error: message, method: "debugger-input" };
      } finally {
        if (attached) {
          if (pressed) {
            try {
              await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
                type: "mouseReleased", x, y, button: "left", clickCount: 1
              });
            } catch (_) { /* the target may already be gone */ }
          }
          try { await chrome.debugger.detach(debuggee); } catch (_) { /* already detached */ }
        }
      }
    })();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "TFC_ROLE") {
      return respondAsync(sendResponse, async () => {
        const id = await readWorkerId();
        bgLog("debug", "Rol solicitado", { senderTabId: sender.tab?.id ?? null, workerTabId: id });
        return { role: sender.tab?.id != null && sender.tab.id === id ? "worker" : "main", tabId: sender.tab?.id ?? null };
      });
    }

    if (message?.type === "TFC_TRUSTED_CLICK") {
      return respondAsync(sendResponse, async () => {
        const tabId = sender.tab?.id;
        const x = Number(message.x);
        const y = Number(message.y);
        if (tabId == null || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) {
          throw new Error("Coordenadas de clic no válidas.");
        }
        return trustedClick(tabId, x, y);
      });
    }

    if (message?.type === "TFC_OPEN_WORKER") {
      return respondAsync(sendResponse, async () => {
        bgLog("info", "Solicitud para abrir worker", { url: safePath(message.url) });
        const existing = await getExistingWorker();
        if (existing != null) {
          await chrome.tabs.update(existing, { url: "https://www.tiktok.com/", active: false });
          bgLog("info", "Worker existente reutilizado y precalentado en TikTok", { tabId: existing, target: safeUrl(message.url) });
          return { ok: true, tabId: existing };
        }
        // Create about:blank first so the worker id is known before TikTok's
        // content script starts. This avoids a race with the role check.
        const tab = await chrome.tabs.create({ url: "https://www.tiktok.com/", active: false });
        await writeWorkerId(tab.id);
        bgLog("info", "Worker creado y precalentando TikTok", { tabId: workerTabId, target: safeUrl(message.url) });
        return { ok: true, tabId: workerTabId };
      });
    }

    if (message?.type === "TFC_NAVIGATE_WORKER") {
      return respondAsync(sendResponse, async () => {
        const id = await getExistingWorker();
        if (id == null) throw new Error("La pestaña de trabajo ya no existe.");
        await chrome.tabs.update(id, { url: message.url, active: false });
        bgLog("info", "Worker navegó a nuevo video", { tabId: id, url: safePath(message.url) });
        return { ok: true, tabId: id };
      });
    }

    if (message?.type === "TFC_WAKE_WORKER") {
      return respondAsync(sendResponse, async () => {
        const id = await getExistingWorker();
        if (id == null) throw new Error("La pestaña de trabajo ya no existe.");
        bgLog("info", "Despertando worker", { tabId: id });
        await chrome.tabs.sendMessage(id, { type: "TFC_RUN_NOW" });
        return { ok: true, tabId: id };
      });
    }

    if (message?.type === "TFC_CLOSE_WORKER") {
      return respondAsync(sendResponse, async () => {
        const id = await getExistingWorker();
        await writeWorkerId(null);
        if (id != null) await chrome.tabs.remove(id);
        bgLog("info", "Worker cerrado", { tabId: id });
        return { ok: true };
      });
    }

    return false;
  });

  chrome.tabs.onRemoved.addListener(async tabId => {
    const knownWorker = await readWorkerId();
    if (tabId !== knownWorker) return;
    bgLog("warn", "La pestaña worker fue cerrada", { tabId });
    await writeWorkerId(null);
    const stored = await chrome.storage.local.get(STATE_KEY);
    const state = stored[STATE_KEY];
    if (state && ["auto_scanning", "deleting", "verifying", "paused"].includes(state.status)) {
      await chrome.storage.local.set({ [STATE_KEY]: { ...state, workerTabId: null, status: "stopped", lastError: "La pestaña de trabajo se cerró; la operación quedó detenida.", lastProgressAt: Date.now(), lastProgressMessage: "La pestaña worker fue cerrada." } });
    }
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    const knownWorker = await readWorkerId();
    if (tabId !== knownWorker || (!changeInfo.status && !changeInfo.url)) return;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (error) {
      bgLog("warn", "No pude leer la pestaña worker tras un cambio", { tabId, error: String(error && error.message || error) });
    }
    bgLog("debug", "Cambio de estado en pestaña worker", { tabId, status: changeInfo.status || "", url: safeUrl(changeInfo.url || tab?.url || ""), title: tab?.title || "", tabStatus: tab?.status || "" });
    if (changeInfo.status === "complete") await ensureWorkerContent(tabId);
  });

  if (chrome.webNavigation?.onErrorOccurred) {
    chrome.webNavigation.onErrorOccurred.addListener(async details => {
      const knownWorker = await readWorkerId();
      if (details.tabId !== knownWorker) return;
      bgLog("error", "Error de navegación en pestaña worker", { tabId: details.tabId, frameId: details.frameId, error: details.error, url: safeUrl(details.url) });
    });
  }
})();
