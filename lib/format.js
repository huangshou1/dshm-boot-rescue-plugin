// dshm-backup 纯规则模块（format）
//
// 本文件只放**不依赖 node 内置模块**的纯函数：备份格式常量、清单校验、
// 路径映射、workspace.json 改写、会话 header 校验等。文件/进程/压缩相关
// 逻辑在 util.js、backup.js、restore.js、zip.js 中。
//
// 设计目标：
//   1) 这些规则可以在没有 Node 的环境里被独立审查（也便于 Python 合成测试
//      以“参考实现”方式逐条对照）；
//   2) 备份包格式、恢复路径映射、Zip Slip 防御等安全关键判断集中在此，
//      界面/HTTP 层不得绕过。
//
// 风格：使用 var/function 的 ES5 兼容写法，避免依赖宿主/浏览器新特性；
// 模块本身仍是 ESM（export）。

export const BACKUP_FORMAT = "dshm-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_KINDS = ["manual", "baseline", "emergency", "pre-restore"];
export const SESSION_FORMAT_VERSION = 4;
export const WORKSPACE_DOMAIN_VERSION = 2;
export const SESSION_LOG_BASENAME = "session.v4.jsonl.zstd";
export const MANIFEST_ENTRY = "manifest.json";
export const WORKSPACE_REGISTRY_ENTRY = "data/workspace.json";
export const SESSION_ENTRY_PREFIX = "data/sessions/";
export const ATTACHMENT_ENTRY_PREFIX = "data/attachments/";
export const WORKSPACE_FILE_ENTRY_PREFIX = "data/workspace-files/";
export const PLUGIN_INVENTORY_ENTRY = "data/plugin-inventory.json";
// 注意：不再导出“下载根前缀”。路径授权统一由 util 的 allowedDownloadRoot/isAllowedDownloadTarget
// 基于已确认的 DSHM_PUBLIC_DOWNLOAD 计算；空前缀不得参与任何 keep/写入判断。
export const RESTORE_FALLBACK_DIRNAME = "dshm-backup-restored";
export const MAX_BACKUP_BYTES = 0xFFFFFFFF - 1024; // < 4 GiB，避免 ZIP64
export const MAX_ZIP_ENTRIES = 60000;
export const MAX_BACKUP_FILES = 50000;
export const MAX_SESSION_ID_LENGTH = 200;

// ── 基础判断 ───────────────────────────────────────────────────────────────

export function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function isHex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isAbsolutePosixPath(value) {
  return typeof value === "string" && value.length > 0 && value.charAt(0) === "/" && value.indexOf("\u0000") === -1;
}

export function hasControlChars(value) {
  return typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value);
}

// ── DSH 会话目录编码（与 core 的 encodeSegment / projectKey 对齐）──────────
//
// 证据：core/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js
//   encodeSegment(): 安全码元 [A-Za-z0-9._-] 原样保留，'.'/'..' 特判为 ~002E，
//                    其余码元写成 ~XXXX（4 位大写十六进制）。
//   projectKey():    '/', '\\', ':' 合并为一个 '-', 其余规则同上，前缀 '--'、
//                    去首部 '-'、截断 251 字符、后缀 '--'（有损、可读优先）。
// 备份包内用 encodeSegment 给会话 id 做单段目录名（避免任何路径逃逸）。
// 恢复时 projectKey(cwd) 必须与 core 的目录名规则一致，否则 core 找不到会话。

