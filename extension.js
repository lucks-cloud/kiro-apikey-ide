"use strict";
// KIRO-APIKEY-IDE
// ---------------------------------------------------------------------------
// Route Kiro's built-in AI calls through a Kiro API key (ksk_...).
//
// How it works (verified against the live service):
//   * A ksk_ key authenticates directly against Kiro's own gateways using the
//     SAME endpoints and SAME wire protocol the IDE already speaks:
//       - runtime.{region}.kiro.dev    (KRS: generateAssistantResponse, ...)
//       - management.{region}.kiro.dev (CPS: List-Available-Models, usage, ...)
//   * Auth is a plain Bearer token PLUS a `tokentype: API_KEY` header, and the
//     request body must NOT carry a profileArn (that belongs to the IDE's own
//     OAuth login and 403s a ksk_ key). The header `x-amzn-kiro-agent-mode`
//     must be present.
//   * Because the ksk_ path and the IDE path are protocol-identical, this
//     extension is a thin reverse proxy: it swaps the credential, strips
//     profileArn, and forwards. No format translation needed.
//
// Integration with the built-in chat is done exactly like the IDE expects:
// we point `codewhisperer.config.krsEndpoints` / `cpsEndpoints` at two local
// proxy servers, so kiro-agent transparently talks to us instead of AWS.
// ---------------------------------------------------------------------------

const vscode = require("vscode");
const http = require("http");
const https = require("https");
const path = require("path");
const fsMod = require("fs");
const childProcess = require("child_process");
const { URL } = require("url");

const CONFIG_NS = "kiroApikeyIde";
const HEALTH_PATH = "/__kiro_key_health";
const HEALTH_MARKER = "kiro-key-ok";
const REPO_URL = "https://github.com/lucks-cloud/kiro-apikey-ide";
// Current extension version, read from the shipped package.json (extension.js
// sits next to it both in dev and inside the packaged VSIX).
function currentVersion() {
  try { return String(require("./package.json").version || "0.0.0"); } catch { return "0.0.0"; }
}
function cleanVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}
// Kiro's product version is NOT vscode.version: e.g. Kiro 0.12.333 is built
// on editor 1.107.1. On macOS the product version lives in the app bundle's
// Info.plist. Other platforms first use Kiro-specific product metadata, then
// the executable's ProductVersion on Windows.
function kiroProductVersion(product) {
  const metadata = [
    product.kiroVersion,
    product.productVersion,
    product.applicationVersion,
    product.releaseVersion,
  ].map(cleanVersion).find(Boolean);
  if (metadata) return metadata;

  if (process.platform === "darwin") {
    const infoFile = path.resolve(vscode.env.appRoot || "", "..", "..", "Info.plist");
    try {
      const xml = fsMod.readFileSync(infoFile, "utf8");
      const match = xml.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/i);
      if (match && cleanVersion(match[1])) return cleanVersion(match[1]);
    } catch {}
    try {
      return cleanVersion(childProcess.execFileSync(
        "/usr/bin/plutil",
        ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoFile],
        { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }
      ));
    } catch {}
  }

  if (process.platform === "win32") {
    try {
      const exe = String(process.execPath || "").replace(/'/g, "''");
      return cleanVersion(childProcess.execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${exe}').VersionInfo.ProductVersion`],
        { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }
      ));
    } catch {}
  }

  // Some distributions expose their product version directly in product.json.
  // Only accept it when it differs from the underlying editor version, so an
  // editor build such as 1.107.1 is never mislabeled as the Kiro release.
  const generic = cleanVersion(product.version);
  return generic && generic !== cleanVersion(vscode.version) ? generic : "unknown";
}
// Report both version layers plus installed Kiro/CodeWhisperer core extensions.
function kiroHostInfo() {
  let product = {};
  try {
    const productFile = path.join(vscode.env.appRoot || "", "product.json");
    product = JSON.parse(fsMod.readFileSync(productFile, "utf8"));
  } catch {}
  const ownId = String(extContext?.extension?.id || "").toLowerCase();
  const core = [];
  try {
    for (const ext of vscode.extensions.all || []) {
      const p = ext.packageJSON || {};
      const text = [ext.id, p.name, p.displayName, p.publisher].join(" ").toLowerCase();
      const id = String(ext.id || "").toLowerCase();
      if (id === ownId || id.includes("kiro-apikey-ide")) continue;
      if (/kiro|codewhisperer/.test(text)) core.push(ext.id + "@" + String(p.version || "unknown"));
    }
  } catch {}
  return {
    appName: String(vscode.env.appName || product.nameLong || product.nameShort || "Kiro"),
    productVersion: kiroProductVersion(product),
    editorVersion: cleanVersion(vscode.version) || "unknown",
    commit: String(product.commit || product.buildNumber || "unknown"),
    platform: process.platform + "/" + process.arch,
    coreExtensions: core.length ? core.join(", ") : "not-detected",
    pluginVersion: currentVersion(),
  };
}
function logKiroHostInfo() {
  const info = kiroHostInfo();
  log("Kiro version: app=" + info.appName
    + " productVersion=" + info.productVersion
    + " editorVersion=" + info.editorVersion
    + " commit=" + info.commit
    + " platform=" + info.platform
    + " coreExtensions=" + info.coreExtensions
    + " plugin=" + info.pluginVersion);
}
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"];

// A ksk_ key is rejected upstream with "Access denied. Please check your
// authentication." whenever the request body carries a profileArn (that field
// belongs to the IDE's OAuth login). Depending on the Kiro build a generation
// request is addressed either REST-style (operation in the URL path) or
// awsJson-style (POST "/" with the operation in the x-amz-target header), so
// gating the strip on the URL alone misses awsJson clients. We instead scrub
// profileArn from ANY JSON body below, which covers both.

// Recursively remove any `profileArn` field from a parsed JSON body. Kiro
// versions have placed it at the top level and, in some builds, nested inside
// the request envelope, so we scrub it everywhere to be safe. Returns true if
// anything was removed.
function scrubProfileArn(node) {
  if (!node || typeof node !== "object") return false;
  let changed = false;
  if (Array.isArray(node)) {
    for (const item of node) if (scrubProfileArn(item)) changed = true;
    return changed;
  }
  if (Object.prototype.hasOwnProperty.call(node, "profileArn")) {
    delete node.profileArn;
    changed = true;
  }
  for (const k of Object.keys(node)) if (scrubProfileArn(node[k])) changed = true;
  return changed;
}

// Strip profileArn from a JSON request body. A ksk_ key must never carry one,
// on ANY operation, so we attempt this whenever the body parses as JSON rather
// than gating on the operation name. Non-JSON bodies are forwarded untouched.
function stripProfileArnFromBody(bodyBuf) {
  if (!bodyBuf || !bodyBuf.length) return bodyBuf;
  let j;
  try {
    j = JSON.parse(bodyBuf.toString("utf8"));
  } catch {
    return bodyBuf; // not JSON: forward untouched
  }
  if (scrubProfileArn(j)) {
    return Buffer.from(JSON.stringify(j), "utf8");
  }
  return bodyBuf;
}

// The upstream authorizes generation requests only when the User-Agent carries
// a KiroIDE signature. kiro-agent sends this naturally; we inject a valid one
// as a fallback so the gateway also works if a client omits it.
const KIRO_VERSION = "0.9.2";
const KIRO_SYSTEM = "darwin#24.6.0";
const KIRO_NODE = "22.21.1";

let extContext = null;
let krsServer = null;
let cpsServer = null;
let statusBarItem = null;
let panelProvider = null;
let output = null;
let _machineId = null;

