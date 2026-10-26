// dshm-boot-rescue v1.1.0 — 旧 dshm-backup 共存状态机（全 fail closed）。
//
// 规则（确认的设计修正 §1）：
//   · 只有“明确确认旧插件已移除，且有效 profile manifest 不再登记”才允许 absent/writeAllowed:true；
//   · 已安装但未登记的残留目录按既有设计视为残留（仍 absent），但前提是 manifest 读取成功；
//   · home/profile/manifest/loader/rows 任一无法确认 ⇒ unknown / writeAllowed:false；
//   · “确认不存在/未登记”和“读取失败”必须分开表达，不得用默认 false 表示未知；
//   · 不自动停用/卸载旧插件；不在运行时动态放开写入（只按本次启动的事实判定）。
// 策略表在 coexistence-policy.json，运行时与测试共用同一份数据。

import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";

const POLICY_PATH = new URL("./coexistence-policy.json", import.meta.url);
const LEGACY_PACKAGE = "dshm-backup";

let policyCache = null;
export function loadPolicy() {
  if (policyCache !== null) return policyCache;
  const raw = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  if (!raw || typeof raw !== "object" || !raw.states || typeof raw.states !== "object") {
    throw new Error("coexistence-policy.json 结构非法");
  }
  policyCache = raw;
  return policyCache;
}

function policyEntry(state) {
  const entry = loadPolicy().states[state];
  if (!entry) throw new Error("未知共存状态：" + String(state));
  return entry;
}

export function unknownCoexistence(reason) {
  const entry = policyEntry("unknown");
  return {
    state: "unknown",
    writeAllowed: false,
    reason: typeof reason === "string" && reason.length > 0 ? reason : entry.reason,
    label: entry.label,
    facts: { known: false },
  };
}

function probeDirectory(dir) {
  try {
    return lstatSync(dir).isDirectory();
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    return null; // 明确区分“不存在”和“读取失败/未知”
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * profile manifest 的“结构可确认”判定（不是“JSON 能解析”就算合法）：
 *   · 顶层必须是非数组对象；
 *   · dependencies / peerDependencies 若存在必须是普通对象；
 *   · dsh 若存在必须是普通对象；dsh.profile 若存在必须是普通对象；
 *   · dsh.profile.bundles 若存在必须是字符串数组。
 * 任一相关字段结构非法/无法解释 ⇒ known=false（调用方必须收敛到 unknown）。
 */
export function manifestStructuralFact(value) {
  if (!isPlainObject(value)) return { known: false, error: "manifest 顶层不是非数组对象" };
  const deps = value.dependencies;
  if (deps !== undefined && !isPlainObject(deps)) return { known: false, error: "dependencies 结构非法" };
  const peer = value.peerDependencies;
  if (peer !== undefined && !isPlainObject(peer)) return { known: false, error: "peerDependencies 结构非法" };
  const dsh = value.dsh;
  if (dsh !== undefined && !isPlainObject(dsh)) return { known: false, error: "dsh 结构非法" };
  if (isPlainObject(dsh)) {
    const profile = dsh.profile;
    if (profile !== undefined && !isPlainObject(profile)) return { known: false, error: "dsh.profile 结构非法" };
    if (isPlainObject(profile) && profile.bundles !== undefined) {
      if (!Array.isArray(profile.bundles) || profile.bundles.some((item) => typeof item !== "string")) {
        return { known: false, error: "dsh.profile.bundles 不是字符串数组" };
      }
    }
  }
  return { known: true, error: "" };
}

function readJsonFact(filename, structuralCheck) {
  let text = null;
  try {
    text = readFileSync(filename, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { known: true, exists: false, value: null, error: "" };
    return { known: false, exists: false, value: null, error: "读取失败：" + String(error && error.code ? error.code : error) };
  }
  let value = null;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { known: false, exists: true, value: null, error: "JSON 非法" };
  }
  if (typeof structuralCheck === "function") {
    const structural = structuralCheck(value);
    if (!structural || structural.known !== true) {
      return { known: false, exists: true, value: null, error: "结构非法：" + String((structural && structural.error) || "unknown") };
    }
  }
  return { known: true, exists: true, value: value, error: "" };
}

function manifestRegistersLegacy(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const fields = ["dependencies", "peerDependencies"];
  for (let i = 0; i < fields.length; i += 1) {
    const deps = manifest[fields[i]];
    if (deps && typeof deps === "object" && Object.prototype.hasOwnProperty.call(deps, LEGACY_PACKAGE)) return true;
  }
  const profile = manifest.dsh && typeof manifest.dsh === "object" ? manifest.dsh.profile : null;
  const bundles = profile && Array.isArray(profile.bundles) ? profile.bundles : null;
  return bundles !== null && bundles.indexOf(LEGACY_PACKAGE) !== -1;
}

/** 严格 rows 解析：只接受明确支持的语法；任何无法确认的结构 ⇒ known=false。 */
function isValidRowsId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/\s/.test(value)) return false;
  return /^[@A-Za-z0-9][A-Za-z0-9@._/:+-]*$/.test(value);
}