export function encodeSegment(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("encodeSegment: empty segment");
  }
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  var out = "";
  for (var i = 0; i < raw.length; i += 1) {
    var code = raw.charCodeAt(i);
    var ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

export function projectKey(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("projectKey: empty cwd");
  }
  var readable = "";
  var separatorRun = false;
  for (var i = 0; i < cwd.length; i += 1) {
    var code = cwd.charCodeAt(i);
    var ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  var clipped = (readable.replace(/^-+/, "") || "root").slice(0, 251);
  return "--" + clipped + "--";
}

/** encodeSegment 的逆运算（用于从会话目录名还原会话 id；非法输入返回 null）。 */
export function decodeSegment(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  if (encoded === "~002E") return ".";
  var out = "";
  var i = 0;
  while (i < encoded.length) {
    var ch = encoded.charAt(i);
    if (ch === "~") {
      var hex = encoded.slice(i + 1, i + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      if (!/^[A-Za-z0-9._-]$/.test(ch)) return null;
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** 会话目录在 DSH_HOME/sessions 下的相对路径（不含 DSH_HOME/sessions 前缀）。 */
export function sessionDirRelPath(cwd, sessionId) {
  return projectKey(cwd) + "/" + encodeSegment(sessionId);
}

/** 备份包内某会话日志的条目名（compression 缺省为 zstd）。 */
export function sessionZipEntry(sessionId, compression) {
  var suffix = compression === "none" ? "session.v4.jsonl" : SESSION_LOG_BASENAME;
  return SESSION_ENTRY_PREFIX + encodeSegment(sessionId) + "/" + suffix;
}

/** 备份包内附件的条目名（rel 为 attachments 根下的相对路径，例如 v1/files/<sha>）。 */
export function attachmentZipEntry(rel) {
  return ATTACHMENT_ENTRY_PREFIX + rel;
}

/** 备份包内工作区文件的条目名（index 为工作区序号，rel 为工作区内相对路径）。 */
export function workspaceFileZipEntry(index, rel) {
  return WORKSPACE_FILE_ENTRY_PREFIX + "ws-" + pad4(index) + "/" + rel;
}

export function pad4(n) {
  var s = String(n);
  while (s.length < 4) s = "0" + s;
  return s;
}

// ── ZIP 条目名安全（Zip Slip / 符号链接 / 可移植性）────────────────────────

/**
 * 校验备份包内条目名是否安全可解压。
 * 拒绝：空名、绝对路径、盘符、反斜杠、NUL/控制字符、'.'/'..' 段、
 *       段末空格/点（Windows 语义歧义）、超长段（>255 字符）、超长路径（>1024）。
 * 允许：目录条目以 '/' 结尾（空段只允许出现在末尾）。
 */
export function isSafeZipEntryName(name) {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 1024) return false;
  if (hasControlChars(name)) return false;
  if (name.indexOf("\\") !== -1) return false;
  if (name.charAt(0) === "/") return false;
  if (/^[A-Za-z]:/.test(name)) return false;

  var isDir = name.charAt(name.length - 1) === "/";
  var body = isDir ? name.slice(0, name.length - 1) : name;
  if (body.length === 0) return false;
  var segments = body.split("/");
  for (var i = 0; i < segments.length; i += 1) {
    var seg = segments[i];
    if (seg.length === 0) return false; // 中间空段 / 双斜杠
    if (seg === "." || seg === "..") return false;
    if (seg.length > 255) return false;
    if (/[. ]$/.test(seg)) return false;
  }
  if (body.length === 0) return false;
  return true;
}

// ── 会话 header 校验/改写（v4）────────────────────────────────────────────
//
// 证据：core dsh-session-persistence-jsonl/lib/index.js:isHeaderLine()
// 必填：type="session"、version=4、id(string)、createdAt(int>=0)、
//        isSeeded(boolean)、delegationDepth(int>=0)
// 可选：cwd(绝对路径)、parentSession、origin("subagent")、agentPreset
// 备份端只读第一帧明文（header），不解析正文；恢复端路径重映射时只改 cwd。

export const SESSION_HEADER_REQUIRED_KEYS = ["type", "version", "id", "createdAt", "isSeeded", "delegationDepth"];
export const SESSION_HEADER_OPTIONAL_KEYS = ["cwd", "parentSession", "origin", "agentPreset"];
export const SESSION_HEADER_ALLOWED_KEYS = SESSION_HEADER_REQUIRED_KEYS.concat(SESSION_HEADER_OPTIONAL_KEYS);

export function parseSessionHeaderLine(text) {
  var errors = [];
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, errors: ["empty-header"], header: null };
  }
  var line = text;
  var nl = line.indexOf("\n");
  if (nl !== -1) line = line.slice(0, nl);
  var value;
  try {
    value = JSON.parse(line);
  } catch (e) {
    return { ok: false, errors: ["header-not-json"], header: null };
  }
  if (!isObject(value)) return { ok: false, errors: ["header-not-object"], header: null };
  for (var i = 0; i < SESSION_HEADER_REQUIRED_KEYS.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, SESSION_HEADER_REQUIRED_KEYS[i])) errors.push("missing-" + SESSION_HEADER_REQUIRED_KEYS[i]);
  }
  for (var k in value) {
    if (Object.prototype.hasOwnProperty.call(value, k) && SESSION_HEADER_ALLOWED_KEYS.indexOf(k) === -1) errors.push("unknown-key-" + k);
  }
  if (value.type !== "session") errors.push("bad-type");
  if (value.version !== SESSION_FORMAT_VERSION) errors.push("bad-version");
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > MAX_SESSION_ID_LENGTH) errors.push("bad-id");
  if (typeof value.createdAt !== "number" || !isFinite(value.createdAt) || value.createdAt < 0 || Math.floor(value.createdAt) !== value.createdAt) errors.push("bad-createdAt");
  if (typeof value.isSeeded !== "boolean") errors.push("bad-isSeeded");
  if (typeof value.delegationDepth !== "number" || value.delegationDepth < 0 || Math.floor(value.delegationDepth) !== value.delegationDepth) errors.push("bad-delegationDepth");
  if (value.cwd !== undefined && !isAbsolutePosixPath(value.cwd)) errors.push("bad-cwd");
  if (value.parentSession !== undefined && typeof value.parentSession !== "string") errors.push("bad-parentSession");
  if (value.origin !== undefined && value.origin !== "subagent") errors.push("bad-origin");
  if (value.agentPreset !== undefined && typeof value.agentPreset !== "string") errors.push("bad-agentPreset");
  if (errors.length > 0) return { ok: false, errors: errors, header: null };
  return { ok: true, errors: [], header: value };
}

/** 只改 header.cwd；返回新对象（不改原对象），保持已知字段。 */
export function rewriteSessionHeaderCwd(header, newCwd) {
  if (!isObject(header)) throw new Error("rewriteSessionHeaderCwd: header is not an object");
  if (!isAbsolutePosixPath(newCwd)) throw new Error("rewriteSessionHeaderCwd: cwd must be absolute");
  var out = {};
  for (var i = 0; i < SESSION_HEADER_ALLOWED_KEYS.length; i += 1) {
    var key = SESSION_HEADER_ALLOWED_KEYS[i];
    if (Object.prototype.hasOwnProperty.call(header, key)) out[key] = header[key];
  }
  out.cwd = newCwd;
  return out;
}

// ── 清单校验 ───────────────────────────────────────────────────────────────

function pushError(errors, code, detail) {
  errors.push(detail === undefined ? code : code + ":" + detail);
}

function checkSha(errors, field, value) {
  if (!isHex64(value)) pushError(errors, "bad-sha256", field);
}

