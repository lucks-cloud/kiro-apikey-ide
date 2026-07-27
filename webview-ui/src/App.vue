<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { message, theme as antdTheme } from "ant-design-vue";
import {
  PlusOutlined,
  ReloadOutlined,
  UnorderedListOutlined,
  ExportOutlined,
  DeleteOutlined,
  GithubOutlined,
  QqOutlined,
  SettingOutlined,
  SyncOutlined,
  SearchOutlined,
  LoadingOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  CopyOutlined,
} from "@ant-design/icons-vue";

// Fixed build date, stamped at packaging time.
const BUILD_DATE = "2026-07-23";
import { useGatewayStore } from "./stores/gateway";
import logoUrl from "./assets/img/logo.png";

const store = useGatewayStore();

// --- Theme bridge -------------------------------------------------------
// The webview lives inside VS Code / Kiro, which tags <body> with one of
// `vscode-light`, `vscode-dark`, `vscode-high-contrast` (dark) or
// `vscode-high-contrast-light`. Mirror that onto ant-design-vue so its
// components (dropdowns, modals, inputs…) render with the matching palette.
function computeIsDark() {
  const b = document.body.classList;
  if (b.contains("vscode-light") || b.contains("vscode-high-contrast-light")) {
    return false;
  }
  // vscode-dark, vscode-high-contrast, or unknown → treat as dark.
  return true;
}

const isDark = ref(computeIsDark());
let themeObserver = null;

const themeConfig = computed(() => ({
  algorithm: isDark.value
    ? antdTheme.darkAlgorithm
    : antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: "#1677ff",
    // Let cards/popovers pick up the editor surface via CSS, but keep antd's
    // text/border tokens in sync with the active algorithm.
    borderRadius: 8,
  },
}));

const KNOWN_REGIONS = [
  { value: "us-east-1", label: "us-east-1" },
];
const REGION_VALUES = KNOWN_REGIONS.map((r) => r.value);

const regionSelect = ref("us-east-1");
const customRegion = ref("");
const isCustomRegion = computed(() => regionSelect.value === "__custom");

// Add-key inline form
const showAdd = ref(false);
const newKey = ref("");

// Search / filter keys
const showSearch = ref(false);
const searchText = ref("");
const filteredKeys = computed(() => {
  const q = searchText.value.trim().toLowerCase();
  const list = !q
    ? store.keys.slice()
    : store.keys.filter(
        (k) =>
          String(k.full || "").toLowerCase().includes(q) ||
          String(k.masked || "").toLowerCase().includes(q)
      );
  // In-use key pinned to the top; the rest newest-first (newly added keys are
  // appended with the highest index, so descending index = newest first).
  return list.sort((a, b) => {
    if (a.index === store.activeIndex) return -1;
    if (b.index === store.activeIndex) return 1;
    return b.index - a.index;
  });
});
function toggleSearch() {
  showSearch.value = !showSearch.value;
  if (!showSearch.value) searchText.value = "";
}
function closeSearch() {
  showSearch.value = false;
  searchText.value = "";
}

// Batch import
const batchModalOpen = ref(false);
const batchText = ref("");

