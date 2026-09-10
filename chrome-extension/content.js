if (!window.__TFC_CONTENT_LOADED__) {
  window.__TFC_CONTENT_LOADED__ = true;

  (function () {
  "use strict";

  const SOURCE = "tfc-page-bridge";
  const STORAGE_KEY = "tfcStateV4";
  const LOG_KEY = "tfcLogsV1";
  const LOG_LIMIT = 500;
  const PAGE_SIZE = 30;
  const DEFAULT_RISK_COOLDOWN_MS = 60000;
  const SETTINGS_PACE_VERSION = 2;
  const LIST_PATH = "/api/user/collect/item_list/";
  const DEFAULT_SETTINGS = {
    from: "",
    to: "",
    minDelay: 1200,
    maxDelay: 2600,
    batchSize: 30,
    cooldownMin: 25000,
    cooldownMax: 45000,
    autoVerify: true,
    allowUnknownState: false
  };

  let host = null;
  let shadow = null;
  let panelOpen = false;
  let runner = false;
  let stopRequested = false;
  let lastUrl = location.href;
  let domSecUidCache = null;
  let listRequestSerial = 0;
  let logChain = Promise.resolve();
  let logsCache = [];
  let currentRole = "main";
  let watchdogStarted = false;
  let lastWatchdogWarningAt = 0;
  let lastWatchdogStopAt = 0;
  let routeNavigationInFlight = false;
  let routeNavigationReleaseTimer = null;
  let resumeTimer = null;
  const pendingListRequests = new Map();
  const mutationEvents = [];
  const mutationTimeline = [];
  let pendingNetworkRequests = 0;
  let lastNetworkActivityAt = 0;

  class SafetyStopError extends Error {}
  class AmbiguousStateError extends Error {}

  function safeDetails(value, depth = 0) {
    if (depth > 2 || value == null) return value == null ? null : String(value);
    if (["string", "number", "boolean"].includes(typeof value)) return String(value).slice(0, 300);
    if (Array.isArray(value)) return value.slice(0, 12).map(item => safeDetails(item, depth + 1));
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, child]) => [key, safeDetails(child, depth + 1)]));
    return String(value);
  }

  function logEvent(level, message, details = {}) {
    const record = {
      at: new Date().toISOString(),
      role: currentRole,
      path: location.pathname.slice(0, 180),
      level,
      message,
      details: safeDetails(details)
    };
    logsCache.push(record);
    if (logsCache.length > LOG_LIMIT) logsCache = logsCache.slice(-LOG_LIMIT);
    const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "info";
    console[consoleMethod](`[TikTok Favorites Cleaner] ${message}`, record.details);
    logChain = logChain.then(async () => {
      const stored = await chrome.storage.local.get(LOG_KEY);
      const logs = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY].slice(-LOG_LIMIT + 1) : [];
      logs.push(record);
      await chrome.storage.local.set({ [LOG_KEY]: logs });
    }).catch(() => undefined);
    if (shadow) setTimeout(() => render(), 0);
  }

  async function loadLogs() {
    try {
      const stored = await chrome.storage.local.get(LOG_KEY);
      logsCache = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY].slice(-LOG_LIMIT) : [];
    } catch (_) {
      logsCache = [];
    }
  }

  function logLines() {
    return logsCache.map(entry => `${entry.at} [${entry.role}] ${entry.level.toUpperCase()} ${entry.message} ${JSON.stringify(entry.details || {})}`).join("\n");
  }

  async function clearLogs() {
    logsCache = [];
    await chrome.storage.local.set({ [LOG_KEY]: [] });
    render();
  }

  function downloadLogs() {
    const blob = new Blob([logLines()], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `tiktok-favorites-cleaner-log-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
  }

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(logLines());
      logEvent("info", "Logs copiados al portapapeles", { count: logsCache.length });
    } catch (error) {
      logEvent("warn", "No se pudieron copiar los logs", { error: errorText(error) });
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function scheduleResume(delayMs = 900) {
    if (resumeTimer != null) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      void resumeForCurrentRole();
    }, Math.max(0, Number(delayMs) || 0));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character]));
  }

  function injectPageBridge() {
    if (document.querySelector("script[data-tfc-page-bridge]")) return;
    const script = document.createElement("script");
    script.dataset.tfcPageBridge = "true";
    script.src = chrome.runtime.getURL("page-bridge.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function randomBetween(min, max) {
    const lower = Math.min(Number(min) || 0, Number(max) || 0);
    const upper = Math.max(Number(min) || 0, Number(max) || 0);
    return Math.floor(lower + Math.random() * (upper - lower + 1));
  }

  function defaultState() {
    return {
      status: "idle",
      items: [],
      queue: [],
      currentIndex: 0,
      workerTabId: null,
      autoMode: false,
      autoCursor: "0",
      autoPage: 0,
      autoBatchIds: [],
      scanCursor: "0",
      scanPage: 0,
      verificationCursor: "0",
      verificationPage: 0,
      verificationPresentIds: [],
      rateLimitUntil: 0,
      settingsPaceVersion: SETTINGS_PACE_VERSION,
      stats: { scanned: 0, removed: 0, skipped: 0, failed: 0, remaining: 0 },
      lastError: "",
      lastProgressAt: 0,
      lastProgressMessage: "",
      settings: { ...DEFAULT_SETTINGS }
    };
  }

  function normalizeState(raw) {
    const base = defaultState();
    const state = raw && typeof raw === "object" ? raw : {};
    const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
    let settingsPaceVersion = Number(state.settingsPaceVersion) || 1;
    if (settingsPaceVersion < SETTINGS_PACE_VERSION) {
      if (Number(settings.minDelay) === 1800 && Number(settings.maxDelay) === 3200) {
        settings.minDelay = DEFAULT_SETTINGS.minDelay;
        settings.maxDelay = DEFAULT_SETTINGS.maxDelay;
      }
      settingsPaceVersion = SETTINGS_PACE_VERSION;
    }
    return {
      ...base,
      ...state,
      items: Array.isArray(state.items) ? state.items : [],
      queue: Array.isArray(state.queue) ? state.queue : [],
      autoBatchIds: Array.isArray(state.autoBatchIds) ? state.autoBatchIds : [],
      verificationPresentIds: Array.isArray(state.verificationPresentIds) ? state.verificationPresentIds : [],
      stats: { ...base.stats, ...(state.stats || {}) },
      settingsPaceVersion,
      settings
    };
  }

  async function getState() {
    const value = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeState(value[STORAGE_KEY]);
  }

  async function saveState(state) {
    const next = normalizeState(state);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    render(next);
    return next;
  }

  async function updateState(updater) {
    const current = await getState();
    const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
    return saveState(next);
  }

  function progressFields(message) {
    return { lastProgressAt: Date.now(), lastProgressMessage: message || "" };
  }

  function startWatchdog() {
    if (watchdogStarted) return;
    watchdogStarted = true;
    setInterval(async () => {
      try {
        const state = await getState();
        if (!["auto_scanning", "deleting", "verifying"].includes(state.status)) {
          lastWatchdogWarningAt = 0;
          lastWatchdogStopAt = 0;
          return;
        }
        if (!state.lastProgressAt) {
          if (!lastWatchdogWarningAt) {
            lastWatchdogWarningAt = Date.now();
            logEvent("warn", "WATCHDOG: operación activa sin marca de progreso", { status: state.status, currentIndex: state.currentIndex, queueLength: state.queue.length });
          }
          return;
        }
        const ageMs = Date.now() - state.lastProgressAt;
        if (ageMs >= 60000 && lastWatchdogWarningAt < state.lastProgressAt) {
          lastWatchdogWarningAt = Date.now();
          logEvent("warn", "WATCHDOG: no hay progreso desde hace más de 60 segundos", { status: state.status, ageMs, lastProgressMessage: state.lastProgressMessage, currentIndex: state.currentIndex, queueLength: state.queue.length });
        }
        if (ageMs >= 180000 && lastWatchdogStopAt < state.lastProgressAt) {
          lastWatchdogStopAt = Date.now();
          logEvent("error", "WATCHDOG: operación detenida por falta de progreso", { status: state.status, ageMs, lastProgressMessage: state.lastProgressMessage, currentIndex: state.currentIndex, queueLength: state.queue.length });
          await saveState({ ...state, status: "stopped", lastError: "La operación se detuvo automáticamente tras 3 minutos sin progreso. Abre los logs para diagnosticarla." });
        }
      } catch (error) {
        logEvent("warn", "WATCHDOG: no pudo revisar el estado", { error: errorText(error) });
      }
    }, 15000);
  }

  async function getTabRole() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "TFC_ROLE" });
      const role = response?.role || "main";
      currentRole = role;
      return role;
    } catch (error) {
      logEvent("warn", "No pude consultar el rol de esta pestaña; usaré main", { error: errorText(error) });
      return "main";
    }
  }

  async function openWorkerFor(url) {
    logEvent("info", "Solicitando pestaña worker", { url: new URL(url, location.href).pathname });
    const response = await chrome.runtime.sendMessage({ type: "TFC_OPEN_WORKER", url });
    if (!response?.ok || response.tabId == null) throw new Error(response?.error || "No pude abrir la pestaña de trabajo.");
    await updateState(state => ({ ...state, workerTabId: response.tabId }));
    logEvent("info", "Pestaña worker lista", { tabId: response.tabId });
    return response.tabId;
  }

  async function navigateWorker(url) {
    logEvent("info", "Navegando pestaña worker", { url: new URL(url, location.href).pathname });
    const response = await chrome.runtime.sendMessage({ type: "TFC_NAVIGATE_WORKER", url });
    if (!response?.ok) throw new Error(response?.error || "No pude navegar la pestaña de trabajo.");
  }

  async function closeWorker() {
    logEvent("info", "Solicitando cierre de pestaña worker");
    try { await chrome.runtime.sendMessage({ type: "TFC_CLOSE_WORKER" }); } catch (_) { /* already closed */ }
  }

  async function navigateCurrentPage(url, reason) {
    const target = new URL(url, location.href);
    if (target.origin !== location.origin) throw new Error("El video pertenece a un origen distinto al de TikTok abierto.");
    const currentPath = location.pathname;
    if ((currentPath.includes("/video/") || currentPath.includes("/photo/")) && currentPath !== target.pathname) {
      logEvent("info", "Restableciendo ruta base antes de cambiar de publicación", { currentPath, targetPath: target.pathname });
      history.pushState({ tfcNavigation: true, at: Date.now() }, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate", { state: { tfcNavigation: true } }));
      await sleep(1200);
    }
    logEvent("info", "Navegando mediante la SPA de TikTok", { reason: reason || "", url: target.pathname, currentPath: location.pathname, method: "history.pushState + popstate" });
    history.pushState({ tfcNavigation: true, at: Date.now() }, "", `${target.pathname}${target.search}`);
    window.dispatchEvent(new PopStateEvent("popstate", { state: { tfcNavigation: true } }));
    document.dispatchEvent(new CustomEvent("tfc:navigation", { detail: { url: target.pathname } }));
    setTimeout(() => logEvent("debug", "Ruta después de navegación SPA", { expectedPath: target.pathname, actualPath: location.pathname, actualUrl: location.href.split("?")[0] }), 350);
    scheduleResume(900);
  }

  function postContextRequest() {
    window.postMessage({ source: SOURCE, type: "TFC_GET_CONTEXT" }, "*");
  }

  function waitForPageContext(timeoutMs) {
    return new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        resolve(value || null);
      };
      const onMessage = event => {
        if (event.source !== window || !event.data || event.data.source !== SOURCE || event.data.type !== "TFC_CONTEXT") return;
        if (event.data.secUid) finish({ secUid: String(event.data.secUid) });
      };
      window.addEventListener("message", onMessage);
      const domSecUid = secUidFromDom();
      if (domSecUid) {
        finish({ secUid: domSecUid });
        return;
      }
      postContextRequest();
      const end = Date.now() + timeoutMs;
      const retry = () => {
        if (done) return;
        if (Date.now() >= end) return finish(null);
        const fallback = secUidFromDom();
        if (fallback) return finish({ secUid: fallback });
        postContextRequest();
        setTimeout(retry, 500);
      };
      setTimeout(retry, 500);
    });
  }

  function secUidFromDom() {
    if (domSecUidCache) return domSecUidCache;
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent || "";
      const match = text.match(/["']secUid["']\s*:\s*["']([^"']{10,})["']/i);
      if (match) {
        domSecUidCache = match[1];
        return domSecUidCache;
      }
    }
    return null;
  }

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function hasSafetyChallenge() {
    const visibleText = (document.body?.innerText || "").slice(0, 20000);
    return /captcha|verify you are human|security check|unusual traffic|access to tiktok was denied|demasiadas solicitudes/i.test(visibleText) ||
      [...document.querySelectorAll("[id*='captcha' i], [class*='captcha' i]")].some(visible);
  }

  function activeVideo() {
    const width = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const height = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    const centerX = width / 2;
    const centerY = height / 2;
    return [...document.querySelectorAll("video")]
      .filter(visible)
      .map(video => {
        const rect = video.getBoundingClientRect();
        const area = rect.width * rect.height;
        const distance = Math.abs(rect.left + rect.width / 2 - centerX) + Math.abs(rect.top + rect.height / 2 - centerY);
        return { video, score: area - distance * 40 };
      })
      .sort((a, b) => b.score - a.score)[0]?.video || null;
  }

  function ancestorsFor(video) {
    const result = [];
    let ancestor = video && video.parentElement;
    for (let depth = 0; ancestor && ancestor !== document.body && depth < 15; depth += 1) {
      const videos = [...ancestor.querySelectorAll("video")];
      if (videos.some(item => item !== video)) break;
      result.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    return result;
  }

  function normalizedText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  const FAVORITE_SELECTORS = [
    "[data-e2e='favorite-button']",
    "[data-e2e='favorite-icon']",
    "[data-e2e='collect-icon']",
    "[data-e2e*='collect-icon' i]",
    "[role='button'][aria-label*='favorit' i]",
    "[role='button'][aria-label*='favorite' i]",
    "[role='button'][aria-label*='guardar' i]",
    "[role='button'][aria-label*='save' i]",
    "[role='button'][aria-label*='salvar' i]",
    "[class*='PFavorite' i]",
    "[data-e2e='undefined-icon']"
  ];

  function asInteractive(element) {
    if (!element) return null;
    return element.matches("button, [role='button'], a[href], [tabindex]")
      ? element
      : element.closest("button, [role='button'], a[href], [tabindex]") || element;
  }

  function elementSummary(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName,
      dataE2e: element.getAttribute("data-e2e") || "",
      role: element.getAttribute("role") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      className: String(element.getAttribute("class") || "").slice(0, 180),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  }

  function clickTargetEvidence(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const hitInteractive = asInteractive(hit);
    return {
      target: elementSummary(element),
      hit: elementSummary(hit),
      hitInteractive: elementSummary(hitInteractive),
      point: { x: Math.round(x), y: Math.round(y) },
      hitInsideTarget: Boolean(hit && (hit === element || element.contains(hit)))
    };
  }

  function findFavoriteButton() {
    const video = activeVideo();
    const roots = video ? ancestorsFor(video) : [];
    for (const root of roots) {
      for (const selector of FAVORITE_SELECTORS) {
        const found = [...root.querySelectorAll(selector)].map(asInteractive).find(visible);
        if (found && !found.closest("#tfc-host")) return found;
      }
    }
    for (const selector of FAVORITE_SELECTORS) {
      const found = [...document.querySelectorAll(selector)].map(asInteractive).find(element => visible(element) && !element.closest("#tfc-host"));
      if (found) return found;
    }
    return null;
  }

  function readFavoriteState(button) {
    if (!button) return null;
    const elements = [button, ...button.querySelectorAll("[aria-pressed], [aria-checked], [data-state], [data-liked]")];
    for (const element of elements) {
      for (const name of ["aria-pressed", "aria-checked", "data-liked"]) {
        const value = element.getAttribute(name);
        if (value === "true" || value === "false") return value === "true";
      }
      const state = (element.getAttribute("data-state") || "").toLowerCase();
      if (["on", "checked", "active", "selected"].includes(state)) return true;
      if (["off", "unchecked", "inactive", "unselected"].includes(state)) return false;
    }

    const label = normalizedText([
      button.getAttribute("aria-label") || "",
      button.getAttribute("title") || "",
      button.getAttribute("data-e2e") || "",
      button.textContent || ""
    ].join(" "));
    if (/remove\s+from\s+(favorites|saved)|unfavorite|unsave|quitar(?: de)? favoritos|quitar(?: de)? guardados|eliminar(?: de)? favoritos|remover(?: dos)? favoritos|remover(?: dos)? salvos|retirar(?: dos)? salvos|desmarcar/i.test(label)) return true;
    if (/add\s+to\s+(favorites|saved)|save\s+to|favorite|favorito|guardar|salvar|adicionar aos favoritos|añadir a favoritos/i.test(label)) return false;
    return null;
  }

  function favoriteStateEvidence(button) {
    if (!button) return null;
    const svg = [...button.querySelectorAll("svg")].slice(0, 4).map(element => {
      const attributes = ["aria-label", "class", "fill", "data-e2e"]
        .map(name => `${name}=${String(element.getAttribute(name) || "").slice(0, 120)}`)
        .join(",");
      return `<svg ${attributes}>`;
    });
    return {
      state: readFavoriteState(button),
      tag: button.tagName,
      dataE2e: button.getAttribute("data-e2e") || "",
      ariaLabel: button.getAttribute("aria-label") || "",
      ariaPressed: button.getAttribute("aria-pressed"),
      ariaChecked: button.getAttribute("aria-checked"),
      dataState: button.getAttribute("data-state"),
      dataLiked: button.getAttribute("data-liked"),
      title: button.getAttribute("title") || "",
      className: String(button.getAttribute("class") || "").slice(0, 300),
      svg
    };
  }

  function recentMutation(startedAt) {
    return mutationEvents.filter(event => event.at >= startedAt && event.kind === "response")
      .sort((a, b) => b.at - a.at)[0] || null;
  }

  function mutationSucceeded(event) {
    if (!event || !Number.isFinite(Number(event.status)) || Number(event.status) < 200 || Number(event.status) >= 300) return false;
    return event.statusCode == null || Number(event.statusCode) === 0;
  }

  function mutationPacing(itemId, event) {
    if (!event) return null;
    const at = Number(event.at) || Date.now();
    mutationTimeline.push({ itemId: String(itemId), at, status: Number(event.status) || 0 });
    const cutoff = at - 60000;
    while (mutationTimeline.length && mutationTimeline[0].at < cutoff) mutationTimeline.shift();
    const previous = mutationTimeline.length > 1 ? mutationTimeline[mutationTimeline.length - 2] : null;
    return {
      actionsLast60s: mutationTimeline.length,
      gapSincePreviousMs: previous ? Math.max(0, at - previous.at) : null,
      status: Number(event.status) || 0,
      retryAfter: String(event.responseHeaders?.["retry-after"] || "")
    };
  }

  function riskCooldownMs(event) {
    if (!event) return 0;
    const retryAfter = String(event.responseHeaders?.["retry-after"] || "").trim();
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15 * 60 * 1000, Math.max(5000, seconds * 1000));
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) return Math.min(15 * 60 * 1000, Math.max(5000, dateMs - Date.now()));
    }
    if (Number(event.status) === 429) return DEFAULT_RISK_COOLDOWN_MS;
    if (Number(event.status) === 403 || /risk|too.?frequent|rate.?limit|slow.?down|blocked|denied/i.test(String(event.statusMessage || ""))) return 2 * DEFAULT_RISK_COOLDOWN_MS;
    return 0;
  }

  async function registerRiskCooldown(itemId, event, pacing) {
    const cooldownMs = riskCooldownMs(event);
    if (!cooldownMs) return 0;
    const until = Date.now() + cooldownMs;
    logEvent("warn", "Señal de limitación detectada; guardaré un cooldown", { itemId, cooldownMs, until: new Date(until).toISOString(), pacing, status: event.status, statusCode: event.statusCode, statusMessage: event.statusMessage, responseHeaders: event.responseHeaders || {} });
    await updateState(current => ({ ...current, rateLimitUntil: Math.max(Number(current.rateLimitUntil) || 0, until), lastError: `TikTok indicó una limitación; esperando ${Math.ceil(cooldownMs / 1000)} s antes de reanudar.` }));
    return cooldownMs;
  }

  async function waitForRiskCooldown() {
    let state = await getState();
    const until = Number(state.rateLimitUntil) || 0;
    if (until <= Date.now()) return;
    const totalMs = until - Date.now();
    logEvent("info", "Cooldown de TikTok activo antes de reanudar", { remainingMs: totalMs, until: new Date(until).toISOString() });
    while (Date.now() < until) {
      checkStop();
      await sleep(Math.min(1000, until - Date.now()));
    }
    state = await getState();
    await saveState({ ...state, rateLimitUntil: 0, lastError: "Cooldown terminado; reanudando con el ritmo normal.", ...progressFields("Cooldown terminado.") });
  }

  async function waitForNetworkQuiet(startedAt, timeoutMs = 6000, quietMs = 700, minimumMs = 1000) {
    const waitStartedAt = Date.now();
    return new Promise(resolve => {
      const check = () => {
        const now = Date.now();
        const elapsedMs = now - waitStartedAt;
        const sinceActivityMs = lastNetworkActivityAt >= startedAt ? now - lastNetworkActivityAt : now - startedAt;
        if (elapsedMs >= minimumMs && pendingNetworkRequests === 0 && sinceActivityMs >= quietMs) {
          logEvent("info", "Red de TikTok en reposo tras la mutación", { pending: pendingNetworkRequests, quietMs: sinceActivityMs, waitedMs: elapsedMs });
          resolve({ quiet: true, pending: pendingNetworkRequests, waitedMs: elapsedMs });
          return;
        }
        if (elapsedMs >= timeoutMs) {
          logEvent("warn", "Tiempo agotado esperando reposo de red; continuaré con verificación cautelosa", { pending: pendingNetworkRequests, sinceActivityMs: sinceActivityMs, waitedMs: elapsedMs, timeoutMs });
          resolve({ quiet: false, pending: pendingNetworkRequests, waitedMs: elapsedMs });
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  async function clickFavoriteControl(button, itemId) {
    if (!button || !button.isConnected) throw new Error("El control de guardado desapareció antes del clic.");
    button.scrollIntoView({ block: "center", inline: "center" });
    await sleep(120);
    const evidence = clickTargetEvidence(button);
    logEvent("debug", "Objetivo físico del clic resuelto", { itemId, ...evidence });
    if (!evidence?.point || !evidence.hitInsideTarget) {
      logEvent("warn", "El centro del control está cubierto o no coincide con el DOM encontrado; probaré el clic DOM", { itemId, evidence });
      button.click();
      return { method: "dom-fallback-covered" };
    }
    try {
      const response = await chrome.runtime.sendMessage({ type: "TFC_TRUSTED_CLICK", x: evidence.point.x, y: evidence.point.y });
      if (response?.ok) return response;
      logEvent("warn", "El clic físico no estuvo disponible; usaré clic DOM como respaldo", { itemId, error: response?.error || "respuesta vacía" });
    } catch (error) {
      logEvent("warn", "No pude solicitar el clic físico; usaré clic DOM como respaldo", { itemId, error: errorText(error) });
    }
    button.click();
    return { method: "dom-fallback" };
  }

  function errorText(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function checkStop() {
    if (stopRequested) throw new Error("Operación detenida por el usuario.");
  }

  async function requestJson(url, init) {
    const response = await fetch(url, { credentials: "include", cache: "no-store", ...init });
    if ([401, 403, 429].includes(response.status)) {
      throw new SafetyStopError(`TikTok respondió ${response.status}. Se detuvo la operación por seguridad.`);
    }
    if (!response.ok) throw new Error(`TikTok respondió HTTP ${response.status}.`);
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch (_) {
      throw new SafetyStopError(`TikTok no devolvió JSON. Posible bloqueo o sesión caducada: ${text.slice(0, 120)}`);
    }
    return validateTikTokPayload(json);
  }

  function validateTikTokPayload(json) {
    if (json && json.status_code != null && json.status_code !== 0) {
      const message = String(json.status_msg || `status_code=${json.status_code}`);
      if (/captcha|verify|too many|too frequent|rate.?limit|risk|restricted|unusual|slow down|denied|blocked/i.test(message)) {
        throw new SafetyStopError(`${message} Se detuvo la operación por seguridad.`);
      }
      throw new Error(message);
    }
    return json;
  }

  function requestListThroughPage(cursor, secUid) {
    return new Promise((resolve, reject) => {
      const requestId = `list-${Date.now()}-${++listRequestSerial}`;
      logEvent("debug", "Solicitando lista mediante puente de página", { requestId, cursor, count: PAGE_SIZE });
      const timer = setTimeout(() => {
        pendingListRequests.delete(requestId);
        logEvent("error", "El puente de página agotó el tiempo de respuesta", { requestId, cursor, timeoutMs: 20000 });
        reject(new Error("El puente de página no respondió a tiempo."));
      }, 20000);
      pendingListRequests.set(requestId, { resolve, reject, timer });
      window.postMessage({ source: SOURCE, type: "TFC_FETCH_LIST", requestId, cursor, secUid, count: PAGE_SIZE }, "*");
    });
  }

  async function requestList(cursor, secUid) {
    try {
      return validateTikTokPayload(await requestListThroughPage(cursor, secUid));
    } catch (error) {
      if (/401|403|429|bloqueo|denied|blocked/i.test(errorText(error))) throw error;
      logEvent("warn", "El puente falló; probando solicitud directa de lista", { cursor, error: errorText(error) });
      return requestJson(buildListUrl(cursor, secUid));
    }
  }

  function buildListUrl(cursor, secUid) {
    const params = new URLSearchParams({
      aid: "1988",
      count: String(PAGE_SIZE),
      coverFormat: "2",
      cursor: String(cursor),
      secUid,
      tfc_nonce: String(Date.now())
    });
    return `${location.origin}${LIST_PATH}?${params}`;
  }

  function unwrapItem(value) {
    return value && (value.item || value.itemStruct || value.aweme || value.awemeInfo || value.aweme_info || (value.itemInfo && value.itemInfo.itemStruct)) || value;
  }

  function makeItem(raw) {
    const item = unwrapItem(raw) || {};
    const author = item.author || item.authorInfo || {};
    const id = item.id || item.itemId || item.aweme_id;
    const creator = author.uniqueId || author.unique_id || "";
    if (!id) return null;
    const routeType = item.imagePost || item.image_post ? "photo" : "video";
    return {
      id: String(id),
      creator: String(creator),
      description: String(item.desc || item.description || ""),
      createTime: item.createTime || item.create_time || item.publishTime || null,
      thumbnail: String(item.video?.cover || item.video?.originCover || item.video?.dynamicCover || ""),
      routeType,
      url: creator ? `https://www.tiktok.com/@${encodeURIComponent(creator)}/${routeType}/${id}` : `https://www.tiktok.com/${routeType}/${id}`,
      serverListed: true,
      selected: false,
      uiRefreshAttempted: false,
      routeRetryAttempted: false,
      recoveryAttempts: 0,
      recoveryStrategy: "",
      status: "pending",
      error: ""
    };
  }

  function pageItems(json) {
    const rawItems = json.itemList || json.item_list || [];
    return rawItems.map(makeItem).filter(Boolean);
  }

  function itemDate(item) {
    const value = Number(item.createTime);
    if (!Number.isFinite(value) || value <= 0) return "";
    const milliseconds = value < 100000000000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString().slice(0, 10);
  }

  function inDateRange(item, settings) {
    if (!settings.from && !settings.to) return true;
    const date = itemDate(item);
    if (!date) return false;
    if (settings.from && date < settings.from) return false;
    if (settings.to && date > settings.to) return false;
    return true;
  }

  function recount(items) {
    return items.reduce((stats, item) => {
      stats.scanned += 1;
      if (item.status === "removed") stats.removed += 1;
      if (item.status === "skipped") stats.skipped += 1;
      if (item.status === "failed") stats.failed += 1;
      if (item.status === "remaining") stats.remaining += 1;
      return stats;
    }, { scanned: 0, removed: 0, skipped: 0, failed: 0, remaining: 0 });
  }

  function mergeItems(existing, incoming) {
    const byId = new Map(existing.map(item => [item.id, item]));
    for (const item of incoming) {
      const previous = byId.get(item.id);
      if (!previous) {
        byId.set(item.id, item);
        continue;
      }
      const merged = {
        ...item,
        ...previous,
        description: item.description || previous.description,
        thumbnail: item.thumbnail || previous.thumbnail,
        routeType: item.routeType || previous.routeType || "video",
        url: item.routeType ? item.url : (previous.url || item.url),
        serverListed: item.serverListed || previous.serverListed || false,
        recoveryAttempts: previous.recoveryAttempts || item.recoveryAttempts || 0,
        recoveryStrategy: previous.recoveryStrategy || item.recoveryStrategy || ""
      };
      byId.set(item.id, merged);
    }
    return [...byId.values()];
  }

  function isAutoEligible(item) {
    return item && !["removed", "remaining", "skipped", "failed", "processing"].includes(item.status);
  }

  async function scanFavorites() {
    if (runner) return;
    runner = true;
    stopRequested = false;
    try {
      logEvent("info", "Inicio de escaneo manual", { from: (await getState()).settings.from, to: (await getState()).settings.to });
      if (hasSafetyChallenge()) throw new SafetyStopError("TikTok mostró un CAPTCHA o una verificación. La operación se detuvo sin recargar la página.");
      const context = await waitForPageContext(6000);
      if (!context?.secUid) throw new Error("No pude identificar tu cuenta. Recarga TikTok con la sesión iniciada e inténtalo de nuevo.");
      await saveState({ ...(await getState()), status: "scanning", items: [], queue: [], currentIndex: 0, scanCursor: "0", scanPage: 0, lastError: "", ...progressFields("Escaneo manual iniciado.") });

      let cursor = "0";
      let page = 0;
      const allItems = [];
      const visited = new Set();
      while (true) {
        checkStop();
        if (visited.has(cursor)) throw new Error("TikTok repitió un cursor de paginación; conservé el resultado parcial.");
        visited.add(cursor);
        page += 1;
        const json = await requestList(cursor, context.secUid);
        const items = pageItems(json);
        const known = new Set(allItems.map(item => item.id));
        allItems.push(...items.filter(item => !known.has(item.id)));
        logEvent("info", "Página de escaneo manual recibida", { page, cursor, items: items.length, total: allItems.length, hasMore: Boolean(json.hasMore) });
        await updateState(state => ({ ...state, status: "scanning", items: allItems, scanCursor: String(json.cursor ?? cursor), scanPage: page, stats: recount(allItems), ...progressFields(`Página ${page} escaneada.`) }));
        if (!json.hasMore || !json.cursor || String(json.cursor) === cursor || items.length === 0) break;
        cursor = String(json.cursor);
        await sleep(randomBetween(1200, 2200));
      }
      const state = await getState();
      const selected = state.items.map(item => ({ ...item, selected: inDateRange(item, state.settings) }));
      logEvent("info", "Escaneo manual terminado", { total: selected.length, page });
      await saveState({ ...state, status: "ready", items: selected, scanCursor: cursor, lastError: "" });
    } catch (error) {
      const state = await getState();
      const status = error instanceof SafetyStopError ? "stopped_safety" : stopRequested ? "stopped" : "error";
      logEvent("error", "Escaneo manual falló", { status, error: errorText(error), page: state.scanPage, cursor: state.scanCursor });
      await saveState({ ...state, status, lastError: errorText(error) });
    } finally {
      runner = false;
      render();
    }
  }

  async function runAutomaticScanBatch() {
    if (runner) return;
    runner = true;
    try {
      let state = await getState();
      if (state.status !== "auto_scanning") return;
      logEvent("info", "Inicio de búsqueda automática", { cursor: state.autoCursor, page: state.autoPage, batchSize: state.settings.batchSize, from: state.settings.from, to: state.settings.to });
      if (hasSafetyChallenge()) throw new SafetyStopError("TikTok mostró un CAPTCHA o una verificación. La operación se detuvo sin recargar la página.");
      const context = await waitForPageContext(6000);
      if (!context?.secUid) throw new Error("No pude identificar tu cuenta. Recarga TikTok con la sesión iniciada e inténtalo de nuevo.");

      let cursor = state.autoCursor || "0";
      let batchIds = state.autoBatchIds.slice();
      const visited = new Set();
      while (true) {
        checkStop();
        if (visited.has(cursor)) throw new Error("TikTok repitió un cursor durante la búsqueda automática.");
        visited.add(cursor);
        const json = await requestList(cursor, context.secUid);
        const incoming = pageItems(json);
        logEvent("info", "Página de guardados recibida", { page: state.autoPage + 1, cursor, items: incoming.length, hasMore: Boolean(json.hasMore), nextCursor: String(json.cursor ?? cursor) });
        const merged = mergeItems(state.items, incoming);
        for (const item of incoming) {
          const stored = merged.find(candidate => candidate.id === item.id);
          if (isAutoEligible(stored) && inDateRange(stored, state.settings) && !batchIds.includes(stored.id)) {
            batchIds.push(stored.id);
          }
          if (batchIds.length >= Math.max(1, Number(state.settings.batchSize) || DEFAULT_SETTINGS.batchSize)) break;
        }
        const nextCursor = String(json.cursor ?? cursor);
        state = await saveState({
          ...state,
          status: "auto_scanning",
          items: merged,
          autoCursor: nextCursor,
          autoPage: state.autoPage + 1,
          autoBatchIds: batchIds,
          stats: recount(merged),
          lastError: `Buscando un lote automático: ${batchIds.length}/${state.settings.batchSize} encontrado(s).`,
          ...progressFields(`Página ${state.autoPage + 1} escaneada; ${batchIds.length} candidato(s).`)
        });
        const enough = batchIds.length >= Math.max(1, Number(state.settings.batchSize) || DEFAULT_SETTINGS.batchSize);
        const noMore = !json.hasMore || !json.cursor || nextCursor === cursor || incoming.length === 0;
        if (enough || noMore) break;
        cursor = nextCursor;
        await sleep(randomBetween(1200, 2200));
      }

      state = await getState();
      if (batchIds.length) {
        logEvent("info", "Lote automático listo para eliminar", { count: batchIds.length, ids: batchIds.slice(0, 30) });
        const batchSet = new Set(batchIds);
        const items = state.items.map(item => batchSet.has(item.id) ? { ...item, status: "pending", error: "" } : item);
        await saveState({ ...state, status: "deleting", items, queue: batchIds, currentIndex: 0, workerTabId: null, lastError: `Lote listo: ${batchIds.length} video(s).`, stats: recount(items), ...progressFields(`Lote listo: ${batchIds.length} video(s).`) });
        const firstUrl = items.find(item => item.id === batchIds[0])?.url;
        if (!firstUrl) throw new Error("El primer video del lote no tiene URL navegable.");
        logEvent("info", "Lote listo; comenzando en la pestaña principal", { count: batchIds.length, firstId: batchIds[0] });
        await navigateCurrentPage(firstUrl, "primer video del lote");
      } else {
        const remaining = state.items.filter(item => item.status === "remaining").length;
        logEvent("info", "Búsqueda automática terminada sin nuevos candidatos", { remaining, pages: state.autoPage });
        await saveState({ ...state, status: remaining ? "complete_with_issues" : "complete", autoMode: false, workerTabId: null, lastError: remaining ? `${remaining} elemento(s) siguen presentes; no se reintentaron automáticamente.` : "No quedan guardados que cumplan el filtro." });
        if (state.workerTabId != null) await closeWorker();
      }
    } catch (error) {
      const state = await getState();
      const status = error instanceof SafetyStopError ? "stopped_safety" : stopRequested ? "stopped" : "error";
      logEvent("error", "Búsqueda automática falló", { status, error: errorText(error), cursor: state.autoCursor, page: state.autoPage });
      await saveState({ ...state, status, lastError: errorText(error) });
    } finally {
      runner = false;
      render();
    }
  }

  async function beginDeletion() {
    if (runner) return;
    const state = await getState();
    const batchSize = Math.max(1, Number(state.settings.batchSize) || DEFAULT_SETTINGS.batchSize);
    const range = state.settings.from || state.settings.to ? ` que cumplan ${state.settings.from || "el inicio"}–${state.settings.to || "hoy"}` : " empezando por los más recientes";
    if (!window.confirm(`Se limpiarán automáticamente lotes de hasta ${batchSize} videos${range}. TikTok puede limitar acciones automatizadas. ¿Continuar?`)) return;
    logEvent("info", "Limpieza automática iniciada", { batchSize, from: state.settings.from, to: state.settings.to, autoVerify: state.settings.autoVerify });
    stopRequested = false;
    if (state.workerTabId != null) await closeWorker();
    await saveState({ ...state, status: "auto_scanning", autoMode: true, workerTabId: null, items: [], queue: [], currentIndex: 0, autoCursor: "0", autoPage: 0, autoBatchIds: [], verificationCursor: "0", verificationPage: 0, verificationPresentIds: [], rateLimitUntil: 0, lastError: "", stats: recount([]), ...progressFields("Limpieza automática iniciada.") });
    void runAutomaticScanBatch();
  }

  async function markCurrentAndAdvance(itemId, status, error) {
    const state = await getState();
    logEvent(status === "removed" ? "info" : "warn", "Resultado del video procesado", { itemId, status, error: error || "", index: state.currentIndex + 1, queueLength: state.queue.length });
    const items = state.items.map(item => item.id === itemId ? { ...item, status, error: error || "" } : item);
    const currentIndex = state.currentIndex + 1;
    const finished = currentIndex >= state.queue.length;
    const nextStatus = finished ? (state.settings.autoVerify ? "verifying" : state.autoMode ? "auto_scanning" : "complete") : "deleting";
    await saveState({
      ...state,
      status: nextStatus,
      items,
      currentIndex,
      verificationCursor: "0",
      verificationPage: 0,
      verificationPresentIds: [],
      autoCursor: nextStatus === "auto_scanning" ? "0" : state.autoCursor,
      autoPage: nextStatus === "auto_scanning" ? 0 : state.autoPage,
      autoBatchIds: nextStatus === "auto_scanning" ? [] : state.autoBatchIds,
      stats: recount(items),
      lastError: "",
      ...progressFields(`Video ${state.currentIndex + 1}/${state.queue.length} procesado: ${status}.`)
    });
    return { finished, state: await getState() };
  }

  async function waitForFavoriteButton(timeoutMs) {
    const startedAt = Date.now();
    let attempts = 0;
    logEvent("debug", "Buscando botón de guardado", { timeoutMs });
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      checkStop();
      attempts += 1;
      if ((attempts === 1 || attempts % 5 === 0) && hasSafetyChallenge()) {
        logEvent("warn", "CAPTCHA o bloqueo detectado mientras esperaba el reproductor", { elapsedMs: Date.now() - startedAt, path: location.pathname });
        throw new SafetyStopError("TikTok mostró un CAPTCHA o una verificación mientras cargaba el video. Resuélvelo y pulsa Reanudar.");
      }
      const button = findFavoriteButton();
      if (button) {
        logEvent("info", "Botón de guardado encontrado", { attempts, elapsedMs: Date.now() - startedAt, evidence: favoriteStateEvidence(button) });
        return button;
      }
      if (attempts % 10 === 0) logEvent("debug", "El botón de guardado aún no aparece", { attempts, elapsedMs: Date.now() - startedAt, ...domSnapshot() });
      await sleep(200);
    }
    logEvent("error", "Tiempo agotado buscando botón de guardado", { attempts, elapsedMs: Date.now() - startedAt, ...domSnapshot() });
    throw new Error("No encontré el botón de guardado del video. TikTok pudo cambiar el DOM o no cargó el reproductor.");
  }

  async function removeCurrentItem(item, settings) {
    logEvent("info", "Comenzando eliminación del video", { itemId: item.id, url: new URL(item.url, location.href).pathname, routeType: item.routeType || "video", serverListed: item.serverListed !== false, refreshAttempted: item.uiRefreshAttempted, recoveryAttempts: item.recoveryAttempts || 0, recoveryStrategy: item.recoveryStrategy || "none" });
    const button = await waitForFavoriteButton(12000);
    if (Number(item.recoveryAttempts) > 0) {
      logEvent("info", "La recuperación logró montar el control de guardado", { itemId: item.id, attempts: item.recoveryAttempts, strategy: item.recoveryStrategy || "unknown", path: location.pathname });
    }
    const before = readFavoriteState(button);
    logEvent("info", "Estado del botón antes del clic", { itemId: item.id, before, serverListed: item.serverListed !== false, refreshAttempted: item.uiRefreshAttempted, evidence: favoriteStateEvidence(button) });
    if (before === false && !item.uiRefreshAttempted) {
      logEvent("warn", "La interfaz dice no guardado; se solicitará una sola recarga", { itemId: item.id });
      return { status: "refresh", error: "La interfaz no coincidió con la lista; se hará una sola recarga limpia." };
    }
    if (before === false) {
      logEvent("warn", item.serverListed !== false
        ? "Contradicción no resuelta; omitiré el video para evitar guardarlo accidentalmente"
        : "El botón indica que el video ya no está guardado; lo omitiré", {
        itemId: item.id,
        action: "skip_without_click",
        serverListed: item.serverListed !== false,
        uiState: before,
        warning: "La lista API y el botón visible no coinciden o el video ya fue quitado."
      });
      throw new AmbiguousStateError("El botón visible indica que el video no está guardado; no hice clic para evitar agregarlo de nuevo.");
    }
    if (before === null && !settings.allowUnknownState) {
      throw new AmbiguousStateError("No pude confirmar que el botón está activo; no hice clic para evitar volver a guardar el video.");
    }

    const startedAt = Date.now();
    button.scrollIntoView({ block: "center", inline: "center" });
    await sleep(120);
    logEvent("info", "Haciendo clic en el botón de guardado", { itemId: item.id, before, method: "trusted-browser-input-with-dom-fallback" });
    const clickResult = await clickFavoriteControl(button, item.id);
    logEvent("debug", "Clic terminado", { itemId: item.id, method: clickResult?.method || "unknown" });

    let stable = before;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(150);
      const event = recentMutation(startedAt);
      if (event && [401, 403, 429].includes(event.status)) {
        const pacing = mutationPacing(item.id, event);
        await registerRiskCooldown(item.id, event, pacing);
        logEvent("error", "La mutación devolvió respuesta de seguridad", { itemId: item.id, status: event.status, path: event.path, pacing, responseHeaders: event.responseHeaders || {} });
        throw new SafetyStopError(`La acción de TikTok respondió ${event.status}. Se detuvo la operación por seguridad.`);
      }
      if (event && event.statusCode != null && Number(event.statusCode) !== 0) {
        const pacing = mutationPacing(item.id, event);
        await registerRiskCooldown(item.id, event, pacing);
        logEvent("error", "TikTok rechazó la mutación", { itemId: item.id, statusCode: event.statusCode, statusMessage: event.statusMessage, path: event.path, pacing, responseHeaders: event.responseHeaders || {} });
        throw new Error(event.statusMessage || `TikTok rechazó la acción (${event.statusCode}).`);
      }
      const currentButton = findFavoriteButton() || button;
      stable = readFavoriteState(currentButton);
      if (stable === false && before !== false) break;
      if (event && before === false) break;
    }

    const networkQuiet = await waitForNetworkQuiet(startedAt);
    const event = recentMutation(startedAt);
    const currentButton = findFavoriteButton() || button;
    stable = readFavoriteState(currentButton);
    const pacing = mutationPacing(item.id, event);
    logEvent("info", "Estado posterior al clic", { itemId: item.id, before, after: stable, serverListed: item.serverListed !== false, evidence: favoriteStateEvidence(currentButton), mutation: event ? { path: event.path, status: event.status, statusCode: event.statusCode, statusMessage: event.statusMessage, requestKeys: event.requestKeys, requestFields: event.requestFields, responseHeaders: event.responseHeaders || {} } : null, pacing, networkQuiet, elapsedMs: Date.now() - startedAt });
    const mutationConfirmed = mutationSucceeded(event);
    if (stable === false && ((!event || event.statusCode == null || Number(event.statusCode) === 0) && (before !== false || settings.allowUnknownState))) {
      return { status: "removed", error: "" };
    }
    if (mutationConfirmed && (before === true || settings.allowUnknownState) && stable !== true) {
      return { status: "removed", error: "" };
    }
    throw new Error(`TikTok no confirmó la eliminación de ${item.id}; no lo marqué como borrado.`);
  }

  const ROUTE_RECOVERY_STRATEGIES = ["spa_refresh", "base_bounce", "dom_reactivate", "full_navigation"];

  function domSnapshot() {
    const bodyText = normalizedText(document.body?.innerText || "");
    const favoriteCandidates = FAVORITE_SELECTORS.reduce((total, selector) => total + document.querySelectorAll(selector).length, 0);
    return {
      readyState: document.readyState,
      title: document.title.slice(0, 120),
      path: location.pathname,
      videoCount: document.querySelectorAll("video").length,
      favoriteCandidates,
      bodyPreview: bodyText.slice(0, 220)
    };
  }

  function isMountFailure(error) {
    return /No encontr|Tiempo agotado buscando/i.test(errorText(error));
  }

  function recoveryUrl(url, strategy, attempt) {
    const target = new URL(url, location.href);
    target.searchParams.set("tfc_recovery", `${strategy}-${attempt}-${Date.now()}`);
    return target.href;
  }

  async function recoverCurrentItem(item) {
    const previousAttempts = Number(item.recoveryAttempts) || 0;
    const strategy = ROUTE_RECOVERY_STRATEGIES[previousAttempts];
    if (!strategy) {
      logEvent("error", "Se agotaron las estrategias de recuperación del DOM", { itemId: item.id, attempts: previousAttempts, ...domSnapshot() });
      return false;
    }

    const attempt = previousAttempts + 1;
    logEvent("warn", "Iniciando estrategia de recuperación", { itemId: item.id, strategy, attempt, maxAttempts: ROUTE_RECOVERY_STRATEGIES.length, ...domSnapshot() });
    await updateState(current => ({
      ...current,
      items: current.items.map(candidate => candidate.id === item.id ? { ...candidate, recoveryAttempts: attempt, recoveryStrategy: strategy, routeRetryAttempted: true, status: "pending", error: "" } : candidate),
      lastError: `Recuperando la interfaz (${strategy}, intento ${attempt}/${ROUTE_RECOVERY_STRATEGIES.length})…`,
      ...progressFields(`Recuperación ${strategy} para ${current.currentIndex + 1}/${current.queue.length}.`)
    }));

    if (strategy === "spa_refresh") {
      await navigateCurrentPage(recoveryUrl(item.url, strategy, attempt), `recuperación ${strategy}`);
      return true;
    }

    if (strategy === "base_bounce") {
      const target = new URL(item.url, location.href);
      logEvent("info", "Recuperación: rebote explícito por la ruta base", { itemId: item.id, targetPath: target.pathname });
      history.pushState({ tfcNavigation: true, at: Date.now() }, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate", { state: { tfcNavigation: true } }));
      document.dispatchEvent(new CustomEvent("tfc:navigation", { detail: { url: "/" } }));
      await sleep(1800);
      await navigateCurrentPage(recoveryUrl(item.url, strategy, attempt), `recuperación ${strategy}`);
      return true;
    }

    if (strategy === "dom_reactivate") {
      logEvent("info", "Recuperación: reactivando la SPA sin cambiar de documento", { itemId: item.id, path: location.pathname });
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      document.dispatchEvent(new CustomEvent("tfc:navigation", { detail: { url: location.pathname } }));
      window.scrollTo(0, 0);
      await sleep(2200);
      scheduleResume(300);
      return true;
    }

    const target = recoveryUrl(item.url, strategy, attempt);
    logEvent("warn", "Recuperación final: navegación completa del documento", { itemId: item.id, targetPath: new URL(target, location.href).pathname, warning: "Puede activar un 403 de TikTok; no se reintentará automáticamente si ocurre." });
    location.assign(target);
    return true;
  }

  async function runDeletionStep() {
    if (runner) return;
    runner = true;
    try {
      let state = await getState();
      if (state.status !== "deleting") return;
      await waitForRiskCooldown();
      state = await getState();
      if (hasSafetyChallenge()) throw new SafetyStopError("TikTok mostró un CAPTCHA o una verificación. La operación se detuvo sin recargar la página.");
      const role = await getTabRole();
      const itemId = state.queue[state.currentIndex];
      let item = state.items.find(candidate => candidate.id === itemId);
      if (!item) throw new Error("El elemento actual ya no existe en el estado guardado.");
      let expectedPath = new URL(item.url, location.href).pathname;
      const legacyPhotoPath = expectedPath.replace("/video/", "/photo/");
      if (location.pathname === legacyPhotoPath && expectedPath !== legacyPhotoPath) {
        const photoUrl = item.url.replace("/video/", "/photo/");
        logEvent("info", "Ruta de publicación tipo foto detectada; adapto el elemento", { itemId: item.id, previousPath: expectedPath, photoPath: legacyPhotoPath });
        item = { ...item, routeType: "photo", url: photoUrl };
        expectedPath = new URL(item.url, location.href).pathname;
        await updateState(current => ({ ...current, items: current.items.map(candidate => candidate.id === item.id ? { ...candidate, routeType: "photo", url: photoUrl } : candidate), ...progressFields(`Ruta tipo foto detectada para ${current.currentIndex + 1}/${current.queue.length}.`) }));
        state = await getState();
      }
      logEvent("info", "Paso de eliminación iniciado", { role, itemId, index: state.currentIndex + 1, queueLength: state.queue.length, currentPath: location.pathname, expectedPath, routeType: item.routeType || "video", workerTabId: state.workerTabId });
      if (location.pathname !== expectedPath) {
        if (routeNavigationInFlight) {
          logEvent("debug", "Navegación ya en curso; ignoro una reentrada", { itemId: item.id, currentPath: location.pathname, expectedPath });
          return;
        }
        routeNavigationInFlight = true;
        clearTimeout(routeNavigationReleaseTimer);
        await saveState({ ...state, lastError: `Abriendo ${state.currentIndex + 1}/${state.queue.length}…`, ...progressFields(`Abriendo video ${state.currentIndex + 1}/${state.queue.length}.`) });
        try {
          if (role === "worker") await navigateWorker(item.url);
          else await navigateCurrentPage(item.url, "elemento del lote");
        } finally {
          routeNavigationReleaseTimer = setTimeout(() => {
            routeNavigationInFlight = false;
            routeNavigationReleaseTimer = null;
            void resumeForCurrentRole();
          }, 2500);
        }
        return;
      }

      if (routeNavigationInFlight) {
        routeNavigationInFlight = false;
        clearTimeout(routeNavigationReleaseTimer);
        routeNavigationReleaseTimer = null;
        logEvent("debug", "Ruta esperada confirmada; libero el bloqueo de navegación", { itemId: item.id, path: location.pathname });
      }

      await saveState({ ...state, items: state.items.map(candidate => candidate.id === item.id ? { ...candidate, status: "processing", error: "" } : candidate), ...progressFields(`Procesando video ${state.currentIndex + 1}/${state.queue.length}.`) });
      let result;
      try {
        result = await removeCurrentItem(item, state.settings);
      } catch (error) {
        if (error instanceof SafetyStopError) throw error;
        logEvent("error", "Excepción durante la eliminación del video", { itemId: item.id, error: errorText(error), name: error?.name || "Error" });
        if (error instanceof AmbiguousStateError) {
          result = { status: "skipped", error: errorText(error) };
        } else if (isMountFailure(error)) {
          const recovered = await recoverCurrentItem(item);
          if (recovered) return;
          result = { status: "failed", error: `${errorText(error)} Se agotaron las estrategias de recuperación.` };
        } else {
          result = { status: "failed", error: errorText(error) };
        }
      }
      if (result.status === "refresh") {
        logEvent("info", "Reintentando una sola vez con recarga limpia", { itemId: item.id });
        await updateState(current => ({ ...current, items: current.items.map(candidate => candidate.id === item.id ? { ...candidate, uiRefreshAttempted: true, status: "pending", error: "" } : candidate), lastError: "La interfaz no coincidió; recargando una sola vez para obtener el estado fresco…", ...progressFields(`Recargando video ${current.currentIndex + 1}/${current.queue.length}.`) }));
        if (role === "worker") await navigateWorker(`${item.url}?tfc_refresh=${Date.now()}`);
        else await navigateCurrentPage(`${item.url}?tfc_refresh=${Date.now()}`, "recarga de estado del video");
        return;
      }
      const advanced = await markCurrentAndAdvance(item.id, result.status, result.error);
      if (advanced.finished) {
        if (advanced.state.status === "verifying") setTimeout(() => void runVerification(), 0);
        if (advanced.state.status === "auto_scanning") setTimeout(() => void runAutomaticScanBatch(), 0);
        return;
      }
      checkStop();
      const completed = advanced.state.currentIndex;
      if (completed > 0 && completed % Math.max(1, Number(state.settings.batchSize) || DEFAULT_SETTINGS.batchSize) === 0) {
        await sleep(randomBetween(state.settings.cooldownMin, state.settings.cooldownMax));
      } else {
        await sleep(randomBetween(state.settings.minDelay, state.settings.maxDelay));
      }
      const nextState = await getState();
      if (nextState.status === "deleting") {
        const nextUrl = nextState.items.find(candidate => candidate.id === nextState.queue[nextState.currentIndex])?.url;
        if (nextUrl) {
          logEvent("info", "Avanzando al siguiente video", { nextIndex: nextState.currentIndex + 1, queueLength: nextState.queue.length });
          if (role === "worker") await navigateWorker(nextUrl);
          else await navigateCurrentPage(nextUrl, "siguiente video del lote");
        } else {
          throw new Error("El siguiente video del lote no tiene URL navegable.");
        }
      }
    } catch (error) {
      const state = await getState();
      const status = error instanceof SafetyStopError ? "stopped_safety" : stopRequested ? "stopped" : "error";
      logEvent("error", "Paso de eliminación terminó con error", { status, error: errorText(error), currentIndex: state.currentIndex, queueLength: state.queue.length, path: location.pathname });
      await saveState({ ...state, status, lastError: errorText(error) });
    } finally {
      runner = false;
      render();
    }
  }

  async function runVerification() {
    if (runner) return;
    runner = true;
    stopRequested = false;
    try {
      if (hasSafetyChallenge()) throw new SafetyStopError("TikTok mostró un CAPTCHA o una verificación. La operación se detuvo sin recargar la página.");
      const context = await waitForPageContext(6000);
      if (!context?.secUid) throw new Error("No pude identificar tu cuenta para verificar.");
      let state = await getState();
      if (state.status !== "verifying") return;
      logEvent("info", "Inicio de verificación completa", { cursor: state.verificationCursor, page: state.verificationPage, removed: state.stats.removed });
      let cursor = state.verificationCursor || "0";
      let verificationPage = Number(state.verificationPage) || 0;
      const verificationStartedAt = Date.now();
      const present = new Set(state.verificationPresentIds.map(String));
      const selectedIds = new Set(state.items.filter(item => item.status === "removed").map(item => String(item.id)));
      const visited = new Set();
      while (true) {
        checkStop();
        if (visited.has(cursor)) throw new Error("TikTok repitió un cursor durante la verificación.");
        visited.add(cursor);
        const pageStartedAt = Date.now();
        const json = await requestList(cursor, context.secUid);
        const pageItemsReceived = pageItems(json);
        const presentBefore = present.size;
        for (const item of pageItemsReceived) present.add(item.id);
        const selectedPresentOnPage = pageItemsReceived.map(item => String(item.id)).filter(id => selectedIds.has(id));
        const nextCursor = json.cursor == null ? "" : String(json.cursor);
        const cursorChanged = Boolean(nextCursor && nextCursor !== cursor);
        const newPresent = present.size - presentBefore;
        verificationPage += 1;
        const selectedPresentTotal = [...present].filter(id => selectedIds.has(String(id)));
        logEvent("info", "Página de verificación recibida", { page: verificationPage, cursor, nextCursor, cursorChanged, items: pageItemsReceived.length, newPresent, selectedPresentOnPage, selectedPresentTotal, hasMore: Boolean(json.hasMore), present: present.size, pagesSeen: visited.size, pageElapsedMs: Date.now() - pageStartedAt, elapsedMs: Date.now() - verificationStartedAt });
        await updateState(current => ({ ...current, status: "verifying", verificationCursor: nextCursor || cursor, verificationPage, verificationPresentIds: [...present], ...progressFields(`Página ${verificationPage} verificada.`) }));
        if (!json.hasMore || !cursorChanged) break;
        cursor = nextCursor;
        await sleep(randomBetween(1200, 2200));
      }
      state = await getState();
      const deletedIds = new Set(state.items.filter(item => item.status === "removed").map(item => item.id));
      const items = state.items.map(item => deletedIds.has(item.id) && present.has(item.id)
        ? { ...item, status: "remaining", error: "Sigue apareciendo tras la verificación del servidor." }
        : item);
      const remaining = items.filter(item => item.status === "remaining").length;
      const remainingIds = items.filter(item => item.status === "remaining").map(item => item.id);
      logEvent("info", "Verificación completa terminada", { removed: deletedIds.size, remaining, remainingIds, present: present.size, pages: visited.size, elapsedMs: Date.now() - verificationStartedAt, autoMode: state.autoMode });
      const nextStatus = state.autoMode ? "auto_scanning" : remaining ? "complete_with_issues" : "complete";
      await saveState({ ...state, status: nextStatus, autoCursor: state.autoMode ? "0" : state.autoCursor, autoPage: state.autoMode ? 0 : state.autoPage, autoBatchIds: state.autoMode ? [] : state.autoBatchIds, queue: state.autoMode ? [] : state.queue, currentIndex: state.autoMode ? 0 : state.currentIndex, items, stats: recount(items), lastError: state.autoMode ? (remaining ? `${remaining} elemento(s) siguen presentes; se continuará con otros.` : "Lote verificado; buscando el siguiente lote.") : remaining ? `${remaining} elemento(s) siguieron presentes; no se reintentaron automáticamente.` : "Verificación completada." });
      if (state.autoMode) setTimeout(() => void runAutomaticScanBatch(), 0);
    } catch (error) {
      const state = await getState();
      const status = error instanceof SafetyStopError ? "stopped_safety" : stopRequested ? "stopped" : "error";
      logEvent("error", "Verificación falló", { status, error: errorText(error), page: state.verificationPage, cursor: state.verificationCursor });
      await saveState({ ...state, status, lastError: errorText(error) });
    } finally {
      runner = false;
      render();
    }
  }

  async function stopOperation() {
    stopRequested = true;
    const state = await getState();
    logEvent("warn", "Detención solicitada por el usuario", { status: state.status, currentIndex: state.currentIndex, queueLength: state.queue.length });
    if (["scanning", "auto_scanning", "deleting", "verifying", "paused"].includes(state.status)) {
      await saveState({ ...state, status: "stopped", lastError: "Operación detenida por el usuario.", ...progressFields("Operación detenida por el usuario.") });
    }
  }

  async function pauseOperation() {
    const state = await getState();
    if (state.status === "deleting") {
      logEvent("warn", "Operación pausada por el usuario", { currentIndex: state.currentIndex, queueLength: state.queue.length });
      await saveState({ ...state, status: "paused", lastError: "Pausado. Puedes reanudar cuando quieras.", ...progressFields("Operación pausada.") });
    }
  }

  async function resumeOperation() {
    const state = await getState();
    if (["paused", "stopped", "stopped_safety"].includes(state.status)) {
      logEvent("info", "Reanudación solicitada por el usuario", { previousStatus: state.status, currentIndex: state.currentIndex, queueLength: state.queue.length, workerTabId: state.workerTabId });
      stopRequested = false;
      await saveState({ ...state, status: state.verificationCursor !== "0" ? "verifying" : "deleting", lastError: "", ...progressFields("Operación reanudada.") });
      if (state.workerTabId != null) await chrome.runtime.sendMessage({ type: "TFC_WAKE_WORKER" });
      else if (state.verificationCursor !== "0") void runVerification();
      else void runDeletionStep();
    }
  }

  async function selectByFilter() {
    const state = await getState();
    const items = state.items.map(item => ({ ...item, selected: inDateRange(item, state.settings) }));
    await saveState({ ...state, items, lastError: "Filtro aplicado a la selección." });
  }

  async function verifyNow() {
    const state = await getState();
    if (["scanning", "auto_scanning", "deleting", "verifying"].includes(state.status)) return;
    await saveState({ ...state, status: "verifying", verificationCursor: "0", verificationPage: 0, verificationPresentIds: [], lastError: "" });
    void runVerification();
  }

  async function clearState() {
    const state = await getState();
    if (["scanning", "auto_scanning", "deleting", "verifying"].includes(state.status)) return;
    if (!window.confirm("¿Limpiar la lista y el historial local de esta extensión? No cambia TikTok.")) return;
    await saveState(defaultState());
  }

  function statusLabel(state) {
    if (Number(state.rateLimitUntil) > Date.now()) return `Cooldown de TikTok: ${Math.ceil((Number(state.rateLimitUntil) - Date.now()) / 1000)} s…`;
    const labels = {
      idle: "Listo. Escanea tus guardados.",
      scanning: `Escaneando página ${state.scanPage || 1}…`,
      auto_scanning: `Buscando automáticamente el siguiente lote (página ${state.autoPage || 1})…`,
      ready: `Escaneo terminado: ${state.items.length} guardado(s).`,
      deleting: `Quitando ${Math.min(state.currentIndex + 1, state.queue.length)}/${state.queue.length}…`,
      processing: "Procesando…",
      paused: "Pausado.",
      verifying: `Verificando en el servidor (página ${state.verificationPage || 1})…`,
      complete: "Terminado y verificado.",
      complete_with_issues: "Terminado con elementos que siguen presentes.",
      stopped: "Detenido.",
      stopped_safety: "Detenido por seguridad.",
      error: "Error; revisa el mensaje.",
      failed: "Error; revisa el mensaje."
    };
    return labels[state.status] || state.status;
  }

  function shortDescription(item) {
    const date = itemDate(item);
    const desc = normalizedText(item.description) || "(sin descripción)";
    return `${date || "fecha desconocida"} · ${desc.slice(0, 72)}${desc.length > 72 ? "…" : ""}`;
  }

  function buildPanel() {
    if (host) return;
    host = document.createElement("div");
    host.id = "tfc-host";
    shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);
    render();
  }

  function openPanel() {
    buildPanel();
    panelOpen = true;
    render();
  }

  function closePanel() {
    panelOpen = false;
    render();
  }

  async function resumeForCurrentRole() {
    const state = await getState();
    const role = await getTabRole();
    const canRunDeletionHere = state.status === "deleting" && (role === "worker" || state.workerTabId == null);
    logEvent("debug", "Evaluando reanudación para esta pestaña", { role, status: state.status, workerTabId: state.workerTabId, path: location.pathname, canRunDeletionHere });
    if (state.status === "auto_scanning" && (role === "worker" || state.workerTabId == null)) void runAutomaticScanBatch();
    if (canRunDeletionHere) void runDeletionStep();
    if (state.status === "verifying" && (role === "worker" || state.workerTabId == null)) void runVerification();
  }

  function render(passedState) {
    if (!shadow) return;
    getState().then(state => {
      if (!shadow) return;
      const current = passedState || state;
      if (!panelOpen) {
        shadow.innerHTML = `<style>:host{all:initial}#launch{position:fixed;right:18px;bottom:18px;z-index:2147483647;border:0;border-radius:999px;padding:11px 15px;background:#fe2c55;color:#fff;font:700 13px system-ui;box-shadow:0 5px 24px #0006;cursor:pointer}</style><button id="launch">🔖 Abrir limpiador</button>`;
        shadow.getElementById("launch").onclick = openPanel;
        return;
      }

      const busy = ["scanning", "auto_scanning", "deleting", "verifying"].includes(current.status);
      const canResume = ["paused", "stopped", "stopped_safety"].includes(current.status) && current.queue.length > current.currentIndex;
      const items = current.items.slice().sort((a, b) => Number(b.createTime || 0) - Number(a.createTime || 0));
      const rows = items.slice(0, 500).map(item => `<div class="item"><span><b>${escapeHtml(item.creator ? "@" + item.creator : "video " + item.id)}</b><small>${escapeHtml(shortDescription(item))}</small><em class="${escapeHtml(item.status)}">${escapeHtml(item.status === "pending" ? "pendiente" : item.status)}</em>${item.error ? `<small class="item-error">${escapeHtml(item.error)}</small>` : ""}</span></div>`).join("");
      shadow.innerHTML = `<style>
        :host{all:initial}*{box-sizing:border-box}#panel{position:fixed;top:16px;right:16px;width:370px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);z-index:2147483647;overflow:hidden;border:1px solid #354052;border-radius:14px;background:#111722;color:#edf2f7;font:13px system-ui,-apple-system,sans-serif;box-shadow:0 18px 60px #000a}header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#182333;border-bottom:1px solid #2b3646}header b{font-size:14px;color:#25f4ee}button{border:0;border-radius:8px;padding:8px 10px;cursor:pointer;font:600 12px system-ui}button:disabled{opacity:.45;cursor:not-allowed}.close{padding:2px 8px;background:transparent;color:#aeb9c8;font-size:20px}.body{padding:12px 14px;overflow:auto;max-height:calc(100vh - 94px)}.status{padding:9px 10px;border-radius:9px;background:#202b3b;line-height:1.4}.error{margin-top:7px;color:#ffadad}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:9px 0}.stat{padding:7px 4px;text-align:center;border-radius:8px;background:#192231;color:#aeb9c8}.stat b{display:block;color:#fff;font-size:16px}.row{display:flex;gap:7px;align-items:end;margin:9px 0}.field{flex:1;color:#9caabb;font-size:11px}.field input{display:block;width:100%;margin-top:4px;padding:7px;border:1px solid #374354;border-radius:7px;background:#0e141e;color:#fff;font:12px system-ui}.actions{display:flex;gap:7px;flex-wrap:wrap}.primary{background:#fe2c55;color:#fff}.teal{background:#20d9d1;color:#071114}.dark{background:#2a3647;color:#fff}.warn{background:#473022;color:#ffd5ad}.hint{display:block;margin:8px 0;color:#96a4b5;font-size:11px;line-height:1.4}.list{display:flex;flex-direction:column;gap:5px;margin-top:10px;max-height:280px;overflow:auto}.item{display:flex;gap:8px;align-items:flex-start;padding:7px;border-radius:8px;background:#182231;cursor:pointer}.item input{margin-top:3px}.item span{min-width:0;flex:1}.item b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.item small{display:block;color:#aeb9c8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}.item em{display:inline-block;margin-top:3px;color:#72e7b4;font-size:10px;font-style:normal}.item em.failed,.item em.remaining{color:#ff9e9e}.item em.skipped{color:#ffd18a}.foot{margin-top:10px;color:#77879a;font-size:10px}.diagnostic{margin-top:8px;color:#9caabb;font-size:10px}.logs{margin-top:10px;border:1px solid #2d394a;border-radius:8px;padding:7px}.logs summary{cursor:pointer;color:#b9c7d8;font-size:11px}.logtext{display:block;width:100%;height:150px;margin-top:7px;resize:vertical;background:#0a0f17;color:#cbd5e1;border:1px solid #2d394a;border-radius:6px;font:10px ui-monospace,Consolas,monospace}.logactions{display:flex;gap:5px;margin-top:6px}.logactions button{padding:6px 8px;font-size:10px}
      </style><div id="panel"><header><b>🔖 TikTok Favorites Cleaner</b><button class="close" id="close">×</button></header><div class="body"><div class="status">${escapeHtml(statusLabel(current))}</div>${current.lastError ? `<div class="error">${escapeHtml(current.lastError)}</div>` : ""}<div class="stats"><div class="stat"><b>${current.items.length}</b>detectados</div><div class="stat"><b>${current.stats.removed}</b>quitados</div><div class="stat"><b>${current.stats.skipped}</b>omitidos</div><div class="stat"><b>${current.stats.failed + current.stats.remaining}</b>problemas</div></div><div class="row"><label class="field">Desde<input id="from" type="date" value="${escapeHtml(current.settings.from)}"></label><label class="field">Hasta<input id="to" type="date" value="${escapeHtml(current.settings.to)}"></label></div><div class="actions"><button class="teal" id="scan" ${busy ? "disabled" : ""}>Escanear vista</button><button class="primary" id="delete" ${busy ? "disabled" : ""}>Iniciar limpieza automática</button></div><div class="row"><label class="field">Pausa entre acciones (ms)<input id="delay" type="number" min="800" max="15000" value="${escapeHtml(current.settings.minDelay)}"></label><label class="field">Lote<input id="batch" type="number" min="1" max="50" value="${escapeHtml(current.settings.batchSize)}"></label></div><label class="hint"><input id="unknown" type="checkbox" ${current.settings.allowUnknownState ? "checked" : ""}> Permitir estado desconocido (riesgoso; solo si no pude leer el botón)</label><label class="hint"><input id="autoverify" type="checkbox" ${current.settings.autoVerify ? "checked" : ""}> Verificar la lista completa al terminar</label><div class="actions"><button class="warn" id="pause" ${current.status !== "deleting" ? "disabled" : ""}>Pausar</button><button class="dark" id="resume" ${!canResume ? "disabled" : ""}>Reanudar</button><button class="dark" id="stop" ${!busy && current.status !== "paused" ? "disabled" : ""}>Detener</button><button class="dark" id="verify" ${busy ? "disabled" : ""}>Verificar</button><button class="dark" id="clear" ${busy ? "disabled" : ""}>Limpiar</button></div><div class="diagnostic">Rol: ${escapeHtml(currentRole)} · worker: ${escapeHtml(current.workerTabId == null ? "no creado" : String(current.workerTabId))}${current.lastProgressAt ? ` · último progreso: ${escapeHtml(new Date(current.lastProgressAt).toLocaleTimeString())}` : ""}</div><details class="logs"><summary>Logs detallados (${logsCache.length})</summary><textarea id="logtext" class="logtext" readonly>${escapeHtml(logLines())}</textarea><div class="logactions"><button class="dark" id="copylogs">Copiar</button><button class="dark" id="downloadlogs">Descargar</button><button class="dark" id="clearlogs">Borrar logs</button></div></details><div class="list">${rows || "<span class='hint'>Todavía no hay videos escaneados.</span>"}</div><div class="foot">Solo funciona en tu pestaña de TikTok. No comparte cookies ni usa un servidor externo. Si TikTok responde 403/429 o muestra CAPTCHA, se detiene.</div></div></div>`;
      bindPanel(current);
    });
  }

  function bindPanel(state) {
    shadow.getElementById("close").onclick = closePanel;
    shadow.getElementById("scan").onclick = scanFavorites;
    shadow.getElementById("delete").onclick = beginDeletion;
    shadow.getElementById("pause").onclick = pauseOperation;
    shadow.getElementById("resume").onclick = resumeOperation;
    shadow.getElementById("stop").onclick = stopOperation;
    shadow.getElementById("verify").onclick = verifyNow;
    shadow.getElementById("clear").onclick = clearState;
    shadow.getElementById("copylogs").onclick = copyLogs;
    shadow.getElementById("downloadlogs").onclick = downloadLogs;
    shadow.getElementById("clearlogs").onclick = clearLogs;

    const settings = () => ({ ...state.settings,
      from: shadow.getElementById("from").value,
      to: shadow.getElementById("to").value,
      minDelay: Math.max(800, Number(shadow.getElementById("delay").value) || DEFAULT_SETTINGS.minDelay),
      maxDelay: Math.max(1200, (Number(shadow.getElementById("delay").value) || DEFAULT_SETTINGS.minDelay) + 1400),
      batchSize: Math.max(1, Math.min(50, Number(shadow.getElementById("batch").value) || DEFAULT_SETTINGS.batchSize)),
      allowUnknownState: shadow.getElementById("unknown").checked,
      autoVerify: shadow.getElementById("autoverify").checked
    });
    for (const id of ["from", "to", "delay", "batch", "unknown", "autoverify"]) {
      shadow.getElementById(id).onchange = () => void updateState(current => ({ ...current, settings: settings() }));
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "TFC_PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "TFC_OPEN_PANEL") openPanel();
    if (message?.type === "TFC_RUN_NOW") void resumeForCurrentRole();
  });

  window.addEventListener("message", event => {
    if (event.source !== window || !event.data || event.data.source !== SOURCE) return;
    if (event.data.type === "TFC_LIST_RESULT") {
      const pending = pendingListRequests.get(event.data.requestId);
      if (!pending) return;
      pendingListRequests.delete(event.data.requestId);
      clearTimeout(pending.timer);
      logEvent(event.data.ok ? "debug" : "warn", "Respuesta del puente de página recibida", { requestId: event.data.requestId, ok: Boolean(event.data.ok), status: event.data.status || 0, error: event.data.error || "" });
      if (event.data.status && [401, 403, 429].includes(Number(event.data.status))) {
        pending.reject(new SafetyStopError(`TikTok respondió ${event.data.status}. Se detuvo la operación por seguridad.`));
      } else if (!event.data.ok) {
        pending.reject(new Error(event.data.error || `TikTok respondió HTTP ${event.data.status || 0}.`));
      } else {
        pending.resolve(event.data.payload);
      }
      return;
    }
    if (event.data.type === "TFC_MUTATION_REQUEST") {
      logEvent("debug", "Solicitud de mutación observada", {
        path: event.data.path,
        method: event.data.method,
        requestKeys: event.data.requestKeys,
        requestFields: event.data.requestFields,
        transport: event.data.transport
      });
    }
    if (event.data.type === "TFC_MUTATION_RESULT") {
      mutationEvents.push(event.data);
      while (mutationEvents.length > 30) mutationEvents.shift();
      logEvent("info", "Respuesta de mutación observada", {
        path: event.data.path,
        method: event.data.method,
        requestKeys: event.data.requestKeys,
        requestFields: event.data.requestFields,
        transport: event.data.transport,
        status: event.data.status,
        statusCode: event.data.statusCode,
        statusMessage: event.data.statusMessage,
        responseHeaders: event.data.responseHeaders
      });
    }
    if (event.data.type === "TFC_NETWORK_ACTIVITY") {
      const at = Number(event.data.at) || Date.now();
      if (event.data.phase === "start") pendingNetworkRequests = Math.max(pendingNetworkRequests, Number(event.data.pending) || 0);
      if (event.data.phase === "end" || event.data.phase === "idle") pendingNetworkRequests = Math.max(0, Number(event.data.pending) || 0);
      if (event.data.phase === "start" || event.data.phase === "end") lastNetworkActivityAt = at;
      logEvent("debug", event.data.phase === "idle" ? "Red de TikTok en reposo" : "Actividad de red de TikTok", {
        phase: event.data.phase,
        requestId: event.data.requestId || "",
        path: event.data.path || "",
        method: event.data.method || "",
        status: event.data.status || 0,
        pending: pendingNetworkRequests,
        elapsedMs: event.data.elapsedMs || 0,
        quietMs: event.data.quietMs || 0
      });
    }
    if (event.data.type === "TFC_CONTEXT" && event.data.secUid) logEvent("debug", "Contexto de cuenta recibido", { hasSecUid: true });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) render(normalizeState(changes[STORAGE_KEY].newValue));
    if (changes[LOG_KEY]) {
      logsCache = Array.isArray(changes[LOG_KEY].newValue) ? changes[LOG_KEY].newValue.slice(-LOG_LIMIT) : [];
      render();
    }
  });

  function observeNavigation() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleResume(900);
    }
    requestAnimationFrame(observeNavigation);
  }

  function start() {
    injectPageBridge();
    buildPanel();
    startWatchdog();
    void loadLogs().then(() => render());
    logEvent("info", "Content script iniciado", { path: location.pathname, href: location.href.split("?")[0] });
    setTimeout(() => {
      postContextRequest();
      void resumeForCurrentRole();
    }, 1000);
    observeNavigation();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  })();
}