// ---------------------------------------------------------------------------
// Config accessors
// ---------------------------------------------------------------------------
function cfg() {
  return vscode.workspace.getConfiguration(CONFIG_NS);
}
function get(key, def) {
  return cfg().get(key, def);
}
async function set(key, value) {
  await cfg().update(key, value, vscode.ConfigurationTarget.Global);
}
function isEnabled() {
  return get("enabled", false);
}
function getApiKeys() {
  const arr = get("apiKeys", []) || [];
  const list = Array.isArray(arr) ? arr.map((s) => String(s || "").trim()).filter(Boolean) : [];
  // de-dupe, preserve order
  return [...new Set(list)];
}
function getActiveApiKey() {
  const list = getApiKeys();
  const a = String(get("activeApiKey", "") || "").trim();
  if (a && list.includes(a)) return a;
  return list[0] || "";
}
function getApiKey() {
  // The selected/active key is the default (control-plane calls, status, etc.).
  return getActiveApiKey();
}
async function setApiKeys(list) {
  const clean = [...new Set((Array.isArray(list) ? list : []).map((s) => String(s || "").trim()).filter(Boolean))];
  await set("apiKeys", clean);
  return clean;
}
// One-time migration: move legacy single apiKey into the apiKeys array.
async function migrateLegacyKey() {
  const legacy = String(get("apiKey", "") || "").trim();
  if (!legacy) return;
  const list = getApiKeys();
  if (!list.includes(legacy)) await setApiKeys([legacy, ...list]);
  await set("apiKey", "");
}
function getRegion() {
  const r = String(get("region", "us-east-1") || "us-east-1").trim();
  return r || "us-east-1";
}
function getPorts() {
  const p = get("ports", {}) || {};
  return { krs: Number(p.krs) || 19820, cps: Number(p.cps) || 19821 };
}
// UI-only preferences live in globalState (not workspace config), so they work
// without registering configuration keys and never hit "config not registered".
function getHideApiKey() {
  const v = extContext && extContext.globalState.get("kiroApikeyIde.hideApiKey");
  return v !== false; // default true
}
async function setHideApiKeyPref(v) {
  if (extContext) await extContext.globalState.update("kiroApikeyIde.hideApiKey", !!v);
}
function getAutoRefresh() {
  if (!extContext) return true;
  const v = extContext.globalState.get("kiroApikeyIde.autoRefresh");
  // Default to enabled when the preference has never been set.
  return v === undefined ? true : v === true;
}
async function setAutoRefreshPref(v) {
  if (extContext) await extContext.globalState.update("kiroApikeyIde.autoRefresh", !!v);
}
function runtimeBase() {
  return "https://runtime." + getRegion() + ".kiro.dev";
}
function managementBase() {
  return "https://management." + getRegion() + ".kiro.dev";
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
// In-memory ring buffer so the control panel can show recent logs in a drawer
// without the user hunting for the "KIRO-APIKEY-IDE" output channel. We keep
// only the last hour (and hard-cap the count) so it never grows unbounded.
const LOG_RETENTION_MS = 60 * 60 * 1000; // keep the last hour
const LOG_MAX_ENTRIES = 5000;            // hard cap regardless of time window
const _logBuffer = [];                   // [{ t: epochMs, line: string }]
function pruneLogs() {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  while (_logBuffer.length && _logBuffer[0].t < cutoff) _logBuffer.shift();
  if (_logBuffer.length > LOG_MAX_ENTRIES) _logBuffer.splice(0, _logBuffer.length - LOG_MAX_ENTRIES);
}
function getRecentLogs() {
  pruneLogs();
  return _logBuffer.map((e) => e.line);
}
function log(...args) {
  const msg = args
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(" ");
  const t = Date.now();
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  const line = "[" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "] " + msg;
  if (!output) output = vscode.window.createOutputChannel("KIRO-APIKEY-IDE");
  output.appendLine(line);
  _logBuffer.push({ t, line });
  pruneLogs();
}

// One-time, prominent marker the first time kiro-agent actually reaches each
// local proxy plane. Both logs a user sent looked "healthy" (ports bound,
// endpoints written) yet contained ZERO proxy traffic — meaning kiro-agent was
// never routed through us. This marker makes "链路真的打通了" unmistakable in
// the log, so "没走代理" vs "走了但上游报错" is obvious at a glance.
let _proxyHit = { KRS: false, CPS: false };
function resetProxyHitMarkers() { _proxyHit = { KRS: false, CPS: false }; }
function markProxyHit(label, req) {
  if (_proxyHit[label]) return;
  _proxyHit[label] = true;
  const op = String((req && req.url) || "").split("?")[0];
  log("========== [" + label + "] 首次收到 kiro-agent 代理请求 → 链路已打通 (" + (req && req.method) + " " + op + ") ==========");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function stripHopByHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
function maskKey(k) {
  if (!k) return "(empty)";
  if (k.length <= 12) return k.slice(0, 4) + "***";
  return k.slice(0, 8) + "…" + k.slice(-4);
}
// Show first 8 + last 8 chars, middle replaced with '*' (capped for display).
function maskKeyLong(k) {
  const s = String(k || "");
  if (s.length <= 16) return s.slice(0, 4) + "*".repeat(Math.max(3, s.length - 4));
  const stars = "*".repeat(Math.min(Math.max(s.length - 16, 4), 16));
  return s.slice(0, 8) + stars + s.slice(-8);
}
// Stable 64-hex machine id (persisted across reloads).
function machineId() {
  if (_machineId) return _machineId;
  let id = extContext && extContext.globalState.get("kiroApikeyIde.machineId");
  if (!id) {
    id = require("crypto").randomBytes(32).toString("hex");
    extContext && extContext.globalState.update("kiroApikeyIde.machineId", id);
  }
  _machineId = id;
  return id;
}
function kiroUserAgent() {
  const mid = machineId();
  return `aws-sdk-js/1.0.34 ua/2.1 os/${KIRO_SYSTEM} lang/js md/nodejs#${KIRO_NODE} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${KIRO_VERSION}-${mid}`;
}
function kiroXAmzUserAgent() {
  return `aws-sdk-js/1.0.34 KiroIDE-${KIRO_VERSION}-${machineId()}`;
}

// Build the upstream headers for a ksk_ request: keep whatever the IDE sent,
// but force the credential + API-key markers.
function injectAuthHeaders(incoming, targetHost, key) {
  const headers = {};
  for (const [k, v] of Object.entries(incoming || {})) {
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "authorization" || lk === "content-length" || lk === "tokentype") continue;
    if (HOP_BY_HOP.includes(lk)) continue;
    headers[k] = v;
  }
  headers["host"] = targetHost;
  headers["authorization"] = "Bearer " + (key || getApiKey());
  headers["tokentype"] = "API_KEY";
  const has = (name) => Object.keys(headers).some((h) => h.toLowerCase() === name);
  if (!has("x-amzn-kiro-agent-mode")) headers["x-amzn-kiro-agent-mode"] = "vibe";
  // The upstream authorizes only when User-Agent carries a KiroIDE signature.
  const uaKey = Object.keys(headers).find((h) => h.toLowerCase() === "user-agent");
  if (!uaKey || !/KiroIDE/i.test(String(headers[uaKey] || ""))) headers[uaKey || "user-agent"] = kiroUserAgent();
  if (!has("x-amz-user-agent")) headers["x-amz-user-agent"] = kiroXAmzUserAgent();
  if (!has("x-amzn-codewhisperer-optout")) headers["x-amzn-codewhisperer-optout"] = "true";
  return headers;
}

// ---------------------------------------------------------------------------
// Reverse proxy: swap credential, strip profileArn, forward to Kiro gateway.
// ---------------------------------------------------------------------------
function makeProxyHandler(label, baseFn) {
  return function handle(req, res) {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(HEALTH_MARKER);
      return;
    }
    const apiKey = getApiKey();
    if (!apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "KIRO-APIKEY-IDE: no API key configured." }));
      return;
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("error", () => {});
    req.on("end", () => {
      let bodyBuf = Buffer.concat(chunks);

      // API keys must not carry a profileArn (belongs to the IDE OAuth login).
      // Strip it whenever the body is JSON, regardless of how the operation is
      // addressed (URL path vs x-amz-target header).
      bodyBuf = stripProfileArnFromBody(bodyBuf);

      let target;
      try {
        target = new URL(baseFn() + req.url);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "bad target url: " + e.message }));
        return;
      }

      const activeKey = getApiKey();
      const keyTag = "key (" + maskKey(activeKey) + ")";
      const headers = injectAuthHeaders(req.headers, target.host, activeKey);
      if (bodyBuf.length) headers["content-length"] = Buffer.byteLength(bodyBuf);

      log("-> [" + label + "] " + keyTag + " " + req.method + " " + req.url.split("?")[0] + " region=" + getRegion());

      const upReq = https.request(
        {
          method: req.method,
          hostname: target.hostname,
          port: 443,
          path: target.pathname + target.search,
          headers,
          timeout: 300000,
        },
        (upRes) => {
          const status = upRes.statusCode || 0;
          const ok = status >= 200 && status < 300;
          log((ok ? "<- [" : "!! [") + label + "] " + keyTag + " -> HTTP " + status);
          const outHeaders = stripHopByHop(upRes.headers);
          res.writeHead(status || 502, outHeaders);
          upRes.pipe(res);
          upRes.on("error", () => { try { res.end(); } catch {} });
        }
      );
      upReq.on("error", (e) => {
        log("!! [" + label + "] " + keyTag + " upstream error: " + e.message);
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
        try { res.end(JSON.stringify({ message: "upstream error: " + e.message })); } catch {}
      });
      upReq.on("timeout", () => upReq.destroy(new Error("upstream timeout")));
      if (bodyBuf.length) upReq.write(bodyBuf);
      upReq.end();
    });
  };
}