export function validateManifest(manifest) {
  var errors = [];
  if (!isObject(manifest)) return { ok: false, errors: ["manifest-not-object"] };
  if (manifest.format !== BACKUP_FORMAT) pushError(errors, "bad-format");
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) pushError(errors, "bad-format-version");
  if (BACKUP_KINDS.indexOf(manifest.kind) === -1) pushError(errors, "bad-kind");
  if (typeof manifest.createdAt !== "string" || isNaN(Date.parse(manifest.createdAt))) pushError(errors, "bad-createdAt");

  var source = manifest.source;
  if (!isObject(source)) {
    pushError(errors, "missing-source");
  } else {
    if (!isNonEmptyString(source.coreVersion)) pushError(errors, "bad-source-coreVersion");
    if (source.sessionFormatVersion !== SESSION_FORMAT_VERSION) pushError(errors, "bad-source-sessionFormatVersion");
    if (source.workspaceDomainVersion !== WORKSPACE_DOMAIN_VERSION) pushError(errors, "bad-source-workspaceDomainVersion");
    // 非关键来源元数据允许缺失或 null（coreDir 未确认时 platform/nodeVersion 可能取不到），
    // 不能因为展示性字段缺失让整份备份在内部清单校验阶段失败。
    if (source.nodeVersion !== undefined && source.nodeVersion !== null && typeof source.nodeVersion !== "string") pushError(errors, "bad-source-nodeVersion");
    if (source.platform !== undefined && source.platform !== null && typeof source.platform !== "string") pushError(errors, "bad-source-platform");
    if (source.coreBuiltAt !== undefined && source.coreBuiltAt !== null && typeof source.coreBuiltAt !== "string") pushError(errors, "bad-source-coreBuiltAt");
    if (source.coreDirSource !== undefined && source.coreDirSource !== null && typeof source.coreDirSource !== "string") pushError(errors, "bad-source-coreDirSource");
    if (source.appVersion !== undefined && source.appVersion !== null && typeof source.appVersion !== "string") pushError(errors, "bad-source-appVersion");
  }

  var contents = manifest.contents;
  if (!isObject(contents)) return { ok: false, errors: errors.concat(["missing-contents"]) };
  var totalBytes = 0;
  var totalFiles = 0;
  var seenEntries = {};
  var seenSessionIds = {};
  var seenWorkspacePaths = {};

  // 会话
  if (!Array.isArray(contents.sessions)) {
    pushError(errors, "bad-sessions");
  } else {
    if (contents.sessions.length > MAX_BACKUP_FILES) pushError(errors, "too-many-sessions");
    for (var i = 0; i < contents.sessions.length; i += 1) {
      var s = contents.sessions[i];
      if (!isObject(s)) { pushError(errors, "bad-session", i); continue; }
      if (!isNonEmptyString(s.id) || s.id.length > MAX_SESSION_ID_LENGTH || hasControlChars(s.id) || s.id.indexOf("/") !== -1 || s.id.indexOf("\\") !== -1) pushError(errors, "bad-session-id", i);
      else if (seenSessionIds[s.id]) pushError(errors, "duplicate-session-id", s.id);
      else seenSessionIds[s.id] = true;
      var sessionComplete = s.complete === true;
      if (sessionComplete) {
        // 可恢复会话：严格要求 cwd/createdAt
        if (!isAbsolutePosixPath(s.cwd)) pushError(errors, "bad-session-cwd", i);
        if (typeof s.createdAt !== "number") pushError(errors, "bad-session-createdAt", i);
      } else {
        // 不完整会话：保留原始字节 + incompleteReason，允许 cwd/createdAt 缺失；
        // 它们仍进入 ZIP 与 SHA-256 校验，但恢复时跳过。
        if (s.cwd !== undefined && s.cwd !== null && !isAbsolutePosixPath(s.cwd)) pushError(errors, "bad-session-cwd", i);
        if (s.createdAt !== undefined && s.createdAt !== null && typeof s.createdAt !== "number") pushError(errors, "bad-session-createdAt", i);
        if (s.incompleteReason !== undefined && typeof s.incompleteReason !== "string") pushError(errors, "bad-session-incompleteReason", i);
      }
      if (!isSafeZipEntryName(s.file)) pushError(errors, "unsafe-session-file", i);
      if (typeof s.size !== "number" || s.size < 0 || Math.floor(s.size) !== s.size) pushError(errors, "bad-session-size", i);
      else totalBytes += s.size;
      checkSha(errors, "session.sha256", s.sha256);
      if (typeof s.complete !== "boolean") pushError(errors, "bad-session-complete", i);
      if (s.file) {
        if (seenEntries[s.file]) pushError(errors, "duplicate-zip-entry", s.file);
        else seenEntries[s.file] = true;
      }
      totalFiles += 1;
    }
  }

  // 工作区记录
  if (!Array.isArray(contents.workspaces)) {
    pushError(errors, "bad-workspaces");
  } else {
    for (var w = 0; w < contents.workspaces.length; w += 1) {
      var ws = contents.workspaces[w];
      if (!isObject(ws)) { pushError(errors, "bad-workspace", w); continue; }
      if (!isAbsolutePosixPath(ws.path)) pushError(errors, "bad-workspace-path", w);
      else if (seenWorkspacePaths[ws.path]) pushError(errors, "duplicate-workspace-path", ws.path);
      else seenWorkspacePaths[ws.path] = true;
      if (typeof ws.title !== "string") pushError(errors, "bad-workspace-title", w);
      if (!Array.isArray(ws.sessionIds)) pushError(errors, "bad-workspace-sessionIds", w);
      else {
        for (var z = 0; z < ws.sessionIds.length; z += 1) {
          if (typeof ws.sessionIds[z] !== "string") pushError(errors, "bad-workspace-sessionId", w);
        }
      }
      if (ws.createdAt !== undefined && typeof ws.createdAt !== "string") pushError(errors, "bad-workspace-createdAt", w);
      if (ws.updatedAt !== undefined && typeof ws.updatedAt !== "string") pushError(errors, "bad-workspace-updatedAt", w);
    }
  }

  // 工作区注册表（可选，但建议始终有）
  if (contents.workspaceRegistry !== null && contents.workspaceRegistry !== undefined) {
    if (!isObject(contents.workspaceRegistry)) pushError(errors, "bad-workspaceRegistry");
    else {
      if (contents.workspaceRegistry.entry !== WORKSPACE_REGISTRY_ENTRY) pushError(errors, "bad-workspaceRegistry-entry");
      checkSha(errors, "workspaceRegistry.sha256", contents.workspaceRegistry.sha256);
      if (contents.workspaceRegistry.entry) {
        if (seenEntries[contents.workspaceRegistry.entry]) pushError(errors, "duplicate-zip-entry", contents.workspaceRegistry.entry);
        else seenEntries[contents.workspaceRegistry.entry] = true;
      }
    }
  }

  // 工作区产出文件
  if (!Array.isArray(contents.workspaceFiles)) {
    pushError(errors, "bad-workspaceFiles");
  } else {
    for (var f = 0; f < contents.workspaceFiles.length; f += 1) {
      var group = contents.workspaceFiles[f];
      if (!isObject(group)) { pushError(errors, "bad-workspaceFile-group", f); continue; }
      if (!isAbsolutePosixPath(group.workspacePath)) pushError(errors, "bad-workspaceFile-path", f);
      if (!isNonEmptyString(group.entryPrefix) || !isSafeZipEntryName(group.entryPrefix + "x")) pushError(errors, "bad-workspaceFile-prefix", f);
      if (!Array.isArray(group.files)) { pushError(errors, "bad-workspaceFile-files", f); continue; }
      for (var g = 0; g < group.files.length; g += 1) {
        var file = group.files[g];
        if (!isObject(file)) { pushError(errors, "bad-workspaceFile", f); continue; }
        if (!isNonEmptyString(file.rel) || !isSafeZipEntryName(file.rel)) pushError(errors, "bad-workspaceFile-rel", f);
        if (typeof file.size !== "number" || file.size < 0 || Math.floor(file.size) !== file.size) pushError(errors, "bad-workspaceFile-size", f);
        else totalBytes += file.size;
        checkSha(errors, "workspaceFile.sha256", file.sha256);
        if (file.entry !== undefined && !isSafeZipEntryName(file.entry)) pushError(errors, "bad-workspaceFile-entry", f);
        if (file.entry) {
          if (seenEntries[file.entry]) pushError(errors, "duplicate-zip-entry", file.entry);
          else seenEntries[file.entry] = true;
        }
        totalFiles += 1;
      }
    }
  }

  // 附件
  if (!Array.isArray(contents.attachments)) {
    pushError(errors, "bad-attachments");
  } else {
    for (var a = 0; a < contents.attachments.length; a += 1) {
      var att = contents.attachments[a];
      if (!isObject(att)) { pushError(errors, "bad-attachment", a); continue; }
      if (!isNonEmptyString(att.entry) || !isSafeZipEntryName(att.entry)) pushError(errors, "bad-attachment-entry", a);
      if (typeof att.size !== "number" || att.size < 0 || Math.floor(att.size) !== att.size) pushError(errors, "bad-attachment-size", a);
      else totalBytes += att.size;
      checkSha(errors, "attachment.sha256", att.sha256);
      if (att.entry) {
        if (seenEntries[att.entry]) pushError(errors, "duplicate-zip-entry", att.entry);
        else seenEntries[att.entry] = true;
      }
      totalFiles += 1;
    }
  }

  // 插件清单：严格只允许 name + version（用户要求只导出名单和版本）
  if (!isObject(contents.plugins)) {
    pushError(errors, "bad-plugins");
  } else {
    var pluginLists = [
      { key: "user", label: "bad-plugins-user" },
      { key: "core", label: "bad-plugins-core" },
    ];
    for (var pi = 0; pi < pluginLists.length; pi += 1) {
      var listKey = pluginLists[pi].key;
      var list = contents.plugins[listKey];
      if (!Array.isArray(list)) {
        pushError(errors, pluginLists[pi].label);
        continue;
      }
      for (var p = 0; p < list.length; p += 1) {
        var pl = list[p];
        if (!isObject(pl)) { pushError(errors, "bad-plugin", listKey + ":" + p); continue; }
        var keys = Object.keys(pl);
        var extra = [];
        for (var pk = 0; pk < keys.length; pk += 1) {
          if (keys[pk] !== "name" && keys[pk] !== "version") extra.push(keys[pk]);
        }
        if (extra.length > 0) pushError(errors, "plugin-extra-fields", listKey + ":" + p + ":" + extra.join(","));
        if (!isNonEmptyString(pl.name)) pushError(errors, "bad-plugin-name", listKey + ":" + p);
        if (typeof pl.version !== "string" || pl.version.length === 0) pushError(errors, "bad-plugin-version", listKey + ":" + p);
      }
    }
  }

  if (totalBytes > MAX_BACKUP_BYTES) pushError(errors, "backup-too-large");
  if (totalFiles > MAX_ZIP_ENTRIES) pushError(errors, "too-many-files");
  if (manifest.stats !== undefined) {
    if (!isObject(manifest.stats)) pushError(errors, "bad-stats");
  }
  return { ok: errors.length === 0, errors: errors };
}

