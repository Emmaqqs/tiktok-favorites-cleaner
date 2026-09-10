(function () {
  "use strict";

  const SOURCE = "tfc-page-bridge";
  const CONTEXT_REQUEST = "TFC_GET_CONTEXT";
  const CONTEXT_RESULT = "TFC_CONTEXT";
  const MUTATION_REQUEST = "TFC_MUTATION_REQUEST";
  const MUTATION_RESULT = "TFC_MUTATION_RESULT";
  const NETWORK_ACTIVITY = "TFC_NETWORK_ACTIVITY";
  const MUTATION_PATH = /\/api\/(?:item\/collect|collect\/item|collection\/item|favorite\/action)(?:\/|$)/i;
  const MUTATION_HINT = /(?:collect|collection|favorite|favourite|bookmark|save|saved|guardar|salvar)/i;
  const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const MUTATION_BODY_KEYS = /^(?:item[_-]?id|aweme[_-]?id|itemId|awemeId|collect|favorite|favourite|bookmark|saved|save)$/i;
  const SAFE_BODY_KEY = /^(?:item[_-]?id|aweme[_-]?id|itemId|awemeId|type|action|collect|favorite|favourite|bookmark|saved|save|status)$/i;
  const API_PATH = /^\/api\//i;
  const ANALYTICS_PATH = /\/monitor_browser\//i;
  const RATE_HEADERS = ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];
  let networkRequestSerial = 0;
  let pendingNetworkRequests = 0;
  let networkTraceUntil = 0;
  let networkIdleTimer = null;

  function post(type, payload) {
    window.postMessage({ source: SOURCE, type, ...payload }, "*");
  }

  function findSecUid(value, seen, depth) {
    if (value == null || depth > 8) return null;
    if (typeof value !== "object") return null;
    const visited = seen || new WeakSet();
    if (visited.has(value)) return null;
    visited.add(value);

    for (const [key, child] of Object.entries(value)) {
      if (/^secUid$/i.test(key) && typeof child === "string" && child.length > 10) {
        return child;
      }
      const found = findSecUid(child, visited, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function getContext() {
    const globals = [
      window.__$UNIVERSAL_DATA$__,
      window.__UNIVERSAL_DATA_FOR_REHYDRATION__,
      window.SIGI_STATE
    ];
    for (const value of globals) {
      const secUid = findSecUid(value);
      if (secUid) return { secUid };
    }
    return { secUid: null };
  }

  function pathOf(input) {
    try {
      const raw = typeof input === "string" ? input : input && input.url;
      return new URL(raw, location.href).pathname;
    } catch (_) {
      return "";
    }
  }

  function isRelevantApiPath(path) {
    return API_PATH.test(path) && !ANALYTICS_PATH.test(path);
  }

  function bodyKeys(body) {
    if (!body) return [];
    try {
      if (typeof body === "string") {
        const text = body.trim();
        if (!text) return [];
        try {
          const json = JSON.parse(text);
          return json && typeof json === "object" && !Array.isArray(json)
            ? Object.keys(json).slice(0, 20)
            : [];
        } catch (_) {
          return [...new URLSearchParams(text).keys()].slice(0, 20);
        }
      }
      if (body instanceof URLSearchParams) return [...body.keys()].slice(0, 20);
      if (typeof FormData !== "undefined" && body instanceof FormData) return [...body.keys()].slice(0, 20);
      if (body instanceof Blob) return ["<blob>"];
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return ["<binary>"];
    } catch (_) { /* body may be a stream or an opaque browser object */ }
    return [];
  }

  function bodyInfoFromText(text, contentType = "") {
    const raw = String(text || "").trim();
    if (!raw) return { keys: [], fields: {} };
    let entries = [];
    try {
      const payload = JSON.parse(raw);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) entries = Object.entries(payload);
    } catch (_) {
      try { entries = [...new URLSearchParams(raw).entries()]; } catch (_) { /* opaque body */ }
    }
    const keys = entries.slice(0, 20).map(([key]) => String(key));
    const fields = Object.fromEntries(entries
      .filter(([key]) => SAFE_BODY_KEY.test(String(key)))
      .slice(0, 20)
      .map(([key, value]) => [String(key), String(value).slice(0, 120)]));
    return { keys, fields, contentType: String(contentType || "").slice(0, 100) };
  }

  function bodyInfo(body, contentType = "") {
    if (!body) return { keys: [], fields: {}, contentType: String(contentType || "").slice(0, 100) };
    if (typeof body === "string") return bodyInfoFromText(body, contentType);
    if (body instanceof URLSearchParams) return bodyInfoFromText(body.toString(), "application/x-www-form-urlencoded");
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const entries = [...body.entries()].map(([key, value]) => [key, typeof value === "string" ? value : "<file>"]);
      return bodyInfoFromText(new URLSearchParams(entries).toString(), "multipart/form-data");
    }
    return { keys: bodyKeys(body), fields: {}, contentType: String(contentType || "").slice(0, 100) };
  }

  async function requestBodyInfo(input, init) {
    const headers = init?.headers;
    const contentType = headers?.get ? headers.get("content-type") : "";
    if (init?.body != null) return bodyInfo(init.body, contentType);
    if (typeof Request !== "undefined" && input instanceof Request) {
      try {
        return bodyInfoFromText(await input.clone().text(), input.headers?.get("content-type") || "");
      } catch (_) { /* request body may be an unreadable stream */ }
    }
    return { keys: [], fields: {}, contentType: String(contentType || "").slice(0, 100) };
  }

  function requestMethod(input, init) {
    const method = init?.method || input?.method || "GET";
    return String(method).toUpperCase();
  }

  function shouldObserveMutation(path, method, keys) {
    if (MUTATION_PATH.test(path)) return true;
    if (!MUTATION_METHODS.has(method)) return false;
    if (!API_PATH.test(path)) return false;
    if (MUTATION_HINT.test(path)) return true;
    return keys.some(key => MUTATION_BODY_KEYS.test(String(key)));
  }

  function publishMutationRequest(path, method, info, transport) {
    post(MUTATION_REQUEST, {
      path,
      method,
      requestKeys: info.keys,
      requestFields: info.fields,
      transport,
      at: Date.now()
    });
  }

  function publishMutation(path, status, payload, meta = {}) {
    const data = payload && typeof payload === "object" ? payload : {};
    post(MUTATION_RESULT, {
      path,
      method: meta.method || "",
      requestKeys: Array.isArray(meta.requestKeys) ? meta.requestKeys : [],
      requestFields: meta.requestFields && typeof meta.requestFields === "object" ? meta.requestFields : {},
      responseHeaders: meta.responseHeaders && typeof meta.responseHeaders === "object" ? meta.responseHeaders : {},
      transport: meta.transport || "",
      kind: "response",
      status,
      statusCode: data.status_code ?? data.statusCode ?? null,
      statusMessage: String(data.status_msg ?? data.statusMessage ?? ""),
      at: Date.now()
    });
  }

  function responseRateHeaders(response) {
    const headers = {};
    for (const name of RATE_HEADERS) {
      try {
        const value = response.headers?.get(name);
        if (value) headers[name] = String(value).slice(0, 120);
      } catch (_) { /* some response types expose no headers */ }
    }
    return headers;
  }

  function xhrRateHeaders(xhr) {
    const headers = {};
    for (const name of RATE_HEADERS) {
      try {
        const value = xhr.getResponseHeader(name);
        if (value) headers[name] = String(value).slice(0, 120);
      } catch (_) { /* response headers may be inaccessible */ }
    }
    return headers;
  }

  function beginNetwork(path, method) {
    if (!isRelevantApiPath(path)) return null;
    const requestId = `api-${Date.now()}-${++networkRequestSerial}`;
    pendingNetworkRequests += 1;
    if (Date.now() <= networkTraceUntil) {
      post(NETWORK_ACTIVITY, { phase: "start", requestId, path, method, pending: pendingNetworkRequests, at: Date.now() });
    }
    return { requestId, startedAt: Date.now(), path, method };
  }

  function finishNetwork(network, status) {
    if (!network) return;
    pendingNetworkRequests = Math.max(0, pendingNetworkRequests - 1);
    if (Date.now() <= networkTraceUntil + 1500) {
      post(NETWORK_ACTIVITY, {
        phase: "end",
        requestId: network.requestId,
        path: network.path,
        method: network.method,
        status: Number(status) || 0,
        pending: pendingNetworkRequests,
        elapsedMs: Date.now() - network.startedAt,
        at: Date.now()
      });
    }
    if (networkIdleTimer != null) clearTimeout(networkIdleTimer);
    networkIdleTimer = setTimeout(() => {
      if (pendingNetworkRequests !== 0) return;
      if (Date.now() > networkTraceUntil + 1500) return;
      post(NETWORK_ACTIVITY, { phase: "idle", pending: 0, quietMs: 900, at: Date.now() });
    }, 900);
  }

  async function inspectResponse(response, path, meta) {
    try {
      const text = await response.clone().text();
      let payload = null;
      try { payload = JSON.parse(text); } catch (_) { /* TikTok may return an empty body. */ }
      publishMutation(path, response.status, payload, { ...meta, responseHeaders: responseRateHeaders(response) });
    } catch (_) {
      publishMutation(path, response.status, null, meta);
    }
  }

  function installFetchBridge() {
    if (typeof window.fetch !== "function") return;
    const originalFetch = window.fetch;
    window.fetch = async function tfcFetch() {
      const input = arguments[0];
      const init = arguments[1] || {};
      const path = pathOf(input);
      const method = requestMethod(input, init);
      const keys = bodyKeys(init.body);
      const observe = shouldObserveMutation(path, method, keys);
      if (observe) networkTraceUntil = Math.max(networkTraceUntil, Date.now() + 10000);
      const network = beginNetwork(path, method);
      const infoPromise = requestBodyInfo(input, init);
      if (observe) void infoPromise.then(info => publishMutationRequest(path, method, info, "fetch"));
      let responseStatus = 0;
      try {
        const response = await originalFetch.apply(this, arguments);
        responseStatus = response.status;
        if (observe) {
          void infoPromise.then(info => inspectResponse(response, path, { method, requestKeys: info.keys, requestFields: info.fields, transport: "fetch" }));
        }
        return response;
      } finally {
        finishNetwork(network, responseStatus);
      }
    };
  }

  function installXhrBridge() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function tfcOpen(method, url) {
      this.__tfcPath = pathOf(url);
      this.__tfcMethod = String(method || "GET").toUpperCase();
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function tfcSend(body) {
      const path = this.__tfcPath || pathOf(this.responseURL);
      const method = this.__tfcMethod || "GET";
      const info = bodyInfo(body);
      const observe = shouldObserveMutation(path, method, info.keys);
      if (observe) networkTraceUntil = Math.max(networkTraceUntil, Date.now() + 10000);
      const network = beginNetwork(path, method);
      if (observe) publishMutationRequest(path, method, info, "xhr");
      this.addEventListener("loadend", function () {
        const path = this.__tfcPath || pathOf(this.responseURL);
        const method = this.__tfcMethod || "GET";
        const info = this.__tfcBodyInfo || { keys: [], fields: {} };
        if (shouldObserveMutation(path, method, info.keys)) {
          let payload = null;
          try { payload = JSON.parse(this.responseText); } catch (_) { /* empty/non-JSON */ }
          publishMutation(path, this.status, payload, { method, requestKeys: info.keys, requestFields: info.fields, responseHeaders: xhrRateHeaders(this), transport: "xhr" });
        }
        finishNetwork(this.__tfcNetwork, this.status);
      }, { once: true });
      this.__tfcBodyInfo = info;
      this.__tfcNetwork = network;
      return originalSend.apply(this, arguments);
    };
  }

  async function fetchFavoriteList(request) {
    const params = new URLSearchParams({
      aid: "1988",
      count: String(request.count || 30),
      coverFormat: "2",
      cursor: String(request.cursor || "0"),
      secUid: String(request.secUid || ""),
      tfc_nonce: String(Date.now())
    });
    const url = `${location.origin}/api/user/collect/item_list/?${params}`;
    try {
      const response = await window.fetch(url, { credentials: "include", cache: "no-store" });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch (_) { /* handled below */ }
      post("TFC_LIST_RESULT", {
        requestId: request.requestId,
        ok: response.ok && Boolean(payload),
        status: response.status,
        payload,
        error: payload ? "" : `TikTok no devolvió JSON: ${text.slice(0, 120)}`
      });
    } catch (error) {
      post("TFC_LIST_RESULT", {
        requestId: request.requestId,
        ok: false,
        status: 0,
        payload: null,
        error: String(error && error.message || error)
      });
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || event.data.source !== SOURCE) return;
    if (event.data.type === CONTEXT_REQUEST) {
      post(CONTEXT_RESULT, getContext());
    }
    if (event.data.type === "TFC_FETCH_LIST" && event.data.requestId) {
      void fetchFavoriteList(event.data);
    }
  });

  installFetchBridge();
  installXhrBridge();
  post(CONTEXT_RESULT, getContext());
})();