// KRS (generation plane) handler. We deliberately use ONLY the user-selected
// (active) key — no automatic rotation across keys. Whatever status the
// selected key returns (including 403/429) is forwarded to the client as-is,
// so the behaviour is predictable and it's always clear which key is in use.
function makeKrsHandler() {
  return function handle(req, res) {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(HEALTH_MARKER);
      return;
    }
    markProxyHit("KRS", req);
    // Only the selected key. No failover list, so a bad/exhausted key surfaces
    // its real error instead of silently switching to a different key.
    const activeKey = getApiKey();
    const keys = activeKey ? [activeKey] : [];
    if (!keys.length) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "KIRO-APIKEY-IDE: no API key configured." }));
      return;
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("error", () => {});
    req.on("end", () => {
      let bodyBuf = Buffer.concat(chunks);
      // A ksk_ key must never carry a profileArn on any generation request,
      // whether addressed via the URL path or the x-amz-target header.
      bodyBuf = stripProfileArnFromBody(bodyBuf);

      let target;
      try {
        target = new URL(runtimeBase() + req.url);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "bad target url: " + e.message }));
        return;
      }

      // Single, user-selected key. Its response (success OR error) is passed
      // straight through — no rotation, no retry with a different key.
      const key = keys[0];
      const keyTag = "key (" + maskKey(key) + ")";
      const headers = injectAuthHeaders(req.headers, target.host, key);
      if (bodyBuf.length) headers["content-length"] = Buffer.byteLength(bodyBuf);
      log("-> [KRS] " + keyTag + " " + req.method + " " + req.url.split("?")[0] + " region=" + getRegion());

      const upReq = https.request(
        { method: req.method, hostname: target.hostname, port: 443, path: target.pathname + target.search, headers, timeout: 300000 },
        (upRes) => {
          const status = upRes.statusCode || 0;
          const ok = status >= 200 && status < 300;
          log((ok ? "<- [KRS] " : "!! [KRS] ") + keyTag + " -> HTTP " + status + (ok ? " (serving)" : ""));
          res.writeHead(status || 502, stripHopByHop(upRes.headers));
          upRes.pipe(res);
          upRes.on("error", () => { try { res.end(); } catch {} });
        }
      );
      upReq.on("error", (e) => {
        log("!! [KRS] " + keyTag + " upstream error: " + e.message);
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
        try { res.end(JSON.stringify({ message: "upstream error: " + e.message })); } catch {}
      });
      upReq.on("timeout", () => upReq.destroy(new Error("upstream timeout")));
      if (bodyBuf.length) upReq.write(bodyBuf);
      upReq.end();
    });
  };
}

// CPS (control plane) handler. kiro-agent may ask for the model list / usage
// via an awsJson call (POST / with x-amz-target) rather than the REST GET path,
// so blind passthrough can hit UnknownOperation and yield an EMPTY model list
// (the "cannot select model" symptom). We DETECT the operation and answer it
// with the known-good management GET call, returning the raw JSON verbatim so
// the format Kiro expects is preserved.
function makeCpsHandler() {
  const passthrough = makeProxyHandler("CPS", managementBase);
  return function handle(req, res) {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(HEALTH_MARKER);
      return;
    }
    if (!getApiKey()) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "KIRO-APIKEY-IDE: no API key configured." }));
      return;
    }
    markProxyHit("CPS", req);
    const clean = (req.url || "/").split("?")[0];
    const amzTarget = String(req.headers["x-amz-target"] || req.headers["x-amzn-target"] || "");
    const norm = (s) => String(s).replace(/[^a-z0-9]/gi, "").toLowerCase();
    const key = norm(clean) + "|" + norm(amzTarget);
    const isModels = key.includes("availablemodels");
    const isUsage = key.includes("usagelimit");
    const contentType = amzTarget ? "application/x-amz-json-1.0" : "application/json";

    if (isModels || isUsage) {
      req.resume(); // drain incoming body
      const upPath = isModels
        ? "/List-Available-Models?origin=AI_EDITOR&maxResults=200"
        : "/Get-Usage-Limits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST";
      const label = isModels ? "ListAvailableModels" : "GetUsageLimits";
      apiGet(managementBase(), upPath)
        .then((r) => {
          const ok = r.statusCode >= 200 && r.statusCode < 300;
          let count = "";
          if (isModels && ok) { try { count = " (" + (JSON.parse(r.body).models || []).length + " models)"; } catch {} }
          log("<- [CPS] " + label + " HTTP " + r.statusCode + count);
          res.writeHead(ok ? 200 : r.statusCode, { "Content-Type": contentType });
          res.end(r.body);
        })
        .catch((e) => {
          log("!! [CPS] " + label + " failed: " + e.message);
          res.writeHead(200, { "Content-Type": contentType });
          res.end(JSON.stringify(isModels ? { models: [] } : {}));
        });
      return;
    }
    // Any other control-plane op: transparent credential-swapping passthrough.
    passthrough(req, res);
  };
}