// ── 版本比较（不同维度分开，不合并成一个字符串）────────────────────────────

/** 从模块名提取 npm 包名（scoped 包取前两段；带子路径的模块名先截断到包名）。
 *  例：@deepseek-ai/dsh-plugin-manager/tools → @deepseek-ai/dsh-plugin-manager；
 *      dsh-base/lib/index.js → dsh-base。 */
export function packageNameOf(moduleName) {
  if (!isNonEmptyString(moduleName)) return null;
  var parts = moduleName.split("/");
  if (moduleName.charAt(0) === "@") {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return parts[0] + "/" + parts[1];
  }
  return parts[0] || null;
}

/** 版本字符串是否为“已确认”的真实版本（unknown/空/未确认一律视为未知）。 */
export function isKnownVersion(value) {
  return isNonEmptyString(value) && value !== "unknown" && value !== "未确认";
}

export function describeVersionComparison(source, target) {
  var warnings = [];
  var level = "exact";
  if (!isObject(source) || !isObject(target)) return { level: "unknown", warnings: ["版本信息缺失，无法比较"] };
  var sourceCoreKnown = isKnownVersion(source.coreVersion);
  var targetCoreKnown = isKnownVersion(target.coreVersion);
  if (!sourceCoreKnown || !targetCoreKnown) {
    level = "unknown";
    warnings.push(
      "核心版本未确认（备份=" + (source.coreVersion || "未知") + "，当前=" + (target.coreVersion || "未知") + "）：不能按同版本处理"
    );
  } else if (source.coreVersion !== target.coreVersion) {
    level = "core-mismatch";
    warnings.push("核心版本不一致：备份来自 " + source.coreVersion + "，当前为 " + target.coreVersion);
  } else if (
    isKnownVersion(source.upstreamDshVersion) &&
    isKnownVersion(target.upstreamDshVersion) &&
    source.upstreamDshVersion !== target.upstreamDshVersion
  ) {
    level = "core-mismatch";
    warnings.push("DSH 上游版本不一致：备份来自 " + source.upstreamDshVersion + "，当前为 " + target.upstreamDshVersion);
  }
  var formatUnknown = false;
  if (typeof source.sessionFormatVersion !== "number" || typeof target.sessionFormatVersion !== "number") {
    formatUnknown = true;
    warnings.push("会话格式版本未确认（备份=" + String(source.sessionFormatVersion) + "，当前=" + String(target.sessionFormatVersion) + "）：不能按同版本处理");
  } else if (source.sessionFormatVersion !== target.sessionFormatVersion) {
    level = "format-mismatch";
    warnings.push("会话格式版本不一致：备份为 v" + source.sessionFormatVersion + "，当前为 v" + target.sessionFormatVersion);
  }
  if (typeof source.workspaceDomainVersion !== "number" || typeof target.workspaceDomainVersion !== "number") {
    formatUnknown = true;
    warnings.push("工作区注册表格式版本未确认（备份=" + String(source.workspaceDomainVersion) + "，当前=" + String(target.workspaceDomainVersion) + "）：不能按同版本处理");
  } else if (source.workspaceDomainVersion !== target.workspaceDomainVersion) {
    level = "format-mismatch";
    warnings.push("工作区注册表格式版本不一致：备份为 v" + source.workspaceDomainVersion + "，当前为 v" + target.workspaceDomainVersion);
  }
  if (formatUnknown && level !== "format-mismatch") level = "unknown";
  return { level: level, warnings: warnings };
}

