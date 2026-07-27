// Single bridge to the VS Code / Kiro extension host.
// acquireVsCodeApi() may only be called once per webview.
const api = typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

export function post(msg) {
  if (api) api.postMessage(msg);
  else console.log("[dev] post", msg);
}

export function onMessage(handler) {
  window.addEventListener("message", (e) => handler(e.data));
}

// Persisted webview state. VS Code keeps this across reloads and while the view
// is hidden, so we use it to cache the pinia store. Falls back to sessionStorage
// during local `vite dev` where acquireVsCodeApi() is unavailable.
export function getState() {
  if (api) return api.getState() || null;
  try {
    const raw = sessionStorage.getItem("kk-state");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
export function setState(state) {
  if (api) {
    api.setState(state);
    return;
  }
  try {
    sessionStorage.setItem("kk-state", JSON.stringify(state));
  } catch {}
}
