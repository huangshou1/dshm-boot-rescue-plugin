// dshm-backup 恢复引擎（restore）
//
// 流程：选择备份 → 只读检查（listZip/readZipEntry/hashZipEntries，不写目标）→
//       预览（目标是否全新、版本比较、路径映射、冲突/警告）→ 明确确认 →
//       解压到 staging 并逐文件校验 → 应用到目标 → 复验 → 报告失败/回滚。
//
// 安全约束：
//   · 目标不是全新实例时默认拒绝（首版不提供覆盖模式）；
//   · 预览阶段零写入目标数据（只看 zip/目标只读状态）；
//   · 路径重映射时只改会话 header 第一帧 cwd，其余 zstd 帧字节不变；
//   · workspace.json 在 Host 运行时写入有被内存态覆盖的风险：恢复成功后强制要求
//     用户冷重启（划掉后台重开），重启前不得新建会话；恢复前会保存目标原文件用于回滚；
//   · 绝不安装/启用/停用插件；插件清单只写入 manifest 供人工核对。


import { access, mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as fmt from "./format.js";
import * as util from "./util.js";
import { listZip, readZipEntry, extractZip, hashZipEntries } from "./zip.js";
import { scanSessionArtifacts } from "./backup.js";

// 备份文件解析统一走 util.resolveBackupFileInput(paths, input)（own/legacy 同一实现）。

/**
 * 读取目标状态（只读）。同时给出：
 *   - fresh 判定所需的全部字段（区分系统默认空工作区与用户数据）；
 *   - targetFingerprint：预览后再次执行恢复时用于判断目标是否已变化。
 */
async function readTargetState(paths) {
  var sessionScan = null;
  var sessionScanKnown = false;
  var sessionStrictErrors = [];
  try {
    sessionScan = await scanSessionArtifacts(paths, { tolerateErrors: true });
    sessionScanKnown = sessionScan.known !== false;
    sessionStrictErrors = Array.isArray(sessionScan.strictErrors) ? sessionScan.strictErrors.slice() : [];
  } catch (error) {
    sessionScan = { artifacts: [], warnings: ["会话扫描失败（fail closed）：" + util.errText(error)], known: false, strictErrors: ["会话扫描失败"] };
    sessionScanKnown = false;
    sessionStrictErrors = ["会话扫描失败：" + util.errText(error)];
  }
  var registryRead = null;
  var registryReadKnown = false;
  try {
    registryRead = await util.readWorkspaceRegistry(paths.workspaceRegistryPath);
    registryReadKnown = registryRead.known !== false;
  } catch (error) {
    registryRead = { exists: false, known: false, registry: null, sha256: null, errors: ["workspace.json 读取失败：" + util.errText(error)] };
    registryReadKnown = false;
  }
  var initialized = false;
  var archivedSessionIds = [];
  var pinnedSessionIds = [];
  var defaultWorkspaceId = null;
  var workspaceIds = [];
  var workspaces = {};
  var hasPendingMutation = false;
  if (registryRead.exists && registryRead.registry && fmt.isObject(registryRead.registry.global)) {
    var global = registryRead.registry.global;
    initialized = global.initialized === true;
    archivedSessionIds = Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds.slice() : [];
    pinnedSessionIds = Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds.slice() : [];
    defaultWorkspaceId = typeof global.defaultWorkspaceId === "string" ? global.defaultWorkspaceId : null;
    workspaceIds = Array.isArray(global.workspaceIds) ? global.workspaceIds.slice() : [];
    hasPendingMutation = fmt.isObject(global.pendingMutation);
    if (fmt.isObject(registryRead.registry.tables) && fmt.isObject(registryRead.registry.tables.workspaces)) {
      var table = registryRead.registry.tables.workspaces;
      for (var id in table) {
        if (!Object.prototype.hasOwnProperty.call(table, id)) continue;
        var record = table[id];
        if (!fmt.isObject(record)) {
          workspaces[id] = { path: null, title: null, sessionIds: null };
          continue;
        }
        workspaces[id] = {
          path: typeof record.path === "string" ? record.path : null,
          title: typeof record.title === "string" ? record.title : null,
          sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.slice() : null,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
        };
      }
    }
  }
  var hostDefaultWorkspacePath = null;
  if (paths.hostReady && typeof paths.hostReady.workspace === "string" && paths.hostReady.workspace.length > 0) {
    hostDefaultWorkspacePath = paths.hostReady.workspace;
  } else if (typeof paths.workspaceRoot === "string" && paths.workspaceRoot.length > 0) {
    hostDefaultWorkspacePath = paths.workspaceRoot;
  }
  var registryErrors = Array.isArray(registryRead.errors) ? registryRead.errors : [];
  var targetKnown = registryReadKnown && sessionScanKnown && sessionStrictErrors.length === 0;
  var unknownReason = "";
  if (!registryReadKnown) unknownReason = "workspace.json 读取状态未知（fail closed），拒绝按全新实例处理";
  else if (!sessionScanKnown) unknownReason = "会话目录无法完整盘点（fail closed），拒绝按全新实例处理";
  else if (sessionStrictErrors.length > 0) unknownReason = "会话目录存在无法识别/不支持/读取失败的工件（fail closed），拒绝按全新实例处理：" + sessionStrictErrors.slice(0, 3).join("；");
  var assessment = fmt.assessFreshTarget({
    workspaceJsonExists: registryRead.exists,
    initialized: initialized,
    workspaceIds: workspaceIds,
    defaultWorkspaceId: defaultWorkspaceId,
    archivedSessionIds: archivedSessionIds,
    pinnedSessionIds: pinnedSessionIds,
    storedSessionCount: sessionScan.artifacts.length,
    hostDefaultWorkspacePath: hostDefaultWorkspacePath,
    hasPendingMutation: hasPendingMutation,
    workspaces: workspaces,
    targetKnown: targetKnown,
    unknownReason: unknownReason,
    registryReadKnown: registryReadKnown,
    registryValid: registryReadKnown && registryErrors.length === 0,
    registryErrors: registryErrors,
    sessionScanKnown: sessionScanKnown,
    sessionStrictErrors: sessionStrictErrors.length,
  });
  var fingerprint = {
    workspaceRegistrySha256: registryRead.sha256 || null,
    workspaceJsonExists: registryRead.exists === true,
    sessionIds: sessionScan.artifacts.map(function (item) { return item.id; }).sort(),
    workspaceIds: workspaceIds.slice().sort(),
    defaultWorkspaceId: defaultWorkspaceId,
    archivedSessionIds: archivedSessionIds.slice().sort(),
    pinnedSessionIds: pinnedSessionIds.slice().sort(),
  };
  return {
    sessionScan: sessionScan,
    registryRead: registryRead,
    initialized: initialized,
    archivedSessionIds: archivedSessionIds,
    pinnedSessionIds: pinnedSessionIds,
    defaultWorkspaceId: defaultWorkspaceId,
    workspaceIds: workspaceIds,
    workspaces: workspaces,
    workspaceCount: Object.keys(workspaces).length,
    hostDefaultWorkspacePath: hostDefaultWorkspacePath,
    hasPendingMutation: hasPendingMutation,
    fresh: assessment.fresh,
    freshReasons: assessment.reasons,
    targetFingerprint: fingerprint,
  };
}

function fingerprintEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_) {
    return false;
  }
}