/** 收集清单中声明的全部 payload 条目 → SHA-256 映射（校验/解压 expectedHashes 用）。 */
export function expectedPayloadHashes(manifest) {
  var expected = {};
  var contents = manifest.contents || {};
  var i;
  var sessions = Array.isArray(contents.sessions) ? contents.sessions : [];
  for (i = 0; i < sessions.length; i += 1) expected[sessions[i].file] = sessions[i].sha256;
  if (contents.workspaceRegistry && contents.workspaceRegistry.entry) {
    expected[contents.workspaceRegistry.entry] = contents.workspaceRegistry.sha256;
  }
  var groups = Array.isArray(contents.workspaceFiles) ? contents.workspaceFiles : [];
  for (i = 0; i < groups.length; i += 1) {
    var files = Array.isArray(groups[i].files) ? groups[i].files : [];
    for (var f = 0; f < files.length; f += 1) {
      if (files[f].entry) expected[files[f].entry] = files[f].sha256;
    }
  }
  var attachments = Array.isArray(contents.attachments) ? contents.attachments : [];
  for (i = 0; i < attachments.length; i += 1) expected[attachments[i].entry] = attachments[i].sha256;
  return expected;
}

// ── 恢复映射 ───────────────────────────────────────────────────────────────

export function normalizePosixPath(value) {
  if (!isAbsolutePosixPath(value)) return null;
  var parts = value.split("/");
  var out = [];
  for (var i = 0; i < parts.length; i += 1) {
    var part = parts[i];
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return "/" + out.join("/");
}

/**
 * 生成恢复映射。resolveTarget(sourcePath) 必须返回
 *   { path: string, mode: "keep"|"remap", reason?: string } 或 null（失败）。
 * 调用方（restore.js）负责真实文件系统可写性探测；本函数只做格式与唯一性校验。
 */
export function buildRestoreMapping(sourcePaths, resolveTarget) {
  var errors = [];
  var mapping = [];
  var seen = {};
  for (var i = 0; i < sourcePaths.length; i += 1) {
    var source = sourcePaths[i];
    if (!isAbsolutePosixPath(source)) { pushError(errors, "bad-source-path", String(i)); continue; }
    var target = null;
    try {
      target = resolveTarget(source);
    } catch (e) {
      target = null;
    }
    if (!target || !isAbsolutePosixPath(target.path)) { pushError(errors, "unresolved-target", source); continue; }
    var normalizedTarget = normalizePosixPath(target.path);
    if (normalizedTarget === null) { pushError(errors, "unsafe-target", source); continue; }
    if (seen[normalizedTarget]) { pushError(errors, "duplicate-target", normalizedTarget); continue; }
    seen[normalizedTarget] = true;
    mapping.push({
      from: source,
      to: normalizedTarget,
      mode: target.mode === "keep" ? "keep" : "remap",
      reason: typeof target.reason === "string" ? target.reason : "",
    });
  }
  return { ok: errors.length === 0, errors: errors, mapping: mapping };
}

/** 从映射数组取 from→to 查表（同时接受未规范化与规范化前缀）。 */
export function mappingIndex(mapping) {
  var index = {};
  for (var i = 0; i < mapping.length; i += 1) {
    index[mapping[i].from] = mapping[i].to;
  }
  return index;
}

/** 把旧路径按映射前缀替换为新路径；无匹配返回 null。 */
export function remapPathByPrefix(oldPath, mapping) {
  if (!isNonEmptyString(oldPath)) return null;
  for (var i = 0; i < mapping.length; i += 1) {
    var from = mapping[i].from;
    var to = mapping[i].to;
    if (oldPath === from) return to;
    if (oldPath.indexOf(from + "/") === 0) return to + oldPath.slice(from.length);
  }
  return null;
}

// ── workspace.json 改写 ────────────────────────────────────────────────────

export function validateWorkspaceRegistry(registry) {
  var errors = [];
  if (!isObject(registry)) return { ok: false, errors: ["registry-not-object"] };
  if (!isObject(registry.unit) || registry.unit.name !== "workspace" || registry.unit.version !== WORKSPACE_DOMAIN_VERSION) {
    pushError(errors, "bad-unit");
  }
  var global = registry.global;
  if (!isObject(global)) {
    pushError(errors, "bad-global");
  } else {
    if (!Array.isArray(global.workspaceIds)) pushError(errors, "bad-workspaceIds");
    if (!Array.isArray(global.archivedSessionIds)) pushError(errors, "bad-archivedSessionIds");
    if (!Array.isArray(global.pinnedSessionIds)) pushError(errors, "bad-pinnedSessionIds");
  }
  if (!isObject(registry.tables) || !isObject(registry.tables.workspaces)) {
    pushError(errors, "bad-tables");
  }
  return { ok: errors.length === 0, errors: errors };
}

/**
 * 用恢复映射改写 workspace.json 的 path 字段，返回新对象；不修改入参。
 * - 删除 pendingMutation（恢复时目标实例的未完成标记必须清掉）；
 * - 强制 initialized=true（恢复后由本文件提供完整注册表）；
 * - 校验 workspaceIds 与表记录、目标 path 唯一性；
 * - options.skippedSessionIds：本次恢复明确跳过的不完整会话 ID，从工作区 sessionIds、
 *   archivedSessionIds、pinnedSessionIds 中清除（真正空会话不在 skipped 列表中，必须保留）。
 */
export function rewriteWorkspaceRegistry(registry, mapping, options) {
  var check = validateWorkspaceRegistry(registry);
  if (!check.ok) return { ok: false, errors: check.errors, registry: null };
  var errors = [];
  var oldToNew = mappingIndex(mapping);
  var clone = JSON.parse(JSON.stringify(registry));
  var targetSeen = {};
  var table = clone.tables.workspaces;
  for (var id in table) {
    if (!Object.prototype.hasOwnProperty.call(table, id)) continue;
    var record = table[id];
    if (!isObject(record)) { pushError(errors, "bad-record", id); continue; }
    var oldPath = record.path;
    var newPath = oldToNew[oldPath];
    if (newPath === undefined) {
      var remapped = remapPathByPrefix(oldPath, mapping);
      if (remapped === null) { pushError(errors, "unmapped-workspace-path", oldPath); continue; }
      newPath = remapped;
    }
    if (targetSeen[newPath]) pushError(errors, "duplicate-workspace-target", newPath);
    targetSeen[newPath] = true;
    record.path = newPath;
    if (!Array.isArray(record.sessionIds)) record.sessionIds = [];
  }
  var global = clone.global;
  if (Object.prototype.hasOwnProperty.call(global, "pendingMutation")) delete global.pendingMutation;
  global.initialized = true;
  var missing = [];
  for (var i = 0; i < global.workspaceIds.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(table, global.workspaceIds[i])) missing.push(global.workspaceIds[i]);
  }
  if (missing.length > 0) {
    // 保序地剔除悬空 id（不改变其余顺序）
    global.workspaceIds = global.workspaceIds.filter(function (wid) { return missing.indexOf(wid) === -1; });
  }
  var withPruned = pruneSkippedSessionReferences(clone, options && Array.isArray(options.skippedSessionIds) ? options.skippedSessionIds : []);
  return { ok: errors.length === 0, errors: errors, registry: withPruned };
}

