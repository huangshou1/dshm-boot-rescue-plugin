// ===== 共享页面状态机（救援面板与正常页启动器互斥的唯一判定）=====
// 目标：标准失败页 / pending-only 只能出现救援入口；健康页只能出现安全中心启动器；
// loading 与未知状态不挂载任何入口；救援/面板自身的 input/textarea 不算健康 UI。
(function () {
  "use strict";
  try {
    if (window.__DSHM_PAGE_STATE__) return;
  } catch (error) {
    return;
  }
  var HEALTHY_UI_SELECTOR = '[role="tree"],textarea,[contenteditable="true"],[role="textbox"],input:not([type="hidden"])';
  // 本插件自己创建的 DOM 不得被误判为“健康 UI”或“页面已进入正常状态”。
  var OWNED_SELECTOR = '#dshm-boot-rescue-overlay,[data-dshm-boot-rescue],.dbr-overlay,[data-dshm-security-launcher],.dshm-sec-launcher,.dshm-sec-overlay,[data-dshm-security-panel],.dshm-sec-panel';
  var FAILURE_PATTERNS = [
    /Failed to load plugins/i,
    /web boot:\s*\d+\s+entr(?:y|ies)\s+did not activate/i,
    /pending \(waiting for service/i,
    /failed to import loader entry/i,
    /failed to apply loader entry/i,
    /failed to resolve loader entry/i,
    /failed to initialize loader entry/i,
    /client-modules:\s*bundle script\s+\S+\s+failed to load/i,
    /import failed\b/i
  ];
  var listeners = [];
  var lastState = null;
  var observer = null;
  var emitTimer = null;
  var stopTimer = null;
  var MAX_WATCH_MS = 120000;

  function isOwned(element) {
    try {
      return !!(element && element.closest && element.closest(OWNED_SELECTOR));
    } catch (error) {
      return false;
    }
  }

  function rootElement() {
    return document.getElementById("root") || document.body || null;
  }

  function rootText() {
    try {
      var root = rootElement();
      return root ? String(root.textContent || "").slice(0, 12000) : "";
    } catch (error) {
      return "";
    }
  }

  function failureTextPresent(text) {
    for (var index = 0; index < FAILURE_PATTERNS.length; index += 1) {
      if (FAILURE_PATTERNS[index].test(text)) return true;
    }
    return false;
  }

  function healthyUiPresent() {
    try {
      var nodes = document.querySelectorAll(HEALTHY_UI_SELECTOR);
      for (var index = 0; index < nodes.length; index += 1) {
        if (!isOwned(nodes[index])) return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  // 明确的启动失败容器/标记：优先于“正文关键词”，且文本作用域限制在失败容器内，
  // 避免健康页聊天正文讨论事故文案时误判为失败页。
  function failureContainerPresent() {
    try {
      var nodes = document.querySelectorAll("[data-dsh-boot],[data-dsh-boot-failed],[data-dshm-boot-failed]");
      for (var index = 0; index < nodes.length; index += 1) {
        var node = nodes[index];
        if (!node || isOwned(node)) continue;
        if (failureTextPresent(String(node.textContent || ""))) return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  function computeState() {
    try {
      if (!rootElement()) return "unknown";
      // 1) 明确启动失败容器/标记：优先 failure。
      if (failureContainerPresent()) return "failure";
      var text = rootText();
      var healthy = healthyUiPresent();
      // 2) 已确认存在非本插件的健康 UI 时，不得仅因聊天正文出现事故关键词判 failure；
      //    但非健康页（含 pending-only）仍允许用正文失败信号判 failure。
      if (!healthy && failureTextPresent(text)) return "failure";
      if (document.querySelector("[data-dsh-boot-spinner]")) return "loading";
      if (/Loading plugins/i.test(text)) return "loading";
      if (healthy) return "healthy";
      return "unknown";
    } catch (error) {
      return "unknown";
    }
  }

  function emit() {
    var next = computeState();
    if (next === lastState) return;
    lastState = next;
    for (var index = 0; index < listeners.length; index += 1) {
      try {
        listeners[index](next);
      } catch (error) {
        // 监听器异常不得影响页面
      }
    }
  }

  function scheduleEmit() {
    if (emitTimer) return;
    emitTimer = window.setTimeout(function () {
      emitTimer = null;
      emit();
    }, 50);
  }

  function startObserver() {
    try {
      if (observer || typeof MutationObserver === "undefined") {
        emit();
        return;
      }
      var target = document.documentElement || document.body;
      if (!target) return;
      observer = new MutationObserver(scheduleEmit);
      observer.observe(target, { childList: true, characterData: true, subtree: true, attributes: true });
      stopTimer = window.setTimeout(function () {
        try {
          if (observer) observer.disconnect();
        } catch (error) {
          // ignore
        }
        observer = null;
      }, MAX_WATCH_MS);
      emit();
    } catch (error) {
      // ignore
    }
  }

  window.__DSHM_PAGE_STATE__ = {
    get: computeState,
    refresh: emit,
    isOwned: isOwned,
    HEALTHY_UI_SELECTOR: HEALTHY_UI_SELECTOR,
    onChange: function (listener) {
      if (typeof listener !== "function") return;
      listeners.push(listener);
      try {
        listener(computeState());
      } catch (error) {
        // ignore
      }
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  else startObserver();
})();

// dshm-boot-rescue — 失败页救援脚本（单文件、零依赖，由宿主 tapIndex 注入浏览器）。
//
// 失败页识别契约。关键行为：
//   * 只在 DSHM「插件加载失败页」挂载：根文本含 "Failed to load plugins" 且没有健康 UI 时。
//     失败页 root 在 #root 内、标题是一个 div，因此这里只按根节点文本检测。
//   * 已知失败文案全部识别：failed to import loader entry、failed to apply / resolve /
//     initialize loader entry、client-modules: bundle script ... failed to load、
//     web boot: N entries did not activate、<name>: pending (waiting for service: ...)。
//   * 插件启停只在进程启动时拼装，本页面里做任何重载都不会生效 —— 脚本从不触发页面重载，
//     只写带标记的停用行并提示「停用后请划掉后台重新打开应用」。
//   * 只用 var/function 传统语法（ArkWeb 兼容）；全部逻辑 try/catch；零遥测。
(function () {
  "use strict";

  try {
    if (window.__DSHM_BOOT_RESCUE__) return;
    window.__DSHM_BOOT_RESCUE__ = true;
  } catch (error) {
    return;
  }

  // ── 1. 常量 ───────────────────────────────────────────────────────────────
  var API_STATE = "/dshm-boot-rescue/state";
  var API_DISABLE = "/dshm-boot-rescue/disable";
  var API_RESTORE = "/dshm-boot-rescue/restore";
  var API_HEALTH = "/dshm-boot-rescue/health";
  // 失败页标题：「Failed to load plugins」渲染在 #root 内的一个 div 里，不是语义标题元素。
  var FAILURE_TITLE = "Failed to load plugins";
  // 健康 DSHM 界面一定存在树控件或可编辑控件；聊天里引用错误文本时用它排除误挂。
  var HEALTHY_UI_SELECTOR = '[role="tree"],textarea,[contenteditable="true"],[role="textbox"],input:not([type="hidden"])';
  var PREVIEW_ATTR = "data-dshm-boot-rescue-preview";
  var MAX_SELECTION = 32;
  var MAX_WATCH_MS = 120000;
  var MAX_FAILURE_TEXT = 12000;
  var RESTART_GUIDE = "停用后请划掉后台重新打开应用";
  var RESTART_DETAIL = "插件启停只在进程启动时拼装，重新打开本页面不会生效";
  var PREVIEW_NOTICE = "只读自检：不会修改任何配置";
  var FALLBACK_WARNING = "本次停用重启应用后失效，请进入系统后立即卸载肇事插件";
  var SERVICE_DOWN_TITLE = "救援服务暂时不可用";
  // 已知失败文案逐条识别（name 只用于诊断；不要求每条同时出现）：
  //   failed to import loader entry <name> (<pkg>)
  //   failed to apply / resolve / initialize loader entry <name> (<pkg>)
  //   client-modules: bundle script <url> failed to load
  //   web boot: N entries did not activate（整体错误，不单独提取名字）
  //   <name>: pending (waiting for service: <service>)
  var LOADER_HINT_PATTERNS = [
    /failed to import loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i,
    /failed to apply loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i,
    /failed to resolve loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i,
    /failed to initialize loader entry\s+([^\s(]+)(?:\s+\(([^)]+)\))?/i
  ];
  var BUNDLE_HINT_PATTERN = /client-modules:\s*bundle script\s+([^\s]+)\s+failed to load/i;
  var ACTIVATION_PATTERN = /web boot:\s*\d+\s+entr(?:y|ies)\s+did not activate/i;
  var PENDING_HINT_PATTERN = /([^\s:]+):\s*pending \(waiting for service[^)]*\)/i;
  // dsh 0.2.1 的失败项实际文案是 "<name>: import failed: <message>" /
  // "<name>: import failed (see console for the import error)"（见核心 bundle 的 bZ()）。
  var IMPORT_FAILED_PATTERN = /([^\s:]+):\s*import failed\b/i;

  // ── 2. 运行时状态 ─────────────────────────────────────────────────────────
  var INSERTED = false;
  var observer = null;
  var watchStopTimer = null;
  var mountTimer = null;
  var restoreConfirmTimer = null;
  var panel = null;
  var isPreview = false;
  var failureText = "";
  var model = {
    version: "", generatedAt: "", mode: "rows", writable: true,
    readOnlyReason: "", readOnlyReasonCode: "", warning: "",
    rowsPath: "", profileDir: "",
    entries: [], rescueRows: {}, suspects: {}, selected: {},
    filter: "user", query: "", busy: false, confirmRestore: false,
    statusText: "", statusTone: ""
  };

  // ── 3. 通用工具 ───────────────────────────────────────────────────────────
  function esc(value) {
    try {
      return String(value === undefined || value === null ? "" : value).replace(/[&<>"']/g, function (character) {
        return character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === '"' ? "&quot;" : "&#39;";
      });
    } catch (error) {
      return "";
    }
  }

  function normalizeText(value) {
    try {
      return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
    } catch (error) {
      return "";
    }
  }

  function asStringArray(value) {
    var output = [];
    var index;
    try {
      if (typeof value === "string") value = [value];
      if (!value || !value.length) return output;
      for (index = 0; index < value.length; index++) {
        var item = String(value[index] === undefined || value[index] === null ? "" : value[index]).trim();
        if (item && output.indexOf(item) === -1) output.push(item);
      }
    } catch (error) {
      return [];
    }
    return output;
  }

  function formatTime(value) {
    try {
      var date = new Date(value);
      if (isNaN(date.getTime())) return "";
      var pad = function (number) { return number < 10 ? "0" + number : String(number); };
      return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " +
        pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    } catch (error) {
      return "";
    }
  }

  function errorMessage(error) {
    return error && error.message ? String(error.message) : "未知错误";
  }

  // ── 4. 条目判定 ───────────────────────────────────────────────────────────
  function groupKey(entry) {
    try {
      return String(entry.groupId || entry.packageName || entry.name || entry.id || "");
    } catch (error) {
      return "";
    }
  }

  function aliasesOf(raw) {
    var output = [];
    try {
      var list = raw && raw.aliases;
      for (var index = 0; list && index < list.length; index++) {
        var value = String(list[index] === undefined || list[index] === null ? "" : list[index]).trim();
        if (value && output.indexOf(value) === -1) output.push(value);
      }
    } catch (error) {
      return [];
    }
    return output;
  }

  // 防御式合并同 id 条目（服务端已去重，这里只做兜底）。
  function normalizeEntries(list) {
    var output = [];
    var byId = {};
    if (!list || !list.length) return output;
    try {
      for (var index = 0; index < list.length; index++) {
        var raw = list[index];
        if (!raw || !raw.id) continue;
        var id = String(raw.id);
        var entry = byId[id];
        if (!entry) {
          entry = {
            id: id, groupId: String(raw.groupId || ""),
            name: String(raw.name || raw.packageName || id), packageName: String(raw.packageName || ""),
            aliases: aliasesOf(raw), builtin: !!raw.builtin, protected: !!raw.protected,
            protectedReason: String(raw.protectedReason || ""), installed: raw.installed !== false,
            hasUserRow: !!raw.hasUserRow, disabled: !!raw.disabled,
            disabledByRescue: !!raw.disabledByRescue, actionable: raw.actionable !== false,
            reason: String(raw.reason || "")
          };
          byId[id] = entry;
          output.push(entry);
          continue;
        }
        var extraAliases = aliasesOf(raw);
        for (var aliasIndex = 0; aliasIndex < extraAliases.length; aliasIndex++) {
          if (entry.aliases.indexOf(extraAliases[aliasIndex]) === -1) entry.aliases.push(extraAliases[aliasIndex]);
        }
        entry.hasUserRow = entry.hasUserRow || !!raw.hasUserRow;
        entry.installed = entry.installed || raw.installed !== false;
        entry.disabled = entry.disabled || !!raw.disabled;
        entry.disabledByRescue = entry.disabledByRescue || !!raw.disabledByRescue;
        entry.builtin = entry.builtin || !!raw.builtin;
        entry.protected = entry.protected || !!raw.protected;
        entry.actionable = entry.actionable && raw.actionable !== false;
        if (!entry.reason && raw.reason) entry.reason = String(raw.reason);
        if (!entry.protectedReason && raw.protectedReason) entry.protectedReason = String(raw.protectedReason);
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  function findEntry(id) {
    try {
      for (var index = 0; index < model.entries.length; index++) {
        if (model.entries[index].id === id) return model.entries[index];
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function isRescueDisabled(entry) {
    try {
      return !!entry.disabledByRescue || !!model.rescueRows[entry.id];
    } catch (error) {
      return false;
    }
  }

  // 可写 + 非内置/受保护 + 未被救援停用 + 未被配置禁用。
  function isActionable(entry) {
    try {
      if (!entry || !model.writable || entry.actionable === false) return false;
      if (entry.builtin || entry.protected) return false;
      if (isRescueDisabled(entry) || entry.disabled) return false;
      return true;
    } catch (error) {
      return false;
    }
  }

  function isUserEntry(entry) {
    return !entry.builtin && !entry.protected;
  }

  // ── 5. 失败页检测与疑似识别（SPEC 4.2）────────────────────────────────────
  function hasKnownFailure(text) {
    try {
      var index;
      for (index = 0; index < LOADER_HINT_PATTERNS.length; index++) {
        if (LOADER_HINT_PATTERNS[index].test(text)) return true;
      }
      return BUNDLE_HINT_PATTERN.test(text) || ACTIVATION_PATTERN.test(text) || PENDING_HINT_PATTERN.test(text)
        || IMPORT_FAILED_PATTERN.test(text);
    } catch (error) {
      return false;
    }
  }

  // 从 client-modules 的 bundle URL 里尽力取出包名 / 插件 id。
  function packageNamesFromUrl(url) {
    var names = [];
    try {
      var value = String(url || "");
      try { value = decodeURIComponent(value); } catch (decodeError) { /* 用原始值继续 */ }
      var match = /\/plugins\/([^\/\s?#]+)\//.exec(value);
      if (match && match[1]) names.push(match[1]);
      match = /node_modules\/((?:@[^\/\s?#]+\/)?[^\/\s?#]+)/.exec(value);
      if (match && match[1]) names.push(match[1]);
      var file = value.split(/[?#]/)[0].split("/").pop() || "";
      if (file) {
        var base = file.replace(/\.(?:js|cjs|mjs|json)(?:\.map)?$/i, "");
        if (base) names.push(base);
      }
    } catch (error) {
      return names;
    }
    return names;
  }

  function collectHints(text) {
    var hints = [];
    var index;
    var match;
    try {
      for (index = 0; index < LOADER_HINT_PATTERNS.length; index++) {
        var pattern = new RegExp(LOADER_HINT_PATTERNS[index].source, "gi");
        while ((match = pattern.exec(text))) {
          if (match[1]) hints.push(match[1]);
          if (match[2]) hints.push(match[2]);
        }
      }
      var bundlePattern = new RegExp(BUNDLE_HINT_PATTERN.source, "gi");
      while ((match = bundlePattern.exec(text))) {
        var names = packageNamesFromUrl(match[1]);
        for (index = 0; index < names.length; index++) hints.push(names[index]);
      }
      var pendingPattern = new RegExp(PENDING_HINT_PATTERN.source, "gi");
      while ((match = pendingPattern.exec(text))) {
        if (match[1]) hints.push(match[1]);
      }
      var importFailedPattern = new RegExp(IMPORT_FAILED_PATTERN.source, "gi");
      while ((match = importFailedPattern.exec(text))) {
        if (match[1]) hints.push(match[1]);
      }
    } catch (error) {
      return hints;
    }
    return hints;
  }

  function identifySuspects(entries, text) {
    var suspects = {};
    var index;
    try {
      var hints = collectHints(text);
      var lowerText = String(text || "").toLowerCase();
      var lowerHints = [];
      for (index = 0; index < hints.length; index++) {
        var hint = String(hints[index] === undefined || hints[index] === null ? "" : hints[index]).trim().toLowerCase();
        if (hint) lowerHints.push(hint);
      }
      for (index = 0; index < entries.length; index++) {
        var entry = entries[index];
        var values = [entry.id, entry.name, entry.packageName].concat(entry.aliases || []);
        for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
          var value = String(values[valueIndex] === undefined || values[valueIndex] === null ? "" : values[valueIndex]).trim().toLowerCase();
          if (value && lowerHints.indexOf(value) !== -1) { suspects[entry.id] = true; break; }
        }
      }
      // 兜底：较长且带 -/@/. 的 alias 出现在失败页文本里即命中（短 alias 只认精确命中）。
      for (index = 0; index < entries.length; index++) {
        if (suspects[entries[index].id]) continue;
        var aliases = entries[index].aliases || [];
        for (var aliasIndex = 0; aliasIndex < aliases.length; aliasIndex++) {
          var alias = String(aliases[aliasIndex] || "").trim().toLowerCase();
          if (alias.length >= 5 && /[-@.]/.test(alias) && lowerText.indexOf(alias) !== -1) {
            suspects[entries[index].id] = true;
            break;
          }
        }
      }
      // 整插件：命中 entry 的同 groupId 条目全部视为疑似（整组停用）。
      var groups = {};
      for (index = 0; index < entries.length; index++) {
        if (suspects[entries[index].id]) groups[groupKey(entries[index])] = true;
      }
      for (index = 0; index < entries.length; index++) {
        if (groups[groupKey(entries[index])]) suspects[entries[index].id] = true;
      }
    } catch (error) {
      return suspects;
    }
    return suspects;
  }

  // 返回失败页根节点；健康 UI、空页、加载页一律返回 null（永不挂载）。
  function findFailureRoot() {
    try {
      var root = document.getElementById("root") || document.body;
      if (!root || !root.querySelector) return null;
      if (healthyUiPresent()) return null;
      var text = normalizeText(root.textContent || "");
      if (!text) return null;
      failureText = text.slice(0, MAX_FAILURE_TEXT);
      // 兜底要求：有标题即挂载，不依赖细节文案；已知失败正则只作附加信号。
      if (text.indexOf(FAILURE_TITLE) === -1 && !hasKnownFailure(text)) return null;
      return root;
    } catch (error) {
      return null;
    }
  }

  // ── 6. state 归一化（SPEC 5.2）────────────────────────────────────────────
  function normalizeState(state) {
    try {
      var data = state || {};
      model.version = String(data.version || "");
      model.generatedAt = String(data.generatedAt || "");
      model.mode = String(data.mode || "rows");
      model.writable = data.writable !== false;
      model.readOnlyReason = String(data.readOnlyReason || "");
      model.readOnlyReasonCode = String(data.readOnlyReasonCode || "");
      model.warning = String(data.warning || "");
      model.rowsPath = String(data.rowsPath || "");
      model.profileDir = String(data.profileDir || "");
      model.entries = normalizeEntries(data.entries);
      model.rescueRows = {};
      var index;
      var rescue = asStringArray(data.rescueRows);
      for (index = 0; index < rescue.length; index++) model.rescueRows[rescue[index]] = true;
      for (index = 0; index < model.entries.length; index++) {
        if (model.rescueRows[model.entries[index].id]) model.entries[index].disabledByRescue = true;
      }
      model.suspects = identifySuspects(model.entries, failureText);
      model.selected = {};
      model.query = "";
      model.busy = false;
      model.confirmRestore = false;
      model.statusText = "";
      model.statusTone = "";
      var actionableSuspects = 0;
      for (index = 0; index < model.entries.length; index++) {
        var suspectEntry = model.entries[index];
        if (model.suspects[suspectEntry.id] && isActionable(suspectEntry)) actionableSuspects++;
      }
      // 有「可操作」疑似时默认看「疑似故障」，否则默认「用户插件」。
      // 疑似高亮与诊断条不受影响：全部疑似项都受保护/不可操作时不再落入空标签页。
      model.filter = actionableSuspects ? "suspect" : "user";
      // 自动勾选所有可操作的疑似项（最多 32 项）。
      var selected = 0;
      for (index = 0; index < model.entries.length; index++) {
        var entry = model.entries[index];
        if (!model.suspects[entry.id] || !isActionable(entry)) continue;
        if (selected >= MAX_SELECTION) break;
        model.selected[entry.id] = true;
        selected++;
      }
    } catch (error) {
      model.entries = [];
      model.suspects = {};
      model.selected = {};
    }
  }

  // ── 7. 样式（固定覆盖层 + 暗色适配，类前缀统一 dbr-）──────────────────────
  function detectDark() {
    try {
      if (document.body && document.body.hasAttribute("data-ds-dark-theme")) return true;
      if (document.documentElement && document.documentElement.hasAttribute("data-ds-dark-theme")) return true;
      if (document.documentElement) {
        var explicit = document.documentElement.getAttribute("data-theme") || document.documentElement.getAttribute("data-color-scheme");
        if (explicit === "dark") return true;
        if (explicit === "light") return false;
      }
      return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (error) {
      return false;
    }
  }

  function injectStyles() {
    try {
      if (document.getElementById("dshm-boot-rescue-styles")) return;
      var style = document.createElement("style");
      style.id = "dshm-boot-rescue-styles";
      style.textContent = [
        ".dbr-overlay{--dbr-bg:#fff;--dbr-raised:#f5f6f8;--dbr-hover:#edf1f5;--dbr-border:#dde2e8;--dbr-border-strong:#c4ccd5;--dbr-text:#1c232b;--dbr-muted:#68727e;--dbr-faint:#8a939e;--dbr-accent:#c4543a;--dbr-accent-hover:#ab452d;--dbr-accent-ink:#fff;--dbr-warn-bg:#fff6e8;--dbr-warn-border:#ecc78d;--dbr-warn-text:#8a4a15;--dbr-danger:#c34a4a;--dbr-ok:#2b8f68;position:fixed;inset:0;z-index:2147483000;overflow:auto;overscroll-behavior:contain;padding:24px 12px 56px;background:rgba(10,14,20,.5);color:var(--dbr-text);font:13px/1.55 'HarmonyOS Sans',Inter,system-ui,-apple-system,'Segoe UI',sans-serif;text-align:left;-webkit-overflow-scrolling:touch}",
        ".dbr-overlay.dbr-dark{--dbr-bg:#1a1d21;--dbr-raised:#24272c;--dbr-hover:#2b2f35;--dbr-border:#33383f;--dbr-border-strong:#464d56;--dbr-text:#eef1f4;--dbr-muted:#a6aeb8;--dbr-faint:#7e8893;--dbr-accent:#e07a5f;--dbr-accent-hover:#ea8b72;--dbr-accent-ink:#17191c;--dbr-warn-bg:#2c241c;--dbr-warn-border:#6b4a27;--dbr-warn-text:#f1bd80;--dbr-danger:#e06868;--dbr-ok:#54b98d;background:rgba(0,0,0,.6)}",
        ".dbr-overlay *,.dbr-overlay *:before,.dbr-overlay *:after{box-sizing:border-box}.dbr-overlay [hidden]{display:none!important}.dbr-overlay button,.dbr-overlay input{font:inherit;color:inherit}.dbr-overlay button{appearance:none;border:0;background:transparent;cursor:pointer}.dbr-svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;display:block;flex:0 0 auto}",
        ".dbr-card{width:min(760px, calc(100% - 24px));margin:0 auto;background:var(--dbr-bg);border:1px solid var(--dbr-border);border-radius:18px;box-shadow:0 18px 60px rgba(8,12,18,.28);overflow:hidden}",
        ".dbr-head{display:flex;align-items:flex-start;gap:14px;padding:20px 22px 16px;border-bottom:1px solid var(--dbr-border)}",
        ".dbr-emblem{width:42px;height:42px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;color:var(--dbr-accent);background:var(--dbr-raised);border:1px solid var(--dbr-border);border-radius:12px}.dbr-emblem .dbr-svg{width:23px;height:23px}",
        ".dbr-head-main{min-width:0;flex:1}.dbr-kicker{display:flex;align-items:center;gap:8px;color:var(--dbr-muted);font-size:10px;font-weight:700;letter-spacing:.12em}.dbr-live{display:inline-flex;align-items:center;gap:5px;letter-spacing:0;font-weight:600;text-transform:none}.dbr-dot{width:6px;height:6px;border-radius:50%;background:var(--dbr-ok);box-shadow:0 0 0 3px rgba(43,143,104,.14)}.dbr-live.dbr-readonly-state .dbr-dot{background:var(--dbr-warn-text);box-shadow:0 0 0 3px rgba(210,138,62,.16)}.dbr-live.dbr-degraded-state .dbr-dot{background:var(--dbr-danger);box-shadow:0 0 0 3px rgba(195,74,74,.16)}.dbr-live.dbr-preview-state .dbr-dot{background:var(--dbr-faint);box-shadow:none}",
        ".dbr-title{font-size:19px;line-height:1.35;font-weight:650;letter-spacing:-.01em;margin-top:3px}.dbr-subtitle{margin-top:3px;color:var(--dbr-muted);font-size:12px}.dbr-version{margin-top:3px;color:var(--dbr-faint);font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}",
        ".dbr-preview{flex:0 0 auto;padding:3px 9px;border:1px solid var(--dbr-warn-border);border-radius:999px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text);font-size:10px;font-weight:650;white-space:nowrap}",
        ".dbr-diagnosis{display:flex;align-items:center;gap:11px;margin:14px 20px 0;padding:11px 12px;border:1px solid var(--dbr-warn-border);border-radius:11px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-diagnosis .dbr-svg{flex:0 0 auto}.dbr-diagnosis-text{min-width:0;flex:1}.dbr-diagnosis-text strong{display:block;font-size:12px}.dbr-diagnosis-text span{display:block;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.dbr-diagnosis-note{flex:0 0 auto;font-size:10px;font-weight:650}",
        ".dbr-warning{display:flex;align-items:flex-start;gap:10px;margin:12px 20px 0;padding:11px 12px;border:1px solid var(--dbr-warn-border);border-left:3px solid var(--dbr-danger);border-radius:10px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-warning .dbr-svg{margin-top:1px;color:var(--dbr-danger)}.dbr-warning-text strong{display:block;font-size:12px}.dbr-warning-text span{display:block;margin-top:2px;font-size:11.5px;line-height:1.5}",
        ".dbr-notice{display:flex;flex-direction:column;gap:2px;margin:14px 20px 0;padding:11px 13px;border-left:3px solid var(--dbr-accent);border-radius:8px;background:var(--dbr-raised)}.dbr-notice strong{font-size:12.5px}.dbr-notice span{color:var(--dbr-muted);font-size:11.5px}",
        ".dbr-controls{padding:14px 20px 8px}.dbr-search{width:100%;height:40px;padding:0 12px;color:var(--dbr-text);background:var(--dbr-raised);border:1px solid var(--dbr-border-strong);border-radius:10px;outline:none}.dbr-search::placeholder{color:var(--dbr-faint)}.dbr-search:focus{border-color:var(--dbr-accent);box-shadow:0 0 0 3px rgba(196,84,58,.16)}",
        ".dbr-tabs{display:flex;align-items:center;gap:3px;margin-top:10px;overflow-x:auto;scrollbar-width:none}.dbr-tabs::-webkit-scrollbar{display:none}.dbr-tab{min-height:32px;padding:5px 10px;border-radius:8px;color:var(--dbr-muted);font-size:11.5px;white-space:nowrap}.dbr-tab:hover{background:var(--dbr-hover)}.dbr-tab[aria-selected='true']{color:var(--dbr-text);background:var(--dbr-raised);font-weight:650}",
        ".dbr-list-meta{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 20px;min-height:30px;color:var(--dbr-muted);font-size:11px}.dbr-meta-actions{display:flex;gap:12px}.dbr-text-btn{padding:3px 0;color:var(--dbr-muted);font-size:11px}.dbr-text-btn:hover{color:var(--dbr-text)}.dbr-text-btn[disabled]{opacity:.4;cursor:not-allowed}",
        ".dbr-list{max-height:42vh;overflow:auto;padding:0 12px 8px;scrollbar-color:var(--dbr-border-strong) transparent}",
        ".dbr-item{display:flex;align-items:center;gap:10px;min-height:54px;padding:7px 9px;border:1px solid transparent;border-radius:10px}.dbr-item+.dbr-item{margin-top:3px}.dbr-item:hover{background:var(--dbr-hover)}.dbr-item.dbr-selected{border-color:var(--dbr-accent);background:var(--dbr-raised)}.dbr-item.dbr-suspect:not(.dbr-selected){border-color:var(--dbr-warn-border)}.dbr-item-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer}.dbr-item-main.dbr-inert{cursor:default}",
        ".dbr-check{width:18px;height:18px;flex:0 0 auto;accent-color:var(--dbr-accent);cursor:pointer}.dbr-check[disabled]{cursor:not-allowed;opacity:.4}.dbr-plugin{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}.dbr-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600}.dbr-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dbr-muted);font:10.5px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}",
        ".dbr-badges{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;flex:0 1 auto;max-width:46%}.dbr-badge{padding:2px 7px;border:1px solid var(--dbr-border);border-radius:999px;background:var(--dbr-raised);color:var(--dbr-muted);font-size:10px;font-weight:600;white-space:nowrap}.dbr-badge-warn{border-color:var(--dbr-warn-border);background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-badge-info{border-color:var(--dbr-border-strong);color:var(--dbr-text)}.dbr-badge-muted{opacity:.85}",
        ".dbr-row-btn{flex:0 0 auto;min-height:28px;padding:3px 9px;border:1px solid var(--dbr-border-strong);border-radius:7px;font-size:11px;font-weight:600;white-space:nowrap}.dbr-row-btn:hover{background:var(--dbr-hover)}.dbr-row-btn[disabled]{opacity:.4;cursor:not-allowed}.dbr-empty{padding:28px 12px;text-align:center;color:var(--dbr-muted);font-size:12px}",
        ".dbr-readonly{margin:12px 20px 0;padding:12px 14px;border:1px solid var(--dbr-warn-border);border-radius:10px;background:var(--dbr-warn-bg);color:var(--dbr-warn-text);font-size:11.5px;line-height:1.55}.dbr-readonly-title{font-size:12px;font-weight:650;margin-bottom:4px}.dbr-readonly p{margin:4px 0 0}.dbr-readonly code,.dbr-fallback code{display:inline-block;padding:1px 5px;border-radius:5px;background:rgba(0,0,0,.06);font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-all}",
        ".dbr-dark .dbr-readonly code,.dbr-dark .dbr-fallback code{background:rgba(255,255,255,.08)}",
        ".dbr-foot{display:flex;flex-direction:column;gap:10px;margin-top:14px;padding:14px 20px 16px;border-top:1px solid var(--dbr-border);background:var(--dbr-raised)}.dbr-status{min-height:18px;color:var(--dbr-muted);font-size:11.5px}.dbr-status[data-tone='error']{color:var(--dbr-danger)}.dbr-status[data-tone='success']{color:var(--dbr-ok)}.dbr-status[data-tone='warn']{color:var(--dbr-warn-text)}.dbr-status[data-tone='preview']{color:var(--dbr-warn-text)}.dbr-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}",
        ".dbr-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:7px 14px;border:1px solid var(--dbr-border-strong);border-radius:10px;background:var(--dbr-bg);font-size:12px;font-weight:600;white-space:nowrap}.dbr-btn:hover{background:var(--dbr-hover)}.dbr-btn .dbr-svg{width:15px;height:15px}.dbr-btn.dbr-primary{border-color:var(--dbr-accent);background:var(--dbr-accent);color:var(--dbr-accent-ink)}.dbr-btn.dbr-primary:hover{background:var(--dbr-accent-hover);border-color:var(--dbr-accent-hover)}.dbr-btn.dbr-restore-confirm{border-color:var(--dbr-warn-border);background:var(--dbr-warn-bg);color:var(--dbr-warn-text)}.dbr-btn[disabled]{opacity:.45;cursor:not-allowed}",
        ".dbr-overlay button:focus-visible,.dbr-overlay input:focus-visible{outline:2px solid var(--dbr-accent);outline-offset:2px}",
        ".dbr-fallback-body{padding:24px}.dbr-fallback-body p{margin:10px 0 0;color:var(--dbr-muted);font-size:12px;line-height:1.6}.dbr-fallback-body .dbr-title{font-size:17px}.dbr-hint{color:var(--dbr-warn-text)!important}",
        "@media(max-width:640px){.dbr-overlay{padding:12px 8px 32px}.dbr-card{width:calc(100% - 16px);border-radius:14px}.dbr-head{padding:16px 15px 13px}.dbr-controls{padding:12px 15px 6px}.dbr-diagnosis,.dbr-notice,.dbr-warning,.dbr-readonly{margin-left:15px;margin-right:15px}.dbr-list-meta{padding:0 15px}.dbr-list{padding-left:7px;padding-right:7px;max-height:38vh}.dbr-foot{padding:12px 15px 14px}.dbr-actions{display:grid;grid-template-columns:1fr 1fr}.dbr-actions .dbr-primary{grid-column:1/-1}.dbr-btn{min-height:42px}.dbr-badges{max-width:38%}}",
        "@media(prefers-reduced-motion:reduce){.dbr-overlay *{animation:none!important;transition:none!important}}"
      ].join("");
      document.head.appendChild(style);
    } catch (error) {
      // 样式失败不影响功能：面板仍可操作，只是无样式。
    }
  }

  // ── 8. 同源 API ───────────────────────────────────────────────────────────
  function api(url, options) {
    try {
      var init = { credentials: "same-origin" };
      if (options) {
        if (options.method) init.method = options.method;
        if (options.headers) init.headers = options.headers;
        if (options.body !== undefined) init.body = options.body;
      }
      return fetch(url, init).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (!response.ok || (body && body.ok === false)) {
            var failure = new Error((body && body.error) || ("HTTP " + response.status));
            failure.code = (body && body.code) || "";
            throw failure;
          }
          return body || {};
        });
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function postJSON(url, payload) {
    return api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload || {}) });
  }

  // ── 9. 数据视图 ───────────────────────────────────────────────────────────
  function countSelected() {
    try { return Object.keys(model.selected).length; } catch (error) { return 0; }
  }

  function countRescueRows() {
    try { return Object.keys(model.rescueRows).length; } catch (error) { return 0; }
  }

  function selectedActionableIds() {
    var ids = [];
    try {
      for (var index = 0; index < model.entries.length; index++) {
        var entry = model.entries[index];
        if (model.selected[entry.id] && isActionable(entry)) ids.push(entry.id);
      }
    } catch (error) {
      return ids;
    }
    return ids;
  }

  function suspectEntries() {
    var output = [];
    try {
      for (var index = 0; index < model.entries.length; index++) {
        if (model.suspects[model.entries[index].id]) output.push(model.entries[index]);
      }
    } catch (error) {
      return output;
    }
    return output;
  }

  function suspectText() {
    var suspects = suspectEntries();
    var names = [];
    for (var index = 0; index < suspects.length; index++) {
      names.push((suspects[index].name || suspects[index].id) + " [" + suspects[index].id + "]");
    }
    return names.join(", ");
  }

  function filteredEntries() {
    var output = [];
    try {
      var query = model.query.trim().toLowerCase();
      for (var index = 0; index < model.entries.length; index++) {
        var entry = model.entries[index];
        if (query) {
          var haystack = [entry.name, entry.id, entry.packageName].concat(entry.aliases || []).join(" ").toLowerCase();
          if (haystack.indexOf(query) !== -1) output.push(entry);
          continue;
        }
        if (model.filter === "suspect" && !model.suspects[entry.id]) continue;
        if (model.filter === "user" && !isUserEntry(entry)) continue;
        if (model.filter === "rescue" && !isRescueDisabled(entry) && !entry.disabled) continue;
        output.push(entry);
      }
      output.sort(function (left, right) {
        var suspectDelta = (model.suspects[right.id] ? 1 : 0) - (model.suspects[left.id] ? 1 : 0);
        if (suspectDelta) return suspectDelta;
        var actionableDelta = (isActionable(right) ? 1 : 0) - (isActionable(left) ? 1 : 0);
        if (actionableDelta) return actionableDelta;
        var leftName = String(left.name || left.id).toLowerCase();
        var rightName = String(right.name || right.id).toLowerCase();
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
      });
    } catch (error) {
      return output;
    }
    return output;
  }

  // ── 10. 面板渲染 ──────────────────────────────────────────────────────────
  var ICONS = {
    rescue: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/><path d="M5.7 5.7 9.3 9.3m5.4 5.4 3.6 3.6m0-12.6-3.6 3.6m-5.4 5.4-3.6 3.6"/></svg>',
    warning: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 4.1 2.6 17.5A1.7 1.7 0 0 0 4.1 20h15.8a1.7 1.7 0 0 0 1.5-2.5L13.7 4.1a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 3.4v.01"/></svg>',
    copy: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    arrow: '<svg class="dbr-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>'
  };

  function buildOverlay() {
    injectStyles();
    var overlay = document.createElement("div");
    overlay.className = "dbr-overlay" + (detectDark() ? " dbr-dark" : "");
    overlay.id = "dshm-boot-rescue-overlay";
    overlay.innerHTML = [
      '<section class="dbr-card" role="dialog" aria-labelledby="dbr-title">',
      '<header class="dbr-head">',
      '<div class="dbr-emblem">' + ICONS.rescue + '</div>',
      '<div class="dbr-head-main">',
      '<div class="dbr-kicker">DSHM BOOT RESCUE<span class="dbr-live" data-role="service-state"><span class="dbr-dot"></span><span data-role="service-label">救援服务在线</span></span></div>',
      '<div class="dbr-title" id="dbr-title">启动恢复中心</div>',
      '<div class="dbr-subtitle">插件加载中断。这里可以定位故障插件并临时停用，让 DSHM 恢复启动。</div>',
      '<div class="dbr-version" data-role="version"></div>',
      '</div>',
      '<span class="dbr-preview" data-role="preview-badge" hidden>只读自检</span>',
      '</header>',
      '<div class="dbr-diagnosis" data-role="diagnosis" hidden>' + ICONS.warning + '<div class="dbr-diagnosis-text"><strong>已定位疑似故障插件</strong><span data-role="suspects"></span></div><span class="dbr-diagnosis-note">已自动勾选</span></div>',
      '<div class="dbr-warning" data-role="warning" hidden>' + ICONS.warning + '<div class="dbr-warning-text"><strong data-role="warning-title">降级模式警示</strong><span data-role="warning-text"></span></div></div>',
      '<div class="dbr-notice"><strong>' + RESTART_GUIDE + '</strong><span>' + RESTART_DETAIL + '</span></div>',
      '<div class="dbr-controls">',
      '<input class="dbr-search" data-role="search" type="search" autocomplete="off" spellcheck="false" placeholder="搜索插件名称、包名或入口 id" aria-label="搜索插件">',
      '<div class="dbr-tabs" role="tablist" aria-label="插件范围">',
      '<button class="dbr-tab" data-filter="suspect" role="tab" type="button">疑似故障</button>',
      '<button class="dbr-tab" data-filter="user" role="tab" type="button">用户插件</button>',
      '<button class="dbr-tab" data-filter="rescue" role="tab" type="button">已停用</button>',
      '<button class="dbr-tab" data-filter="all" role="tab" type="button">全部</button>',
      '</div>',
      '</div>',
      '<div class="dbr-list-meta"><span data-role="summary"></span><span class="dbr-meta-actions"><button class="dbr-text-btn" data-act="select-visible" type="button">选择当前可用项</button><button class="dbr-text-btn" data-act="clear" type="button">清除选择</button></span></div>',
      '<div class="dbr-list" data-role="list" role="list"></div>',
      '<div class="dbr-readonly" data-role="readonly" hidden></div>',
      '<footer class="dbr-foot">',
      '<div class="dbr-status" data-role="status" role="status" aria-live="polite"></div>',
      '<div class="dbr-actions">',
      '<button class="dbr-btn" data-act="copy" type="button">' + ICONS.copy + '<span>复制诊断</span></button>',
      '<button class="dbr-btn" data-act="restore-all" type="button"><span data-role="restore-label">恢复救援停用项</span></button>',
      '<button class="dbr-btn dbr-primary" data-act="disable" type="button"><span data-role="disable-label">停用所选并等待重启</span>' + ICONS.arrow + '</button>',
      '</div>',
      '</footer>',
      '</section>'
    ].join("");
    return overlay;
  }

  function entryMarkup(entry) {
    var suspect = !!model.suspects[entry.id];
    var rescueDisabled = isRescueDisabled(entry);
    var selected = !!model.selected[entry.id];
    var actionable = isActionable(entry);
    var classes = "dbr-item" + (selected ? " dbr-selected" : "") + (suspect ? " dbr-suspect" : "");
    var badges = [];
    if (suspect) badges.push('<span class="dbr-badge dbr-badge-warn">疑似故障</span>');
    if (rescueDisabled) badges.push('<span class="dbr-badge dbr-badge-info">已由救援停用</span>');
    else if (entry.disabled) badges.push('<span class="dbr-badge">配置已禁用</span>');
    if (entry.builtin) {
      badges.push('<span class="dbr-badge dbr-badge-muted" title="内置受保护条目，救援脚本不会修改">内置受保护</span>');
    } else if (entry.protected) {
      badges.push('<span class="dbr-badge dbr-badge-muted" title="' + esc(entry.protectedReason || "") + '">' + (entry.protectedReason === "self" ? "救援自身" : "受保护") + '</span>');
    } else if (!actionable && !rescueDisabled && entry.reason) {
      badges.push('<span class="dbr-badge dbr-badge-muted" title="' + esc(entry.reason) + '">未映射</span>');
    }
    var meta = [];
    if (entry.packageName && entry.packageName !== entry.id) meta.push("包名 " + entry.packageName);
    meta.push("入口 id: " + entry.id);
    if (entry.hasUserRow) meta.push("已有用户行");
    var checkbox = '<input class="dbr-check" type="checkbox" data-id="' + esc(entry.id) + '"' + (selected ? " checked" : "") + (actionable && !model.busy && !isPreview ? "" : " disabled") + ' aria-label="选择 ' + esc(entry.name || entry.id) + '">';
    var restoreButton = rescueDisabled
      ? '<button class="dbr-row-btn" data-act="restore-one" data-id="' + esc(entry.id) + '" type="button"' + (model.busy || !model.writable || isPreview ? " disabled" : "") + '>恢复</button>'
      : "";
    return '<div class="' + classes + '" role="listitem" data-id="' + esc(entry.id) + '">' +
      '<label class="dbr-item-main' + (actionable ? "" : " dbr-inert") + '">' + checkbox +
      '<span class="dbr-plugin"><span class="dbr-name" title="' + esc(entry.name || entry.id) + '">' + esc(entry.name || entry.id) + '</span>' +
      '<span class="dbr-meta" title="' + esc(meta.join(" · ")) + '">' + esc(meta.join(" · ")) + '</span></span></label>' +
      '<span class="dbr-badges">' + badges.join("") + '</span>' + restoreButton + '</div>';
  }

  function defaultStatus() {
    if (isPreview) return { text: PREVIEW_NOTICE, tone: "preview" };
    if (!model.writable) return { text: model.readOnlyReason || "当前无法安全修改配置，已进入只读模式。", tone: "error" };
    var selected = countSelected();
    if (selected) return { text: "已选择 " + selected + " 个插件；只会写入带救援标记的临时停用行。", tone: "" };
    var rescueCount = countRescueRows();
    if (rescueCount) return { text: "当前有 " + rescueCount + " 个插件由救援停用。", tone: "" };
    if (model.mode === "patch-fallback") return { text: "当前为降级模式：停用只在本轮启动内有效，请按上方警示处理。", tone: "warn" };
    return { text: "选择疑似故障插件后执行停用；不会删除插件或用户数据。", tone: "" };
  }

  function paintStatus() {
    if (!panel) return;
    try {
      var element = panel.querySelector('[data-role="status"]');
      if (!element) return;
      var text = model.statusText;
      var tone = model.statusTone;
      if (!text) {
        var preset = defaultStatus();
        text = preset.text;
        tone = preset.tone;
      }
      element.textContent = text;
      element.setAttribute("data-tone", tone || "");
    } catch (error) {
      // 状态渲染失败不抛出
    }
  }

  function setStatus(text, tone) {
    model.statusText = text || "";
    model.statusTone = tone || "";
    paintStatus();
  }

  function renderPanel() {
    if (!panel) return;
    try {
      // 统一复位所有按钮：setBusy(true) 会禁用全部按钮，重渲染若只细化部分按钮，
      // 标签页等按钮会永久保持禁用。先按 busy 复位，再由下面的具体逻辑细化。
      var allButtons = panel.querySelectorAll("button");
      for (var allIndex = 0; allIndex < allButtons.length; allIndex++) allButtons[allIndex].disabled = !!model.busy;
      // 顶部状态 + 版本小字
      var label = "救援服务在线";
      var stateClass = "dbr-live";
      if (isPreview) { label = "只读自检"; stateClass += " dbr-preview-state"; }
      else if (!model.writable) { label = "救援服务只读"; stateClass += " dbr-readonly-state"; }
      else if (model.mode === "patch-fallback") { label = "降级模式"; stateClass += " dbr-degraded-state"; }
      var serviceLabel = panel.querySelector('[data-role="service-label"]');
      if (serviceLabel) serviceLabel.textContent = label;
      var serviceState = panel.querySelector('[data-role="service-state"]');
      if (serviceState) serviceState.className = stateClass;
      var versionLine = model.version ? "版本 " + model.version : "";
      if (model.generatedAt) {
        var stamp = formatTime(model.generatedAt);
        if (stamp) versionLine += (versionLine ? " · " : "") + "生成于 " + stamp;
      }
      var versionElement = panel.querySelector('[data-role="version"]');
      if (versionElement) versionElement.textContent = versionLine;
      var previewBadge = panel.querySelector('[data-role="preview-badge"]');
      if (previewBadge) previewBadge.hidden = !isPreview;

      // 疑似诊断条
      var suspects = suspectEntries();
      var diagnosis = panel.querySelector('[data-role="diagnosis"]');
      if (diagnosis) diagnosis.hidden = !suspects.length;
      var suspectNames = [];
      for (var index = 0; index < suspects.length; index++) suspectNames.push(suspects[index].name || suspects[index].id);
      var suspectElement = panel.querySelector('[data-role="suspects"]');
      if (suspectElement) suspectElement.textContent = suspectNames.join(" · ");

      // 降级模式 warning（显著展示）
      var warningText = model.mode === "patch-fallback" ? (model.warning || FALLBACK_WARNING) : model.warning;
      var warningBox = panel.querySelector('[data-role="warning"]');
      if (warningBox) warningBox.hidden = !warningText;
      var warningTitle = panel.querySelector('[data-role="warning-title"]');
      if (warningTitle) warningTitle.textContent = model.mode === "patch-fallback" ? "降级模式警示" : "提示";
      var warningElement = panel.querySelector('[data-role="warning-text"]');
      if (warningElement) warningElement.textContent = warningText;

      // 标签页
      var tabs = panel.querySelectorAll(".dbr-tab");
      for (var tabIndex = 0; tabIndex < tabs.length; tabIndex++) {
        tabs[tabIndex].setAttribute("aria-selected", tabs[tabIndex].getAttribute("data-filter") === model.filter ? "true" : "false");
      }

      // 列表
      var visible = filteredEntries();
      var html = [];
      var actionableVisible = 0;
      for (var listIndex = 0; listIndex < visible.length; listIndex++) {
        html.push(entryMarkup(visible[listIndex]));
        if (isActionable(visible[listIndex])) actionableVisible++;
      }
      var list = panel.querySelector('[data-role="list"]');
      if (list) list.innerHTML = visible.length ? html.join("") : '<div class="dbr-empty">当前范围内没有匹配的插件</div>';
      var summary = panel.querySelector('[data-role="summary"]');
      if (summary) summary.textContent = "显示 " + visible.length + " 项 · 可操作 " + actionableVisible + " 项 · 已选择 " + countSelected() + " 项";
      var selectVisible = panel.querySelector('[data-act="select-visible"]');
      if (selectVisible) selectVisible.disabled = model.busy || !model.writable || isPreview || actionableVisible === 0;
      var clear = panel.querySelector('[data-act="clear"]');
      if (clear) clear.disabled = model.busy || countSelected() === 0;

      // 只读原因 + 手改指引
      var readonlyBox = panel.querySelector('[data-role="readonly"]');
      if (readonlyBox) {
        if (model.writable) {
          readonlyBox.hidden = true;
          readonlyBox.innerHTML = "";
        } else {
          var target = "";
          if (model.mode === "patch-fallback") target = model.profileDir ? model.profileDir.replace(/\/+$/, "") + "/cordis.patch.yml" : "当前 profile 目录下的 cordis.patch.yml";
          else if (model.rowsPath) target = model.rowsPath;
          else if (model.profileDir) target = model.profileDir.replace(/\/+$/, "") + "/.dshm-plugin-rows.yml";
          else target = "当前 profile 目录下的 .dshm-plugin-rows.yml";
          readonlyBox.hidden = false;
          readonlyBox.innerHTML = '<div class="dbr-readonly-title">只读模式：按钮已禁用，不会写入任何配置</div>' +
            '<p>原因：' + esc(model.readOnlyReason || "当前无法安全修改配置，已进入只读模式。") + '</p>' +
            '<p>手改指引：编辑 <code>' + esc(target) + '</code>，为故障插件追加 <code>- id: &lt;entry id&gt;</code> 与 <code>&nbsp;&nbsp;disabled: true</code> 两行后保存；或到系统设置 → 插件 中卸载该插件。</p>';
        }
      }

      // 底部按钮
      var selectedCount = countSelected();
      var rescueCount = countRescueRows();
      var disableButton = panel.querySelector('[data-act="disable"]');
      var restoreButton = panel.querySelector('[data-act="restore-all"]');
      var disableLabel = panel.querySelector('[data-role="disable-label"]');
      var restoreLabel = panel.querySelector('[data-role="restore-label"]');
      if (disableLabel) disableLabel.textContent = "停用所选并等待重启" + (selectedCount ? "（" + selectedCount + "）" : "");
      if (restoreLabel) restoreLabel.textContent = (model.confirmRestore ? "再次点击确认恢复" : "恢复救援停用项") + (rescueCount ? "（" + rescueCount + "）" : "");
      if (disableButton) disableButton.disabled = model.busy || !model.writable || isPreview || selectedCount === 0;
      if (restoreButton) {
        restoreButton.disabled = model.busy || !model.writable || isPreview || rescueCount === 0;
        restoreButton.className = "dbr-btn" + (model.confirmRestore ? " dbr-restore-confirm" : "");
      }
      var copyButton = panel.querySelector('[data-act="copy"]');
      if (copyButton) copyButton.disabled = model.busy;

      paintStatus();
    } catch (error) {
      // 单次渲染失败不影响宿主页面
    }
  }

  // ── 11. 挂载 / 回退 ───────────────────────────────────────────────────────
  function wireEvents() {
    if (!panel) return;
    panel.addEventListener("input", onPanelInput);
    panel.addEventListener("change", onPanelChange);
    panel.addEventListener("click", onPanelClick);
  }

  function appendOverlay(overlay, interactive) {
    try {
      var host = document.body || document.getElementById("root") || document.documentElement;
      if (!host || !overlay) return false;
      host.appendChild(overlay);
      try { window.__DSHM_BOOT_RESCUE_ACTIVE__ = true; } catch (activeError) { /* ignore */ }
      if (interactive) {
        panel = overlay;
        wireEvents();
        renderPanel();
      }
      return true;
    } catch (error) {
      return false;
    }
  }

  // 服务不可用回退面板：不猜路径，只给同源 health 与手改指引。
  function buildFallback(error) {
    injectStyles();
    var overlay = document.createElement("div");
    overlay.className = "dbr-overlay" + (detectDark() ? " dbr-dark" : "");
    overlay.id = "dshm-boot-rescue-overlay";
    overlay.innerHTML = [
      '<section class="dbr-card dbr-fallback" role="dialog" aria-label="' + SERVICE_DOWN_TITLE + '">',
      '<div class="dbr-fallback-body">',
      '<div class="dbr-title">' + SERVICE_DOWN_TITLE + '</div>',
      '<p>无法读取救援状态：<code>' + esc(errorMessage(error)) + '</code></p>',
      '<p>可以尝试：打开 <code>' + API_HEALTH + '</code> 检查救援服务；或手动编辑当前 profile 的用户行文件，为故障插件追加 <code>- id: &lt;entry id&gt;</code> 与 <code>&nbsp;&nbsp;disabled: true</code> 两行；也可以在系统设置 → 插件 中卸载该插件。</p>',
      '<p class="dbr-hint">' + RESTART_GUIDE + '。' + RESTART_DETAIL + '。</p>',
      '</div></section>'
    ].join("");
    return overlay;
  }

  // ── 12. 写操作（成功后不重载页面，只更新 UI + 重启指引）──────────────────
  function setBusy(busy) {
    model.busy = !!busy;
    if (!panel) return;
    if (busy) {
      var buttons = panel.querySelectorAll("button");
      for (var index = 0; index < buttons.length; index++) buttons[index].disabled = true;
    } else {
      renderPanel();
    }
  }

  function markDisabled(ids, data) {
    var changed = {};
    var index;
    try {
      for (index = 0; index < ids.length; index++) changed[String(ids[index])] = true;
      var added = asStringArray(data && data.disabled);
      for (index = 0; index < added.length; index++) changed[added[index]] = true;
      var already = asStringArray(data && data.already);
      for (index = 0; index < already.length; index++) changed[already[index]] = true;
      if (data && data.rescueRows) {
        model.rescueRows = {};
        var rows = asStringArray(data.rescueRows);
        for (index = 0; index < rows.length; index++) model.rescueRows[rows[index]] = true;
      }
      var keys = Object.keys(changed);
      for (index = 0; index < keys.length; index++) {
        model.rescueRows[keys[index]] = true;
        var entry = findEntry(keys[index]);
        if (entry) {
          entry.disabledByRescue = true;
          entry.disabled = true;
        }
      }
      if (data && data.mode) model.mode = String(data.mode);
      if (data && data.warning) model.warning = String(data.warning);
    } catch (error) {
      return changed;
    }
    return changed;
  }

  // 写操作成功后拉取一次权威 state：以服务端 entries 为准重渲染，避免本地猜测与真实用户行不符。
  // 刷新失败时保留调用方已做的本地更新与结果文案，不阻断流程。
  function refreshAfterWrite(message, tone) {
    var previousFilter = model.filter;
    var previousQuery = model.query;
    api(API_STATE).then(function (state) {
      try {
        normalizeState(state);
        model.filter = previousFilter;
        model.query = previousQuery;
        model.selected = {};
        var search = panel ? panel.querySelector('[data-role="search"]') : null;
        if (search) search.value = model.query;
        setStatus(message, tone);
        renderPanel();
      } catch (error) {
        setStatus(message, tone);
        setBusy(false);
      }
    }).catch(function () {
      setStatus(message, tone);
      setBusy(false);
    });
  }

  function doDisable() {
    if (isPreview) {
      setStatus(PREVIEW_NOTICE, "preview");
      return;
    }
    if (!model.writable) {
      setStatus(model.readOnlyReason || "当前为只读模式，无法写入配置。", "error");
      return;
    }
    var ids = selectedActionableIds();
    if (!ids.length) {
      setStatus("请先选择要停用的插件。", "error");
      return;
    }
    if (ids.length > MAX_SELECTION) {
      setStatus("单次最多停用 " + MAX_SELECTION + " 个插件，请分批操作。", "error");
      return;
    }
    setBusy(true);
    setStatus("正在写入临时停用行…", "");
    postJSON(API_DISABLE, { ids: ids }).then(function (result) {
      var data = result || {};
      markDisabled(ids, data);
      model.selected = {};
      model.confirmRestore = false;
      var addedCount = asStringArray(data.disabled).length;
      var message = (addedCount ? "已停用 " + addedCount + " 个插件。" : "所选插件已在救援停用列表中。") + RESTART_GUIDE + "。" + RESTART_DETAIL + "。";
      if (model.mode === "patch-fallback") message += " " + (model.warning || FALLBACK_WARNING);
      refreshAfterWrite(message, "success");
    }).catch(function (error) {
      setStatus("停用失败：" + errorMessage(error), "error");
      setBusy(false);
    });
  }

  function doRestore(ids) {
    if (isPreview) {
      setStatus(PREVIEW_NOTICE, "preview");
      return;
    }
    if (!model.writable) {
      setStatus(model.readOnlyReason || "当前为只读模式，无法写入配置。", "error");
      return;
    }
    var restoringAll = !ids || !ids.length;
    var payload = restoringAll ? {} : { ids: ids };
    setBusy(true);
    setStatus(restoringAll ? "正在恢复全部救援停用项…" : "正在恢复插件…", "");
    postJSON(API_RESTORE, payload).then(function (result) {
      var data = result || {};
      var restored = asStringArray(data.restored);
      for (var index = 0; index < restored.length; index++) {
        delete model.rescueRows[restored[index]];
        var entry = findEntry(restored[index]);
        if (entry) {
          entry.disabledByRescue = false;
          entry.disabled = false;
        }
      }
      model.selected = {};
      model.confirmRestore = false;
      if (data.mode) model.mode = String(data.mode);
      var message = restored.length ? "已恢复 " + restored.length + " 个插件。" + RESTART_GUIDE + "。" : "没有可恢复的救援停用项。";
      refreshAfterWrite(message, restored.length ? "success" : "");
    }).catch(function (error) {
      setStatus("恢复失败：" + errorMessage(error), "error");
      setBusy(false);
    });
  }

  // ── 13. 复制诊断 ──────────────────────────────────────────────────────────
  function buildReport() {
    var lines = [];
    try {
      lines.push("DSHM 启动救援诊断");
      lines.push("版本: " + (model.version || "未知"));
      lines.push("时间: " + (formatTime(model.generatedAt) || new Date().toISOString()));
      lines.push("模式: " + (model.mode || "rows"));
      lines.push("只读: " + (model.writable ? "否" : "是"));
      if (!model.writable) lines.push("只读原因: " + (model.readOnlyReason || "未提供"));
      lines.push("rowsPath: " + (model.rowsPath || "未提供"));
      lines.push("profileDir: " + (model.profileDir || "未提供"));
      lines.push("疑似故障: " + (suspectText() || "未识别"));
      lines.push("已由救援停用: " + (Object.keys(model.rescueRows).join(", ") || "无"));
      if (model.warning) lines.push("降级警示: " + model.warning);
      lines.push("失败页文本: " + (failureText || "未捕获"));
      if (isPreview) lines.push(PREVIEW_NOTICE);
    } catch (error) {
      return "DSHM 启动救援诊断（收集失败）";
    }
    return lines.join("\n");
  }

  function copyDiagnostics() {
    var report = buildReport();
    var done = function () { setStatus("诊断信息已复制到剪贴板。", "success"); };
    var fallback = function () {
      var area = null;
      var copied = false;
      try {
        area = document.createElement("textarea");
        area.value = report;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        copied = !!document.execCommand("copy");
      } catch (error) {
        copied = false;
      }
      try {
        if (area && area.parentNode) area.parentNode.removeChild(area);
      } catch (removeError) {
        // 忽略清理失败
      }
      if (copied) done();
      else setStatus("剪贴板不可用，请手动复制诊断信息。", "error");
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(report).then(done, fallback);
      else fallback();
    } catch (error) {
      fallback();
    }
  }

  // ── 14. 事件 ──────────────────────────────────────────────────────────────
  function closestButton(node) {
    try {
      while (node && node !== panel) {
        if (node.nodeType === 1 && node.tagName === "BUTTON") return node;
        node = node.parentNode;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function onPanelInput(event) {
    try {
      var target = event.target;
      if (!target || target.getAttribute("data-role") !== "search") return;
      model.query = String(target.value || "");
      model.statusText = "";
      model.statusTone = "";
      renderPanel();
    } catch (error) {
      // 搜索渲染失败不影响操作
    }
  }

  function onPanelChange(event) {
    try {
      var target = event.target;
      if (!target || !target.classList || !target.classList.contains("dbr-check")) return;
      if (isPreview) return;
      var id = target.getAttribute("data-id");
      if (!id) return;
      if (target.checked) {
        if (countSelected() >= MAX_SELECTION) {
          target.checked = false;
          setStatus("单次最多停用 " + MAX_SELECTION + " 个插件，请分批操作。", "error");
          return;
        }
        model.selected[id] = true;
      } else {
        delete model.selected[id];
      }
      model.statusText = "";
      model.statusTone = "";
      renderPanel();
    } catch (error) {
      // 选择状态异常时保持原状
    }
  }

  function clearRestoreTimer() {
    if (restoreConfirmTimer) {
      window.clearTimeout(restoreConfirmTimer);
      restoreConfirmTimer = null;
    }
  }

  function onPanelClick(event) {
    try {
      var button = closestButton(event.target);
      if (!button || button.disabled) return;
      var filter = button.getAttribute("data-filter");
      if (filter) {
        model.filter = filter;
        model.query = "";
        var search = panel.querySelector('[data-role="search"]');
        if (search) search.value = "";
        model.statusText = "";
        model.statusTone = "";
        renderPanel();
        return;
      }
      var action = button.getAttribute("data-act");
      if (action === "select-visible") {
        var room = MAX_SELECTION - countSelected();
        if (room <= 0) {
          setStatus("单次最多停用 " + MAX_SELECTION + " 个插件，请先清除部分选择。", "error");
          return;
        }
        var visible = filteredEntries();
        var added = 0;
        var skipped = 0;
        for (var index = 0; index < visible.length; index++) {
          var entry = visible[index];
          if (!isActionable(entry) || model.selected[entry.id]) continue;
          if (added >= room) { skipped++; continue; }
          model.selected[entry.id] = true;
          added++;
        }
        model.statusText = "";
        model.statusTone = "";
        renderPanel();
        if (skipped) setStatus("已选择前 " + added + " 项；单次最多 " + MAX_SELECTION + " 项。", "warn");
      } else if (action === "clear") {
        model.selected = {};
        model.statusText = "";
        model.statusTone = "";
        renderPanel();
      } else if (action === "copy") {
        copyDiagnostics();
      } else if (action === "disable") {
        doDisable();
      } else if (action === "restore-one") {
        var restoreId = button.getAttribute("data-id");
        if (restoreId) doRestore([restoreId]);
      } else if (action === "restore-all") {
        if (!model.writable) {
          setStatus(model.readOnlyReason || "当前为只读模式，无法写入配置。", "error");
          return;
        }
        if (countRescueRows() === 0) return;
        if (!model.confirmRestore) {
          model.confirmRestore = true;
          clearRestoreTimer();
          restoreConfirmTimer = window.setTimeout(function () {
            restoreConfirmTimer = null;
            model.confirmRestore = false;
            if (panel && !model.busy) renderPanel();
          }, 5000);
          setStatus("再次点击「恢复救援停用项」以确认；只会撤销救援写入的临时停用行。", "warn");
          renderPanel();
        } else {
          clearRestoreTimer();
          model.confirmRestore = false;
          doRestore(null);
        }
      }
    } catch (error) {
      setStatus("操作失败：" + errorMessage(error), "error");
    }
  }

  // ── 15. 侦测 / 挂载生命周期 ───────────────────────────────────────────────
  function stopWatching() {
    try {
      if (observer) observer.disconnect();
    } catch (error) {
      // 忽略断开失败
    }
    observer = null;
    if (watchStopTimer) { window.clearTimeout(watchStopTimer); watchStopTimer = null; }
    if (mountTimer) { window.clearTimeout(mountTimer); mountTimer = null; }
  }

  function scheduleMount() {
    if (INSERTED || mountTimer) return;
    mountTimer = window.setTimeout(function () {
      mountTimer = null;
      try { mount(); } catch (error) { stopWatching(); }
    }, 100);
  }

  // 健康 UI 已出现时说明不是失败页；排除本插件自己创建的 input/textarea 等 DOM。
  function healthyUiPresent() {
    try {
      var shared = window.__DSHM_PAGE_STATE__;
      if (shared && typeof shared.get === "function") {
        return shared.get() === "healthy";
      }
      var nodes = document.querySelectorAll(HEALTHY_UI_SELECTOR);
      for (var index = 0; index < nodes.length; index += 1) {
        var node = nodes[index];
        if (node && node.closest && node.closest('#dshm-boot-rescue-overlay,.dbr-overlay,.dshm-sec-overlay,.dshm-sec-launcher')) continue;
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  function mount() {
    try {
      if (INSERTED) return;
      var root = findFailureRoot();
      if (!root) {
        if (healthyUiPresent()) stopWatching();
        return;
      }
      INSERTED = true;
      isPreview = !!(document.body && document.body.hasAttribute(PREVIEW_ATTR));
      // 一旦决定挂载就停止观察，避免自身 DOM 变更反复触发。
      stopWatching();
      api(API_STATE).then(function (state) {
        try {
          normalizeState(state);
          appendOverlay(buildOverlay(), true);
        } catch (error) {
          appendOverlay(buildFallback(error), false);
        }
      }).catch(function (error) {
        appendOverlay(buildFallback(error), false);
      });
    } catch (error) {
      stopWatching();
    }
  }

  function startWatching() {
    try {
      if (INSERTED) return;
      // 首次检查：DOMContentLoaded 后立即执行一次。
      mount();
      if (INSERTED || observer || typeof MutationObserver === "undefined") return;
      var target = document.documentElement || document.body;
      if (!target) return;
      // 只观察、不轮询；失败页可能在首次检查之后才渲染出来。
      observer = new MutationObserver(scheduleMount);
      observer.observe(target, { childList: true, characterData: true, subtree: true });
      // 观察上限 120000ms，超时后永久停止，避免长期占用渲染进程。
      watchStopTimer = window.setTimeout(stopWatching, MAX_WATCH_MS);
    } catch (error) {
      stopWatching();
    }
  }

  function boot() {
    try {
      if (document.body && document.body.hasAttribute(PREVIEW_ATTR)) isPreview = true;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startWatching, { once: true });
      else startWatching();
    } catch (error) {
      stopWatching();
    }
  }

  function removeRescueEntry() {
    try {
      var node = document.getElementById("dshm-boot-rescue-overlay");
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch (error) {
      // ignore
    }
    INSERTED = false;
    try { window.__DSHM_BOOT_RESCUE_ACTIVE__ = false; } catch (activeError) { /* ignore */ }
  }

  function onPageStateChange(state) {
    try {
      if (state === "failure") {
        if (!INSERTED) startWatching();
        return;
      }
      // 健康页/加载页/未知状态：救援入口不得残留。
      removeRescueEntry();
      stopWatching();
    } catch (error) {
      // ignore
    }
  }

  boot();
  try {
    var pageStateApi = window.__DSHM_PAGE_STATE__;
    if (pageStateApi && typeof pageStateApi.onChange === "function") {
      pageStateApi.onChange(onPageStateChange);
    }
  } catch (pageStateError) {
    // ignore：旧页面/异常环境下仍按 boot 的初始探测工作
  }
})();

// ===== dshm-boot-rescue v1.1.0 正常页统一面板（与失败页救援脚本同文件、零依赖） =====
// 约束：只用 var/function 传统语法；无 JSX/无构建；全部逻辑 try/catch；零遥测；
// 不使用 setInterval、不自动刷新页面；所有写操作显式确认并由宿主复核。
(function () {
  "use strict";

  try {
    if (window.__DSHM_SECURITY_PANEL__) return;
    window.__DSHM_SECURITY_PANEL__ = true;
  } catch (error) {
    return;
  }

  var API = "/dshm-boot-rescue";
  var LAUNCH_DELAY_MS = 1200;
  var HEALTH_TIMEOUT_MS = 4000;
  var JOB_POLL_MS = 1200;
  var JOB_POLL_MAX = 600;
  var FAILURE_TITLE = "Failed to load plugins";
  var HEALTHY_UI_SELECTOR = '[role="tree"],textarea,[contenteditable="true"],[role="textbox"],input:not([type="hidden"])';
  var PANEL_ATTR = "data-dshm-security-panel";
  var STYLE_ATTR = "data-dshm-security-panel-style";
  var RUNTIME_VERSION_ATTR = "data-dshm-security-runtime-version";
  var LAUNCHER_DRAG_THRESHOLD = 7;
  var RESTART_GUIDE = "写入成功≠故障已修复：请划掉后台重新打开应用（冷重启）；重启前不要新建会话。";

  var model = {
    open: false,
    tab: "rescue",
    busy: false,
    data: null,
    status: "",
    tone: "",
    selectedEntry: "",
    selectedBackup: "",
    preview: null,
    jobTimer: null,
    jobAttempts: 0,
    launcher: null,
    panel: null,
    runtimeVersion: "",
    launcherPositioned: false,
    launcherCleanup: null
  };

  function pageState() {
    try {
      var shared = window.__DSHM_PAGE_STATE__;
      if (shared && typeof shared.get === "function") return shared.get();
    } catch (error) {
      // fallthrough
    }
    return "unknown";
  }

  function isFailurePage() {
    return pageState() === "failure";
  }

  function rescueEntryActive() {
    try {
      return window.__DSHM_BOOT_RESCUE_ACTIVE__ === true;
    } catch (error) {
      return false;
    }
  }

  function request(method, path, body) {
    var init = {
      method: method,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "accept": "application/json" }
    };
    if (body !== undefined && body !== null) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var controller = null;
    try {
      if (typeof AbortController === "function") {
        controller = new AbortController();
        init.signal = controller.signal;
        setTimeout(function () { try { controller.abort(); } catch (_) { /* ignore */ } }, HEALTH_TIMEOUT_MS * 3);
      }
    } catch (_) {
      controller = null;
    }
    return fetch(API + path, init).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = null; }
        if (!response.ok) {
          var error = new Error(payload && payload.error ? payload.error : "HTTP " + response.status);
          error.code = payload && payload.code ? payload.code : "HTTP_" + response.status;
          error.payload = payload;
          throw error;
        }
        return payload;
      });
    });
  }

  function setStatus(text, tone) {
    model.status = String(text || "");
    model.tone = tone || "";
    renderStatusOnly();
  }

  function renderStatusOnly() {
    try {
      var node = document.querySelector("[" + PANEL_ATTR + '="status"]');
      if (!node) return;
      node.textContent = model.status;
      node.className = "dshm-sec-status" + (model.tone ? " dshm-sec-status-" + model.tone : "");
    } catch (error) {
      // ignore
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(label, options) {
    var opts = options || {};
    var node = el("button", "dshm-sec-btn" + (opts.primary ? " dshm-sec-btn-primary" : "") + (opts.danger ? " dshm-sec-btn-danger" : ""), label);
    node.type = "button";
    node.disabled = opts.disabled === true;
    if (opts.title) node.title = String(opts.title);
    if (typeof opts.onClick === "function" && opts.disabled !== true) {
      node.addEventListener("click", function () {
        try { opts.onClick(); } catch (error) { setStatus("操作异常：" + errorMessage(error), "error"); }
      });
    }
    return node;
  }

  function errorMessage(error) {
    try {
      return error && error.message ? String(error.message) : String(error);
    } catch (_) {
      return "未知错误";
    }
  }

  function ensureStyle() {
    try {
      if (document.querySelector("style[" + STYLE_ATTR + "]")) return;
      var style = document.createElement("style");
      style.setAttribute(STYLE_ATTR, "1");
      style.textContent = [
        ".dshm-sec-launcher{position:fixed;right:18px;bottom:18px;z-index:2147483000;border:1px solid rgba(0,0,0,.18);border-radius:999px;background:#1d232b;color:#fff;font:600 13px/1 system-ui,sans-serif;padding:11px 16px;box-shadow:0 6px 18px rgba(0,0,0,.22);cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}",
        ".dshm-sec-launcher-dragging{cursor:grabbing;opacity:.92}",
        ".dshm-sec-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(15,20,26,.42);display:flex;align-items:flex-end;justify-content:flex-end;padding:14px}",
        ".dshm-sec-panel{width:min(720px,calc(100vw - 28px));max-height:min(82vh,760px);display:flex;flex-direction:column;background:#fbfcfd;color:#1d232b;border:1px solid rgba(0,0,0,.14);border-radius:16px;box-shadow:0 18px 48px rgba(0,0,0,.28);overflow:hidden}",
        ".dshm-sec-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(0,0,0,.08);background:#fff}",
        ".dshm-sec-title{font:700 14px/1.3 system-ui,sans-serif;flex:1}",
        ".dshm-sec-sub{font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#6b7682}",
        ".dshm-sec-close{border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:#6b7682}",
        ".dshm-sec-tabs{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid rgba(0,0,0,.08);background:#fff}",
        ".dshm-sec-tab{border:1px solid rgba(0,0,0,.12);background:#f2f4f7;border-radius:999px;padding:6px 12px;font:600 12px system-ui,sans-serif;cursor:pointer;color:#33404d}",
        ".dshm-sec-tab.active{background:#1d232b;color:#fff;border-color:#1d232b}",
        ".dshm-sec-body{padding:12px 14px;overflow:auto;font:12px/1.55 system-ui,sans-serif}",
        ".dshm-sec-note{padding:9px 10px;border-radius:10px;background:#fff7e6;border:1px solid #f3d19e;color:#6b4a09;margin:0 0 10px;font-size:12px}",
        ".dshm-sec-note-error{background:#fff1f0;border-color:#ffb3a7;color:#8a1f11}",
        ".dshm-sec-note-ok{background:#f0f9f2;border-color:#b7e1c1;color:#1f5f33}",
        ".dshm-sec-card{border:1px solid rgba(0,0,0,.1);border-radius:12px;padding:10px 12px;margin-bottom:10px;background:#fff}",
        ".dshm-sec-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}",
        ".dshm-sec-btn{border:1px solid rgba(0,0,0,.16);background:#fff;border-radius:8px;padding:7px 11px;font:600 12px system-ui,sans-serif;cursor:pointer;color:#26313c}",
        ".dshm-sec-btn:disabled{opacity:.45;cursor:not-allowed}",
        ".dshm-sec-btn-primary{background:#1d232b;color:#fff;border-color:#1d232b}",
        ".dshm-sec-btn-danger{background:#fff1f0;color:#8a1f11;border-color:#ffb3a7}",
        ".dshm-sec-list{margin:0;padding:0;list-style:none;max-height:220px;overflow:auto}",
        ".dshm-sec-item{display:flex;gap:8px;align-items:flex-start;padding:7px 6px;border-radius:8px}",
        ".dshm-sec-item:nth-child(odd){background:#f6f8fa}",
        ".dshm-sec-mono{font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#56616d;word-break:break-all}",
        ".dshm-sec-status{min-height:18px;margin-top:8px;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#56616d;white-space:pre-wrap}",
        ".dshm-sec-status-error{color:#8a1f11}",".dshm-sec-status-ok{color:#1f5f33}",
        ".dshm-sec-checkbox{margin-top:2px}"
      ].join("\n");
      document.head.appendChild(style);
    } catch (error) {
      // ignore
    }
  }

  function normalizeRuntimeVersion(payload) {
    try {
      if (!payload || typeof payload !== "object" || payload.ok !== true) return "";
      var value = payload.version;
      if (typeof value !== "string") return "";
      value = value.trim();
      if (value.length === 0 || value.length > 120) return "";
      return value;
    } catch (error) {
      return "";
    }
  }

  function renderRuntimeVersion() {
    try {
      var node = model.panel && model.panel.versionNode;
      if (node) node.textContent = "运行版本：" + (model.runtimeVersion || "未知");
    } catch (error) {
      // ignore
    }
  }

  function setRuntimeVersion(value) {
    model.runtimeVersion = typeof value === "string" ? value : "";
    renderRuntimeVersion();
  }

  function launcherVisible() {
    return model.launcher && model.launcher.parentNode;
  }

  function viewportSize() {
    var width = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
    var height = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    return { width: width, height: height };
  }

  function clampLauncherPosition(left, top, width, height) {
    var viewport = viewportSize();
    var maxLeft = Math.max(0, viewport.width - width);
    var maxTop = Math.max(0, viewport.height - height);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop)
    };
  }

  function setLauncherPosition(node, left, top) {
    node.style.left = Math.round(left) + "px";
    node.style.top = Math.round(top) + "px";
    node.style.right = "auto";
    node.style.bottom = "auto";
    model.launcherPositioned = true;
  }

  function clampCurrentLauncher() {
    try {
      if (!model.launcher || !model.launcherPositioned) return;
      var rect = model.launcher.getBoundingClientRect();
      var position = clampLauncherPosition(rect.left, rect.top, rect.width, rect.height);
      setLauncherPosition(model.launcher, position.left, position.top);
    } catch (error) {
      // ignore
    }
  }

  function showLauncher() {
    try {
      if (pageState() !== "healthy" || rescueEntryActive()) return;
      if (launcherVisible()) return;
      ensureStyle();
      var node = el("button", "dshm-sec-launcher", "安全中心");
      node.type = "button";
      node.setAttribute("data-dshm-security-launcher", "1");
      var suppressClick = false;
      var activePointer = null;

      function onViewportChange() {
        clampCurrentLauncher();
      }

      function releasePointerCapture(pointerId) {
        try {
          if (node.hasPointerCapture && node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
        } catch (error) {
          // ignore
        }
      }

      function finishPointer(event) {
        if (!activePointer || !event || event.pointerId !== activePointer.pointerId) return;
        var moved = activePointer.moved;
        activePointer = null;
        releasePointerCapture(event.pointerId);
        try { node.classList.remove("dshm-sec-launcher-dragging"); } catch (error) { /* ignore */ }
        if (moved) suppressClick = true;
      }

      node.addEventListener("click", function (event) {
        if (suppressClick && event && event.detail > 0) {
          suppressClick = false;
          return;
        }
        suppressClick = false;
        openPanel();
      });

      node.addEventListener("pointerdown", function (event) {
        try {
          if (activePointer) return;
          if (!event.isPrimary) return;
          if (event.pointerType === "mouse" && event.button !== 0) return;
          suppressClick = false;
          var rect = node.getBoundingClientRect();
          activePointer = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: rect.left,
            startTop: rect.top,
            moved: false
          };
          if (node.setPointerCapture) node.setPointerCapture(event.pointerId);
        } catch (error) {
          activePointer = null;
        }
      });

      node.addEventListener("pointermove", function (event) {
        try {
          if (!activePointer || event.pointerId !== activePointer.pointerId) return;
          var dx = event.clientX - activePointer.startX;
          var dy = event.clientY - activePointer.startY;
          if (!activePointer.moved && (dx * dx + dy * dy) < (LAUNCHER_DRAG_THRESHOLD * LAUNCHER_DRAG_THRESHOLD)) return;
          if (!activePointer.moved) {
            activePointer.moved = true;
            node.classList.add("dshm-sec-launcher-dragging");
          }
          var position = clampLauncherPosition(activePointer.startLeft + dx, activePointer.startTop + dy, node.offsetWidth, node.offsetHeight);
          setLauncherPosition(node, position.left, position.top);
          if (event.cancelable) event.preventDefault();
        } catch (error) {
          // ignore
        }
      });

      node.addEventListener("pointerup", finishPointer);
      node.addEventListener("pointercancel", function (event) {
        try {
          if (activePointer && event && event.pointerId === activePointer.pointerId) {
            suppressClick = true;
            finishPointer(event);
          }
        } catch (error) {
          // ignore
        }
      });
      node.addEventListener("lostpointercapture", function (event) {
        try {
          if (activePointer && event && event.pointerId === activePointer.pointerId) finishPointer(event);
        } catch (error) {
          // ignore
        }
      });

      window.addEventListener("resize", onViewportChange);
      window.addEventListener("orientationchange", onViewportChange);
      model.launcherCleanup = function () {
        try {
          if (activePointer) {
            releasePointerCapture(activePointer.pointerId);
            activePointer = null;
          }
          node.classList.remove("dshm-sec-launcher-dragging");
        } catch (error) {
          // ignore
        }
        try { window.removeEventListener("resize", onViewportChange); } catch (error) { /* ignore */ }
        try { window.removeEventListener("orientationchange", onViewportChange); } catch (error) { /* ignore */ }
      };
      document.body.appendChild(node);
      model.launcher = node;
      model.launcherPositioned = false;
    } catch (error) {
      // ignore
    }
  }

  function openPanel() {
    try {
      if (model.open) return;
      ensureStyle();
      if (!model.panel) buildPanel();
      model.open = true;
      document.body.appendChild(model.panel.overlay);
      refreshState();
    } catch (error) {
      // ignore
    }
  }

  function closePanel() {
    try {
      model.open = false;
      stopJobPolling();
      if (model.panel && model.panel.overlay && model.panel.overlay.parentNode) {
        model.panel.overlay.parentNode.removeChild(model.panel.overlay);
      }
    } catch (error) {
      // ignore
    }
  }

  function buildPanel() {
    var overlay = el("div", "dshm-sec-overlay");
    var panel = el("div", "dshm-sec-panel");
    var head = el("div", "dshm-sec-head");
    var titles = el("div", "dshm-sec-title");
    var title = el("div", "", "DSHM 安全中心");
    var sub = el("div", "dshm-sec-sub", "救援 / 备份 / 恢复 · 纯本机回环");
    var runtimeVersion = el("div", "dshm-sec-sub", "运行版本：未知");
    runtimeVersion.setAttribute(RUNTIME_VERSION_ATTR, "1");
    titles.appendChild(title);
    titles.appendChild(sub);
    titles.appendChild(runtimeVersion);
    var close = el("button", "dshm-sec-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭");
    close.addEventListener("click", closePanel);
    head.appendChild(titles);
    head.appendChild(close);

    var tabs = el("div", "dshm-sec-tabs");
    var tabSpecs = [["rescue", "救援"], ["backup", "备份/恢复"], ["status", "状态/诊断"]];
    var tabNodes = {};
    for (var i = 0; i < tabSpecs.length; i += 1) {
      (function (key, label) {
        var node = el("button", "dshm-sec-tab", label);
        node.type = "button";
        node.addEventListener("click", function () {
          model.tab = key;
          renderPanel();
          refreshStateIfNeeded();
        });
        tabs.appendChild(node);
        tabNodes[key] = node;
      })(tabSpecs[i][0], tabSpecs[i][1]);
    }

    var body = el("div", "dshm-sec-body");
    var status = el("div", "dshm-sec-status");
    status.setAttribute(PANEL_ATTR, "status");
    body.appendChild(status);

    panel.appendChild(head);
    panel.appendChild(tabs);
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener("click", function (event) {
      if (event && event.target === overlay) closePanel();
    });
    model.panel = { overlay: overlay, panel: panel, body: body, status: status, tabs: tabNodes, versionNode: runtimeVersion };
    renderRuntimeVersion();
  }

  function refreshStateIfNeeded() {
    if (model.open && !model.data) refreshState();
  }

  function refreshState() {
    if (!model.open) return Promise.resolve();
    return request("GET", "/state").then(function (payload) {
      model.data = payload || {};
      renderPanel();
      return payload;
    }).catch(function (error) {
      model.data = null;
      renderPanel();
      setStatus("状态读取失败：" + errorMessage(error), "error");
    });
  }

  function backupState() {
    var data = model.data || {};
    return data.backup && typeof data.backup === "object" ? data.backup : null;
  }

  function renderPanel() {
    try {
      if (!model.panel) return;
      var body = model.panel.body;
      while (body.firstChild) body.removeChild(body.firstChild);
      var tabs = model.panel.tabs;
      for (var key in tabs) {
        if (Object.prototype.hasOwnProperty.call(tabs, key)) {
          tabs[key].className = "dshm-sec-tab" + (model.tab === key ? " active" : "");
        }
      }
      var statusNode = model.panel.status;
      body.appendChild(statusNode);
      if (model.tab === "rescue") renderRescue(body);
      else if (model.tab === "backup") renderBackup(body);
      else renderDiagnostics(body);
      statusNode.textContent = model.status;
      statusNode.className = "dshm-sec-status" + (model.tone ? " dshm-sec-status-" + model.tone : "");
    } catch (error) {
      setStatus("面板渲染异常：" + errorMessage(error), "error");
    }
  }

  function dataReady() {
    return !!(model.data && model.data.ok !== false);
  }

  function renderRescue(body) {
    var data = model.data || {};
    var card = el("div", "dshm-sec-card");
    var mode = String(data.mode || "unknown");
    var writable = data.writable === true;
    card.appendChild(el("div", "dshm-sec-sub", "模式：" + mode + " · 写入：" + (writable ? "可用" : "只读/不可用")));
    if (data.readOnlyReason) {
      var note = el("div", "dshm-sec-note dshm-sec-note-error", String(data.readOnlyReason));
      card.appendChild(note);
    }
    if (!dataReady()) {
      card.appendChild(el("div", "dshm-sec-note dshm-sec-note-error", "救援状态暂不可用：Host 可能尚未启动，或本页不是由宿主注入的安全中心页面。"));
      body.appendChild(card);
      return;
    }
    var entries = Array.isArray(data.entries) ? data.entries : [];
    card.appendChild(el("div", "", "疑似故障插件的 loader 行（仅展示可操作项；未映射真实 entry id 的候选已拒绝写入）："));
    var list = el("ul", "dshm-sec-list");
    var actionable = 0;
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i] || {};
      if (entry.actionable !== true) continue;
      actionable += 1;
      var item = el("li", "dshm-sec-item");
      var radio = el("input", "dshm-sec-checkbox");
      radio.type = "radio";
      radio.name = "dshm-sec-entry";
      radio.value = String(entry.id || "");
      radio.checked = model.selectedEntry === String(entry.id || "");
      radio.disabled = !writable;
      (function (id) {
        radio.addEventListener("change", function () { model.selectedEntry = id; });
      })(String(entry.id || ""));
      var meta = el("div", "");
      meta.appendChild(el("div", "dshm-sec-mono", String(entry.id || "?")));
      meta.appendChild(el("div", "dshm-sec-sub", "package=" + String(entry.packageName || "-") + " · name=" + String(entry.name || "-") + " · 风险=" + String(entry.risk || "-")));
      item.appendChild(radio);
      item.appendChild(meta);
      list.appendChild(item);
    }
    if (actionable === 0) {
      card.appendChild(el("div", "dshm-sec-note", "没有可操作的第三方插件行。救援只处理用户明确选择、且能证明 id 映射的第三方行；不会停用自己、@deepseek-ai/* 内置或无法确认的核心行。"));
    } else {
      card.appendChild(list);
    }
    var row = el("div", "dshm-sec-row");
    row.appendChild(button("停用选中行（单层写入）", {
      primary: true,
      disabled: !writable || model.busy,
      title: writable ? "写入 .dshm-plugin-rows.yml；写入后需冷重启；不会自动叠加 home patch 或 bundles 层" : "当前为只读/不可用状态",
      onClick: disableSelected
    }));
    row.appendChild(button("回滚本插件救援写入", {
      disabled: !writable || model.busy,
      title: writable ? "只删除本插件精确标记块；回滚可能重新启用故障插件" : "当前为只读/不可用状态",
      onClick: restoreRescue
    }));
    row.appendChild(button("刷新状态", { disabled: model.busy, onClick: refreshState }));
    card.appendChild(row);
    card.appendChild(el("div", "dshm-sec-note", "救援每次只执行一个经确认的写入层：默认仅写 profile 的 .dshm-plugin-rows.yml（单层）。不会在 rows 失败后自动升级到 home patch 或 bundles 层。写入成功不代表故障已修复；请冷重启，重启后回到本面板确认 loader 行已 disabled。"));
    body.appendChild(card);
  }

  function renderBackup(body) {
    var data = model.data || {};
    var backup = backupState();
    var coexist = data.coexistence || (backup ? backup.coexistence : null);
    if (coexist && coexist.writeAllowed !== true) {
      body.appendChild(el("div", "dshm-sec-note dshm-sec-note-error", "检测到旧备份插件，备份写入处于共存只读模式。" + String(coexist.reason || "")));
    }
    if (!backup) {
      body.appendChild(el("div", "dshm-sec-note dshm-sec-note-error", "备份服务状态不可用（Host 侧备份模块未就绪）。"));
      return;
    }
    if (backup.unavailable === true) {
      body.appendChild(el("div", "dshm-sec-note dshm-sec-note-error", String(backup.error || "备份服务不可用")));
      return;
    }
    var writeAllowed = backup.writeAllowed === true;
    var card = el("div", "dshm-sec-card");
    card.appendChild(el("div", "dshm-sec-sub", "备份目录：" + String(backup.backupDir || "-") + (backup.backupDirVisible === true ? "（用户可见）" : "（沙箱内）")));
    if (backup.writeBlockedReason) card.appendChild(el("div", "dshm-sec-note", String(backup.writeBlockedReason)));

    var list = Array.isArray(backup.backups) ? backup.backups : [];
    var listNode = el("ul", "dshm-sec-list");
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i] || {};
      var row = el("li", "dshm-sec-item");
      var radio = el("input", "dshm-sec-checkbox");
      radio.type = "radio";
      radio.name = "dshm-sec-backup";
      radio.value = String(item.file || "");
      radio.checked = model.selectedBackup === String(item.file || "");
      (function (file) {
        radio.addEventListener("change", function () {
          model.selectedBackup = file;
          model.preview = null;
        });
      })(String(item.file || ""));
      var meta = el("div", "");
      meta.appendChild(el("div", "dshm-sec-mono", String(item.name || "?") + (item.storage === "legacy" ? " · 旧插件既有备份（只读发现）" : "")));
      meta.appendChild(el("div", "dshm-sec-sub", "kind=" + String(item.kind || "-") + " · " + String(item.size || 0) + "B · verified=" + (item.verified === true ? "yes" : "no") + " · sha256=" + String(item.sha256 || "-").slice(0, 16)));
      row.appendChild(radio);
      row.appendChild(meta);
      listNode.appendChild(row);
    }
    if (list.length === 0) listNode.appendChild(el("li", "dshm-sec-sub", "暂无备份（新实例或备份目录为空）。"));
    card.appendChild(listNode);

    var row1 = el("div", "dshm-sec-row");
    row1.appendChild(button("立即备份（手动）", {
      primary: true,
      disabled: !writeAllowed || model.busy,
      title: writeAllowed ? "创建手动备份并做 SHA-256 校验；故障状态下手动备份不会标为健康基线" : "共存只读/不可写",
      onClick: function () { createBackup("manual"); }
    }));
    row1.appendChild(button("紧急备份", {
      disabled: !writeAllowed || model.busy,
      title: writeAllowed ? "异常抢备（故障状态不标健康基线）" : "共存只读/不可写",
      onClick: createEmergency
    }));
    row1.appendChild(button("校验选中", { disabled: model.busy || !model.selectedBackup, onClick: verifySelectedBackup }));
    row1.appendChild(button("预览导入", { disabled: model.busy || !model.selectedBackup, onClick: inspectSelectedBackup }));
    card.appendChild(row1);

    var row2 = el("div", "dshm-sec-row");
    row2.appendChild(button("确认恢复（必须先预览）", {
      danger: true,
      disabled: !writeAllowed || model.busy || !model.preview || model.preview.canRestore !== true,
      title: model.preview ? "恢复会覆盖当前实例；核心版本/格式必须 exact，预览无冲突才允许" : "先选择备份并点“预览导入”",
      onClick: restorePreview
    }));
    row2.appendChild(button("刷新备份状态", { disabled: model.busy, onClick: refreshState }));
    card.appendChild(row2);

    if (model.preview) {
      var preview = model.preview;
      var pv = el("div", "dshm-sec-card");
      pv.appendChild(el("div", "", "导入预览（尚未写入）"));
      pv.appendChild(el("div", "dshm-sec-mono", "预览ID=" + String(preview.previewId || "-") + " · 可恢复=" + (preview.canRestore === true ? "yes" : "no") + " · 版本级别=" + String(preview.versionLevel || "unknown")));
      if (Array.isArray(preview.conflicts) && preview.conflicts.length > 0) {
        pv.appendChild(el("div", "dshm-sec-note dshm-sec-note-error", "预览存在冲突：" + JSON.stringify(preview.conflicts).slice(0, 800)));
      }
      if (preview.versionLevel && preview.versionLevel !== "exact") {
        pv.appendChild(el("div", "dshm-sec-note dshm-sec-note-error", "核心版本/格式不是 exact：禁止恢复（同核心版本是硬门槛，无跨版本确认旁路）。"));
      }
      card.appendChild(pv);
    }

    var job = backup.job;
    if (job) {
      var jobNode = el("div", "dshm-sec-note", "任务 " + String(job.kind || "") + " 状态：" + String(job.phase || "") + " " + String(job.percent || 0) + "% " + String(job.message || ""));
      if (job.error && job.error.message) jobNode.className = "dshm-sec-note dshm-sec-note-error";
      card.appendChild(jobNode);
    }
    if (backup.restore && backup.restore.pendingRestart === true) {
      card.appendChild(el("div", "dshm-sec-note dshm-sec-note-error", "恢复已完成，必须冷重启；重启前不要新建会话。"));
    }
    body.appendChild(card);
  }

  function renderDiagnostics(body) {
    var data = model.data || {};
    var backup = backupState();
    var card = el("div", "dshm-sec-card");
    card.appendChild(el("div", "", "宿主状态"));
    card.appendChild(el("div", "dshm-sec-mono", JSON.stringify({
      version: data.version || null,
      mode: data.mode || null,
      writable: data.writable === true,
      generatedAt: data.generatedAt || null,
      rowsPath: data.rowsPath || null,
      profileDir: data.profileDir || null,
      coexistState: data.coexistence ? data.coexistence.state : null
    }, null, 2)));
    var diag = el("div", "dshm-sec-mono");
    diag.textContent = JSON.stringify({ rescue: data.diagnostics || null, backup: backup ? backup.diagnostics || null : null }, null, 2);
    card.appendChild(diag);
    if (Array.isArray(data.limitations) && data.limitations.length > 0) {
      var ul = el("ul", "dshm-sec-list");
      for (var i = 0; i < data.limitations.length; i += 1) ul.appendChild(el("li", "dshm-sec-item", String(data.limitations[i])));
      card.appendChild(el("div", "", "边界与限制"));
      card.appendChild(ul);
    }
    body.appendChild(card);
  }

  function disableSelected() {
    var id = String(model.selectedEntry || "");
    if (!id) { setStatus("先选择要停用的插件行。", "error"); return; }
    if (!window.confirm("停用 " + id + " ？\n\n只写入一个加载层（.dshm-plugin-rows.yml），不会自动叠加 home patch 或 bundles。写入后需要划掉后台重新打开应用。")) return;
    model.busy = true;
    renderPanel();
    request("POST", "/disable", { ids: [id] }).then(function (payload) {
      setStatus("已写入停用行：" + id + "（mode=" + String(payload && payload.mode) + "）。" + RESTART_GUIDE, "ok");
      return refreshState();
    }).catch(function (error) {
      setStatus("停用失败：" + errorMessage(error), "error");
    }).then(function () {
      model.busy = false;
      renderPanel();
    });
  }

  function restoreRescue() {
    if (!window.confirm("回滚本插件写入的救援停用行？\n\n只删除本插件精确标记块；回滚可能重新启用故障插件。")) return;
    model.busy = true;
    renderPanel();
    request("POST", "/restore", {}).then(function (payload) {
      setStatus("已回滚：" + JSON.stringify(payload && payload.restored ? payload.restored : []) + "。" + RESTART_GUIDE, "ok");
      return refreshState();
    }).catch(function (error) {
      setStatus("回滚失败：" + errorMessage(error), "error");
    }).then(function () {
      model.busy = false;
      renderPanel();
    });
  }

  function createBackup(kind) {
    if (!window.confirm("开始" + (kind === "baseline" ? "健康基线" : "手动") + "备份？备份包含明文聊天/工作区内容，请妥善保管。")) return;
    model.busy = true;
    renderPanel();
    request("POST", "/backup/api/backup", { kind: kind }).then(function (payload) {
      setStatus("备份任务已创建：" + String(payload && payload.jobId) + "。", "ok");
      startJobPolling();
      return refreshState();
    }).catch(function (error) {
      setStatus("备份启动失败：" + errorMessage(error), "error");
    }).then(function () {
      model.busy = false;
      renderPanel();
    });
  }

  function createEmergency() {
    if (!window.confirm("立即创建一次紧急备份？故障状态下的备份不会标为健康基线。")) return;
    model.busy = true;
    renderPanel();
    request("POST", "/backup/api/emergency", {}).then(function (payload) {
      setStatus(payload && payload.started ? "紧急备份已开始。" : "紧急备份未开始：" + String(payload && payload.reason ? payload.reason : ""), payload && payload.started ? "ok" : "error");
      if (payload && payload.started) startJobPolling();
      return refreshState();
    }).catch(function (error) {
      setStatus("紧急备份失败：" + errorMessage(error), "error");
    }).then(function () {
      model.busy = false;
      renderPanel();
    });
  }

  function verifySelectedBackup() {
    var file = String(model.selectedBackup || "");
    if (!file) return;
    model.busy = true;
    renderPanel();
    request("POST", "/backup/api/verify", { file: file }).then(function (payload) {
      setStatus(payload && payload.ok ? "校验通过（SHA-256 一致）。" : "校验未通过：" + JSON.stringify(payload && payload.errors ? payload.errors : []), payload && payload.ok ? "ok" : "error");
      return refreshState();
    }).catch(function (error) {
      setStatus("校验失败：" + errorMessage(error), "error");
    }).then(function () {
      model.busy = false;
      renderPanel();
    });
  }

  function inspectSelectedBackup() {
    var file = String(model.selectedBackup || "");
    if (!file) return;
    model.busy = true;
    renderPanel();
    request("POST", "/backup/api/inspect", { file: file }).then(function (payload) {
      model.preview = payload && payload.preview ? payload.preview : null;
      if (payload && payload.previewId) model.preview.previewId = payload.previewId;
      setStatus("预览完成（尚未写入）。请检查冲突与版本提示后再确认恢复。", "ok");
      renderPanel();
    }).catch(function (error) {
      setStatus("预览失败：" + errorMessage(error), "error");
    }).then(function () {
      model.busy = false;
      renderPanel();
    });
  }

  function restorePreview() {
    if (!model.preview) return;
    if (!window.confirm("确认恢复？这会覆盖当前实例的会话/工作区内容（目标必须为全新实例、核心版本一致）。恢复后必须冷重启，重启前不要新建会话。")) return;
    var payload = { confirm: true, previewId: String(model.preview.previewId || "") };
    if (model.preview.canRestore !== true) {
      setStatus("预览结果不可恢复（冲突或核心版本/格式不是 exact）；不允许跨核心恢复。", "error");
      return;
    }
    model.busy = true;
    renderPanel();
    request("POST", "/backup/api/restore", payload).then(function (response) {
      setStatus("恢复任务已创建：" + String(response && response.jobId) + "。恢复完成后必须冷重启，重启前不要新建会话。", "ok");
      startJobPolling();
      return refreshState();
    }).catch(function (error) {
      setStatus("恢复启动失败：" + errorMessage(error), "error");
    }).then(function () {
      model.busy = false;
      renderPanel();
    });
  }

  function stopJobPolling() {
    if (model.jobTimer) {
      clearTimeout(model.jobTimer);
      model.jobTimer = null;
    }
  }

  function startJobPolling() {
    stopJobPolling();
    model.jobAttempts = 0;
    scheduleJobPoll();
  }

  function scheduleJobPoll() {
    if (!model.open) return;
    if (model.jobAttempts >= JOB_POLL_MAX) return;
    model.jobTimer = setTimeout(function () {
      model.jobTimer = null;
      model.jobAttempts += 1;
      request("GET", "/backup/api/state").then(function (payload) {
        if (!model.data) model.data = {};
        model.data.backup = payload;
        renderPanel();
        var job = payload && payload.job;
        if (job && job.running === true) {
          scheduleJobPoll();
        } else if (job) {
          setStatus(job.phase === "done" ? "任务完成。" + (job.kind === "restore" ? "必须冷重启；重启前不要新建会话。" : "") : "任务失败：" + String(job.message || ""), job.phase === "done" ? "ok" : "error");
          refreshState();
        }
      }).catch(function () {
        if (model.jobAttempts < JOB_POLL_MAX) scheduleJobPoll();
      });
    }, JOB_POLL_MS);
  }

  function bootstrap() {
    try {
      if (pageState() !== "healthy" || rescueEntryActive()) return;
      request("GET", "/health").then(function (payload) {
        setRuntimeVersion(normalizeRuntimeVersion(payload));
        if (payload && payload.ok === true && pageState() === "healthy" && !rescueEntryActive()) showLauncher();
      }).catch(function () {
        setRuntimeVersion("");
        // Host 不可用：不显示虚假在线状态，也不显示面板
      });
    } catch (error) {
      // ignore
    }
  }

  function removeLauncher() {
    try {
      if (model.launcherCleanup) model.launcherCleanup();
    } catch (error) {
      // ignore
    }
    try {
      if (model.launcher && model.launcher.parentNode) model.launcher.parentNode.removeChild(model.launcher);
    } catch (error) {
      // ignore
    }
    model.launcher = null;
    model.launcherCleanup = null;
    model.launcherPositioned = false;
  }

  function onPageStateChange(state) {
    try {
      if (state === "healthy" && !rescueEntryActive()) {
        setTimeout(bootstrap, 0);
        return;
      }
      // 失败页/pending-only、loading、未知状态：安全中心启动器不得残留。
      removeLauncher();
      if ((state === "failure" || state === "loading") && model.open) closePanel();
    } catch (error) {
      // ignore
    }
  }

  function start() {
    try {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
          setTimeout(bootstrap, LAUNCH_DELAY_MS);
          try {
            var api = window.__DSHM_PAGE_STATE__;
            if (api && typeof api.onChange === "function") api.onChange(onPageStateChange);
          } catch (error) {
            // ignore
          }
        });
      } else {
        setTimeout(bootstrap, LAUNCH_DELAY_MS);
        try {
          var api = window.__DSHM_PAGE_STATE__;
          if (api && typeof api.onChange === "function") api.onChange(onPageStateChange);
        } catch (error) {
          // ignore
        }
      }
    } catch (error) {
      // ignore
    }
  }

  start();
})();