// Selection mode: "" (off) | "export" | "delete". Both share the same
// checkbox selection UI; only the confirm action differs.
const selectMode = ref("");
const selecting = computed(() => selectMode.value !== "");
const selectedKeys = ref(new Set()); // set of key indices selected
const selectedCount = computed(() => selectedKeys.value.size);
function isSelected(i) {
  return selectedKeys.value.has(i);
}
// In delete mode the in-use key (active + gateway on) is locked: it can't be
// selected or removed, so deleting never tears down the running gateway.
function deleteLocked(index) {
  return selectMode.value === "delete" && store.enabled && index === store.activeIndex;
}
// Indices eligible for the current selection mode (delete skips the locked key).
function selectableIndices() {
  return store.keys.filter((k) => !deleteLocked(k.index)).map((k) => k.index);
}
function toggleSelect(i) {
  if (deleteLocked(i)) return;
  const s = new Set(selectedKeys.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  selectedKeys.value = s;
}
function selectAll() {
  selectedKeys.value = new Set(selectableIndices());
}
function invertSelect() {
  const s = new Set();
  for (const i of selectableIndices()) if (!selectedKeys.value.has(i)) s.add(i);
  selectedKeys.value = s;
}
function enterExport() {
  // Close any inline forms and default to selecting every key.
  showAdd.value = false;
  closeSearch();
  selectedKeys.value = new Set(store.keys.map((k) => k.index));
  selectMode.value = "export";
}
function enterDelete() {
  // Default to selecting every removable key (the in-use key stays locked).
  showAdd.value = false;
  closeSearch();
  selectMode.value = "delete";
  selectedKeys.value = new Set(selectableIndices());
}
function cancelSelect() {
  selectMode.value = "";
  selectedKeys.value = new Set();
}
function confirmExport() {
  const indices = store.keys.map((k) => k.index).filter((i) => selectedKeys.value.has(i));
  if (indices.length === 0) {
    message.warning("请至少选择一个 API Key");
    return;
  }
  store.exportKeys(indices);
  cancelSelect();
}
// Batch delete: confirm via modal before wiping the selected keys.
const batchDeleteOpen = ref(false);
function askDeleteSelected() {
  if (selectedCount.value === 0) {
    message.warning("请至少选择一个 API Key");
    return;
  }
  batchDeleteOpen.value = true;
}
function confirmDeleteSelected() {
  const indices = store.keys.map((k) => k.index).filter((i) => selectedKeys.value.has(i));
  batchDeleteOpen.value = false;
  if (indices.length === 0) return;
  store.deleteKeys(indices);
  cancelSelect();
}
function onAddMenu({ key }) {
  if (key === "batch") openBatch();
  else if (key === "export") enterExport();
  else if (key === "delete") enterDelete();
}

// QQ group modal
const qqModalOpen = ref(false);

// Settings drawer (bottom, 80% height)
const settingsOpen = ref(false);

// Log drawer (bottom, 80% height) — quick view of recent host logs so users
// don't have to open the "KIRO-APIKEY-IDE" output channel.
const logDrawerOpen = ref(false);
function openLogs() {
  logDrawerOpen.value = true;
  store.fetchLogs();
}
const logText = computed(() => (store.logs || []).join("\n"));
function fmtLogTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// --- Account auto-refresh -----------------------------------------------
// When enabled, periodically sync each key's subscription tier + credit usage.
const AUTO_REFRESH_MS = 60000;
let autoInterval = null;
let autoTimeout = null;

// Visual list order (active key first, then newest first) so account requests
// start from the top of the list the user sees, not the oldest key.
function visualOrderIndices() {
  return store.keys
    .slice()
    .sort((a, b) => {
      if (a.index === store.activeIndex) return -1;
      if (b.index === store.activeIndex) return 1;
      return b.index - a.index;
    })
    .map((k) => k.index);
}
function syncAccountsNow() {
  store.fetchAccounts(visualOrderIndices());
}
// Only refresh when the cached data is at least a minute old. Switching back to
// this view (which recreates the webview) therefore reuses the cache instead of
// re-requesting every time.
function startAutoRefresh() {
  stopAutoRefresh();
  const age = Date.now() - (store.lastSyncAt || 0);
  const due = Math.max(0, AUTO_REFRESH_MS - age);
  const beginInterval = () => {
    syncAccountsNow();
    autoInterval = setInterval(syncAccountsNow, AUTO_REFRESH_MS);
  };
  if (due === 0) {
    beginInterval();
  } else {
    // Wait out the remaining time before the first refresh, then go periodic.
    autoTimeout = setTimeout(beginInterval, due);
  }
}
function stopAutoRefresh() {
  if (autoInterval) { clearInterval(autoInterval); autoInterval = null; }
  if (autoTimeout) { clearTimeout(autoTimeout); autoTimeout = null; }
}
function onHideKeyChange(checked) {
  store.setHideApiKey(checked);
}
function onAutoRefreshChange(checked) {
  store.setAutoRefresh(checked);
}

// Format epoch ms as hh:mm:ss (empty when never synced).
function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Round credits to a whole number for display.
function fmtNum(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "-";
  return String(Math.round(n));
}

// Subscription tag text without the leading "Kiro" brand word (e.g.
// "Kiro Pro" -> "Pro", "KIRO Power" -> "Power").
function tierLabel(title) {
  return String(title || "").replace(/^\s*kiro\s*/i, "").trim() || String(title || "");
}

// Per-key account entry (loading / info / error), keyed by index.
function accountOf(index) {
  return store.accounts[index];
}
// Whether this key's account info is currently being synced.
function isAccountLoading(index) {
  return !!store.accountLoading[index];
}
// Right-click menu on a key row.
function onKeyMenu(key, index) {
  if (key === "copy") store.copyKey(index);
  else if (key === "sync") store.refreshAccount(index);
}
// Tag color for a subscription tier.
function tierColor(tier) {
  switch (tier) {
    case "power": return "purple";
    case "pro+": return "geekblue";
    case "pro": return "blue";
    case "free": return "default";
    default: return "cyan";
  }
}

const creditTotals = computed(() => store.creditTotals);
const syncedLabel = computed(() => fmtTime(store.lastSyncAt));

// React to the auto-refresh toggle coming from either the UI or host state.
watch(
  () => store.autoRefresh,
  (on) => {
    if (on) startAutoRefresh();
    else stopAutoRefresh();
  }
);

// The host pushes keys asynchronously after mount. Once they first arrive (and
// auto-refresh is on) start the refresh loop, which itself only fetches when
// the cache is older than a minute.
watch(
  () => store.keyCount,
  (n, old) => {
    if (n > 0 && (old || 0) === 0 && store.autoRefresh && !autoInterval && !autoTimeout) {
      startAutoRefresh();
    }
  }
);

// Test connectivity modal
const testModalOpen = ref(false);
const testIndex = ref(-1);
const testMasked = ref("");
const currentTest = computed(() => store.keyTests[testIndex.value]);
function openTest(item) {
  testIndex.value = item.index;
  testMasked.value = item.masked;
  testModalOpen.value = true;
  store.testKey(item.index);
}

watch(
  () => store.region,
  (r) => {
    if (REGION_VALUES.includes(r)) {
      regionSelect.value = r;
    } else {
      regionSelect.value = "__custom";
      customRegion.value = r;
    }
  },
  { immediate: true }
);

watch(
  () => store.toast,
  (t) => {
    if (!t) return;
    if (t.type === "error") message.error(t.text);
    else message.success(t.text);
    store.toast = null;
  }
);

function onToggle(checked) {
  store.toggle(checked);
}

// Deleting the in-use key while the gateway is on needs an explicit warning:
// it also turns the gateway off and requires a window reload.
const dangerDeleteOpen = ref(false);
const dangerDeleteIndex = ref(-1);
function openDangerDelete(index) {
  dangerDeleteIndex.value = index;
  dangerDeleteOpen.value = true;
}
function cancelDangerDelete() {
  dangerDeleteOpen.value = false;
  dangerDeleteIndex.value = -1;
}
function confirmDangerDelete() {
  const i = dangerDeleteIndex.value;
  dangerDeleteOpen.value = false;
  dangerDeleteIndex.value = -1;
  if (i >= 0) store.deleteActiveKeyAndDisable(i);
}
function confirmAdd() {
  const v = newKey.value.trim();
  if (!v) {
    message.warning("请输入 API Key");
    return;
  }
  if (!v.startsWith("ksk_")) {
    message.error("密钥不正确：Kiro API Key 应以 ksk_ 开头");
    return;
  }
  store.addKey(v);
  newKey.value = "";
  showAdd.value = false;
}
function cancelAdd() {
  newKey.value = "";
  showAdd.value = false;
}
function openBatch() {
  batchText.value = "";
  batchModalOpen.value = true;
}
function confirmBatch() {
  const lines = batchText.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    message.warning("请输入至少一个 API Key");
    return;
  }
  // Send all lines in one message: the host validates, de-dupes, persists in a
  // single write and reports the result. Adding one-by-one raced and dropped
  // all but one key.
  store.addKeys(lines);
  batchText.value = "";
  batchModalOpen.value = false;
}
function onRegionChange(val) {
  if (val === "__custom") return;
  store.saveRegion(val);
}
function saveCustomRegion() {
  const v = customRegion.value.trim();
  if (v) store.saveRegion(v);
}