/**
 * 从 workspace.json 的会话引用中移除“本次恢复明确跳过的不完整会话 ID”。
 * 只移除传入的 skippedSessionIds；真正的空会话（只在 registry 中、没有日志）不在该列表，
 * 因此不会被误删。返回新对象，不修改入参。
 */
export function pruneSkippedSessionReferences(registry, skippedSessionIds) {
  if (!isObject(registry)) return registry;
  var clone = JSON.parse(JSON.stringify(registry));
  var skipped = {};
  var ids = Array.isArray(skippedSessionIds) ? skippedSessionIds : [];
  for (var i = 0; i < ids.length; i += 1) {
    if (typeof ids[i] === "string" && ids[i].length > 0) skipped[ids[i]] = true;
  }
  if (Object.keys(skipped).length === 0) return clone;
  function filterIds(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (id) { return !skipped[id]; });
  }
  var table = clone.tables && clone.tables.workspaces;
  if (isObject(table)) {
    for (var id in table) {
      if (!Object.prototype.hasOwnProperty.call(table, id)) continue;
      if (isObject(table[id]) && Array.isArray(table[id].sessionIds)) table[id].sessionIds = filterIds(table[id].sessionIds);
    }
  }
  if (isObject(clone.global)) {
    clone.global.archivedSessionIds = filterIds(clone.global.archivedSessionIds);
    clone.global.pinnedSessionIds = filterIds(clone.global.pinnedSessionIds);
  }
  return clone;
}