// ---------------------------------------------------------------------------
// Port binder: bind locally, reuse if a sibling instance already holds it.
// ---------------------------------------------------------------------------
class ProxyServer {
  constructor(port, handler, label) {
    this.port = port;
    this.handler = handler;
    this.label = label;
    this.server = null;
    this.pending = null;
    this.stopped = false;
    this.retryTimer = null;
  }
  start() {
    this.stopped = false;
    this._tryBind();
  }
  _tryBind() {
    if (this.stopped) return;
    const srv = http.createServer(this.handler);
    this.pending = srv;
    srv.on("error", (e) => {
      if (this.pending === srv) this.pending = null;
      try { srv.close(); } catch {}
      if (e.code === "EADDRINUSE") {
        log("!! [" + this.label + "] port " + this.port + " is in use; checking whether it is another healthy gateway");
      } else {
        log("!! [" + this.label + "] listen error: " + e.message);
      }
      this._scheduleRetry();
    });
    srv.listen(this.port, "127.0.0.1", () => {
      if (this.stopped) {
        try { srv.close(); } catch {}
        if (this.pending === srv) this.pending = null;
        return;
      }
      this.server = srv;
      this.pending = null;
      log("[" + this.label + "] listening on 127.0.0.1:" + this.port);
    });
  }
  _scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this._tryBind();
    }, 3000);
  }
  async isReachable() {
    if (this.server) return true;
    return new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: this.port, path: HEALTH_PATH, method: "GET", timeout: 1000 },
        (r) => {
          const c = [];
          r.on("data", (d) => c.push(d));
          r.on("end", () => resolve(Buffer.concat(c).toString("utf8").includes(HEALTH_MARKER)));
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    });
  }
  async waitUntilReachable(timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.isReachable()) return true;
      await sleep(150);
    } while (!this.stopped && Date.now() < deadline);
    log("!! [" + this.label + "] health check failed on 127.0.0.1:" + this.port);
    return false;
  }
  stop() {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
    if (this.pending) { try { this.pending.close(); } catch {} this.pending = null; }
  }
}

// ---------------------------------------------------------------------------
// codewhisperer.config endpoint override (redirect kiro-agent to our proxy)
// ---------------------------------------------------------------------------
// Regions we advertise as redirected. Our single local proxy handles all of
// them and forwards to the user's configured region, so kiro-agent hits us no
// matter which region it thinks it is using. This is a STATIC baseline; the
// user's currently-selected region is always merged in at write time (see
// redirectRegions) so a key issued in, say, ap-southeast-2 still gets its
// endpoint rewritten — otherwise kiro-agent would silently bypass the proxy
// and talk to AWS directly for that region.
const REDIRECT_REGIONS = ["us-east-1", "eu-central-1"];
// The regions to actually write, always including the active region so the
// redirect can never miss the plane kiro-agent is really using.
function redirectRegions() {
  return [...new Set([getRegion(), ...REDIRECT_REGIONS].map((r) => String(r || "").trim()).filter(Boolean))];
}

// Locate the active profile's settings.json. In profile-enabled Kiro builds,
// globalStorageUri itself is profile-scoped, so walking up from
// <profile>/globalStorage/<extension-id> lands in the correct profile rather
// than always writing the default User/settings.json.
function userSettingsPath() {
  try {
    const gs = extContext.globalStorageUri.fsPath;
    return path.join(path.resolve(gs, "..", ".."), "settings.json");
  } catch {
    return "";
  }
}
function parseSettingsJson(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  const stripped = text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)/g, (m, c) => (c ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped || "{}");
}
function fullEndpointKey(key) {
  return "codewhisperer.config." + key;
}
function normalizeEndpointList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      region: String(e.region || "").trim(),
      endpoint: String(e.endpoint || "").trim().replace(/\/$/, ""),
    }))
    .filter((e) => e.region && e.endpoint)
    .sort((a, b) => a.region.localeCompare(b.region) || a.endpoint.localeCompare(b.endpoint));
}
function endpointListsEqual(a, b) {
  return JSON.stringify(normalizeEndpointList(a)) === JSON.stringify(normalizeEndpointList(b));
}
function endpointOverride(port) {
  return redirectRegions().map((region) => ({ region, endpoint: "http://127.0.0.1:" + port }));
}
function readEndpointFromSettingsFile(key) {
  const file = userSettingsPath();
  if (!file || !fsMod.existsSync(file)) return undefined;
  try {
    return parseSettingsJson(fsMod.readFileSync(file, "utf8"))[fullEndpointKey(key)];
  } catch (e) {
    log("!! settings.json read failed (" + file + "): " + (e?.message || e));
    return undefined;
  }
}
// Fallback for Kiro builds that consume these hidden settings but do not
// register them with VS Code's configuration schema. The write is verified by
// reading the exact active-profile file back; "write succeeded" alone is not
// treated as proof anymore.
function writeEndpointToSettingsFile(key, value) {
  const file = userSettingsPath();
  if (!file) return { ok: false, file: "" };
  try {
    fsMod.mkdirSync(path.dirname(file), { recursive: true });
    const raw = fsMod.existsSync(file) ? fsMod.readFileSync(file, "utf8") : "{}";
    const obj = parseSettingsJson(raw);
    obj[fullEndpointKey(key)] = value;
    const backup = file + ".kiro-apikey-ide.bak";
    if (fsMod.existsSync(file) && !fsMod.existsSync(backup)) {
      try { fsMod.copyFileSync(file, backup); } catch {}
    }
    const tmp = file + ".kiro-apikey-ide.tmp";
    fsMod.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
    try {
      fsMod.renameSync(tmp, file);
    } catch {
      fsMod.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
      try { fsMod.unlinkSync(tmp); } catch {}
    }
    const readBack = readEndpointFromSettingsFile(key);
    const ok = endpointListsEqual(readBack, value);
    log((ok ? "endpoint disk verification OK" : "!! endpoint disk verification FAILED")
      + " for " + fullEndpointKey(key) + " file=" + file);
    return { ok, file };
  } catch (e) {
    log("!! settings.json fallback failed (" + file + "): " + (e?.message || e));
    return { ok: false, file };
  }
}
async function waitForEndpointReadback(cw, key, expected, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (endpointListsEqual(cw.get(key), expected)) return true;
    await sleep(100);
  } while (Date.now() < deadline);
  return endpointListsEqual(cw.get(key), expected);
}
function logEndpointScopes(cw, key) {
  const i = cw.inspect(key);
  if (!i) {
    log("endpoint config inspect: " + fullEndpointKey(key) + " is not registered/visible through Configuration API");
    return;
  }
  const scopes = ["globalValue", "workspaceValue", "workspaceFolderValue"]
    .filter((name) => i[name] !== undefined)
    .join(",") || "default-only";
  log("endpoint config inspect: " + fullEndpointKey(key) + " scopes=" + scopes);
}
function hasHigherScopeConflict(cw, key, expected) {
  const i = cw.inspect(key);
  if (!i) return false;
  const higher = i.workspaceFolderValue !== undefined ? i.workspaceFolderValue : i.workspaceValue;
  return higher !== undefined && !endpointListsEqual(higher, expected);
}
async function updateWithRetry(cw, key, value, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await cw.update(key, value, vscode.ConfigurationTarget.Global);
      return true;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (/not (?:a )?registered configuration|没有注册配置|未注册/i.test(msg)) break;
      await sleep(250 * (i + 1));
    }
  }
  throw lastErr;
}
async function overrideEndpoint(key, port, backupKey) {
  const cw = vscode.workspace.getConfiguration("codewhisperer.config");
  const expected = endpointOverride(port);
  const effective = cw.get(key) ?? [];
  const disk = readEndpointFromSettingsFile(key);
  if (!globalThis[backupKey]) {
    const current = effective.length ? effective : (disk ?? []);
    const isLocal = Array.isArray(current) && current.some((e) => /127\.0\.0\.1|localhost/.test(e?.endpoint ?? ""));
    globalThis[backupKey] = isLocal ? [] : current;
  }
  // Exact, region-complete comparison. The old `.some(localhost)` check
  // incorrectly skipped rewrites when only one of several regions matched.
  const effectiveMatches = endpointListsEqual(effective, expected);
  const diskMatches = endpointListsEqual(disk, expected);
  if (effectiveMatches || diskMatches) {
    if (!effectiveMatches && hasHigherScopeConflict(cw, key, expected)) {
      log("!! active-profile endpoint is correct on disk but blocked by workspace/folder settings: " + fullEndpointKey(key));
      return { changed: false, ok: false };
    }
    log("endpoint verification OK: " + fullEndpointKey(key)
      + " regions=" + redirectRegions().join(",")
      + " source=" + (effectiveMatches ? "effective-config" : "active-profile-disk")
      + (effectiveMatches ? "" : " file=" + userSettingsPath()));
    return { changed: false, ok: true };
  }
  logEndpointScopes(cw, key);
  try {
    await updateWithRetry(cw, key, expected);
    if (await waitForEndpointReadback(cw, key, expected)) {
      log("endpoint effective-config verification OK: " + fullEndpointKey(key) + " -> 127.0.0.1:" + port);
      return { changed: true, ok: true };
    }
    log("!! Configuration API returned success but readback mismatched for " + fullEndpointKey(key));
  } catch (e) {
    log("config API write unavailable for " + key + "; using active-profile settings.json: " + (e?.message || e));
  }
  const written = writeEndpointToSettingsFile(key, expected);
  if (written.ok) {
    const effectiveOk = await waitForEndpointReadback(cw, key, expected);
    if (!effectiveOk && hasHigherScopeConflict(cw, key, expected)) {
      log("!! endpoint override blocked by workspace/folder settings: " + fullEndpointKey(key));
      vscode.window.showErrorMessage(
        "KIRO-APIKEY-IDE: 工作区设置覆盖了 " + fullEndpointKey(key)
        + "，请删除工作区中的同名配置后重新加载窗口。"
      );
      return { changed: true, ok: false };
    }
    log("endpoint override verified via settings.json -> 127.0.0.1:" + port
      + (effectiveOk ? " (effective config updated)" : " (disk verified; reload required)"));
    return { changed: true, ok: true };
  }
  vscode.window.showErrorMessage(
    "KIRO-APIKEY-IDE: 无法写入或验证 " + fullEndpointKey(key)
    + "。请打开日志查看实际 settings.json 路径。"
  );
  return { changed: false, ok: false };
}
async function restoreEndpoint(key, backupKey) {
  const cw = vscode.workspace.getConfiguration("codewhisperer.config");
  let restore = globalThis[backupKey] ?? [];
  if (Array.isArray(restore) && restore.some((e) => /127\.0\.0\.1|localhost/.test(e?.endpoint ?? ""))) restore = [];
  const effective = cw.get(key);
  const disk = readEndpointFromSettingsFile(key);
  if (endpointListsEqual(effective, restore) && endpointListsEqual(disk ?? restore, restore)) return false;
  try {
    await updateWithRetry(cw, key, restore);
    if (await waitForEndpointReadback(cw, key, restore)) {
      log(key + " restored -> Kiro official (verified)");
      return true;
    }
  } catch (e) {
    log("config API restore unavailable for " + key + "; using settings.json: " + (e?.message || e));
  }
  const written = writeEndpointToSettingsFile(key, restore);
  if (written.ok) log(key + " restored via settings.json -> Kiro official (disk verified)");
  return written.ok;
}