onMounted(() => {
  store.bind();
  // If keys are already hydrated and auto-refresh is on, start now; otherwise
  // the keyCount watcher above starts it once the host pushes the key list.
  if (store.autoRefresh && store.keyCount > 0) startAutoRefresh();
  // React to live theme switches in the host without a reload.
  themeObserver = new MutationObserver(() => {
    isDark.value = computeIsDark();
  });
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
});

onBeforeUnmount(() => {
  if (themeObserver) themeObserver.disconnect();
  stopAutoRefresh();
});
</script>

<template>
  <a-config-provider :theme="themeConfig">
  <div class="kk-wrap">
    <div class="kk-row">
      <div style="display: flex; align-items: center; gap: 8px">
        <img :src="logoUrl" alt="logo" width="22" height="22" style="border-radius: 4px" />
        <h2 class="kk-title">KIRO-APIKEY-IDE</h2>
        <span v-if="store.version" class="kk-ver-badge">v{{ store.version }}</span>
      </div>
      <div style="display: flex; align-items: center; gap: 8px">
        <a-tag :color="store.active ? 'green' : 'default'" style="margin: 0">
          {{ store.active ? "开启中" : "未开启" }}
        </a-tag>
        <a-button
          shape="round"
          size="small"
          title="设置"
          @click="settingsOpen = true"
        >
          <template #icon><SettingOutlined /></template>
          设置
        </a-button>
      </div>
    </div>
    <p class="kk-sub">用 Kiro API Key（ksk_）直接在自带对话框里选择模型聊天</p>

    <!-- Notice -->
    <a-alert
      class="kk-card"
      type="warning"
      show-icon
      message="本拓展纯免费・KIRO官方直连・发现中转・赔款一万元"
    />

    <!-- Master switch -->
    <a-card size="small" class="kk-card">
      <div class="kk-row">
        <span><b>网关开关</b></span>
        <a-switch
          :checked="store.active"
          :disabled="store.keyCount === 0"
          @change="onToggle"
        />
      </div>
      <div class="kk-hint" style="margin-top: 10px">
        添加至少一个 API Key 并打开开关后，Kiro 自带对话即走你的 key。首次启用需重新加载窗口生效。
      </div>
    </a-card>

    <!-- API keys (multi) -->
    <a-card size="small" class="kk-card">
      <template #title>API Key<span v-if="store.keys.length" class="kk-key-count">（{{ store.keys.length }} 个）</span></template>
      <template #extra>
        <!-- Selection toolbar (export / delete) -->
        <a-space v-if="selecting" :size="6">
          <a-button size="small" @click="selectAll">全选</a-button>
          <a-button size="small" @click="invertSelect">反选</a-button>
          <a-button
            v-if="selectMode === 'export'"
            size="small"
            type="primary"
            @click="confirmExport"
          >导出</a-button>
          <a-button
            v-else
            size="small"
            type="primary"
            danger
            @click="askDeleteSelected"
          >删除</a-button>
          <a-button size="small" @click="cancelSelect">取消</a-button>
        </a-space>
        <!-- Normal toolbar -->
        <a-space v-else :size="8">
          <a-button size="small" title="搜索" @click="toggleSearch">
            <template #icon><SearchOutlined /></template>
          </a-button>
          <a-dropdown-button
            type="primary"
            size="small"
            @click="showAdd = true"
          >
            <PlusOutlined />
            添加
            <template #overlay>
              <a-menu @click="onAddMenu">
                <a-menu-item key="batch">
                  <UnorderedListOutlined />
                  批量添加
                </a-menu-item>
                <a-menu-item key="export">
                  <ExportOutlined />
                  批量导出
                </a-menu-item>
                <a-menu-item key="delete" danger>
                  <DeleteOutlined />
                  批量删除
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown-button>
        </a-space>
      </template>

      <!-- search form -->
      <div v-if="showSearch" style="display: flex; gap: 8px; margin-bottom: 10px">
        <a-input
          v-model:value="searchText"
          placeholder="输入关键字筛选密钥"
          allow-clear
          @pressEnter="() => {}"
        >
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <a-button @click="closeSearch">关闭</a-button>
      </div>

      <!-- add form -->
      <div v-if="showAdd" style="display: flex; gap: 8px; margin-bottom: 10px">
        <a-input-password
          v-model:value="newKey"
          placeholder="ksk_..."
          allow-clear
          @pressEnter="confirmAdd"
        />
        <a-button type="primary" @click="confirmAdd">确定</a-button>
        <a-button @click="cancelAdd">取消</a-button>
      </div>

      <!-- selection mode hint -->
      <div v-if="selectMode === 'export'" class="kk-hint" style="margin: 0 0 10px">
        勾选要导出的密钥（已选 {{ selectedCount }} / {{ store.keys.length }}），点击右上角「导出」保存为 txt 文件。
      </div>
      <div v-else-if="selectMode === 'delete'" class="kk-hint" style="margin: 0 0 10px">
        勾选要删除的密钥（已选 {{ selectedCount }} / {{ store.keys.length }}），点击右上角「删除」后需二次确认。
      </div>

      <a-empty
        v-if="store.keys.length === 0 && !showAdd"
        :image="null"
        description="还没有添加密钥，点击右上角「添加」"
      />
      <a-empty
        v-else-if="filteredKeys.length === 0 && showSearch"
        :image="null"
        description="没有匹配的密钥"
      />

      <div v-if="filteredKeys.length > 0" class="kk-key-list">
      <a-dropdown
        v-for="item in filteredKeys"
        :key="item.index"
        :trigger="['contextmenu']"
      >
        <div
          class="kk-key-row"
          :class="{
            active: !selecting && item.index === store.activeIndex,
            selected: selecting && isSelected(item.index),
          }"
          @click="selecting ? toggleSelect(item.index) : store.selectKey(item.index)"
        >
          <a-checkbox
            v-if="selecting"
            :checked="isSelected(item.index)"
            :disabled="deleteLocked(item.index)"
            class="kk-key-check"
            @click.stop="toggleSelect(item.index)"
          />
          <div class="kk-key-main">
            <code class="kk-keytext">
              <a-tag
                v-if="store.enabled && item.index === store.activeIndex"
                color="green"
                class="kk-inuse-tag"
              >当前</a-tag>
              {{ store.hideApiKey ? item.masked : item.full }}
              <a-tag v-if="deleteLocked(item.index)" color="green" class="kk-inuse-tag">使用中 · 不可删除</a-tag>
            </code>
            <!-- Account tier + per-key credits (auto-refresh on) -->
            <div v-if="store.autoRefresh" class="kk-key-meta">
              <LoadingOutlined
                v-if="isAccountLoading(item.index)"
                class="kk-acct-spin"
              />
              <template v-if="accountOf(item.index) && accountOf(item.index).ok">
                <a-tag
                  v-if="accountOf(item.index).info.subscriptionTitle"
                  :color="tierColor(accountOf(item.index).info.tier)"
                >
                  {{ tierLabel(accountOf(item.index).info.subscriptionTitle) }}
                </a-tag>
                <span
                  v-if="accountOf(item.index).info.total != null"
                  class="kk-credit-mini"
                >{{ fmtNum(accountOf(item.index).info.used) }}/{{ fmtNum(accountOf(item.index).info.total) }}</span>
              </template>
              <template v-else-if="accountOf(item.index) && !accountOf(item.index).ok">
                <a-tag color="default">未知身份</a-tag>
                <span class="kk-credit-mini">0/0</span>
              </template>
            </div>
          </div>
          <a-space v-if="!selecting" :size="6" @click.stop>
            <a-button size="small" @click="openTest(item)">测试</a-button>
            <!-- In-use key + gateway on: warn first (delete also disables the
                 gateway and needs a reload). Otherwise: plain confirm. -->
            <a-button
              v-if="item.index === store.activeIndex && store.enabled"
              size="small"
              danger
              @click.stop="openDangerDelete(item.index)"
            >删除</a-button>
            <a-popconfirm
              v-else
              title="确定删除该密钥？"
              ok-text="删除"
              cancel-text="取消"
              @confirm="store.deleteKey(item.index)"
            >
              <a-button size="small" danger>删除</a-button>
            </a-popconfirm>
          </a-space>
        </div>
        <template #overlay>
          <a-menu @click="({ key }) => onKeyMenu(key, item.index)">
            <a-menu-item key="copy">复制完整密钥</a-menu-item>
            <a-menu-item v-if="store.autoRefresh" key="sync">同步账户信息</a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
      </div>

      <!-- Aggregate credits + last sync time (auto-refresh on) -->
      <div v-if="store.autoRefresh && store.keys.length > 0" class="kk-credit-summary">
        <div class="kk-credit-line">
          <span>已用积分 / 总积分</span>
          <b v-if="creditTotals.has">{{ fmtNum(creditTotals.used) }}/{{ fmtNum(creditTotals.total) }}</b>
          <b v-else>—</b>
        </div>
        <div class="kk-credit-sync">
          <a-button
            type="link"
            size="small"
            class="kk-sync-btn"
            style="padding: 0; height: auto"
            :loading="store.syncing"
            :disabled="store.syncing"
            @click="syncAccountsNow()"
          >
            <template v-if="!store.syncing" #icon><SyncOutlined /></template>
            {{ store.syncing ? "同步中…" : "立即同步" }}
          </a-button>
          <span v-if="syncedLabel">同步于 {{ syncedLabel }}</span>
        </div>
      </div>
    </a-card>

    <!-- Batch import modal -->
    <a-modal
      v-model:open="batchModalOpen"
      title="批量添加 API Key"
      ok-text="导入"
      cancel-text="取消"
      centered
      @ok="confirmBatch"
    >
      <div class="kk-hint" style="margin: 0 0 8px">
        每行一个 API Key（以 ksk_ 开头），空行会被忽略。
      </div>
      <a-textarea
        v-model:value="batchText"
        :rows="8"
        placeholder="ksk_xxxx&#10;ksk_yyyy&#10;ksk_zzzz"
        allow-clear
      />
    </a-modal>

    <!-- Batch delete confirm modal -->
    <a-modal
      v-model:open="batchDeleteOpen"
      title="确认批量删除"
      ok-text="删除"
      cancel-text="取消"
      :ok-button-props="{ danger: true }"
      :mask-closable="false"
      centered
      @ok="confirmDeleteSelected"
    >
      <div style="display: flex; align-items: flex-start; gap: 10px">
        <ExclamationCircleOutlined style="font-size: 18px; color: #ff4d4f; margin-top: 2px" />
        <span>
          确定删除选中的 <b>{{ selectedCount }}</b> 个 API Key 吗？此操作不可撤销。谨慎操作！
        </span>
      </div>
    </a-modal>

    <!-- Test connectivity modal -->
    <a-modal v-model:open="testModalOpen" title="测试连通性" :footer="null" centered>
      <div style="margin-bottom: 12px">
        <div class="kk-hint" style="margin: 0 0 4px">API Key</div>
        <code class="kk-keytext">{{ testMasked }}</code>
      </div>
      <div v-if="currentTest && currentTest.loading" class="kk-test-loading">
        <a-spin tip="正在测试…" />
      </div>
      <template v-else-if="currentTest && currentTest.ok">
        <a-alert type="success" show-icon style="margin-bottom: 10px">
          <template #message>
            连通正常 · {{ currentTest.result.subscription || "?" }}
            <template v-if="currentTest.result.total != null">
              · {{ fmtNum(currentTest.result.used) }}/{{ fmtNum(currentTest.result.total) }}
            </template>
            · {{ currentTest.result.modelCount }} 个模型
          </template>
        </a-alert>
        <a-alert type="warning" show-icon style="margin-bottom: 10px">
          <template #message>
            测试连通性正常仅代表当前 API Key 有效。是否可使用请开启网关并切换到该 API Key 进行测试。如有疑问可查看下方常见问题。
          </template>
        </a-alert>
        <a-list
          size="small"
          :data-source="currentTest.result.models"
          style="max-height: 60vh; min-height: 320px; overflow: auto"
        >
          <template #renderItem="{ item }">
            <a-list-item>
              <span>{{ item.name }}</span>
              <a-tag>{{ item.id }} · x{{ item.rate }}</a-tag>
            </a-list-item>
          </template>
        </a-list>
      </template>
      <a-alert
        v-else-if="currentTest && !currentTest.ok"
        type="error"
        show-icon
        :message="'连通失败: ' + currentTest.message"
      />
    </a-modal>

    <!-- Warn before deleting the in-use key (also disables the gateway) -->
    <a-modal
      :open="dangerDeleteOpen"
      title="当前密钥正在使用"
      ok-text="仍要删除"
      cancel-text="取消"
      :ok-button-props="{ danger: true }"
      :mask-closable="false"
      centered
      @ok="confirmDangerDelete"
      @cancel="cancelDangerDelete"
    >
      <div style="display: flex; align-items: flex-start; gap: 10px">
        <ExclamationCircleOutlined style="font-size: 18px; color: #faad14; margin-top: 2px" />
        <span>该密钥正在被网关使用中。删除后将同步关闭网关，并需要重新加载窗口才能恢复 Kiro 默认服务。确定删除吗？</span>
      </div>
    </a-modal>

    <!-- Loading prompt while an async toggle/restore is in flight -->
    <a-modal
      :open="store.busyModal.open"
      :title="store.busyModal.title"
      :footer="null"
      :closable="false"
      :mask-closable="false"
      :keyboard="false"
      centered
    >
      <a-spin>
        <div style="height: 48px"></div>
      </a-spin>
    </a-modal>

    <!-- Reload-required prompt -->
    <a-modal
      :open="store.reloadModal.open"
      title="需要重新加载窗口"
      ok-text="重新加载窗口"
      :cancel-button-props="{ style: { display: 'none' } }"
      :closable="false"
      :mask-closable="false"
      centered
      @ok="store.confirmReload()"
    >
      <div style="display: flex; align-items: flex-start; gap: 10px">
        <ReloadOutlined style="font-size: 18px; color: #1677ff; margin-top: 2px" />
        <span>{{ store.reloadModal.text }}</span>
      </div>
    </a-modal>

    <!-- Region -->
    <a-card size="small" class="kk-card" title="地区">
      <a-select
        v-model:value="regionSelect"
        style="width: 100%"
        @change="onRegionChange"
      >
        <a-select-option v-for="r in KNOWN_REGIONS" :key="r.value" :value="r.value">
          {{ r.label }}
        </a-select-option>
        <a-select-option value="__custom">自定义…</a-select-option>
      </a-select>
      <div v-if="isCustomRegion" style="margin-top: 8px; display: flex; gap: 8px">
        <a-input
          v-model:value="customRegion"
          placeholder="输入 region，如 ap-southeast-2"
          @pressEnter="saveCustomRegion"
        />
        <a-button @click="saveCustomRegion">应用</a-button>
      </div>
      <div class="kk-hint">你的 key 属于哪个区域就选哪个；不确定先用默认 us-east-1。</div>
    </a-card>

    <!-- Actions + health -->
    <a-card size="small" class="kk-card">
      <a-space wrap>
        <a-button @click="store.reload()">
          <template #icon><ReloadOutlined /></template>
          重新加载窗口
        </a-button>
        <a-button @click="openLogs">
          <template #icon><FileTextOutlined /></template>
          日志
        </a-button>
      </a-space>
      <div class="kk-hint" style="margin-top: 10px">
        注册表: {{ store.registered ? "已登记" : "未登记（已尝试自愈）" }}
        <span v-if="store.obsolete"> · ⚠ 被标记 .obsolete</span>
        <br />
        端口: KRS {{ store.ports.krs }} / CPS {{ store.ports.cps }}
      </div>
    </a-card>

    <!-- FAQ -->
    <a-card size="small" class="kk-card" title="常见问题">
      <a-collapse class="kk-faq-collapse">
        <a-collapse-panel key="1" header="KIRO-APIKEY-IDE 的作用是什么？">
          <p class="kk-faq">
            使用 Kiro API Key（ksk_）直接在 Kiro 自带的对话框里选择模型聊天、完成代码任务。不借助任何第三方服务器、外部依赖，无需安装额外软件。
          </p>
        </a-collapse-panel>
        <a-collapse-panel key="2" header="什么是 API Key？">
          <p class="kk-faq">
            Kiro API Key 是 Kiro（Amazon Q 旗下 AI 编程助手）的“程序密码”，用来在脚本、CI/CD、容器里免登录、无交互调用 Kiro CLI / API，不用每次都弹浏览器登录。
          </p>
        </a-collapse-panel>
        <a-collapse-panel key="3" header="如何获取 API Key？">
          <p class="kk-faq">
            可以在 KIRO 官网账户后台获取 API Key，也可以在任意其他渠道购买获取。
          </p>
        </a-collapse-panel>
        <a-collapse-panel key="4" header="如何判断是否连接成功？">
          <p class="kk-faq">
            选择有效 key 后，开启网关开关。重载窗口后查看 KIRO IDE 右下角积分是否与当前 key 的积分一致。若一致代表连接成功。
          </p>
        </a-collapse-panel>
        <a-collapse-panel key="5" header="测试 API Key 有效，但无法进行对话？">
          <p class="kk-faq">
            API Key 测试连通性显示正常，说明当前 API Key 是有效的。可排查网络故障、是否安装其他类似插件造成冲突等问题。也可以在日志查询功能中查看 [KRS]、[CPS] 端口是否正常启用，以及 [CPS] 的 kiro-agent 代理请求链路是否已打通。最后，可以使用 <a-button href="https://kiro.dev/cli/" type="link" target="_blank">KIRO CLI</a-button>进行准确联通测试。
          </p>
        </a-collapse-panel>
        <a-collapse-panel key="6" header="需要人工服务？">
          <p class="kk-faq">
            本插件纯免费，开发不易，不提供免费人工咨询答疑服务。如您确需要技术人员为您提供帮助，可进入交流群联系群主。注：协助服务 50 元/次，未解决好全额退款！
          </p>
        </a-collapse-panel>
      </a-collapse>
    </a-card>

    <!-- Footer: links + version -->
    <div class="kk-footer">
      <div class="kk-footer-btns">
        <a-button shape="round" @click="store.openExternal(store.repoUrl)">
          <template #icon><GithubOutlined /></template>
          GitHub
        </a-button>
        <a-button shape="round" @click="qqModalOpen = true">
          <template #icon><QqOutlined /></template>
          加入交流群
        </a-button>
      </div>
      <div class="kk-footer-ver">
        v{{ store.version || "-" }} · 更新于 {{ BUILD_DATE }}
      </div>
    </div>

    <!-- QQ group modal -->
    <a-modal
      v-model:open="qqModalOpen"
      title="加入交流群"
      :footer="null"
      centered
    >
      <div class="kk-qq">
        <QqOutlined class="kk-qq-icon" />
        <div class="kk-hint" style="margin: 0 0 4px">QQ 交流群（添加请备注 KIRO）</div>
        <div class="kk-qq-num">1076613780</div>
      </div>
    </a-modal>

    <!-- Settings drawer (bottom, 80% height) -->
    <a-drawer
      v-model:open="settingsOpen"
      title="设置"
      placement="bottom"
      height="80%"
      :body-style="{ padding: '12px 16px' }"
    >
      <div class="kk-setting-item">
        <div class="kk-setting-text">
          <div class="kk-setting-title">隐藏 API Key</div>
          <div class="kk-hint">开启后列表中的密钥以掩码显示；关闭后显示完整密钥。</div>
        </div>
        <a-switch :checked="store.hideApiKey" @change="onHideKeyChange" />
      </div>

      <a-divider style="margin: 12px 0" />

      <div class="kk-setting-item">
        <div class="kk-setting-text">
          <div class="kk-setting-title">自动刷新</div>
          <div class="kk-hint">自动同步更新账户信息（订阅类型与积分用量）。</div>
        </div>
        <a-switch :checked="store.autoRefresh" @change="onAutoRefreshChange" />
      </div>
      <div v-if="store.autoRefresh" class="kk-hint" style="margin-top: 8px">
        已开启：将在 API Key 列表下方显示「已用积分 / 总积分」与同步时间，每分钟自动刷新一次。
      </div>
    </a-drawer>

    <!-- Log drawer (bottom, 80% height) -->
    <a-drawer
      v-model:open="logDrawerOpen"
      title="运行日志"
      placement="bottom"
      height="80%"
      :body-style="{ padding: '12px 16px', display: 'flex', flexDirection: 'column' }"
    >
      <template #extra>
        <a-space :size="8">
          <a-button size="small" @click="store.fetchLogs()">
            <template #icon><SyncOutlined /></template>
            刷新
          </a-button>
          <a-button size="small" @click="store.copyLogs()">
            <template #icon><CopyOutlined /></template>
            复制
          </a-button>
        </a-space>
      </template>
      <div class="kk-hint" style="margin: 0 0 8px">
        仅保留最近一小时的日志。查看 <code>-&gt; [KRS]</code> / <code>首次收到 kiro-agent 代理请求</code> 可判断请求是否真的走了本地代理。
        <span v-if="store.logsAt"> · 拉取于 {{ fmtLogTime(store.logsAt) }}</span>
      </div>
      <a-spin v-if="store.logsLoading && store.logs.length === 0" tip="正在加载日志…" style="margin-top: 24px" />
      <a-empty
        v-else-if="store.logs.length === 0"
        :image="null"
        description="暂无日志"
      />
      <pre v-else class="kk-log-pre">{{ logText }}</pre>
    </a-drawer>
  </div>
  </a-config-provider>