/** 无 workspace.json 备份时的兜底：从 manifest.workspaces 构造注册表。 */
export function buildWorkspaceRegistryFromManifest(manifest, mapping, makeId) {
  var errors = [];
  var idToPath = mappingIndex(mapping);
  var registry = {
    unit: { name: "workspace", version: WORKSPACE_DOMAIN_VERSION },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  };
  var usedIds = {};
  for (var i = 0; i < manifest.contents.workspaces.length; i += 1) {
    var ws = manifest.contents.workspaces[i];
    var targetPath = idToPath[ws.path];
    if (targetPath === undefined) targetPath = remapPathByPrefix(ws.path, mapping);
    if (targetPath === null) { pushError(errors, "unmapped-workspace-path", ws.path); continue; }
    var id = typeof makeId === "function" ? makeId() : "ws-" + i;
    while (usedIds[id]) id = typeof makeId === "function" ? makeId() : "ws-" + i + "-" + Object.keys(usedIds).length;
    usedIds[id] = true;
    registry.tables.workspaces[id] = {
      path: targetPath,
      title: typeof ws.title === "string" && ws.title.length > 0 ? ws.title : targetPath.split("/").pop(),
      sessionIds: Array.isArray(ws.sessionIds) ? ws.sessionIds.slice() : [],
      createdAt: typeof ws.createdAt === "string" ? ws.createdAt : new Date(0).toISOString(),
      updatedAt: typeof ws.updatedAt === "string" ? ws.updatedAt : new Date(0).toISOString(),
    };
    registry.global.workspaceIds.push(id);
  }
  return { ok: errors.length === 0, errors: errors, registry: registry };
}

// ── 全新实例判定（输入为已采集的只读状态）──────────────────────────────────

/**
 * 判定目标是否为“可恢复的全新实例”。
 *
 * 关键背景：DSHM 在完全空白时可能由系统自动创建一个**默认工作区**，
 * 因此 initialized=true + 1 个工作区不一定是用户数据。本函数只允许严格可识别的
 * “系统自动创建的空白默认工作区”进入全新实例兼容范围：
 *   - 没有任何 stored session；
 *   - archivedSessionIds / pinnedSessionIds 都为空；
 *   - 只有一条 workspace 记录，且正是 global.defaultWorkspaceId 指向的默认工作区；
 *   - 该记录 sessionIds 为空；
 *   - path 与 Host 当前默认工作区路径一致；
 *   - 没有 pendingMutation / 无法解释的额外记录。
 * 结构无法确认时继续拒绝并给出原因（不得把“所有空工作区”都算全新）。
 *
 * state = {
 *   workspaceJsonExists: boolean,
 *   initialized: boolean,
 *   workspaceIds: string[],
 *   defaultWorkspaceId: string|null,
 *   archivedSessionIds: string[],
 *   pinnedSessionIds: string[],
 *   storedSessionCount: number,
 *   hostDefaultWorkspacePath: string|null,
 *   workspaces: { <id>: { path, title, sessionIds, createdAt, updatedAt } },
 *   hasPendingMutation: boolean,
 * }
 */