function stripYamlScalar(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (text.length >= 2) {
    const first = text.charAt(0);
    const last = text.charAt(text.length - 1);
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) return text.slice(1, -1);
  }
  return text;
}

function readRowsDisabledFact(rowsPath) {
  let text = null;
  try {
    text = readFileSync(rowsPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { known: true, exists: false, disabled: false, error: "" };
    return { known: false, exists: false, disabled: false, error: "读取失败：" + String(error && error.code ? error.code : error) };
  }
  if (text.indexOf("\t") !== -1) return { known: false, exists: true, disabled: false, error: "不支持的制表符缩进" };
  if (text.indexOf("\u0000") !== -1) return { known: false, exists: true, disabled: false, error: "包含 NUL 字符" };
  const rawLines = text.split("\n");
  const rows = [];
  let current = null;
  const seen = {};
  for (let i = 0; i < rawLines.length; i += 1) {
    let line = rawLines[i];
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;
    if (line.trim().startsWith("#")) continue;
    const rowMatch = /^-\s+id:\s*(\S.*)$/.exec(line);
    if (rowMatch) {
      const id = stripYamlScalar(rowMatch[1]);
      if (!isValidRowsId(id)) return { known: false, exists: true, disabled: false, error: "行 id 非法：" + String(rowMatch[1]).slice(0, 80) };
      if (seen[id]) return { known: false, exists: true, disabled: false, error: "重复的 row id：" + id };
      seen[id] = true;
      current = { id: id, disabled: false, disabledSeen: false };
      rows.push(current);
      continue;
    }
    const disabledMatch = /^ {2}disabled:\s*(true|false)\s*$/.exec(line);
    if (disabledMatch && current) {
      if (current.disabledSeen) return { known: false, exists: true, disabled: false, error: "同一行重复 disabled" };
      current.disabledSeen = true;
      current.disabled = disabledMatch[1] === "true";
      continue;
    }
    return { known: false, exists: true, disabled: false, error: "不支持的 rows 内容：" + line.slice(0, 120) };
  }
  let disabled = false;
  for (let r = 0; r < rows.length; r += 1) {
    if (rows[r].id === LEGACY_PACKAGE) disabled = rows[r].disabled === true;
  }
  return { known: true, exists: true, disabled: disabled, error: "" };
}

const MAX_LOADER_ENTRIES = 4096;

function loaderEntryValidationError(entry) {
  try {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "entry 必须是非 null 对象且非数组";
    const options = entry.options;
    if (options === null || typeof options !== "object" || Array.isArray(options)) return "entry.options 必须是非 null 对象且非数组";
    if (Object.prototype.hasOwnProperty.call(options, "id") && typeof options.id !== "string") return "entry.options.id 必须是字符串";
    if (Object.prototype.hasOwnProperty.call(options, "name") && typeof options.name !== "string") return "entry.options.name 必须是字符串";
    return "";
  } catch (error) {
    return "读取 entry/options 字段失败";
  }
}

function closeLoaderIterator(iterator) {
  try {
    if (iterator && typeof iterator.return === "function") iterator.return();
  } catch (error) {
    // 清理异常不得把失败改成功
  }
}

function isPlainLoaderValue(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch (error) {
    return false;
  }
}

const MAP_SIZE_GETTER = (function () {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(Map.prototype, "size");
    return descriptor && typeof descriptor.get === "function" ? descriptor.get : null;
  } catch (error) {
    return null;
  }
})();

const SET_SIZE_GETTER = (function () {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(Set.prototype, "size");
    return descriptor && typeof descriptor.get === "function" ? descriptor.get : null;
  } catch (error) {
    return null;
  }
})();

function isMapOrSetValue(value) {
  // 不使用 Object.prototype.toString / Symbol.toStringTag：后者可被伪装。
  // Map/Set 的真实内建 brand：size getter 只能在真实内建实例上成功。
  try {
    if (MAP_SIZE_GETTER !== null) {
      MAP_SIZE_GETTER.call(value);
      return true;
    }
  } catch (error) {
    // 不是真实 Map；继续尝试 Set
  }
  try {
    if (SET_SIZE_GETTER !== null) {
      SET_SIZE_GETTER.call(value);
      return true;
    }
  } catch (error) {
    // 不是真实 Set
  }
  return false;
}

