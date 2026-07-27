import { createApp } from "vue";
import { createPinia } from "pinia";
// ant-design-vue components are auto-imported on demand (see vite.config.js).
// Only the base reset stylesheet is imported globally; component styles are
// injected at runtime via cssinjs.
import "ant-design-vue/dist/reset.css";
import App from "./App.vue";
import "./style.css";
import { getState, setState } from "./vscode";

// Persist selected pinia state into the VS Code webview state so settings and
// synced account info survive a window reload / the view being hidden, instead
// of snapping back to defaults. Only UI-owned fields are cached; the host still
// pushes authoritative gateway state (keys, enabled, region…) on "ready".
const PERSIST = {
  gateway: ["hideApiKey", "autoRefresh", "accountsByFull", "lastSyncAt", "keyTests"],
};

const pinia = createPinia();
pinia.use(({ store }) => {
  const fields = PERSIST[store.$id];
  if (!fields) return;
  const saved = getState();
  const cached = saved && saved.stores && saved.stores[store.$id];
  if (cached) {
    const patch = {};
    for (const k of fields) if (k in cached) patch[k] = cached[k];
    store.$patch(patch);
  }
  store.$subscribe((_mutation, state) => {
    const all = getState() || {};
    if (!all.stores) all.stores = {};
    const slice = {};
    for (const k of fields) slice[k] = state[k];
    all.stores[store.$id] = slice;
    setState(all);
  });
});

const app = createApp(App);
app.use(pinia);
app.mount("#app");