</template>

<style scoped>
.kk-key-count {
  font-size: 12px;
  font-weight: 400;
  opacity: 0.65;
}
.kk-keytext {
  background: transparent;
  padding: 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  word-break: break-all;
}
/* Footer: centered action buttons above a centered version line. */
.kk-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  padding: 8px 0 4px;
}
.kk-footer-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}
.kk-footer-ver {
  font-size: 12px;
  opacity: 0.7;
  text-align: center;
}
/* QQ group modal body: icon + number, centered. */
.kk-qq {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 12px 0 4px;
}
.kk-qq-icon {
  font-size: 40px;
  color: #12b7f5;
  margin-bottom: 12px;
}
.kk-qq-num {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 1px;
  user-select: all;
}
/* Loading area for the connectivity test: vertically centered with a subtle
   surface background so it reads as a distinct panel while models load. */
.kk-test-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  border-radius: 8px;
  background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.08));
}
/* Log drawer: scrollable, monospace console-style block filling the drawer. */
.kk-log-pre {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--vscode-editorWidget-background, rgba(127, 127, 127, 0.08));
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
/* API key list: fixed max height (~10 rows) with internal scroll so a large
   number of keys doesn't grow the whole panel unbounded. */
.kk-key-list {
  max-height: 520px;
  overflow-y: auto;
  overflow-x: hidden;
  /* room so the scrollbar doesn't overlap the row borders */
  padding-right: 4px;
}
/* Each API key is a rounded, clickable card; the active one is highlighted. */
.kk-key-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.kk-key-row:last-child {
  margin-bottom: 0;
}
.kk-key-row:hover {
  border-color: #69b1ff;
}
.kk-key-row.active {
  border-color: #1677ff;
}
.kk-key-row.selected {
  border-color: #1677ff;
  background: rgba(22, 119, 255, 0.08);
}
.kk-key-check {
  flex: none;
}
.kk-key-row.active .kk-keytext {
  color: #1677ff;
  font-weight: 600;
}
/* Left column of a key row: key text stacked over its account meta. */
.kk-key-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.kk-key-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.kk-key-meta .ant-tag {
  margin: 0;
}
.kk-credit-mini {
  font-size: 12px;
  opacity: 0.75;
  font-family: var(--vscode-editor-font-family, monospace);
}
.kk-acct-spin {
  color: var(--vscode-textLink-foreground, #1677ff);
  font-size: 13px;
}
.kk-inuse-tag {
  margin-left: 6px;
  vertical-align: middle;
}
/* Aggregate credits + sync line beneath the key list. */
.kk-credit-summary {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed rgba(128, 128, 128, 0.35);
}
.kk-credit-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
}
.kk-credit-sync {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.7;
}
/* Keep the sync button visually blue while it's disabled during syncing,
   only blocking clicks (no grayed-out look). */