/**
 * 严格、有界的 loader.entries() 物化：
 *   · Array 或同步非 plain iterable（含 core.96 的 generator）→ 逐条校验；
 *   · null/标量/Map/Set/plain object/async-only/array-like/异常 iterator → ok:false；
 *   · 最多 4096 项；失败/超限时尽力 iterator.return()，清理失败不改变 ok:false。
 * 不得把它解释为“未知即空数组”。
 */
export function materializeLoaderEntries(loader) {
  if (!loader || typeof loader.entries !== "function") return { ok: false, error: "loader.entries 不可用" };
  let raw = null;
  try {
    raw = loader.entries();
  } catch (error) {
    return { ok: false, error: "loader.entries() 抛错" };
  }
  try {
    if (Array.isArray(raw)) {
      if (raw.length > MAX_LOADER_ENTRIES) return { ok: false, error: "loader.entries() 超出 4096 项上限" };
      const entries = [];
      for (let i = 0; i < raw.length; i += 1) {
        const reason = loaderEntryValidationError(raw[i]);
        if (reason) return { ok: false, error: reason + "（第 " + (i + 1) + " 项）" };
        entries.push(raw[i]);
      }
      return { ok: true, entries: entries };
    }
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "loader.entries() 返回结构非法" };
    if (isMapOrSetValue(raw) || isPlainLoaderValue(raw)) return { ok: false, error: "loader.entries() 返回结构非法" };
    const iteratorMethod = raw[Symbol.iterator];
    if (typeof iteratorMethod !== "function") return { ok: false, error: "loader.entries() 返回结构非法" };
    let iterator = null;
    try {
      iterator = iteratorMethod.call(raw);
    } catch (error) {
      return { ok: false, error: "loader.entries() 无法获得同步 iterator" };
    }
    if (!iterator || typeof iterator.next !== "function") {
      closeLoaderIterator(iterator);
      return { ok: false, error: "loader.entries() 的 iterator 缺少 next()" };
    }
    const entries = [];
    while (true) {
      let step = null;
      try {
        step = iterator.next();
      } catch (error) {
        closeLoaderIterator(iterator);
        return { ok: false, error: "loader.entries() 迭代抛错" };
      }
      if (step === null || typeof step !== "object" || Array.isArray(step)) {
        closeLoaderIterator(iterator);
        return { ok: false, error: "loader.entries() 的 iterator 返回结构非法" };
      }
      let done = false;
      try {
        done = step.done;
      } catch (error) {
        closeLoaderIterator(iterator);
        return { ok: false, error: "读取 iterator 结果失败" };
      }
      if (done === true) return { ok: true, entries: entries };
      if (entries.length >= MAX_LOADER_ENTRIES) {
        closeLoaderIterator(iterator);
        return { ok: false, error: "loader.entries() 超出 4096 项上限" };
      }
      let value = null;
      try {
        value = step.value;
      } catch (error) {
        closeLoaderIterator(iterator);
        return { ok: false, error: "读取 iterator 条目失败" };
      }
      const reason = loaderEntryValidationError(value);
      if (reason) {
        closeLoaderIterator(iterator);
        return { ok: false, error: reason + "（第 " + (entries.length + 1) + " 项）" };
      }
      entries.push(value);
    }
  } catch (error) {
    return { ok: false, error: "loader.entries() 遍历失败" };
  }
}

export function findLoaderEntry(loader) {
  const materialized = materializeLoaderEntries(loader);
  if (!materialized.ok) return { known: false, entry: null, error: "loader.entries() 返回结构非法：" + materialized.error };
  const entries = materialized.entries;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const options = entry.options;
    const id = typeof options.id === "string" ? options.id : "";
    const name = typeof options.name === "string" ? options.name : "";
    if (id === LEGACY_PACKAGE || name === LEGACY_PACKAGE) return { known: true, entry: entry, error: "" };
  }
  return { known: true, entry: null, error: "" };
}

/**
 * 纯事实分类。facts 必须显式携带 known 标记：
 *   { homeKnown, profileKnown, manifest: {known,value}, installed: {known,value},
 *     loader: {known,entry}, rows: {known,disabled} }
 * 任一关键项 known=false ⇒ unknown（writeAllowed:false）。
 */