/**
 * 只读检查恢复冲突（预览与执行前重新检查共用）：
 *   - 同 id 会话已存在；
 *   - 会话/工作区没有目标映射；
 *   - 目标工作区文件已存在且内容不同；
 *   - 目标工作区文件目标越界。
 */
async function collectRestoreConflicts(runtime, manifest, mapping, target) {
  var conflicts = [];
  var skippedSessions = [];
  var sessions = Array.isArray(manifest.contents.sessions) ? manifest.contents.sessions : [];
  var existingSessionIds = {};
  for (var ex = 0; ex < target.sessionScan.artifacts.length; ex += 1) {
    existingSessionIds[target.sessionScan.artifacts[ex].id] = true;
  }
  for (var ss = 0; ss < sessions.length; ss += 1) {
    var session = sessions[ss];
    if (!session.complete) {
      skippedSessions.push({ id: session.id, reason: session.incompleteReason || "备份时不完整" });
      continue;
    }
    if (existingSessionIds[session.id]) conflicts.push("目标实例已存在会话：" + session.id);
    if (mappingLookup(mapping, session.cwd) === null) conflicts.push("会话无目标工作区映射：" + session.id + "（" + session.cwd + "）");
  }
  var workspaceFiles = Array.isArray(manifest.contents.workspaceFiles) ? manifest.contents.workspaceFiles : [];
  for (var wf = 0; wf < workspaceFiles.length; wf += 1) {
    var group = workspaceFiles[wf];
    var groupTarget = mappingLookup(mapping, group.workspacePath);
    if (groupTarget === null) {
      conflicts.push("工作区文件没有目标映射：" + group.workspacePath);
      continue;
    }
    for (var f = 0; f < group.files.length; f += 1) {
      var fileDecl = group.files[f];
      var targetFile = join(groupTarget, fileDecl.rel);
      if (!util.isInsidePath(groupTarget, targetFile)) {
        conflicts.push("工作区文件目标越界：" + fileDecl.rel);
        continue;
      }
      if (await util.pathExists(targetFile)) {
        try {
          var targetSha = await util.sha256File(targetFile);
          if (targetSha !== fileDecl.sha256) conflicts.push("目标文件已存在且内容不同：" + targetFile);
        } catch (error) {
          conflicts.push("目标文件检查失败：" + targetFile + "：" + util.errText(error));
        }
      }
    }
  }
  return { conflicts: conflicts, skippedSessions: skippedSessions };
}

async function canReuseExistingDir(dirPath) {
  try {
    var info = await stat(dirPath);
    if (!info.isDirectory()) return false;
    await access(dirPath, 0o2 /* W_OK */);
    return true;
  } catch (_) {
    return false;
  }
}

async function buildTargetMapping(paths, sourcePaths) {
  var used = [];
  var resolved = {};
  var warnings = [];
  for (var i = 0; i < sourcePaths.length; i += 1) {
    var source = sourcePaths[i];
    var target = null;
    if (util.isAllowedDownloadTarget(paths, source)) {
      var reusable = await canReuseExistingDir(source);
      if (reusable) {
        target = { path: source, mode: "keep", reason: "目标机原工作区目录已存在且可写，按原路径恢复" };
      }
    }
    if (!target) {
      var fallback = fmt.fallbackRestorePath(source, paths.restoreFallbackBase, used);
      if (!fallback) {
        throw util.errorWithCode("RESTORE_MAPPING_FAILED", "无法为工作区计算恢复路径：" + source, 500);
      }
      target = {
        path: fallback,
        mode: "remap",
        reason: "目标机原路径不可复用，重映射到默认工作区内的恢复目录",
      };
      warnings.push("工作区路径重映射：" + source + " → " + fallback);
    }
    used.push(target.path);
    resolved[source] = target;
  }
  var mappingResult = fmt.buildRestoreMapping(sourcePaths, function (sourcePath) {
    return resolved[sourcePath] || null;
  });
  if (!mappingResult.ok) throw util.errorWithCode("RESTORE_MAPPING_FAILED", "恢复路径映射校验失败：" + mappingResult.errors.join(","), 500);
  return { mapping: mappingResult.mapping, warnings: warnings };
}