.kk-sync-btn.ant-btn-link[disabled],
.kk-sync-btn.ant-btn-link[disabled]:hover {
  color: var(--vscode-textLink-foreground, #1677ff) !important;
  opacity: 1;
}
/* Settings drawer rows. */
.kk-setting-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.kk-setting-text {
  flex: 1;
  min-width: 0;
}
.kk-setting-title {
  font-weight: 600;
  margin-bottom: 2px;
}
.kk-contact > div {
  line-height: 1.9;
}
.kk-faq {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.7;
}
/* Give the FAQ collapse a visible light-gray border regardless of theme. */
:deep(.kk-faq-collapse.ant-collapse) {
  border: 1px solid rgba(128, 128, 128, 0.35);
  border-radius: 8px;
  background: transparent;
}
:deep(.kk-faq-collapse .ant-collapse-item),
:deep(.kk-faq-collapse .ant-collapse-content) {
  border-color: rgba(128, 128, 128, 0.35);
}
/* The last item's own bottom border stacks on the container's bottom border,
   producing a double line. Drop it so only the container edge shows. */
:deep(.kk-faq-collapse .ant-collapse-item:last-child),
:deep(.kk-faq-collapse .ant-collapse-item:last-child > .ant-collapse-header) {
  border-bottom: none;
}
/* Tighten the title header and the gap between title and content. */
:deep(.ant-card-small > .ant-card-head) {
  min-height: auto;
  padding: 10px 12px;
  border-bottom: none;
}
:deep(.ant-card-small > .ant-card-head + .ant-card-body) {
  padding-top: 4px;
}
:deep(.ant-card-small > .ant-card-body) {
  padding: 10px 12px;
}
</style>