export function classifyLegacyBackup(facts) {
  const f = facts || {};
  const manifestFact = f.manifest || { known: false };
  let manifestFactKnown = manifestFact.known === true;
  if (manifestFactKnown) {
    const structural = manifestStructuralFact(manifestFact.value);
    if (!structural.known) manifestFactKnown = false;
  }
  const installedFact = f.installed || { known: false };
  const loaderFact = f.loader || { known: false };
  const rowsFact = f.rows || { known: false };
  const profileKnown = f.profileKnown === true;
  const homeKnown = f.homeKnown === true;
  let state = "unknown";
  let reason = "";
  if (!homeKnown || !profileKnown) {
    reason = "home/profile 无法确认（fail closed）";
  } else if (!manifestFactKnown) {
    reason = "profile manifest 读取失败或结构非法，无法确认旧插件是否已移除（fail closed）" + (manifestFact.error ? "：" + manifestFact.error : "");
  } else if (installedFact.known !== true) {
    reason = "无法确认旧插件安装状态（fail closed）";
  } else if (rowsFact.known !== true) {
    reason = "无法确认用户行文件状态（fail closed）";
  } else if (loaderFact.known !== true) {
    reason = "loader 状态无法确认（fail closed）" + (loaderFact.error ? "：" + loaderFact.error : "");
  } else {
    const installed = installedFact.value === true;
    const registered = manifestRegistersLegacy(manifestFact.value);
    if (!installed && !registered) {
      state = "absent";
    } else if (!registered) {
      // 已安装但未登记：残留目录，旧插件无法从 profile 启动。
      state = "absent";
    } else if (rowsFact.disabled === true) {
      state = "disabled";
    } else if (loaderFact.entry && loaderFact.entry.disabled === true) {
      state = "disabled";
    } else if (loaderFact.entry) {
      state = "enabled";
    } else {
      state = "registered-unmounted";
    }
  }
  const entry = policyEntry(state);
  return {
    state: state,
    writeAllowed: entry.writeAllowed === true,
    reason: reason.length > 0 ? reason : entry.reason,
    label: entry.label,
    facts: {
      homeKnown: homeKnown,
      profileKnown: profileKnown,
      manifestKnown: manifestFactKnown,
      installedKnown: installedFact.known === true,
      rowsKnown: rowsFact.known === true,
      loaderKnown: loaderFact.known === true,
      installed: installedFact.value === true,
      registered: manifestFactKnown ? manifestRegistersLegacy(manifestFact.value) : null,
      rowsDisabled: rowsFact.known === true ? rowsFact.disabled === true : null,
      enabled: state === "enabled",
    },
  };
}

function statDirectoryFact(dir) {
  const value = probeDirectory(dir);
  if (value === null) return { known: false };
  return { known: true, value: value };
}

/**
 * 从真实 profile/loader 读取事实并分类；任何读取失败/未知都收敛到 unknown（fail closed）。
 */
export function detectLegacyBackupCoexistence(rescueRuntime, ctx) {
  const facts = {
    homeKnown: false,
    profileKnown: false,
    manifest: { known: false, value: null, error: "未读取" },
    installed: { known: false, value: null },
    loader: { known: false, entry: null, error: "未读取" },
    rows: { known: false, disabled: false },
  };
  try {
    const homeDir = rescueRuntime && rescueRuntime.homeDir ? rescueRuntime.homeDir : "";
    const profileDir = rescueRuntime && rescueRuntime.profileDir ? rescueRuntime.profileDir : "";
    const homeFact = homeDir ? statDirectoryFact(homeDir) : { known: false };
    const profileFact = profileDir ? statDirectoryFact(profileDir) : { known: false };
    facts.homeKnown = homeFact.known === true && homeFact.value === true;
    facts.profileKnown = profileFact.known === true && profileFact.value === true;
    if (!facts.profileKnown) return classifyLegacyBackup(facts);
    facts.manifest = readJsonFact(join(profileDir, "package.json"), manifestStructuralFact);
    facts.installed = (function () {
      try {
        const info = lstatSync(join(profileDir, "node_modules", LEGACY_PACKAGE, "package.json"));
        return { known: true, value: info.isFile() };
      } catch (error) {
        if (error && error.code === "ENOENT") return { known: true, value: false };
        return { known: false, value: null };
      }
    })();
    facts.rows = readRowsDisabledFact(join(profileDir, ".dshm-plugin-rows.yml"));
    let loader = null;
    try {
      loader = ctx && typeof ctx.get === "function" ? ctx.get("loader") : undefined;
    } catch (_) {
      loader = null;
    }
    facts.loader = findLoaderEntry(loader);
  } catch (_) {
    facts.loader = { known: false, entry: null, error: "检测异常" };
  }
  return classifyLegacyBackup(facts);
}