function mappingLookup(mapping, sourcePath) {
  var exact = fmt.mappingIndex(mapping)[sourcePath];
  if (exact !== undefined) return exact;
  return fmt.remapPathByPrefix(sourcePath, mapping);
}

/**
 * 只读检查 + 预览。成功返回 { ok, preview, internal }；致命错误抛带 code 的错误。
 * 预览阶段不写任何目标数据（只读 zip、stat/access 目标）。
 */
export async function inspectBackup(runtime, fileInput) {
  var paths = runtime.paths;
  var resolvedBackup = await util.resolveBackupFileInput(paths, fileInput);
  var filePath = resolvedBackup.path;
  var fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) throw util.errorWithCode("BACKUP_FILE_INVALID", "不是普通文件", 400);

  var listed = await listZip(filePath);
  for (var i = 0; i < listed.entries.length; i += 1) {
    if (!fmt.isSafeZipEntryName(listed.entries[i].name)) {
      throw util.errorWithCode("BACKUP_UNSAFE_ENTRY", "备份包含不安全路径：" + listed.entries[i].name, 422);
    }
  }
  var manifestBytes;
  try {
    manifestBytes = await readZipEntry(filePath, fmt.MANIFEST_ENTRY);
  } catch (error) {
    throw util.errorWithCode("BACKUP_MANIFEST_MISSING", "备份包缺少 manifest.json：" + util.errText(error), 422);
  }
  var manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw util.errorWithCode("BACKUP_MANIFEST_INVALID", "manifest.json 不是合法 JSON", 422);
  }
  var manifestCheck = fmt.validateManifest(manifest);
  if (!manifestCheck.ok) {
    throw util.errorWithCode("BACKUP_MANIFEST_INVALID", "manifest 校验失败：" + manifestCheck.errors.slice(0, 8).join(","), 422);
  }
  var manifestSha = util.sha256Buffer(manifestBytes);
  var hashes = await hashZipEntries(filePath);
  var byName = {};
  for (var h = 0; h < hashes.entries.length; h += 1) byName[hashes.entries[h].name] = hashes.entries[h];
  var expected = fmt.expectedPayloadHashes(manifest);
  var expectedNames = Object.keys(expected);
  var integrityErrors = [];
  for (var e = 0; e < expectedNames.length; e += 1) {
    var expectedName = expectedNames[e];
    var actualItem = byName[expectedName];
    if (!actualItem) integrityErrors.push("缺少文件：" + expectedName);
    else if (actualItem.sha256 !== expected[expectedName]) integrityErrors.push("SHA-256 不一致：" + expectedName);
  }
  if (integrityErrors.length > 0) {
    throw util.errorWithCode("BACKUP_INTEGRITY_FAILED", "备份包完整性校验失败：" + integrityErrors.slice(0, 8).join("；"), 422);
  }
  var actualSha = await util.sha256File(filePath);
  var sidecarSha = null;
  try {
    var sidecar = await readFile(filePath + ".sha256", "utf8");
    var sidecarMatch = /^([0-9a-f]{64})/.exec(sidecar);
    if (sidecarMatch) sidecarSha = sidecarMatch[1];
  } catch (_) {
    sidecarSha = null;
  }
  if (sidecarSha !== null && sidecarSha !== actualSha) {
    throw util.errorWithCode("BACKUP_INTEGRITY_FAILED", "备份包与 .sha256 旁文件不一致（包可能被篡改或传输损坏）", 422);
  }

  var targetVersions = util.collectVersionInfo(paths);
  var versionCheck = fmt.describeVersionComparison(manifest.source, targetVersions);
  // 同核心版本是硬门槛：core-mismatch / 未知 / 格式不兼容全部拒绝，不存在 confirm 绕过。
  if (versionCheck.level === "format-mismatch") {
    throw util.errorWithCode("BACKUP_FORMAT_INCOMPATIBLE", "会话/工作区格式版本不兼容，拒绝恢复：" + versionCheck.warnings.join("；"), 422);
  }
  if (versionCheck.level !== "exact") {
    throw util.errorWithCode("BACKUP_CORE_MISMATCH", "核心版本不一致或未知，禁止恢复（同核心版本是硬门槛）：" + versionCheck.warnings.join("；"), 422);
  }
  var target = await readTargetState(paths);
  if (!target.fresh) {
    throw util.errorWithCode(
      "TARGET_NOT_FRESH",
      "目标实例不是全新实例（" + target.freshReasons.join("；") + "）。首版工具默认拒绝覆盖已有数据。",
      409
    );
  }

  var sourcePaths = [];
  var seen = {};
  var workspaces = Array.isArray(manifest.contents.workspaces) ? manifest.contents.workspaces : [];
  for (var w = 0; w < workspaces.length; w += 1) {
    var workspacePath = workspaces[w].path;
    if (fmt.isAbsolutePosixPath(workspacePath) && !seen[workspacePath]) {
      seen[workspacePath] = true;
      sourcePaths.push(workspacePath);
    }
  }
  var sessions = Array.isArray(manifest.contents.sessions) ? manifest.contents.sessions : [];
  for (var s = 0; s < sessions.length; s += 1) {
    var sessionCwd = sessions[s].cwd;
    if (fmt.isAbsolutePosixPath(sessionCwd) && !seen[sessionCwd]) {
      seen[sessionCwd] = true;
      sourcePaths.push(sessionCwd);
    }
  }
  var mappingResult = await buildTargetMapping(paths, sourcePaths);
  var mapping = mappingResult.mapping;
  var warnings = versionCheck.warnings.concat(mappingResult.warnings);

  // 目标冲突（只读；预览与执行前重新检查共用同一套规则）
  var conflictResult = await collectRestoreConflicts(runtime, manifest, mapping, target);
  var conflicts = conflictResult.conflicts;
  var skippedSessions = conflictResult.skippedSessions;

  // 磁盘空间预估（只读 statfs）
  var freeBytes = await util.statfsFreeBytes(paths.home);
  var neededBytes = typeof manifest.stats === "object" && manifest.stats !== null && typeof manifest.stats.totalBytes === "number" ? manifest.stats.totalBytes : 0;
  if (freeBytes !== null && neededBytes > 0 && freeBytes < neededBytes * 2 + 32 * 1024 * 1024) {
    warnings.push("磁盘剩余空间可能不足：需要约 " + fmt.formatBytes(neededBytes * 2) + "，可用 " + fmt.formatBytes(freeBytes));
  }

  var workspaceFiles = Array.isArray(manifest.contents.workspaceFiles) ? manifest.contents.workspaceFiles : [];
  var counts = {
    sessions: sessions.length,
    restorableSessions: sessions.filter(function (item) { return item.complete === true; }).length,
    workspaces: workspaces.length,
    workspaceFiles: workspaceFiles.reduce(function (sum, item) { return sum + (Array.isArray(item.files) ? item.files.length : 0); }, 0),
    attachments: Array.isArray(manifest.contents.attachments) ? manifest.contents.attachments.length : 0,
    totalBytes: neededBytes,
  };
  var previewId = "preview-" + util.randomSuffix();
  var preview = {
    previewId: previewId,
    file: filePath,
    name: filePath.split("/").pop(),
    size: fileInfo.size,
    sha256: actualSha,
    verified: true,
    verifiedAt: util.nowIso(),
    manifest: {
      format: manifest.format,
      formatVersion: manifest.formatVersion,
      kind: manifest.kind,
      createdAt: manifest.createdAt,
      source: manifest.source,
      warnings: Array.isArray(manifest.warnings) ? manifest.warnings : [],
      exclusions: Array.isArray(manifest.exclusions) ? manifest.exclusions : [],
    },
    counts: counts,
    mapping: mapping,
    targetFresh: target.fresh,
    targetFreshReasons: target.freshReasons,
    skippedSessions: skippedSessions,
    conflicts: conflicts,
    warnings: warnings,
    versionLevel: versionCheck.level,
    versionWarnings: versionCheck.warnings,
    backupDirVisible: paths.backupDirVisible,
    backupDir: paths.backupDir,
    canRestore: conflicts.length === 0,
  };
  var internal = {
    previewId: previewId,
    filePath: filePath,
    sha256: actualSha,
    manifestSha: manifestSha,
    manifest: manifest,
    mapping: mapping,
    sourcePaths: sourcePaths,
    targetVersions: targetVersions,
    targetFingerprint: target.targetFingerprint,
    targetFresh: target.fresh,
    conflicts: conflicts.slice(),
    canRestore: conflicts.length === 0,
    versionLevel: versionCheck.level,
    createdAt: Date.now(),
  };
  return { ok: true, preview: preview, internal: internal };
}

