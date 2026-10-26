// dshm-backup 备份引擎（backup）
//
// 职责：把 DSHM 的“会话日志 + 工作区注册表 + 工作区产出文件 + 附件 + 插件清单”
// 打成单个 ZIP，写完后重新读取校验，只有验证通过才发布为正式备份文件。
//
// 一致性策略：
//   · 会话日志是 append+fsync、多 zstd 帧拼接；按 core 的 readStableSnapshot 思路
//     stat→read→stat 比对 identity（dev/ino/size/mtimeNs/ctimeNs），变化重试一次，
//     仍变化则截取“第一次 stat 的 size 前缀”，并在 manifest 标记 stable=false；
//   · 逐帧解压校验 checksum；末尾不完整帧会标记 torn，仍按“不完整”记录，不静默丢弃；
//   · 所有 payload 先复制到 staging 并重新计算 SHA-256，再用 staging 打包，
//     避免“hash 一份、打包另一份”的竞态；
//   · 写入临时文件 → 重新读取并逐文件 SHA-256 校验 → 原子 rename → 写 .sha256 旁文件。


import { readdir, stat, readFile, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import * as fmt from "./format.js";
import * as util from "./util.js";
import { writeZip, listZip, hashZipEntries, readZipEntry } from "./zip.js";

export const BACKUP_SKIP_DIR_NAMES = util.DEFAULT_SKIP_DIR_NAMES;

function emptyProgress() {}

function normalizeProgress(onProgress) {
  return typeof onProgress === "function" ? onProgress : emptyProgress;
}

function compressionForName(name) {
  if (/\.(json|jsonl|md|txt|yml|yaml|log|csv|tsv|xml|js|mjs|cjs|css|html)$/i.test(name)) return "deflate";
  return "store";
}

/**
 * 扫描 DSH_HOME/sessions，返回会话工件列表（只读，不加载正文）。
 * 结果项：
 *   { id, sessionDir, filePath, compression, projectDir }
 * 无法识别/不支持的工件进入 warnings。
 */
export async function scanSessionArtifacts(paths, options) {
  var settings = options || {};
  var tolerateErrors = settings.tolerateErrors === true;
  var warnings = [];
  var strictErrors = [];
  var artifacts = [];
  var projectNames = null;
  try {
    projectNames = await readdir(paths.sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { artifacts: artifacts, warnings: ["sessions 目录不存在"], known: true, absent: true, strictErrors: strictErrors };
    }
    var readFailure = "sessions 目录读取失败：" + util.errText(error);
    if (tolerateErrors) {
      return { artifacts: artifacts, warnings: warnings.concat([readFailure]), known: false, absent: false, strictErrors: [readFailure] };
    }
    throw error;
  }
  projectNames.sort(function (a, b) {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (var i = 0; i < projectNames.length; i += 1) {
    var project = projectNames[i];
    if (!project.isDirectory()) continue;
    var projectDir = join(paths.sessionsDir, project.name);
    var sessionNames = null;
    try {
      sessionNames = await readdir(projectDir, { withFileTypes: true });
    } catch (error) {
      var projectError = "会话项目目录读取失败：" + project.name + "：" + util.errText(error);
      warnings.push(projectError + "（已跳过）");
      strictErrors.push(projectError);
      continue;
    }
    sessionNames.sort(function (a, b) {
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    for (var j = 0; j < sessionNames.length; j += 1) {
      var sessionEntry = sessionNames[j];
      if (!sessionEntry.isDirectory()) continue;
      var sessionDir = join(projectDir, sessionEntry.name);
      var decodedId = fmt.decodeSegment(sessionEntry.name);
      if (decodedId === null) {
        var nameError = "无法解析会话目录名：" + project.name + "/" + sessionEntry.name;
        warnings.push(nameError + "（已跳过）");
        strictErrors.push(nameError);
        continue;
      }
      var fileNames = null;
      try {
        fileNames = await readdir(sessionDir);
      } catch (error) {
        var sessionError = "会话目录读取失败：" + sessionEntry.name + "：" + util.errText(error);
        warnings.push(sessionError + "（已跳过）");
        strictErrors.push(sessionError);
        continue;
      }
      var zstdName = null;
      var plainName = null;
      var unsupported = [];
      for (var k = 0; k < fileNames.length; k += 1) {
        var fileName = fileNames[k];
        var m = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(fileName);
        if (!m) continue;
        if (m[1] !== String(fmt.SESSION_FORMAT_VERSION)) {
          unsupported.push(fileName);
          continue;
        }
        if (m[2] === ".zstd") zstdName = fileName;
        else plainName = fileName;
      }
      if (unsupported.length > 0) {
        var unsupportedError = "发现非 v" + fmt.SESSION_FORMAT_VERSION + " 会话工件：" + sessionEntry.name + " -> " + unsupported.join(",");
        warnings.push(unsupportedError + "（首版不迁移，已跳过）");
        strictErrors.push(unsupportedError);
      }
      var chosen = zstdName || plainName;
      if (!chosen) {
        var missingError = "会话目录内没有可识别的 v" + fmt.SESSION_FORMAT_VERSION + " 日志文件：" + sessionEntry.name;
        warnings.push(missingError + "（已跳过）");
        strictErrors.push(missingError);
        continue;
      }
      artifacts.push({
        id: decodedId,
        sessionDir: sessionDir,
        filePath: join(sessionDir, chosen),
        compression: zstdName ? "zstd" : "none",
        projectDir: project.name,
        projectPath: projectDir,
      });
    }
  }
  return { artifacts: artifacts, warnings: warnings, known: true, absent: false, strictErrors: strictErrors };
}

async function countStoredSessions(paths) {
  var scan = await scanSessionArtifacts(paths);
  return { count: scan.artifacts.length, warnings: scan.warnings };
}

/**
 * 生成一次备份。runtime 由 index.js 提供：
 *   { paths, versions, config, logger, onProgress }
 * 返回报告对象；失败抛错（错误带 code），并清理本次 staging。
 */
export async function createBackup(runtime, kind, options) {
  try {
    return await createBackupInner(runtime, kind, options);
  } catch (error) {
    await cleanupAllStaging(runtime.paths.stagingRoot).catch(function () {
      return undefined;
    });
    throw error;
  }
}

async function createBackupInner(runtime, kind, options) {
  var settings = options || {};
  var progress = normalizeProgress(settings.onProgress || runtime.onProgress);
  var paths = runtime.paths;
  var logger = runtime.logger;
  var config = runtime.config || {};
  var startedAt = Date.now();
  var jobId = "backup-" + util.randomSuffix();
  var stageRoot = join(paths.stagingRoot, jobId);
  var payloadRoot = join(stageRoot, "payload");
  var warnings = [];
  var exclusions = defaultExclusions();
  var totals = { sessions: 0, workspaces: 0, workspaceFiles: 0, attachments: 0, bytes: 0 };
  var manifestSessions = [];
  var manifestWorkspaceFiles = [];
  var manifestAttachments = [];
  var payloadEntries = [];

  progress("scanning", 2, "检查磁盘空间与目录");
  await util.ensureDir(paths.stagingRoot);
  await cleanupOldStaging(paths.stagingRoot);
  var freeBytes = await util.statfsFreeBytes(paths.backupDir);
  var minFree = typeof config.minFreeBytes === "number" ? config.minFreeBytes : 64 * 1024 * 1024;
  if (freeBytes !== null && freeBytes < minFree) {
    throw util.errorWithCode("DISK_FULL", "备份目录剩余空间不足（" + fmt.formatBytes(freeBytes) + " < " + fmt.formatBytes(minFree) + "）：" + paths.backupDir, 507);
  }
  await util.ensureDir(paths.backupDir);
  await util.ensureDir(payloadRoot);

  // 1) 会话扫描
  progress("scanning", 5, "扫描会话记录");
  var sessionScan = await scanSessionArtifacts(paths);
  warnings = warnings.concat(sessionScan.warnings);
  var sessionArtifacts = sessionScan.artifacts;
  if (sessionArtifacts.length > fmt.MAX_BACKUP_FILES) {
    throw util.errorWithCode("BACKUP_TOO_MANY_SESSIONS", "会话数量超过上限（" + fmt.MAX_BACKUP_FILES + "）", 413);
  }
  var sessionPlan = [];
  for (var si = 0; si < sessionArtifacts.length; si += 1) {
    var artifact = sessionArtifacts[si];
    var planItem = null;
    try {
      var snapshot = await util.readStableFile(artifact.filePath, { retries: 1 });
      var inspection = util.inspectSessionBytes(snapshot.bytes, artifact.compression);
      var header = inspection.header;
      var reason = null;
      if (!snapshot.stable) reason = "备份时文件仍在写入（已截取稳定前缀）";
      if (inspection.torn) reason = (reason ? reason + "；" : "") + "日志末尾存在未完成 zstd 帧";
      if (!header) reason = (reason ? reason + "；" : "") + "header 校验失败：" + inspection.errors.join(",");
      if (header && header.id !== artifact.id) reason = (reason ? reason + "；" : "") + "目录名与 header id 不一致（目录=" + artifact.id + "，header=" + header.id + "）";
      if (header && !header.cwd) reason = (reason ? reason + "；" : "") + "header 缺少 cwd，无法确定工作区";
      planItem = {
        id: header && header.id === artifact.id ? header.id : artifact.id,
        header: header,
        cwd: header && header.cwd ? header.cwd : null,
        createdAt: header && typeof header.createdAt === "number" ? header.createdAt : null,
        bytes: snapshot.bytes,
        compression: artifact.compression,
        complete: inspection.complete && snapshot.stable && !!header && header.id === artifact.id && !!header.cwd,
        reason: reason,
        sourceFile: artifact.filePath,
        frameCount: inspection.frameCount,
        eventCount: inspection.eventCount,
        torn: inspection.torn,
        stable: snapshot.stable,
      };
    } catch (error) {
      warnings.push("会话读取失败（不进入可恢复区段）：" + artifact.id + "：" + util.errText(error));
      continue;
    }
    sessionPlan.push(planItem);
  }

  // 2) 会话写入 staging
  progress("staging", 20, "复制会话快照");
  for (var sj = 0; sj < sessionPlan.length; sj += 1) {
    var item = sessionPlan[sj];
    var entry = fmt.sessionZipEntry(item.id, item.compression);
    var stagedPath = join(payloadRoot, entry);
    await util.writeFileAtomic(stagedPath, item.bytes, { mode: 0o600 });
    var stagedSha = await util.sha256File(stagedPath);
    var stagedSize = (await stat(stagedPath)).size;
    item.entry = entry;
    item.size = stagedSize;
    item.sha256 = stagedSha;
    totals.sessions += 1;
    totals.bytes += stagedSize;
    manifestSessions.push({
      id: item.id,
      cwd: item.cwd,
      createdAt: item.createdAt,
      file: entry,
      size: stagedSize,
      sha256: stagedSha,
      complete: item.complete,
      incompleteReason: item.complete ? "" : item.reason || "备份时无法确认一致性",
      stable: item.stable,
      torn: item.torn,
      frames: item.frameCount,
      events: item.eventCount,
    });
    payloadEntries.push({ name: entry, source: { type: "file", path: stagedPath }, compress: "store" });
    progress("staging", 20 + Math.round(((sj + 1) / Math.max(1, sessionPlan.length)) * 15), "复制会话快照 " + (sj + 1) + "/" + sessionPlan.length);
  }

  // 3) 工作区注册表
  progress("staging", 36, "读取工作区注册表");
  var registryRead = await util.readWorkspaceRegistry(paths.workspaceRegistryPath);
  var manifestWorkspaces = [];
  var registryEntry = null;
  var registrySha = null;
  if (registryRead.errors.length > 0) warnings = warnings.concat(registryRead.errors.map(function (item) { return "workspace.json：" + item; }));
  if (registryRead.exists) {
    registrySha = registryRead.sha256;
    registryEntry = fmt.WORKSPACE_REGISTRY_ENTRY;
    var registryPath = join(payloadRoot, registryEntry);
    await util.writeFileAtomic(registryPath, registryRead.text, { mode: 0o600 });
    payloadEntries.push({ name: registryEntry, source: { type: "file", path: registryPath }, compress: "deflate" });
    var registry = registryRead.registry;
    if (registry && fmt.isObject(registry.tables) && fmt.isObject(registry.tables.workspaces)) {
      var table = registry.tables.workspaces;
      for (var wsId in table) {
        if (!Object.prototype.hasOwnProperty.call(table, wsId)) continue;
        var record = table[wsId];
        if (!fmt.isObject(record) || !fmt.isAbsolutePosixPath(record.path)) continue;
        manifestWorkspaces.push({
          path: record.path,
          title: typeof record.title === "string" ? record.title : record.path.split("/").pop(),
          sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.filter(function (sid) { return typeof sid === "string"; }) : [],
          createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
        });
      }
      totals.workspaces = manifestWorkspaces.length;
    }
  } else {
    warnings.push("未找到 workspace.json：恢复时将由启动引导按会话 header 重建工作区（会丢失标题/顺序/归档/置顶）");
    manifestWorkspaces = deriveWorkspacesFromSessions(sessionPlan);
    totals.workspaces = manifestWorkspaces.length;
  }
  if (registryRead.exists && registryRead.errors.length > 0) {
    // 注册表结构损坏：仍保留原始文件供人工查看，但工作区列表从会话 header 推导
    manifestWorkspaces = manifestWorkspaces.length > 0 ? manifestWorkspaces : deriveWorkspacesFromSessions(sessionPlan);
  }

  // 4) 附件
  progress("staging", 42, "扫描附件");
  var attachmentScan = await util.scanAttachmentFiles(paths.attachmentsDir);
  warnings = warnings.concat(attachmentScan.warnings);
  for (var ai = 0; ai < attachmentScan.files.length; ai += 1) {
    var att = attachmentScan.files[ai];
    checkTotal(totals.bytes + att.size);
    var attStaged = join(payloadRoot, att.entry);
    await util.copyFileAtomic(att.abs, attStaged);
    var attSha = await util.sha256File(attStaged);
    var attSize = (await stat(attStaged)).size;
    totals.attachments += 1;
    totals.bytes += attSize;
    manifestAttachments.push({ entry: att.entry, size: attSize, sha256: attSha });
    payloadEntries.push({ name: att.entry, source: { type: "file", path: attStaged }, compress: compressionForName(att.entry) });
    if (ai % 20 === 0) progress("staging", 42 + Math.round(((ai + 1) / Math.max(1, attachmentScan.files.length)) * 8), "复制附件 " + (ai + 1) + "/" + attachmentScan.files.length);
  }

  // 5) 工作区产出文件
  progress("staging", 52, "扫描工作区产出文件");
  var skipAbsPrefixes = [paths.backupDir, paths.stateDir, paths.stagingRoot];
  for (var wi = 0; wi < manifestWorkspaces.length; wi += 1) {
    var workspace = manifestWorkspaces[wi];
    var wsExists = await util.isDirectory(workspace.path);
    if (!wsExists) {
      warnings.push("工作区目录不存在（不复制产出文件）：" + workspace.path);
      continue;
    }
    var walk = await util.walkFiles(workspace.path, {
      skipAbsPrefixes: skipAbsPrefixes,
      maxFiles: fmt.MAX_BACKUP_FILES - totals.workspaceFiles,
    });
    warnings = warnings.concat(walk.warnings.map(function (line) { return "工作区 " + workspace.path + "：" + line; }));
    var group = { workspacePath: workspace.path, entryPrefix: fmt.WORKSPACE_FILE_ENTRY_PREFIX + "ws-" + fmt.pad4(wi + 1) + "/", files: [] };
      if (walk.files.length >= fmt.MAX_BACKUP_FILES - totals.workspaceFiles) {
        await cleanupStagingBestEffort(stageRoot, logger);
        throw util.errorWithCode("BACKUP_TOO_MANY_FILES", "工作区文件数量超过上限（" + fmt.MAX_BACKUP_FILES + "），备份失败而不是静默截断；请先清理工作区", 413);
      }
      for (var fi = 0; fi < walk.files.length; fi += 1) {
      var wfile = walk.files[fi];
      checkTotal(totals.bytes + wfile.size);
      var rel = wfile.rel;
      var wsEntry = group.entryPrefix + rel;
      if (!fmt.isSafeZipEntryName(wsEntry)) {
        warnings.push("工作区文件名不安全，已跳过：" + wfile.abs);
        continue;
      }
      var stagedWsPath = join(payloadRoot, wsEntry);
      await util.copyFileAtomic(wfile.abs, stagedWsPath);
      var wsSha = await util.sha256File(stagedWsPath);
      var wsSize = (await stat(stagedWsPath)).size;
      totals.workspaceFiles += 1;
      totals.bytes += wsSize;
      group.files.push({ rel: rel, entry: wsEntry, size: wsSize, sha256: wsSha });
      payloadEntries.push({ name: wsEntry, source: { type: "file", path: stagedWsPath }, compress: compressionForName(wsEntry) });
      if (totals.workspaceFiles % 50 === 0) progress("staging", 52 + Math.min(20, Math.round(totals.workspaceFiles / 1000)), "复制工作区文件 " + totals.workspaceFiles);
    }
    if (group.files.length > 0) manifestWorkspaceFiles.push(group);
  }

  // 6) 插件清单（只名单/版本，不含目录）
  progress("staging", 74, "采集插件清单与版本");
  var inventory = util.readPluginInventory(paths);
  warnings = warnings.concat(inventory.warnings);
  await util.writeJsonAtomic(join(payloadRoot, fmt.PLUGIN_INVENTORY_ENTRY), {
    capturedAt: util.nowIso(),
    core: inventory.core,
    user: inventory.user,
  });
  payloadEntries.push({ name: fmt.PLUGIN_INVENTORY_ENTRY, source: { type: "file", path: join(payloadRoot, fmt.PLUGIN_INVENTORY_ENTRY) }, compress: "deflate" });

  // 7) 清单
  var versions = runtime.versions || util.collectVersionInfo(paths);
  var manifest = {
    format: fmt.BACKUP_FORMAT,
    formatVersion: fmt.BACKUP_FORMAT_VERSION,
    kind: kind,
    createdAt: util.nowIso(),
    source: {
      coreVersion: versions.coreVersion || "unknown",
      coreDirSource: versions.coreDirSource || "unconfirmed",
      coreBuiltAt: versions.coreBuiltAt || null,
      upstreamDshVersion: versions.upstreamDshVersion || "unknown",
      nodeVersion: versions.nodeVersion || null,
      platform: versions.platform || null,
      jitless: versions.jitless === true,
      zstd: versions.zstd === true,
      profile: versions.profile || paths.profileName,
      appVersion: versions.appVersion || null,
      backupToolVersion: versions.backupToolVersion || null,
      sessionFormatVersion: fmt.SESSION_FORMAT_VERSION,
      workspaceDomainVersion: fmt.WORKSPACE_DOMAIN_VERSION,
    },
    stats: {
      sessions: totals.sessions,
      workspaces: totals.workspaces,
      workspaceFiles: totals.workspaceFiles,
      attachments: totals.attachments,
      totalBytes: totals.bytes,
    },
    contents: {
      sessions: manifestSessions,
      workspaces: manifestWorkspaces,
      workspaceRegistry: registryEntry === null ? null : { entry: registryEntry, sha256: registrySha },
      workspaceFiles: manifestWorkspaceFiles,
      attachments: manifestAttachments,
      plugins: { core: inventory.core, user: inventory.user },
    },
    exclusions: exclusions,
    warnings: warnings,
    integrity: {
      verifiedBeforePublish: true,
      generatedAt: util.nowIso(),
    },
  };
  var manifestCheck = fmt.validateManifest(manifest);
  if (!manifestCheck.ok) {
    await cleanupStagingBestEffort(stageRoot, logger);
    throw util.errorWithCode("MANIFEST_INVALID", "内部清单校验失败：" + manifestCheck.errors.slice(0, 8).join(","), 500);
  }
  var manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  var manifestSha = util.sha256Buffer(manifestBytes);
  await util.writeFileAtomic(join(payloadRoot, fmt.MANIFEST_ENTRY), manifestBytes, { mode: 0o600 });
  payloadEntries.push({ name: fmt.MANIFEST_ENTRY, source: { type: "buffer", data: manifestBytes }, compress: "deflate" });

  // 8) 打包（staging 内所有 payload 都已在 manifest 里登记；按 payloadEntries 顺序写）
  progress("packing", 80, "生成 ZIP 备份包");
  var missing = [];
  for (var pe = 0; pe < payloadEntries.length; pe += 1) {
    if (payloadEntries[pe].source.type === "file") {
      if (!(await util.pathExists(payloadEntries[pe].source.path))) missing.push(payloadEntries[pe].name);
    }
  }
  if (missing.length > 0) {
    await cleanupStagingBestEffort(stageRoot, logger);
    throw util.errorWithCode("PAYLOAD_MISSING", "staging 缺少文件：" + missing.slice(0, 5).join(","), 500);
  }
  var finalName = fmt.backupFileName(kind, new Date(), util.randomSuffix());
  var tempZipPath = join(paths.backupDir, "." + finalName + "." + util.randomSuffix() + ".writing");
  var zipResult = await writeZip(tempZipPath, payloadEntries);
  progress("verifying", 90, "重新读取 ZIP 并校验 SHA-256");
  var verify = await verifyWrittenZip(tempZipPath, manifest, manifestSha, zipResult.sha256);
  if (!verify.ok) {
    await cleanupStagingBestEffort(stageRoot, logger);
    await cleanupFileBestEffort(tempZipPath, logger);
    throw util.errorWithCode("BACKUP_VERIFY_FAILED", "备份包写入后校验失败：" + verify.errors.join("；"), 500);
  }
  var finalPath = join(paths.backupDir, finalName);
  var finalExists = await util.pathExists(finalPath);
  if (finalExists) {
    // 理论上随机后缀已避免；仍存在则不覆盖旧备份
    await cleanupStagingBestEffort(stageRoot, logger);
    await cleanupFileBestEffort(tempZipPath, logger);
    throw util.errorWithCode("BACKUP_EXISTS", "备份文件名已存在，拒绝覆盖：" + finalName, 409);
  }
  try {
    await rename(tempZipPath, finalPath);
  } catch (error) {
    await cleanupStagingBestEffort(stageRoot, logger);
    await cleanupFileBestEffort(tempZipPath, logger);
    throw util.errorWithCode("BACKUP_PUBLISH_FAILED", "备份包发布失败：" + util.errText(error), 507);
  }
  var publishedSha = verify.sha256 === null ? "" : verify.sha256;
  await util.writeFileAtomic(finalPath + ".sha256", publishedSha + "  " + finalName + "\n", { mode: 0o600 });
  progress("verifying", 97, "备份包已发布，重新读取最终文件校验");
  // 发布后再次从最终路径复核（不落盘解压）
  var finalVerify = await verifyPublishedZip(finalPath, manifest, manifestSha, zipResult.sha256, publishedSha);
  if (!finalVerify.ok) {
    // 发布后校验失败：尝试删除正式文件；删除失败/未确认时不得声称“已删除”
    var cleanupResults = [];
    cleanupResults.push({ path: finalPath, result: await cleanupFileBestEffort(finalPath, logger) });
    cleanupResults.push({ path: finalPath + ".sha256", result: await cleanupFileBestEffort(finalPath + ".sha256", logger) });
    cleanupResults.push({ path: stageRoot, result: await cleanupStagingBestEffort(stageRoot, logger) });
    var remaining = [];
    for (var ci = 0; ci < cleanupResults.length; ci += 1) {
      var cr = cleanupResults[ci].result;
      if (!cr || cr.cleaned !== true || cr.stillExists === true) {
        remaining.push(cleanupResults[ci].path + (cr && cr.error ? "（" + cr.error + "）" : ""));
      }
    }
    var cleanupText = remaining.length > 0
      ? "；清理未确认，以下路径可能仍存在：" + remaining.join("；")
      : "；已确认删除不完整备份";
    throw util.errorWithCode("BACKUP_VERIFY_FAILED", "最终文件复验失败：" + finalVerify.errors.join("；") + cleanupText, 500);
  }
  var finalInfo = await stat(finalPath);
  progress("done", 100, "备份完成");
  await cleanupStagingBestEffort(stageRoot, logger);
  var report = {
    ok: true,
    jobId: jobId,
    kind: kind,
    file: finalPath,
    name: finalName,
    size: finalInfo.size,
    sha256: publishedSha,
    createdAt: manifest.createdAt,
    counts: {
      sessions: totals.sessions,
      workspaces: totals.workspaces,
      workspaceFiles: totals.workspaceFiles,
      attachments: totals.attachments,
      totalBytes: totals.bytes,
    },
    warnings: warnings,
    exclusions: exclusions,
    verified: true,
    verifiedAt: util.nowIso(),
    durationMs: Date.now() - startedAt,
    visible: paths.backupDirVisible,
    backupDir: paths.backupDir,
    coreVersion: versions.coreVersion || null,
  };
  if (logger) logger.info("备份完成：kind=" + kind + " file=" + finalPath + " size=" + finalInfo.size + " sha256=" + publishedSha);
  return report;
}

function checkTotal(bytes) {
  if (bytes > fmt.MAX_BACKUP_BYTES) {
    throw util.errorWithCode("BACKUP_TOO_LARGE", "备份内容超过单包上限（< 4 GiB），请先清理工作区大文件后重试", 413);
  }
}

function deriveWorkspacesFromSessions(sessionPlan) {
  var byCwd = {};
  var order = [];
  for (var i = 0; i < sessionPlan.length; i += 1) {
    var item = sessionPlan[i];
    if (!item.cwd) continue;
    if (!byCwd[item.cwd]) {
      byCwd[item.cwd] = {
        path: item.cwd,
        title: item.cwd.split("/").pop() || item.cwd,
        sessionIds: [],
        createdAt: item.createdAt !== null ? new Date(item.createdAt).toISOString() : "",
        updatedAt: "",
      };
      order.push(item.cwd);
    }
    byCwd[item.cwd].sessionIds.push(item.id);
  }
  return order.map(function (cwd) {
    return byCwd[cwd];
  });
}

function defaultExclusions() {
  return [
    { pattern: "DSH_HOME/.credentials.yaml", reason: "凭据文件" },
    { pattern: "DSH_HOME/host-ready.json", reason: "宿主握手文件（含 token）" },
    { pattern: "DSH_HOME/openai-gateway/api-key", reason: "API 凭据" },
    { pattern: "DSH_HOME/.anonymous-user-id", reason: "匿名用户标识（不迁移）" },
    { pattern: "DSH_HOME/profiles/**/node_modules/**", reason: "插件安装目录（不迁移插件）" },
    { pattern: "DSH_HOME/profiles/**/.dsh-market/**", reason: "插件市场缓存" },
    { pattern: "DSH_HOME/profiles/**/.plugin-manager/**", reason: "插件管理缓存" },
    { pattern: "DSH_HOME/storages/session_projcache/**", reason: "会话投影缓存（可重建）" },
    { pattern: "DSH_HOME/attachments/**/tmp/**", reason: "附件临时文件" },
    { pattern: "DSH_HOME/**/*.lock", reason: "运行时锁文件" },
    { pattern: "**/node_modules/**", reason: "依赖目录（不迁移）" },
    { pattern: "**/.git/**", reason: "版本库元数据（不迁移）" },
    { pattern: "**/.cache/**", reason: "缓存目录" },
    { pattern: "**/.virtfs_metadata/**", reason: "虚拟文件系统元数据" },
    { pattern: "<备份目录>/**", reason: "备份自身（避免递归打包）" },
    { pattern: "<staging 目录>/**", reason: "备份/恢复临时目录" },
  ];
}

/**
 * 备份失败路径的 staging 清理：使用严格删除，失败时记录“仍存在”，不谎称已清理。
 * 返回 { cleaned, stillExists, error }。
 */
async function cleanupStagingBestEffort(stageRoot, logger) {
  var result = await util.removeTreeStrict(stageRoot);
  if (!result.ok || result.stillExists) {
    if (logger) logger.error("staging 清理失败或未确认（路径仍可能存在）：" + stageRoot + "：" + (result.error || "still-exists"));
    return { cleaned: false, stillExists: true, error: result.error || "still-exists" };
  }
  return { cleaned: true, stillExists: false, error: null };
}

/** 备份失败路径的单文件清理：同样严格判定，不吞错误。 */
async function cleanupFileBestEffort(filePath, logger) {
  var result = await util.removeFileStrict(filePath);
  if (!result.ok || result.stillExists) {
    if (logger) logger.error("临时文件清理失败或未确认（路径仍可能存在）：" + filePath + "：" + (result.error || "still-exists"));
    return { cleaned: false, stillExists: true, error: result.error || "still-exists" };
  }
  return { cleaned: true, stillExists: false, error: null };
}

async function cleanupOldStaging(stagingRoot) {
  var names = null;
  try {
    names = await readdir(stagingRoot);
  } catch (_) {
    return;
  }
  var now = Date.now();
  for (var i = 0; i < names.length; i += 1) {
    var full = join(stagingRoot, names[i]);
    try {
      var info = await stat(full);
      if (now - info.mtimeMs > 24 * 60 * 60 * 1000) await util.removeTreeQuietly(full);
    } catch (_) {
      // ignore
    }
  }
}

/** 任务失败时清空所有 staging（调用方持有单实例锁，不会有并发任务）。 */
async function cleanupAllStaging(stagingRoot) {
  var names = null;
  try {
    names = await readdir(stagingRoot);
  } catch (_) {
    return;
  }
  for (var i = 0; i < names.length; i += 1) {
    var result = await util.removeTreeStrict(join(stagingRoot, names[i]));
    if (!result.ok || result.stillExists) {
      try {
        console.error("[dshm-backup] staging 残留未清理：" + join(stagingRoot, names[i]) + "：" + (result.error || "still-exists"));
      } catch (_) {
        // ignore
      }
    }
  }
}

async function verifyWrittenZip(zipPath, manifest, manifestSha, expectedWholeSha) {
  var errors = [];
  try {
    var listed = await listZip(zipPath);
    for (var i = 0; i < listed.entries.length; i += 1) {
      if (!fmt.isSafeZipEntryName(listed.entries[i].name)) errors.push("不安全条目名：" + listed.entries[i].name);
    }
    var manifestRead = await readZipEntry(zipPath, fmt.MANIFEST_ENTRY);
    var parsed = JSON.parse(manifestRead.toString("utf8"));
    var check = fmt.validateManifest(parsed);
    if (!check.ok) errors.push("manifest 校验失败：" + check.errors.slice(0, 5).join(","));
    if (util.sha256Buffer(manifestRead) !== manifestSha) errors.push("manifest SHA-256 不一致");
    var hashes = await hashZipEntries(zipPath);
    var byName = {};
    for (var h = 0; h < hashes.entries.length; h += 1) byName[hashes.entries[h].name] = hashes.entries[h];
    var expected = fmt.expectedPayloadHashes(manifest);
    var expectedNames = Object.keys(expected);
    for (var e = 0; e < expectedNames.length; e += 1) {
      var name = expectedNames[e];
      var item = byName[name];
      if (!item) {
        errors.push("备份包缺少文件：" + name);
        continue;
      }
      if (item.sha256 !== expected[name]) errors.push("文件 SHA-256 不一致：" + name);
    }
    var actualSha = await util.sha256File(zipPath);
    if (expectedWholeSha && actualSha !== expectedWholeSha) errors.push("整包 SHA-256 与写入时不一致");
    return { ok: errors.length === 0, errors: errors, sha256: actualSha };
  } catch (error) {
    return { ok: false, errors: ["读取校验失败：" + util.errText(error)], sha256: null };
  }
}

async function verifyPublishedZip(zipPath, manifest, manifestSha, expectedWholeSha, expectedSidecarSha) {
  var result = await verifyWrittenZip(zipPath, manifest, manifestSha, expectedWholeSha);
  var sidecar = null;
  try {
    sidecar = await readFile(zipPath + ".sha256", "utf8");
  } catch (_) {
    sidecar = null;
  }
  if (sidecar !== null) {
    var m = /^([0-9a-f]{64})/.exec(sidecar);
    if (!m || (expectedSidecarSha && m[1] !== expectedSidecarSha)) {
      result.ok = false;
      result.errors.push("旁文件 .sha256 与备份包不一致");
    }
  }
  return result;
}



/** 校验一个已有备份文件（供 UI 的“校验选中备份”）。 */
export async function verifyBackupFile(paths, filePath) {
  var result = { ok: false, file: filePath, errors: [], manifest: null, sha256: null, entries: 0 };
  try {
    var info = await stat(filePath);
    if (!info.isFile()) {
      result.errors.push("不是普通文件");
      return result;
    }
    var listed = await listZip(filePath);
    result.entries = listed.entries.length;
    var manifestBytes = await readZipEntry(filePath, fmt.MANIFEST_ENTRY);
    var manifest = JSON.parse(manifestBytes.toString("utf8"));
    result.manifest = manifest;
    var check = fmt.validateManifest(manifest);
    if (!check.ok) result.errors = result.errors.concat(check.errors);
    var hashes = await hashZipEntries(filePath);
    var byName = {};
    for (var i = 0; i < hashes.entries.length; i += 1) byName[hashes.entries[i].name] = hashes.entries[i];
    var expected = fmt.expectedPayloadHashes(manifest);
    var names = Object.keys(expected);
    for (var e = 0; e < names.length; e += 1) {
      if (!byName[names[e]]) result.errors.push("缺少文件：" + names[e]);
      else if (byName[names[e]].sha256 !== expected[names[e]]) result.errors.push("SHA-256 不一致：" + names[e]);
    }
    var actual = await util.sha256File(filePath);
    result.sha256 = actual;
    var sidecar = null;
    try {
      sidecar = await readFile(filePath + ".sha256", "utf8");
    } catch (_) {
      sidecar = null;
    }
    if (sidecar !== null) {
      var m = /^([0-9a-f]{64})/.exec(sidecar);
      if (!m || m[1] !== actual) result.errors.push("旁文件 .sha256 与备份包不一致");
    }
    result.ok = result.errors.length === 0;
  } catch (error) {
    result.errors.push(util.errText(error));
  }
  return result;
}

/** 自动轮换：只删自动备份，手动备份永不删除；且只在新备份校验成功后调用。
 *  删除使用严格判定：只有确认目标已不存在才算“已删除”；失败项单独报告，不谎称删除成功。 */
export async function rotateBackups(runtime, kind) {
  var config = runtime.config || {};
  var keepBaseline = typeof config.keepBaseline === "number" ? config.keepBaseline : 3;
  var keepEmergency = typeof config.keepEmergency === "number" ? config.keepEmergency : 2;
  if (kind !== "baseline" && kind !== "emergency") return { removed: [], failed: [] };
  var limit = kind === "baseline" ? keepBaseline : keepEmergency;
  var entries = await util.listBackupEntries(runtime.paths.backupDir);
  var sameKind = entries.filter(function (item) {
    return item.kind === kind;
  });
  if (sameKind.length <= limit) return { removed: [], failed: [] };
  sameKind.sort(function (a, b) {
    return a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0;
  });
  var removed = [];
  var failed = [];
  for (var i = limit; i < sameKind.length; i += 1) {
    var victim = sameKind[i];
    var fileResult = await util.removeFileStrict(victim.file);
    if (!fileResult.ok || fileResult.stillExists) {
      failed.push({ file: victim.file, error: fileResult.error || "still-exists" });
      continue;
    }
    var sidecarResult = await util.removeFileStrict(victim.file + ".sha256");
    if (!sidecarResult.ok || sidecarResult.stillExists) {
      // 备份本体已删除、旁文件残留：记录为未完全清理，不声称“删除成功且干净”
      failed.push({ file: victim.file + ".sha256", error: sidecarResult.error || "still-exists" });
    } else {
      removed.push(victim.file);
    }
  }
  if (removed.length > 0 && runtime.logger) runtime.logger.info("自动轮换删除旧 " + kind + " 备份：" + removed.length + " 个");
  if (failed.length > 0 && runtime.logger) {
    runtime.logger.error(
      "自动轮换有 " + failed.length + " 项删除失败/未确认（旧备份可能仍存在，未删除手动备份）：" +
        JSON.stringify(failed.slice(0, 5))
    );
  }
  return { removed: removed, failed: failed };
}

export { countStoredSessions, defaultExclusions };