// Bind only after both listeners pass their health checks, then persist and
// verify both endpoint overrides. This avoids the old fixed-400ms startup race.
async function syncEndpoints() {
  const { krs, cps } = getPorts();
  const [krsOk, cpsOk] = await Promise.all([
    krsServer ? krsServer.waitUntilReachable() : false,
    cpsServer ? cpsServer.waitUntilReachable() : false,
  ]);
  if (isEnabled() && getApiKey() && krsOk && cpsOk) {
    const a = await overrideEndpoint("krsEndpoints", krs, "__kiroKeyOrigKrs");
    const b = await overrideEndpoint("cpsEndpoints", cps, "__kiroKeyOrigCps");
    const ok = a.ok && b.ok;
    log(ok
      ? "gateway endpoint verification complete: KRS/CPS ready; reload Kiro if no proxy request appears"
      : "!! gateway endpoint verification incomplete: KRS/CPS override is partial");
    return { bound: ok, changed: a.changed || b.changed };
  }
  const a = await restoreEndpoint("krsEndpoints", "__kiroKeyOrigKrs");
  const b = await restoreEndpoint("cpsEndpoints", "__kiroKeyOrigCps");
  return { bound: false, changed: a || b };
}

// ---------------------------------------------------------------------------
// Registry self-heal: survive window reloads (Kiro tends to mark sideloaded
// extensions .obsolete / drop them from extensions.json). Only ever touches
// THIS extension's own entries.
// ---------------------------------------------------------------------------
function myExtId() {
  return extContext?.extension?.id || "local.kiro-apikey-ide";
}
function myExtDirName() {
  try { return path.basename(extContext.extensionPath); } catch { return ""; }
}
function extensionsRootDir() {
  try { return path.resolve(extContext.extensionPath, ".."); } catch { return ""; }
}
function readJsonSafe(file, fallback) {
  try {
    const raw = fsMod.readFileSync(file, "utf8").trim();
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function writeJsonSafe(file, data) {
  const text = JSON.stringify(data);
  try {
    if (fsMod.existsSync(file) && !fsMod.existsSync(file + ".kkbak")) fsMod.copyFileSync(file, file + ".kkbak");
  } catch {}
  const tmp = file + ".kktmp";
  fsMod.writeFileSync(tmp, text, "utf8");
  fsMod.renameSync(tmp, file);
}
function cleanObsoleteSelf() {
  const root = extensionsRootDir();
  if (!root) return false;
  const obsPath = path.join(root, ".obsolete");
  if (!fsMod.existsSync(obsPath)) return false;
  const obs = readJsonSafe(obsPath, null);
  if (!obs || typeof obs !== "object") return false;
  const dirName = myExtDirName();
  let changed = false;
  for (const k of Object.keys(obs)) {
    if (k === dirName || k.startsWith(myExtId())) { delete obs[k]; changed = true; }
  }
  if (changed) { writeJsonSafe(obsPath, obs); log("self-heal: removed self from .obsolete"); }
  return changed;
}
function ensureRegistered() {
  const root = extensionsRootDir();
  if (!root) return false;
  const file = path.join(root, "extensions.json");
  const list = readJsonSafe(file, null);
  if (!Array.isArray(list)) return false;
  const id = myExtId();
  if (list.some((e) => e?.identifier?.id === id)) return false;
  const version = extContext?.extension?.packageJSON?.version || "1.0.0";
  const dirName = myExtDirName();
  list.push({
    identifier: { id },
    version,
    location: { $mid: 1, path: extContext.extensionPath, scheme: "file" },
    relativeLocation: dirName,
    metadata: {
      isApplicationScoped: false, isMachineScoped: false, isBuiltin: false,
      installedTimestamp: Date.now(), pinned: false, source: "vsix",
      updated: false, private: false, isPreReleaseVersion: false,
      hasPreReleaseVersion: false, preRelease: false,
    },
  });
  writeJsonSafe(file, list);
  log("self-heal: registered self in extensions.json");
  return true;
}
function selfHeal() {
  try { cleanObsoleteSelf(); } catch (e) { log("cleanObsoleteSelf failed: " + (e?.message || e)); }
  try { ensureRegistered(); } catch (e) { log("ensureRegistered failed: " + (e?.message || e)); }
}
function registryHealth() {
  const root = extensionsRootDir();
  const out = { registered: false, obsolete: false };
  if (!root) return out;
  const list = readJsonSafe(path.join(root, "extensions.json"), null);
  if (Array.isArray(list)) out.registered = list.some((e) => e?.identifier?.id === myExtId());
  const obs = readJsonSafe(path.join(root, ".obsolete"), null);
  if (obs && typeof obs === "object") {
    const dirName = myExtDirName();
    out.obsolete = Object.keys(obs).some((k) => k === dirName || k.startsWith(myExtId()));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Direct API calls (used by the Test button and the panel's model/usage view)
// ---------------------------------------------------------------------------
function apiGet(base, urlPath, key) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(base + urlPath); } catch (e) { return reject(e); }
    const req = https.request(
      {
        method: "GET",
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + (key || getApiKey()),
          tokentype: "API_KEY",
          "x-amzn-kiro-agent-mode": "vibe",
          "user-agent": kiroUserAgent(),
        },
        timeout: 30000,
      },
      (res) => {
        const c = [];
        res.on("data", (d) => c.push(d));
        res.on("end", () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(c).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}
async function fetchModels(key) {
  const res = await apiGet(managementBase(), "/List-Available-Models?origin=AI_EDITOR&maxResults=200", key);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error("HTTP " + res.statusCode + ": " + res.body.slice(0, 200));
  const data = JSON.parse(res.body);
  return {
    defaultModel: data?.defaultModel?.modelId || "",
    models: (data.models || []).map((m) => ({ id: m.modelId, name: m.modelName, rate: m.rateMultiplier })),
  };
}
async function fetchUsage(key) {
  const res = await apiGet(managementBase(), "/Get-Usage-Limits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST", key);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error("HTTP " + res.statusCode + ": " + res.body.slice(0, 200));
  return JSON.parse(res.body);
}
async function testKey(key) {
  const k = (key || getApiKey() || "").trim();
  if (!k) throw new Error("请先填写 API Key");
  const m = await fetchModels(k);
  let subscription = "";
  let used = null, total = null;
  try {
    const info = await fetchAccountInfo(k);
    subscription = info?.subscriptionTitle || "";
    used = info?.used;
    total = info?.total;
  } catch {}
  return { modelCount: m.models.length, defaultModel: m.defaultModel, subscription, used, total, models: m.models };
}

// First numeric value among the given keys of an object (NaN-safe).
function pickNum(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && !Number.isNaN(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}
// Recursively collect any { currentUsage*, usageLimit* } pairs from the usage
// response. Field names have shifted across Kiro builds (…WithPrecision vs
// plain, top-level vs nested in breakdown lists), so we scan defensively rather
// than assume one shape.
function collectUsagePairs(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectUsagePairs(item, out);
    return;
  }
  const used = pickNum(node, ["currentUsageWithPrecision", "currentUsage", "usedCredits", "used"]);
  const limit = pickNum(node, ["usageLimitWithPrecision", "usageLimit", "totalCredits", "limit"]);
  if (used != null || limit != null) out.push({ used, limit });
  for (const k of Object.keys(node)) collectUsagePairs(node[k], out);
}
// Map a subscription title to a coarse tier for consistent tag coloring.
function tierFromTitle(title) {
  const t = String(title || "").toLowerCase();
  if (!t) return "";
  if (t.includes("power")) return "power";
  if (t.includes("pro+") || t.includes("pro plus") || t.includes("promax") || t.includes("pro max")) return "pro+";
  if (t.includes("pro")) return "pro";
  if (t.includes("free")) return "free";
  return "other";
}
// Fetch subscription tier + aggregate credit usage for a single key.
async function fetchAccountInfo(key) {
  const data = await fetchUsage(key);
  const title = data?.subscriptionInfo?.subscriptionTitle || data?.subscriptionInfo?.subscriptionType || "";
  const pairs = [];
  collectUsagePairs(data, pairs);
  let used = null, total = null;
  for (const p of pairs) {
    if (p.used != null) used = (used || 0) + p.used;
    if (p.limit != null) total = (total || 0) + p.limit;
  }
  log("account info: title=" + title + " used=" + used + " total=" + total);
  return { subscriptionTitle: title, tier: tierFromTitle(title), used, total };
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
function updateStatusBar() {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "kiroApikeyIde.openPanel";
  }
  const on = isEnabled() && !!getApiKey();
  statusBarItem.text = on ? "$(key) KIRO-APIKEY-IDE: 开启中" : "$(key) KIRO-APIKEY-IDE: 未开启";
  statusBarItem.tooltip = on
    ? "KIRO-APIKEY-IDE 已启用 · region=" + getRegion() + " · " + maskKey(getApiKey())
    : "KIRO-APIKEY-IDE 未启用（点击打开面板）";
  statusBarItem.show();
}

// ---------------------------------------------------------------------------
// Apply current state: (re)bind servers + sync endpoint override.
// Serialized so overlapping calls (toggle + config-change listener) don't write
// codewhisperer.config concurrently, which triggers write conflicts.
// ---------------------------------------------------------------------------
let _applyChain = Promise.resolve();
function applyState(opts = {}) {
  const run = () => _applyStateImpl(opts);
  _applyChain = _applyChain.then(run, run);
  return _applyChain;
}
async function _applyStateImpl(opts = {}) {
  const { krs, cps } = getPorts();
  if (isEnabled() && getApiKey()) {
    // A port change must recreate the listener. Previously the old server was
    // kept alive while settings were rewritten to the new (unbound) port.
    if (krsServer && krsServer.port !== krs) { krsServer.stop(); krsServer = null; }
    if (cpsServer && cpsServer.port !== cps) { cpsServer.stop(); cpsServer = null; }
    if (!krsServer) { resetProxyHitMarkers(); krsServer = new ProxyServer(krs, makeKrsHandler(), "KRS"); krsServer.start(); }
    if (!cpsServer) { cpsServer = new ProxyServer(cps, makeCpsHandler(), "CPS"); cpsServer.start(); }
  } else {
    // Disabled (or no key): tear the proxies down so the local ports are freed
    // instead of lingering and holding 19820/19821.
    if (krsServer) { krsServer.stop(); krsServer = null; log("[KRS] stopped (disabled)"); }
    if (cpsServer) { cpsServer.stop(); cpsServer = null; log("[CPS] stopped (disabled)"); }
  }
  const { bound, changed } = await syncEndpoints();
  updateStatusBar();
  if (changed && !opts.silent) {
    const pick = await vscode.window.showInformationMessage(
      "KIRO-APIKEY-IDE 已接管内置对话。需要重新加载窗口后 Kiro 才会走新端点。",
      "重新加载窗口"
    );
    if (pick === "重新加载窗口") await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
  return { bound, changed };
}

// ---------------------------------------------------------------------------
// Webview control panel
// ---------------------------------------------------------------------------
class ControlPanelProvider {
  constructor() { this.view = null; }
  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const distRoot = vscode.Uri.joinPath(extContext.extensionUri, "webview-ui", "dist");
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [distRoot] };
    webviewView.webview.html = this.getHtml(webviewView.webview, distRoot);
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try { await this.onMessage(msg); } catch (e) { this.post({ type: "error", message: e?.message || String(e) }); }
    });
    this.pushState();
  }
  post(m) { if (this.view) this.view.webview.postMessage(m); }
  pushState() {
    const rh = registryHealth();
    const keys = getApiKeys();
    const active = getActiveApiKey();
    this.post({
      type: "state",
      enabled: isEnabled(),
      keys: keys.map((k, i) => ({ index: i, masked: maskKeyLong(k), full: k })),
      keyCount: keys.length,
      activeIndex: active ? keys.indexOf(active) : -1,
      region: getRegion(),
      ports: getPorts(),
      registered: rh.registered,
      obsolete: rh.obsolete,
      hideApiKey: getHideApiKey(),
      autoRefresh: getAutoRefresh(),
      version: currentVersion(),
      repoUrl: REPO_URL,
    });
  }
  // Sync account info (subscription tier + credits) for the given key indices.
  // Results stream back per-key as they resolve; a final accountDone stamps the
  // sync time. Shared by the manual "fetchAccount" flow and post-add sync.
  //
  // opts.retries / opts.retryDelayMs: a freshly-created ksk_ key often isn't
  // queryable on the backend for the first second or two, so the immediate
  // post-add sync can fail even though the key is valid (a manual "立即同步"
  // a moment later succeeds). Retrying a few times papers over that window so
  // the new key doesn't render a stale "同步失败".
  async syncAccounts(targets, opts = {}) {
    const { retries = 0, retryDelayMs = 1500 } = opts;
    const keys = getApiKeys();
    const valid = targets.filter((idx) => idx >= 0 && idx < keys.length);
    if (!valid.length) return;
    // Query keys in small concurrent batches instead of all at once: syncing
    // dozens/hundreds of keys with a single Promise.all would fire that many
    // simultaneous backend requests. Running BATCH_SIZE at a time (and waiting
    // for each batch before starting the next) keeps it fast while capping the
    // burst. We also don't emit "accountLoading" — the UI keeps showing the
    // previous value and silently swaps in the fresh result when each resolves.
    const BATCH_SIZE = 5;
    const syncOne = async (idx) => {
      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const info = await fetchAccountInfo(keys[idx]);
          // Include the key string so the webview can cache by key identity
          // (stable across reorders) instead of a volatile array index.
          this.post({ type: "accountResult", index: idx, key: keys[idx], ok: true, info });
          return;
        } catch (e) {
          lastErr = e;
          if (attempt < retries) await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
      this.post({ type: "accountResult", index: idx, key: keys[idx], ok: false, message: lastErr?.message || String(lastErr) });
    };
    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      const batch = valid.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(syncOne));
    }
    this.post({ type: "accountDone", at: Date.now() });
  }
  async onMessage(msg) {
    switch (msg.type) {
      case "ready":
        this.pushState();
        break;
      case "addKey": {
        const v = String(msg.value || "").trim();
        if (!v) { this.post({ type: "error", message: "密钥不能为空" }); break; }
        if (!v.startsWith("ksk_")) { this.post({ type: "error", message: "密钥不正确：应以 ksk_ 开头" }); break; }
        const list = getApiKeys();
        if (list.includes(v)) { this.post({ type: "error", message: "该密钥已存在" }); break; }
        const newIndex = list.length; // appended at the end → new key's index
        await setApiKeys([...list, v]);
        await applyState();
        this.pushState();
        this.post({ type: "toast", message: "已添加密钥" });
        // With auto-refresh on, immediately sync the new key's account info so
        // it doesn't render a stale "同步失败" until the next tick / manual sync.
        // Retry a few times: a just-created key can take a second or two to
        // become queryable on the backend (which is why a manual sync moments
        // later succeeds), so a single immediate attempt often fails.
        if (getAutoRefresh()) await this.syncAccounts([newIndex], { retries: 3, retryDelayMs: 1500 });
        break;
      }
      case "addKeys": {
        // Batch add: validate + de-dupe and persist in ONE write. Adding keys
        // one-by-one races here because each webview message is handled
        // concurrently and reads the same pre-write list, so only the last
        // write would survive.
        const incoming = Array.isArray(msg.values) ? msg.values : [];
        const list = getApiKeys();
        const existing = new Set(list);
        const toAdd = [];
        let invalid = 0, dup = 0;
        for (const raw of incoming) {
          const v = String(raw || "").trim();
          if (!v) continue;
          if (!v.startsWith("ksk_")) { invalid++; continue; }
          if (existing.has(v)) { dup++; continue; }
          existing.add(v);
          toAdd.push(v);
        }
        if (toAdd.length === 0) {
          this.post({ type: "error", message: "没有可添加的密钥（无效或重复）" });
          break;
        }
        const startIndex = list.length;
        await setApiKeys([...list, ...toAdd]);
        await applyState();
        this.pushState();
        const skipped = invalid + dup;
        this.post({
          type: "toast",
          message: skipped > 0
            ? `已添加 ${toAdd.length} 个密钥，忽略 ${skipped} 个（无效或重复）`
            : `已添加 ${toAdd.length} 个密钥`,
        });
        if (getAutoRefresh()) {
          await this.syncAccounts(
            toAdd.map((_, k) => startIndex + k),
            { retries: 3, retryDelayMs: 1500 }
          );
        }
        break;
      }
      case "deleteKey": {
        const list = getApiKeys();
        const i = Number(msg.index);
        if (i >= 0 && i < list.length) {
          list.splice(i, 1);
          await setApiKeys(list);
          await applyState();
          this.pushState();
          this.post({ type: "toast", message: "已删除密钥" });
        }
        break;
      }
      case "deleteKeys": {
        // Batch delete by index in ONE write. If the currently in-use key is
        // among them and the gateway is on, also turn the gateway off and
        // require a reload (mirroring the single delete-of-active flow).
        const list = getApiKeys();
        const valid = (Array.isArray(msg.indices) ? msg.indices : [])
          .map((n) => Number(n))
          .filter((i) => Number.isInteger(i) && i >= 0 && i < list.length);
        if (valid.length === 0) {
          this.post({ type: "error", message: "删除失败: 没有选中的密钥" });
          break;
        }
        const remove = new Set(valid);
        const activeKey = getActiveApiKey();
        const removingActive = !!activeKey && remove.has(list.indexOf(activeKey));
        const remaining = list.filter((_, i) => !remove.has(i));
        await setApiKeys(remaining);
        if (removingActive && isEnabled()) {
          await set("enabled", false);
          await applyState({ silent: true });
          this.pushState();
          this.post({
            type: "needReload",
            text: `已删除 ${valid.length} 个密钥（含当前使用的密钥）并关闭网关。重新加载窗口后恢复 Kiro 默认服务。`,
          });
        } else {
          await applyState();
          this.pushState();
          this.post({ type: "toast", message: `已删除 ${valid.length} 个密钥` });
        }
        break;
      }
      case "deleteKeyDisableGateway": {
        // Delete the key that's currently in use AND turn the gateway off in one
        // atomic host-side step, then require a reload. The webview shows its own
        // a-modal spinner + reload prompt, so applyState runs silent to avoid a
        // duplicate native VS Code dialog.
        const list = getApiKeys();
        const i = Number(msg.index);
        if (i >= 0 && i < list.length) {
          list.splice(i, 1);
          await setApiKeys(list);
          await set("enabled", false);
          await applyState({ silent: true });
          this.pushState();
          this.post({
            type: "needReload",
            text: "已删除当前使用的密钥并关闭网关。重新加载窗口后恢复 Kiro 默认服务。",
          });
        } else {
          this.post({ type: "error", message: "删除失败: 未找到该密钥" });
        }
        break;
      }
      case "selectKey": {
        const list = getApiKeys();
        const i = Number(msg.index);
        if (i >= 0 && i < list.length) {
          await set("activeApiKey", list[i]);
          // silent: the webview shows its own a-modal reload prompt below.
          await applyState({ silent: true });
          this.pushState();
          this.post({
            type: "needReload",
            text: "已切换密钥。重新加载窗口后生效。",
          });
        }
        break;
      }
      case "copyKey": {
        const list = getApiKeys();
        const i = Number(msg.index);
        if (i >= 0 && i < list.length) {
          try {
            await vscode.env.clipboard.writeText(list[i]);
            this.post({ type: "toast", message: "已复制完整密钥到剪贴板" });
          } catch (e) {
            this.post({ type: "error", message: "复制失败: " + (e?.message || e) });
          }
        } else {
          this.post({ type: "error", message: "复制失败: 未找到该密钥" });
        }
        break;
      }
      case "exportKeys": {
        // Export selected keys (by index) to a .txt file the user picks via a
        // native save dialog, one key per line.
        const list = getApiKeys();
        const picked = (Array.isArray(msg.indices) ? msg.indices : [])
          .map((n) => Number(n))
          .filter((i) => Number.isInteger(i) && i >= 0 && i < list.length)
          .map((i) => list[i]);
        if (picked.length === 0) {
          this.post({ type: "error", message: "导出失败: 没有可导出的密钥" });
          break;
        }
        try {
          const d = new Date();
          const p = (n) => String(n).padStart(2, "0");
          const name = `kiro-api-keys-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;
          const baseDir =
            (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]?.uri.fsPath) ||
            require("os").homedir();
          const uri = await vscode.window.showSaveDialog({
            title: "导出 API Key",
            saveLabel: "导出",
            defaultUri: vscode.Uri.file(path.join(baseDir, name)),
            filters: { "文本文件": ["txt"], "所有文件": ["*"] },
          });
          if (!uri) break; // user cancelled
          fsMod.writeFileSync(uri.fsPath, picked.join("\n") + "\n", "utf8");
          this.post({ type: "toast", message: `已导出 ${picked.length} 个密钥` });
        } catch (e) {
          this.post({ type: "error", message: "导出失败: " + (e?.message || e) });
        }
        break;
      }
      case "saveRegion":
        await set("region", String(msg.value || "us-east-1").trim() || "us-east-1");
        await applyState();
        this.pushState();
        this.post({ type: "toast", message: "Region 已保存: " + getRegion() });
        break;
      case "toggle":
        await set("enabled", !!msg.value);
        // silent: the webview shows its own a-modal reload prompt below,
        // so we suppress the native VS Code dialog to avoid a double prompt.
        await applyState({ silent: true });
        this.pushState();
        this.post({
          type: "needReload",
          text: msg.value
            ? "网关已开启。重新加载窗口后，Kiro 自带对话即走你的 API Key。"
            : "网关已关闭。重新加载窗口后恢复默认。",
        });
        break;
      case "test": {
        const i = Number(msg.index);
        const keys = getApiKeys();
        const key = i >= 0 && i < keys.length ? keys[i] : getApiKey();
        this.post({ type: "testing", index: i });
        try {
          const r = await testKey(key);
          this.post({ type: "testResult", index: i, ok: true, result: r });
        } catch (e) {
          this.post({ type: "testResult", index: i, ok: false, message: e?.message || String(e) });
        }
        break;
      }
      case "setHideApiKey":
        await setHideApiKeyPref(msg.value);
        this.pushState();
        break;
      case "setAutoRefresh":
        await setAutoRefreshPref(msg.value);
        this.pushState();
        break;
      case "fetchAccount": {
        // Sync account info. The webview may send an explicit ordered `indices`
        // array (top-of-list first); otherwise a single index, or all keys.
        const keys = getApiKeys();
        let targets;
        if (Array.isArray(msg.indices)) {
          targets = msg.indices.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < keys.length);
        } else {
          const i = Number(msg.index);
          targets = i >= 0 && i < keys.length ? [i] : keys.map((_, idx) => idx);
        }
        await this.syncAccounts(targets);
        break;
      }
      case "reload":
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        break;
      case "openExternal": {
        try { await vscode.env.openExternal(vscode.Uri.parse(String(msg.url || REPO_URL))); }
        catch (e) { this.post({ type: "error", message: "打开链接失败: " + (e?.message || e) }); }
        break;
      }
      case "getLogs": {
        // Serve the in-memory ring buffer (last hour) so the panel's log drawer
        // shows recent activity without opening the output channel.
        this.post({ type: "logs", entries: getRecentLogs(), at: Date.now() });
        break;
      }
      case "copyLogs": {
        try {
          await vscode.env.clipboard.writeText(getRecentLogs().join("\n"));
          this.post({ type: "toast", message: "已复制日志到剪贴板" });
        } catch (e) {
          this.post({ type: "error", message: "复制失败: " + (e?.message || e) });
        }
        break;
      }
    }
  }
  getHtml(webview, distRoot) {
    const indexPath = vscode.Uri.joinPath(distRoot, "index.html").fsPath;
    let html;
    try {
      html = fsMod.readFileSync(indexPath, "utf8");
    } catch {
      return '<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground)">'
        + '<h3>KIRO-APIKEY-IDE</h3><p>Webview 尚未构建。请在 <code>webview-ui</code> 目录执行:</p>'
        + '<pre>npm install &amp;&amp; npm run build</pre></body></html>';
    }
    // Drop crossorigin (blocked in webviews) and rewrite ./assets/* to webview URIs.
    html = html.replace(/\s*crossorigin/g, "");
    html = html.replace(/(src|href)="\.?\/?(assets\/[^"]+)"/g, (_m, attr, rel) => {
      const uri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, rel));
      return attr + '="' + uri.toString() + '"';
    });
    const csp =
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
      + "img-src " + webview.cspSource + " https: data:; "
      + "style-src " + webview.cspSource + " 'unsafe-inline'; "
      + "font-src " + webview.cspSource + " data:; "
      + "script-src " + webview.cspSource + " 'unsafe-inline' 'unsafe-eval';\">";
    html = html.replace(/<head>/i, "<head>\n    " + csp);
    return html;
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
async function activate(context) {
  extContext = context;
  log("activate");
  logKiroHostInfo();
  selfHeal();
  try { await migrateLegacyKey(); } catch (e) { log("migrateLegacyKey failed: " + (e?.message || e)); }

  panelProvider = new ControlPanelProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("kiroApikeyIde.controlPanel", panelProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kiroApikeyIde.openPanel", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.kiroApikeyIde");
    }),
    vscode.commands.registerCommand("kiroApikeyIde.toggle", async () => {
      await set("enabled", !isEnabled());
      await applyState();
      panelProvider && panelProvider.pushState();
    }),
    vscode.commands.registerCommand("kiroApikeyIde.test", async () => {
      try {
        const r = await testKey();
        vscode.window.showInformationMessage("Kiro Key 有效 · " + (r.subscription || "") + " · " + r.modelCount + " 个模型");
      } catch (e) {
        vscode.window.showErrorMessage("Kiro Key 测试失败: " + (e?.message || e));
      }
    })
  );

  // React to relevant config changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("kiroApikeyIde.enabled") || e.affectsConfiguration("kiroApikeyIde.apiKeys") || e.affectsConfiguration("kiroApikeyIde.activeApiKey") || e.affectsConfiguration("kiroApikeyIde.region") || e.affectsConfiguration("kiroApikeyIde.ports")) {
        await applyState({ silent: true });
        panelProvider && panelProvider.pushState();
      }
    })
  );

  await applyState({ silent: true });
  updateStatusBar();
}

function deactivate() {
  // NOTE: intentionally do NOT restore the endpoint override here.
  // deactivate() runs on every window reload; kiro-agent reads the endpoints
  // once at init. Wiping them on reload would drop the redirect before the
  // reloaded host re-applies it. Turn the gateway switch off to undo.
  if (krsServer) krsServer.stop();
  if (cpsServer) cpsServer.stop();
}

module.exports = { activate, deactivate };