export function assessFreshTarget(state) {
  var reasons = [];
  if (!isObject(state)) return { fresh: false, reasons: ["无法读取目标状态"] };
  // 严格 fail closed：未知状态不得按“全新实例”处理。
  if (state.targetKnown === false) {
    return { fresh: false, reasons: [typeof state.unknownReason === "string" && state.unknownReason.length > 0 ? state.unknownReason : "目标状态无法确认（fail closed），拒绝按全新实例处理"] };
  }
  if (state.registryReadKnown === false) {
    return { fresh: false, reasons: ["workspace.json 读取状态未知（fail closed），拒绝按全新实例处理"].concat(Array.isArray(state.registryErrors) ? state.registryErrors : []) };
  }
  if (state.sessionScanKnown === false) {
    return { fresh: false, reasons: ["会话目录无法完整盘点（fail closed），拒绝按全新实例处理"] };
  }
  if (typeof state.sessionStrictErrors === "number" && state.sessionStrictErrors > 0) {
    return { fresh: false, reasons: ["会话目录存在无法识别/不支持的工件或读取失败（fail closed），拒绝按全新实例处理"] };
  }
  if (state.workspaceJsonExists === true && state.registryValid !== true) {
    return { fresh: false, reasons: ["workspace.json 存在但无法完整校验（fail closed），拒绝按全新实例处理"].concat(Array.isArray(state.registryErrors) ? state.registryErrors : []) };
  }
  var stored = typeof state.storedSessionCount === "number" ? state.storedSessionCount : 0;
  var archived = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : [];
  var pinned = Array.isArray(state.pinnedSessionIds) ? state.pinnedSessionIds : [];
  var workspaceIds = Array.isArray(state.workspaceIds) ? state.workspaceIds : [];
  var workspaces = isObject(state.workspaces) ? state.workspaces : {};
  var tableIds = Object.keys(workspaces);
  var hostPath = typeof state.hostDefaultWorkspacePath === "string" ? normalizePosixPath(state.hostDefaultWorkspacePath) : null;

  if (!state.workspaceJsonExists) {
    if (stored > 0) return { fresh: false, reasons: ["目标实例已有 " + stored + " 个会话记录"] };
    if (archived.length > 0) return { fresh: false, reasons: ["目标实例已有归档会话"] };
    if (pinned.length > 0) return { fresh: false, reasons: ["目标实例已有置顶会话"] };
    return { fresh: true, reasons: ["workspace.json 不存在，且无会话/归档/置顶数据"] };
  }

  if (stored > 0) reasons.push("目标实例已有 " + stored + " 个会话记录");
  if (archived.length > 0) reasons.push("目标实例已有归档会话（" + archived.length + " 条）");
  if (pinned.length > 0) reasons.push("目标实例已有置顶会话（" + pinned.length + " 条）");
  if (state.hasPendingMutation === true) reasons.push("工作区注册表存在未完成的 mutation 标记");

  if (state.initialized !== true) {
    if (reasons.length === 0 && workspaceIds.length === 0 && tableIds.length === 0) {
      return { fresh: true, reasons: ["注册表未初始化且没有任何工作区记录"] };
    }
    reasons.push("注册表 initialized 不为 true 但存在记录，无法确认是全新实例");
    return { fresh: false, reasons: reasons };
  }

  if (workspaceIds.length === 0 && tableIds.length === 0) {
    if (reasons.length === 0) return { fresh: true, reasons: ["注册表已初始化但没有任何工作区记录"] };
    return { fresh: false, reasons: reasons };
  }

  // 只允许：恰好一条记录，且是系统默认空白工作区
  if (workspaceIds.length !== 1) reasons.push("存在多个工作区记录（" + workspaceIds.length + " 个），拒绝按全新实例处理");
  if (tableIds.length !== 1) reasons.push("工作区表记录数与 workspaceIds 不一致（表 " + tableIds.length + " 条）");
  if (reasons.length > 0) return { fresh: false, reasons: reasons };

  var onlyId = workspaceIds[0];
  var record = workspaces[onlyId];
  if (!isObject(record)) return { fresh: false, reasons: ["默认工作区记录缺失或结构非法"] };
  var defaultId = typeof state.defaultWorkspaceId === "string" ? state.defaultWorkspaceId : null;
  if (!defaultId) {
    return { fresh: false, reasons: ["无法确认 global.defaultWorkspaceId，拒绝按全新实例处理"] };
  }
  if (defaultId !== onlyId) {
    return { fresh: false, reasons: ["唯一工作区不是 defaultWorkspaceId 指向的默认工作区"] };
  }
  if (!hostPath) {
    return { fresh: false, reasons: ["无法取得 Host 当前默认工作区路径，拒绝按全新实例处理"] };
  }
  var recordPath = typeof record.path === "string" ? normalizePosixPath(record.path) : null;
  if (!recordPath) return { fresh: false, reasons: ["默认工作区 path 不是合法绝对路径"] };
  if (recordPath !== hostPath) {
    return { fresh: false, reasons: ["默认工作区 path 与 Host 当前默认工作区不一致：" + recordPath + " ≠ " + hostPath] };
  }
  if (!Array.isArray(record.sessionIds)) {
    return { fresh: false, reasons: ["默认工作区 sessionIds 结构非法，无法确认是否为空"] };
  }
  if (record.sessionIds.length > 0) {
    return { fresh: false, reasons: ["默认工作区已包含 " + record.sessionIds.length + " 个会话 ID"] };
  }
  return {
    fresh: true,
    reasons: ["只有系统默认空白工作区（" + onlyId + "），无会话/归档/置顶/额外记录"],
    defaultWorkspaceOnly: true,
  };
}

// ── 文件名/展示辅助 ────────────────────────────────────────────────────────

export function backupFileName(kind, date, randomSuffix) {
  var safeKind = BACKUP_KINDS.indexOf(kind) === -1 ? "manual" : kind;
  var d = date instanceof Date ? date : new Date();
  var pad = function (n) { return (n < 10 ? "0" : "") + String(n); };
  var stamp = String(d.getUTCFullYear()) + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "-" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  var rand = typeof randomSuffix === "string" ? randomSuffix.replace(/[^a-z0-9]/gi, "").slice(0, 8) : "00000000";
  return "dshm-backup-" + safeKind + "-" + stamp + "-" + rand + ".zip";
}

export function formatBytes(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "未知";
  if (n < 1024) return n + " B";
  var units = ["KB", "MB", "GB", "TB"];
  var value = n;
  var unit = "";
  for (var i = 0; i < units.length; i += 1) {
    value = value / 1024;
    unit = units[i];
    if (value < 1024) break;
  }
  return (Math.round(value * 10) / 10) + " " + unit;
}

/** 供宿主把绝对路径映射到默认导出目录下的恢复子目录。 */
export function fallbackRestorePath(sourcePath, fallbackBase, usedPaths) {
  if (!isAbsolutePosixPath(sourcePath) || !isAbsolutePosixPath(fallbackBase)) return null;
  var base = normalizePosixPath(fallbackBase);
  if (base === null) return null;
  var raw = sourcePath.split("/").pop() || "workspace";
  var safe = raw.replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, "_").slice(0, 60) || "workspace";
  var candidate = base + "/" + safe;
  var n = 2;
  var list = Array.isArray(usedPaths) ? usedPaths : [];
  while (list.indexOf(candidate) !== -1) {
    candidate = base + "/" + safe + "-" + n;
    n += 1;
  }
  return candidate;
}