// ── 执行恢复 ───────────────────────────────────────────────────────────────

function assertTargetAllowed(paths, targetPath) {
  if (!fmt.isAbsolutePosixPath(targetPath) || fmt.normalizePosixPath(targetPath) === null) {
    throw util.errorWithCode("RESTORE_TARGET_UNSAFE", "恢复目标路径不安全：" + targetPath, 500);
  }
  // 与 buildTargetMapping 共用同一套 util 路径策略；不允许空根/相似前缀放行。
  if (util.isAllowedDownloadTarget(paths, targetPath)) return;
  if (util.isRestoreFallbackTarget(paths, targetPath)) return;
  throw util.errorWithCode("RESTORE_TARGET_UNSAFE", "恢复目标不在允许目录（已验证的下载根或恢复专用目录）内：" + targetPath, 500);
}

async function ensureDirTracked(dirPath, createdDirs) {
  if (await util.pathExists(dirPath)) return;
  var missing = [];
  var cursor = resolve(dirPath);
  while (!(await util.pathExists(cursor))) {
    missing.push(cursor);
    var parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (var i = missing.length - 1; i >= 0; i -= 1) {
    await mkdir(missing[i], { recursive: true, mode: 0o700 });
    createdDirs.push(missing[i]);
  }
}

/**
 * 回滚恢复操作。
 *
 * 关键要求：**不得**用会吞错误的 Quietly 删除函数作为“已回滚”的依据。
 * - 文件/会话目录用 strict 删除，并再次 stat 确认不存在；
 * - 本次创建的空目录用 rmdir（非递归）删除：若目录非空，说明其中可能有未跟踪文件，
 *   保留并记为失败，绝不递归删除未知数据；
 * - workspace.json 恢复后重新读取比对原文；无法确认一律 rolledBack=false；
 * - 保留恢复前 registry 快照作为人工排查证据，不因回滚而删除。
 */
export async function rollbackRestore(runtime, journal, errors) {
  var paths = runtime.paths;
  var failures = [];
  var warnings = [];
  function fail(targetPath, error) {
    failures.push({ path: targetPath, error: error || "unknown" });
  }

  // 逆序删除本次创建的文件
  for (var i = journal.createdFiles.length - 1; i >= 0; i -= 1) {
    var fileResult = await util.removeFileStrict(journal.createdFiles[i]);
    if (!fileResult.ok || fileResult.stillExists) {
      fail(journal.createdFiles[i], fileResult.error || "still-exists");
    }
  }

  // 删除本次“新建”的会话目录：文件已在上一步删除，这里只做非递归 rmdir；
  // 非空（存在未跟踪文件）即失败并保留目录，绝不递归删除既有/未知数据。
  for (var s = journal.createdSessionDirs.length - 1; s >= 0; s -= 1) {
    try {
      await rmdir(journal.createdSessionDirs[s]);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      if (error && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) {
        fail(journal.createdSessionDirs[s], "会话目录非空（含未跟踪文件，已保留）");
      } else {
        fail(journal.createdSessionDirs[s], errTextSafe(error));
      }
    }
  }

  // 删除本次创建的空目录（从深到浅；非递归，避免误删未跟踪数据）
  var dirs = journal.createdDirs.slice().sort(function (a, b) {
    return b.length - a.length;
  });
  for (var d = 0; d < dirs.length; d += 1) {
    try {
      await rmdir(dirs[d]);
    } catch (error) {
      if (error && error.code === "ENOENT") continue; // 已不存在 = 清理成功
      if (error && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) {
        fail(dirs[d], "目录非空（可能含未跟踪文件，已保留）");
      } else {
        fail(dirs[d], errTextSafe(error));
      }
    }
  }

  // 恢复目标 workspace.json（恢复后重新读取比对）
  try {
    if (journal.registryExisted) {
      await util.writeFileAtomic(paths.workspaceRegistryPath, journal.registryText, { mode: 0o600 });
      var restoredText = await readFile(paths.workspaceRegistryPath, "utf8");
      if (restoredText !== journal.registryText) {
        fail(paths.workspaceRegistryPath, "恢复后的 workspace.json 与快照内容不一致");
      }
    } else {
      var registryRemove = await util.removeFileStrict(paths.workspaceRegistryPath);
      if (!registryRemove.ok || registryRemove.stillExists) {
        fail(paths.workspaceRegistryPath, registryRemove.error || "still-exists");
      }
    }
  } catch (error) {
    fail(paths.workspaceRegistryPath, errTextSafe(error));
  }

  // staging 属于临时区；清理失败只作为警告记录（不谎称已清理），不影响目标回滚判定
  var stagingResult = await util.removeTreeStrict(journal.stagingDir);
  if (!stagingResult.ok || stagingResult.stillExists) {
    warnings.push({ path: journal.stagingDir, error: stagingResult.error || "still-exists" });
  }

  var messages = [];
  for (var f = 0; f < failures.length; f += 1) messages.push("回滚未完成：" + failures[f].path + "：" + failures[f].error);
  for (var w = 0; w < warnings.length; w += 1) messages.push("临时区清理未确认：" + warnings[w].path + "：" + warnings[w].error);
  return {
    rolledBack: failures.length === 0,
    failures: failures,
    warnings: warnings,
    messages: messages,
    errors: errors,
    registrySnapshotPath: journal.registrySnapshotPath || null,
  };
}

function errTextSafe(error) {
  try {
    return util.errText(error);
  } catch (_) {
    return "unknown";
  }
}

/**
 * 执行恢复。internal 来自 inspectBackup；
 * options = { onProgress?: function }。核心版本/格式必须 exact，不存在跨版本确认旁路。
 * 返回报告（ok:true/false，含 rollback 信息）；致命参数错误抛带 code 的错误。
 */
export async function executeRestore(runtime, internal, options) {
  var settings = options || {};
  var paths = runtime.paths;
  var logger = runtime.logger;
  var manifest = internal.manifest;
  var mapping = internal.mapping;
  // 进度回调优先使用 startJob 传入的 onProgress（否则界面会一直停在排队状态）
  var progress =
    typeof settings.onProgress === "function"
      ? settings.onProgress
      : typeof runtime.onProgress === "function"
        ? runtime.onProgress
        : function () {};

  if (!internal || internal.canRestore !== true || (Array.isArray(internal.conflicts) && internal.conflicts.length > 0)) {
    throw util.errorWithCode("RESTORE_PREVIEW_INVALID", "预览结果不可恢复（存在冲突或预览无效），请重新预览", 409);
  }
  if (internal.versionLevel !== "exact") {
    throw util.errorWithCode("BACKUP_CORE_MISMATCH", "预览中的核心版本/格式不是 exact，禁止恢复（同核心版本是硬门槛）", 409);
  }
  var versionNow = fmt.describeVersionComparison(manifest.source, util.collectVersionInfo(paths));
  if (versionNow.level !== "exact") {
    throw util.errorWithCode("BACKUP_CORE_MISMATCH", "执行前复核：核心版本不一致/未知或格式不兼容，禁止恢复：" + versionNow.warnings.join("；"), 409);
  }
  progress("applying", 2, "复核备份包完整性");
  var resolvedNow = await util.resolveBackupFileInput(paths, internal.filePath);
  if (resolvedNow.path !== internal.filePath) {
    throw util.errorWithCode("BACKUP_CHANGED", "备份文件路径解析异常，请重新预览", 409);
  }
  var currentSha = await util.sha256File(internal.filePath);
  if (currentSha !== internal.sha256) {
    throw util.errorWithCode("BACKUP_CHANGED", "备份文件在预览后被修改，请重新预览", 409);
  }

  // ── 必须在任何 staging 解压、目录创建、目标写入之前重新检查目标 ──────────
  progress("verifying", 3, "重新检查目标状态");
  var targetNow = await readTargetState(paths);
  if (!targetNow.fresh) {
    throw util.errorWithCode(
      "RESTORE_PREVIEW_STALE",
      "目标实例在预览后不再全新（" + targetNow.freshReasons.join("；") + "），请重新预览后再决定",
      409
    );
  }
  if (!fingerprintEqual(internal.targetFingerprint, targetNow.targetFingerprint)) {
    throw util.errorWithCode(
      "RESTORE_PREVIEW_STALE",
      "目标状态在预览后发生变化（会话/工作区/归档/置顶/registry 有变化），请重新预览",
      409
    );
  }
  var mappingNow = await buildTargetMapping(paths, internal.sourcePaths || []);
  if (JSON.stringify(mappingNow.mapping) !== JSON.stringify(internal.mapping)) {
    throw util.errorWithCode("RESTORE_PREVIEW_STALE", "恢复路径映射在预览后发生变化，请重新预览", 409);
  }
  var conflictsNow = await collectRestoreConflicts(runtime, manifest, internal.mapping, targetNow);
  if (conflictsNow.conflicts.length > 0) {
    throw util.errorWithCode(
      "RESTORE_PREVIEW_STALE",
      "目标出现新的冲突（" + conflictsNow.conflicts.slice(0, 3).join("；") + "），请重新预览",
      409
    );
  }

  await util.ensureDir(paths.stagingRoot);
  var jobId = "restore-" + util.randomSuffix();
  var stagingDir = join(paths.stagingRoot, jobId);
  var journal = {
    stagingDir: stagingDir,
    createdFiles: [],
    createdDirs: [],
    createdSessionDirs: [],
    registryExisted: false,
    registryText: null,
  };
  var skipped = [];

  try {
    await util.ensureDir(stagingDir);
    progress("applying", 8, "解压并逐文件校验备份包");
    var extractOptions = {
      expectedHashes: fmt.expectedPayloadHashes(manifest),
      maxTotalBytes: fmt.MAX_BACKUP_BYTES,
      maxFileBytes: fmt.MAX_BACKUP_BYTES,
      onProgress: function (done, total) {
        var percent = 8 + Math.round((done / Math.max(1, total)) * 42);
        progress("applying", percent, "解压备份包");
      },
    };
    await extractZip(internal.filePath, stagingDir, extractOptions);

    // 安全备份目标 workspace.json（恢复前快照；全新实例通常只有默认空工作区记录）
    progress("applying", 55, "保存目标当前工作区注册表快照");
    journal.registryExisted = await util.pathExists(paths.workspaceRegistryPath);
    if (journal.registryExisted) {
      journal.registryText = await readFile(paths.workspaceRegistryPath, "utf8");
      // 持久化恢复前快照：即使本次任务失败/应用重启，也能人工找回目标原注册表
      try {
        var rollbackDir = join(paths.stateDir, "rollback");
        await util.ensureDir(rollbackDir);
        journal.registrySnapshotPath = join(rollbackDir, "pre-restore-" + jobId + "-workspace.json");
        await util.writeFileAtomic(journal.registrySnapshotPath, journal.registryText, { mode: 0o600 });
      } catch (_) {
        journal.registrySnapshotPath = null;
      }
    }

    // 1) 创建目标工作区目录
    progress("applying", 58, "准备工作区目录");
    for (var m = 0; m < mapping.length; m += 1) {
      assertTargetAllowed(paths, mapping[m].to);
      await ensureDirTracked(mapping[m].to, journal.createdDirs);
    }

    // 2) 恢复会话日志（必要时重写 header.cwd）
    progress("applying", 62, "写入会话记录");
    var sessions = Array.isArray(manifest.contents.sessions) ? manifest.contents.sessions : [];
    var restoredSessions = 0;
    var sessionIds = {};
    for (var si = 0; si < sessions.length; si += 1) {
      var session = sessions[si];
      if (!session.complete) {
        skipped.push({ id: session.id, reason: session.incompleteReason || "备份时不完整" });
        continue;
      }
      var stagedSessionPath = join(stagingDir, session.file);
      if (!(await util.pathExists(stagedSessionPath))) throw util.errorWithCode("RESTORE_STAGING_MISSING", "staging 缺少会话文件：" + session.file, 500);
      var targetCwd = mappingLookup(mapping, session.cwd);
      if (targetCwd === null) throw util.errorWithCode("RESTORE_MAPPING_MISSING", "会话无目标工作区映射：" + session.id, 500);
      var sessionCompression = /\.zstd$/.test(session.file) ? "zstd" : "none";
      var sessionFileName = sessionCompression === "zstd" ? fmt.SESSION_LOG_BASENAME : "session.v4.jsonl";
      var projectDir = join(paths.sessionsDir, fmt.projectKey(targetCwd));
      var sessionDir = join(projectDir, fmt.encodeSegment(session.id));
      var logPath = join(sessionDir, sessionFileName);
      if (await util.pathExists(logPath)) throw util.errorWithCode("RESTORE_SESSION_CONFLICT", "目标会话已存在，拒绝覆盖：" + session.id, 409);
      // 记录 sessionDir 是否由本次恢复创建：回滚时只有“本次新建”的目录才参与目录清理；
      // 既有 sessionDir 只允许删除本次新写入的日志文件，绝不递归删除整个目录。
      var sessionDirExistedBefore = await util.pathExists(sessionDir);
      await ensureDirTracked(sessionDir, journal.createdDirs);
      var bytes = await readFile(stagedSessionPath);
      if (targetCwd !== session.cwd) {
        bytes = util.rewriteSessionCwd(bytes, sessionCompression, targetCwd);
      }
      await util.writeFileAtomic(logPath, bytes, { mode: 0o600 });
      journal.createdFiles.push(logPath);
      if (!sessionDirExistedBefore) journal.createdSessionDirs.push(sessionDir);
      restoredSessions += 1;
      sessionIds[session.id] = true;
      if (si % 10 === 0) progress("applying", 62 + Math.round(((si + 1) / Math.max(1, sessions.length)) * 8), "写入会话记录 " + (si + 1) + "/" + sessions.length);
    }

    // 3) 恢复附件
    progress("applying", 72, "写入附件");
    var attachments = Array.isArray(manifest.contents.attachments) ? manifest.contents.attachments : [];
    var restoredAttachments = 0;
    for (var ai = 0; ai < attachments.length; ai += 1) {
      var attachment = attachments[ai];
      var rel = attachment.entry.slice(fmt.ATTACHMENT_ENTRY_PREFIX.length);
      var dest = join(paths.attachmentsDir, rel);
      if (!util.isInsidePath(paths.attachmentsDir, dest)) throw util.errorWithCode("RESTORE_TARGET_UNSAFE", "附件目标越界：" + attachment.entry, 500);
      if (await util.pathExists(dest)) {
        var existingSha = await util.sha256File(dest);
        if (existingSha === attachment.sha256) continue;
        throw util.errorWithCode("RESTORE_FILE_CONFLICT", "目标附件已存在且内容不同：" + dest, 409);
      }
      await ensureDirTracked(dirname(dest), journal.createdDirs);
      await util.copyFileAtomic(join(stagingDir, attachment.entry), dest);
      journal.createdFiles.push(dest);
      restoredAttachments += 1;
    }

    // 4) 恢复工作区产出文件
    progress("applying", 78, "写入工作区产出文件");
    var workspaceFiles = Array.isArray(manifest.contents.workspaceFiles) ? manifest.contents.workspaceFiles : [];
    var restoredWorkspaceFiles = 0;
    for (var wi = 0; wi < workspaceFiles.length; wi += 1) {
      var group = workspaceFiles[wi];
      var groupTarget = mappingLookup(mapping, group.workspacePath);
      if (groupTarget === null) throw util.errorWithCode("RESTORE_MAPPING_MISSING", "工作区无目标映射：" + group.workspacePath, 500);
      for (var fi = 0; fi < group.files.length; fi += 1) {
        var fileDecl = group.files[fi];
        var targetFile = join(groupTarget, fileDecl.rel);
        if (!util.isInsidePath(groupTarget, targetFile)) throw util.errorWithCode("RESTORE_TARGET_UNSAFE", "工作区文件目标越界：" + fileDecl.rel, 500);
        if (await util.pathExists(targetFile)) {
          var same = (await util.sha256File(targetFile)) === fileDecl.sha256;
          if (same) continue;
          throw util.errorWithCode("RESTORE_FILE_CONFLICT", "目标文件已存在且内容不同：" + targetFile, 409);
        }
        await ensureDirTracked(dirname(targetFile), journal.createdDirs);
        // 用户可见目录禁止 copyfile/chmod（及可能的 fsync/rename）；目标已确认不存在，
        // 直接流式写入最终路径。只有 copyFileDirect 排他创建成功后，才通过 onCreated
        // 登记 journal；EEXIST/既有文件绝不登记、绝不删除。
        await util.copyFileDirect(join(stagingDir, fileDecl.entry), targetFile, {
          onCreated: function (createdPath) {
            journal.createdFiles.push(createdPath);
          },
        });
        restoredWorkspaceFiles += 1;
      }
    }

    // 5) 写回 workspace.json（最后一步；恢复后必须冷重启）
    progress("applying", 88, "写入工作区注册表");
    var registry = null;
    var skippedSessionIds = skipped.map(function (item) { return item.id; }).filter(function (id) { return typeof id === "string"; });
    if (manifest.contents.workspaceRegistry) {
      var registryBytes = await readFile(join(stagingDir, manifest.contents.workspaceRegistry.entry));
      var originalRegistry = JSON.parse(registryBytes.toString("utf8"));
      var rewrite = fmt.rewriteWorkspaceRegistry(originalRegistry, mapping, { skippedSessionIds: skippedSessionIds });
      if (!rewrite.ok) throw util.errorWithCode("RESTORE_REGISTRY_INVALID", "改写工作区注册表失败：" + rewrite.errors.join(","), 500);
      registry = rewrite.registry;
    } else {
      var built = fmt.buildWorkspaceRegistryFromManifest(manifest, mapping, randomUUID);
      if (!built.ok) throw util.errorWithCode("RESTORE_REGISTRY_INVALID", "构造工作区注册表失败：" + built.errors.join(","), 500);
      registry = fmt.pruneSkippedSessionReferences(built.registry, skippedSessionIds);
    }
    var registryCheck = fmt.validateWorkspaceRegistry(registry);
    if (!registryCheck.ok) throw util.errorWithCode("RESTORE_REGISTRY_INVALID", "恢复后的 workspace.json 校验失败：" + registryCheck.errors.join(","), 500);
    await util.writeFileAtomic(paths.workspaceRegistryPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });

    // 6) 复验
    progress("applying", 94, "复验恢复结果");
    var verify = await verifyRestore(runtime, manifest, mapping, sessionIds);
    if (!verify.ok) {
      throw util.errorWithCode("RESTORE_VERIFY_FAILED", "恢复后复验失败：" + verify.errors.join("；"), 500);
    }

    progress("done", 100, "恢复完成，请冷重启 DSHM");
    var stagingCleanup = await util.removeTreeStrict(stagingDir);
    var extraWarnings = (verify.warnings || []).concat(Array.isArray(manifest.warnings) ? manifest.warnings : []);
    if (!stagingCleanup.ok || stagingCleanup.stillExists) {
      extraWarnings.push("staging 清理未确认（可能残留临时目录）：" + stagingDir + "：" + (stagingCleanup.error || "still-exists"));
    }
    var report = {
      ok: true,
      jobId: jobId,
      needsColdRestart: true,
      restoredSessions: restoredSessions,
      restoredWorkspaces: Object.keys(registry.tables.workspaces).length,
      restoredWorkspaceFiles: restoredWorkspaceFiles,
      restoredAttachments: restoredAttachments,
      skipped: skipped,
      skippedSessionIds: skippedSessionIds,
      warnings: extraWarnings,
      mapping: mapping,
      registryPath: paths.workspaceRegistryPath,
      restoreSafetyRegistrySaved: journal.registryExisted,
      registrySnapshotPath: journal.registrySnapshotPath || null,
      reportText: buildRestoreReportText(restoredSessions, registry, restoredWorkspaceFiles, restoredAttachments, skipped),
      finishedAt: util.nowIso(),
    };
    if (logger) logger.info("恢复完成：sessions=" + restoredSessions + " workspaces=" + report.restoredWorkspaces + " files=" + restoredWorkspaceFiles);
    return report;
  } catch (error) {
    var rollback = await rollbackRestore(runtime, journal, [util.errText(error)]);
    if (logger) logger.error("恢复失败并回滚：error=" + util.errText(error) + " rollback=" + JSON.stringify(rollback.messages));
    var failureText = "恢复失败：" + util.errText(error);
    if (rollback.rolledBack) {
      failureText += "\n已回滚到恢复前状态（文件/会话目录/目录/workspace.json 均已确认恢复或清理）。";
    } else {
      failureText += "\n回滚未完成，请人工检查以下路径：";
      for (var ff = 0; ff < (rollback.failures || []).length; ff += 1) {
        failureText += "\n- " + rollback.failures[ff].path + "（" + rollback.failures[ff].error + "）";
      }
      if (rollback.registrySnapshotPath) failureText += "\n恢复前 registry 快照：" + rollback.registrySnapshotPath;
    }
    return {
      ok: false,
      jobId: jobId,
      error: util.errText(error),
      code: error.code || "RESTORE_FAILED",
      rolledBack: rollback.rolledBack,
      rollbackFailures: rollback.failures || [],
      rollbackWarnings: rollback.warnings || [],
      rollbackMessages: rollback.messages,
      registrySnapshotPath: rollback.registrySnapshotPath || null,
      needsColdRestart: false,
      reportText: failureText,
      finishedAt: util.nowIso(),
    };
  }
}

