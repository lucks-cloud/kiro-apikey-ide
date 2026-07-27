import { defineStore } from "pinia";
import { post, onMessage } from "../vscode";

// Remap an index-keyed map (accounts / keyTests) onto a new keys array by the
// actual key string, so deletions/reorders don't leave stale or misaligned
// entries. Entries whose key no longer exists are dropped.
function remapByFull(map, oldKeys, newKeys) {
  if (!map || !Object.keys(map).length) return {};
  const byFull = {};
  for (const k of oldKeys || []) {
    if (k && map[k.index] != null) byFull[k.full] = map[k.index];
  }
  const out = {};
  for (const k of newKeys || []) {
    if (k && byFull[k.full] != null) out[k.index] = byFull[k.full];
  }
  return out;
}

export const useGatewayStore = defineStore("gateway", {
  state: () => ({
    enabled: false,
    keys: [], // [{ index, masked }]
    keyCount: 0,
    activeIndex: -1,
    region: "us-east-1",
    ports: { krs: 19820, cps: 19821 },
    registered: false,
    obsolete: false,
    version: "",
    repoUrl: "https://github.com/lucks-cloud/kiro-apikey-ide",
    // Settings (mirrored from host config)
    hideApiKey: true, // mask keys in the list
    autoRefresh: true, // auto-sync account info
    // UI-only
    keyTests: {}, // index -> { loading, ok, result?, message? }
    // Account info cached BY KEY STRING (stable across reorders / reloads), so
    // switching sidebars doesn't drop it. The index-keyed `accounts` getter is
    // derived from this for the template.
    accountsByFull: {}, // fullKey -> { ok, info?, message? }
    accountLoadingByFull: {}, // fullKey -> true while a per-key sync is in flight
    lastSyncAt: 0, // epoch ms of the last account sync
    syncing: false, // an account sync is in flight (drives the sync button)
    logs: [], // recent host log lines (last hour), for the log drawer
    logsAt: 0, // epoch ms the logs were last fetched
    logsLoading: false,
    toast: null, // { text, type }
    reloadModal: { open: false, text: "" }, // reload-required prompt
    busyModal: { open: false, title: "" }, // loading prompt for async toggle
  }),
  getters: {
    active: (s) => s.enabled && s.keyCount > 0,
    // Index-keyed view derived from accountsByFull, for the template's
    // accountOf(index) lookups.
    accounts: (s) => {
      const out = {};
      for (const k of s.keys) {
        const e = s.accountsByFull[k.full];
        if (e) out[k.index] = e;
      }
      return out;
    },
    // Index-keyed view of which keys are currently syncing account info,
    // derived from accountLoadingByFull (keyed by key string).
    accountLoading: (s) => {
      const out = {};
      for (const k of s.keys) {
        if (s.accountLoadingByFull[k.full]) out[k.index] = true;
      }
      return out;
    },
    // Aggregate used/total credits across every current key with known info.
    creditTotals: (s) => {
      let used = 0, total = 0, has = false;
      for (const k of s.keys) {
        const a = s.accountsByFull[k.full];
        if (!a || !a.ok || !a.info) continue;
        if (typeof a.info.used === "number") { used += a.info.used; has = true; }
        if (typeof a.info.total === "number") { total += a.info.total; has = true; }
      }
      return { used, total, has };
    },
  },
  actions: {
    bind() {
      onMessage((m) => this.onHostMessage(m));
      post({ type: "ready" });
    },
    onHostMessage(m) {
      switch (m.type) {
        case "state": {
          // accounts / keyTests are keyed by array index. When keys are
          // deleted (or reordered) the indices shift, so remap those maps by
          // the actual key string and drop entries for keys that no longer
          // exist — otherwise stale credits from deleted keys keep counting in
          // the aggregate totals.
          const newKeys = m.keys || [];
          this.keyTests = remapByFull(this.keyTests, this.keys, newKeys);
          // accountsByFull is keyed by the API key string, so reorders need no
          // remap — just drop entries for keys that no longer exist so deleted
          // keys stop counting toward the aggregate totals.
          {
            const present = new Set(newKeys.map((k) => k.full));
            const pruned = {};
            for (const f of Object.keys(this.accountsByFull)) {
              if (present.has(f)) pruned[f] = this.accountsByFull[f];
            }
            this.accountsByFull = pruned;
          }
          this.enabled = m.enabled;
          this.keys = newKeys;
          this.keyCount = m.keyCount || 0;
          this.activeIndex = typeof m.activeIndex === "number" ? m.activeIndex : -1;
          this.region = m.region;
          this.ports = m.ports;
          this.registered = m.registered;
          this.obsolete = m.obsolete;
          if (typeof m.hideApiKey === "boolean") this.hideApiKey = m.hideApiKey;
          if (typeof m.autoRefresh === "boolean") this.autoRefresh = m.autoRefresh;
          if (m.version) this.version = m.version;
          if (m.repoUrl) this.repoUrl = m.repoUrl;
          break;
        }
        case "accountResult": {
          const full = m.key || (this.keys[m.index] && this.keys[m.index].full);
          if (!full) break;
          // This key finished syncing — clear its loading flag.
          if (this.accountLoadingByFull[full]) {
            const rest = { ...this.accountLoadingByFull };
            delete rest[full];
            this.accountLoadingByFull = rest;
          }
          if (m.ok) {
            // New data arrived — replace directly.
            this.accountsByFull = { ...this.accountsByFull, [full]: { ok: true, info: m.info } };
          } else {
            // A transient failure must not wipe a previously-good value; only
            // record failure when we have nothing good cached for this key.
            const prev = this.accountsByFull[full];
            if (!prev || !prev.ok) {
              this.accountsByFull = { ...this.accountsByFull, [full]: { ok: false, message: m.message } };
            }
          }
          break;
        }
        case "accountDone":
          this.lastSyncAt = m.at || Date.now();
          this.syncing = false;
          // Safety: clear any lingering per-key loading flags.
          this.accountLoadingByFull = {};
          break;
        case "logs":
          this.logs = Array.isArray(m.entries) ? m.entries : [];
          this.logsAt = m.at || Date.now();
          this.logsLoading = false;
          break;
        case "testing":
          this.keyTests = { ...this.keyTests, [m.index]: { loading: true } };
          break;
        case "testResult":
          this.keyTests = {
            ...this.keyTests,
            [m.index]: m.ok
              ? { loading: false, ok: true, result: m.result }
              : { loading: false, ok: false, message: m.message },
          };
          break;
        case "toast":
          this.toast = { text: m.message, type: "success" };
          break;
        case "error":
          this.toast = { text: m.message, type: "error" };
          // async op failed: close the loading modal so the UI isn't stuck.
          this.busyModal = { open: false, title: "" };
          this.syncing = false;
          this.accountLoadingByFull = {};
          break;
        case "needReload":
          // async toggle finished: drop the loading modal, then show
          // the result (reload-required prompt).
          this.busyModal = { open: false, title: "" };
          this.reloadModal = {
            open: true,
            text: m.text || "改动需要重新加载窗口后生效。",
          };
          break;
      }
    },
    addKey(v) { post({ type: "addKey", value: v }); },
    addKeys(values) { post({ type: "addKeys", values }); },
    deleteKey(i) { post({ type: "deleteKey", index: i }); },
    deleteKeys(indices) { post({ type: "deleteKeys", indices }); },
    // Delete the in-use key while the gateway is on: show a spinner, delete +
    // disable the gateway on the host, then prompt for a reload (needReload
    // closes the busy modal and opens the reload modal).
    deleteActiveKeyAndDisable(i) {
      this.busyModal = { open: true, title: "正在删除密钥并关闭网关…" };
      post({ type: "deleteKeyDisableGateway", index: i });
    },
    selectKey(i) {
      if (i === this.activeIndex) return;
      this.busyModal = { open: true, title: "正在切换密钥…" };
      post({ type: "selectKey", index: i });
    },
    copyKey(i) { post({ type: "copyKey", index: i }); },
    exportKeys(indices) { post({ type: "exportKeys", indices }); },
    testKey(i) {
      this.keyTests = { ...this.keyTests, [i]: { loading: true } };
      post({ type: "test", index: i });
    },
    saveRegion(v) { post({ type: "saveRegion", value: v }); },
    setHideApiKey(v) {
      this.hideApiKey = v;
      post({ type: "setHideApiKey", value: v });
    },
    setAutoRefresh(v) {
      this.autoRefresh = v;
      post({ type: "setAutoRefresh", value: v });
      // The App.vue watcher drives the (order-aware, staleness-checked) refresh
      // when this flips on, so we intentionally don't fetch here.
    },
    // Flag the given key indices (or all keys when omitted) as loading so the
    // UI can show a per-key spinner. Keyed by key string for reorder-safety.
    markAccountsLoading(indices) {
      const targetSet = Array.isArray(indices) ? new Set(indices) : null;
      const next = { ...this.accountLoadingByFull };
      for (const k of this.keys) {
        if (!targetSet || targetSet.has(k.index)) next[k.full] = true;
      }
      this.accountLoadingByFull = next;
    },
    // Sync account info. Pass an ordered index array (top-of-list first), a
    // single index, or nothing (all keys, host order).
    fetchAccounts(target) {
      if (Array.isArray(target)) {
        if (target.length === 0) return; // nothing to sync; don't enter loading
        this.syncing = true;
        this.markAccountsLoading(target);
        post({ type: "fetchAccount", indices: target });
      } else if (typeof target === "number") {
        this.syncing = true;
        this.markAccountsLoading([target]);
        post({ type: "fetchAccount", index: target });
      } else {
        this.syncing = true;
        this.markAccountsLoading(null);
        post({ type: "fetchAccount", index: -1 });
      }
    },
    // Refresh a single key's account info (from the right-click menu). Shows
    // the same per-key loading spinner without driving the global sync button.
    refreshAccount(index) {
      this.markAccountsLoading([index]);
      post({ type: "fetchAccount", index });
    },
    // Pull the host's recent log buffer (last hour) for the log drawer.
    fetchLogs() {
      this.logsLoading = true;
      post({ type: "getLogs" });
    },
    copyLogs() { post({ type: "copyLogs" }); },
    toggle(v) {
      this.busyModal = { open: true, title: v ? "正在开启网关…" : "正在关闭网关…" };
      post({ type: "toggle", value: v });
    },
    reload() { post({ type: "reload" }); },
    openExternal(url) { post({ type: "openExternal", url: url || this.repoUrl }); },
    confirmReload() {
      this.reloadModal = { open: false, text: "" };
      post({ type: "reload" });
    },
    dismissReload() {
      this.reloadModal = { open: false, text: "" };
    },
  },
});