async function verifyRestore(runtime, manifest, mapping, restoredSessionIds) {
  var paths = runtime.paths;
  var errors = [];
  var warnings = [];
  var scan = await scanSessionArtifacts(paths);
  var found = {};
  for (var i = 0; i < scan.artifacts.length; i += 1) found[scan.artifacts[i].id] = scan.artifacts[i];
  var expectedSessions = Array.isArray(manifest.contents.sessions) ? manifest.contents.sessions.filter(function (item) { return item.complete; }) : [];
  for (var s = 0; s < expectedSessions.length; s += 1) {
    var session = expectedSessions[s];
    var artifact = found[session.id];
    if (!artifact) {
      errors.push("复验时找不到会话：" + session.id);
      continue;
    }
    try {
      var snapshot = await util.readStableFile(artifact.filePath, { retries: 0 });
      var inspection = util.inspectSessionBytes(snapshot.bytes, artifact.compression);
      if (!inspection.header) errors.push("会话 header 无法解析：" + session.id);
      else {
        var expectedCwd = mappingLookup(mapping, session.cwd);
        if (inspection.header.cwd !== expectedCwd) errors.push("会话 cwd 与映射不一致：" + session.id);
      }
    } catch (error) {
      errors.push("复验会话失败：" + session.id + "：" + util.errText(error));
    }
  }
  // 注册表复验
  var registryRead = await util.readWorkspaceRegistry(paths.workspaceRegistryPath);
  if (!registryRead.exists || registryRead.errors.length > 0) {
    errors.push("恢复后 workspace.json 不可读或结构异常");
  } else {
    var registry = registryRead.registry;
    var table = registry.tables.workspaces;
    for (var id in table) {
      if (!Object.prototype.hasOwnProperty.call(table, id)) continue;
      var record = table[id];
      if (!fmt.isAbsolutePosixPath(record.path)) errors.push("工作区路径非法：" + id);
      else if (!(await util.isDirectory(record.path))) warnings.push("工作区目录尚不存在（会话目录会在首次使用前由系统创建）：" + record.path);
      if (!Array.isArray(record.sessionIds)) errors.push("工作区 sessionIds 缺失：" + id);
    }
  }
  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

function buildRestoreReportText(sessions, registry, files, attachments, skipped) {
  var lines = [];
  lines.push("恢复成功。");
  lines.push("- 会话：" + sessions + " 个");
  lines.push("- 工作区：" + Object.keys(registry.tables.workspaces).length + " 个");
  lines.push("- 工作区产出文件：" + files + " 个");
  lines.push("- 附件：" + attachments + " 个");
  if (skipped.length > 0) {
    lines.push("- 跳过的不完整/冲突会话：" + skipped.length + " 个（详见恢复报告）");
  }
  lines.push("");
  lines.push("必须冷重启：请划掉 DSHM 后台并重新打开应用，重启前不要新建会话，否则恢复的工作区注册表可能被运行中的实例覆盖。");
  return lines.join("\n");
}

// ── 只读检查入口（供 Node 24 行为测试；不写目标） ──────────────────────────
export async function inspectRestoreTargetForTests(paths) {
  return readTargetState(paths);
}

export async function buildTargetMappingForTests(paths, sourcePaths) {
  return buildTargetMapping(paths, sourcePaths);
}
