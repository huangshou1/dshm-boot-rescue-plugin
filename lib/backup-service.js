// dshm-boot-rescue v1.1.0 — 备份/恢复服务模块（由合并版 lib/index.js 挂载）
//
// 运行目标：DSHM（HarmonyOS 端 DeepSeek Harness）宿主 node 进程内的第三方插件。
// 形态约束：
//   · 纯宿主插件，无 cordis client 半身；UI 由 webServer.tapIndex 注入单文件
//     lib/client.js 提供（失败页也会执行，因此 Host 活着时仍能备份/查看）；
//   · 零静态 inject：webServer/loader 全部 ctx.get 判空 + internal/service 事件 +
//     定时重试兜底；拿不到服务只降级写日志，绝不让宿主进入 pending；
//   · 所有 HTTP 写接口自行校验回环 Host/Origin/Sec-Fetch-Site/content-type/body 上限；
//   · 备份/恢复任务单实例串行（文件锁 + 内存 job 状态），失败如实上报。
//
// 合并版：本模块只提供备份/恢复服务与 /backup/api/* 子路由；路由注册、tapIndex
// 与统一状态由 lib/index.js + lib/rescue.js 负责。

import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fmt from "./format.js";
import * as util from "./util.js";
import { createBackup, verifyBackupFile, rotateBackups, scanSessionArtifacts } from "./backup.js";
import { inspectBackup, executeRestore } from "./restore.js";
import { materializeLoaderEntries } from "./coexistence.js";

export const name = "dshm-backup";
export const version = readOwnVersion();

function readOwnVersion() {
  try {
    var manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    return typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
}

const SERVICE_WAIT_MS = 1000;
const SERVICE_WAIT_TRIES = 30;
const JOB_POLL_NOTE = "任务状态通过 GET /dshm-boot-rescue/backup/api/state 轮询";
const MAX_BODY_BYTES = 64 * 1024;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const STARTUP_FAILURE_SCAN_DELAY_MS = 15000;
const DEFAULT_CONFIG = {
  backupDir: null,
  minFreeBytes: 64 * 1024 * 1024,
  keepBaseline: 3,
  keepEmergency: 2,
  baseline: { enabled: true, delayMs: 90000, minIntervalMs: 24 * 60 * 60 * 1000 },
  emergency: { enabled: true, minIntervalMs: 10 * 60 * 1000 },
};

// ── 运行时对象 ─────────────────────────────────────────────────────────────

function loadConfig(paths) {
  var config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    if (existsSync(paths.configPath)) {
      var raw = JSON.parse(readFileSync(paths.configPath, "utf8"));
      if (raw && typeof raw === "object") {
        if (typeof raw.backupDir === "string" && raw.backupDir.length > 0) config.backupDir = raw.backupDir;
        if (typeof raw.minFreeBytes === "number" && raw.minFreeBytes > 0) config.minFreeBytes = raw.minFreeBytes;
        if (typeof raw.keepBaseline === "number" && raw.keepBaseline > 0) config.keepBaseline = raw.keepBaseline;
        if (typeof raw.keepEmergency === "number" && raw.keepEmergency > 0) config.keepEmergency = raw.keepEmergency;
        if (raw.baseline && typeof raw.baseline === "object") {
          if (raw.baseline.enabled === false) config.baseline.enabled = false;
          if (typeof raw.baseline.delayMs === "number" && raw.baseline.delayMs >= 0) config.baseline.delayMs = raw.baseline.delayMs;
          if (typeof raw.baseline.minIntervalMs === "number" && raw.baseline.minIntervalMs > 0) config.baseline.minIntervalMs = raw.baseline.minIntervalMs;
        }
        if (raw.emergency && typeof raw.emergency === "object") {
          if (raw.emergency.enabled === false) config.emergency.enabled = false;
          if (typeof raw.emergency.minIntervalMs === "number" && raw.emergency.minIntervalMs > 0) config.emergency.minIntervalMs = raw.emergency.minIntervalMs;
        }
      }
    }
  } catch (_) {
    // 配置损坏时使用默认值，并在诊断中记录
    config.__loadError = "读取 config.json 失败，使用默认配置";
  }
  return config;
}

function loadState(paths) {
  try {
    if (existsSync(paths.statePath)) {
      var raw = JSON.parse(readFileSync(paths.statePath, "utf8"));
      if (raw && typeof raw === "object") return raw;
    }
  } catch (_) {
    // ignore
  }
  return { version: 1, lastBaseline: null, lastManual: null, lastEmergency: null, lastRestore: null, verified: {} };
}

async function saveState(runtime) {
  // 同一门禁：共存未知/只读期间禁止任何状态写入（含 pendingRestart 清理）。
  if (runtime.writeBlocked || runtime.readOnly) {
    if (runtime.logger) runtime.logger.info("共存门禁未开放，跳过 state.json 写入");
    return;
  }
  try {
    await util.writeJsonAtomic(runtime.paths.statePath, runtime.state);
  } catch (error) {
    if (runtime.logger) runtime.logger.error("保存 state.json 失败：" + util.errText(error));
  }
}

function bootId(paths) {
  var hostReady = paths.hostReady || {};
  return String(hostReady.pid || process.pid) + ":" + String(hostReady.startedAt || "unknown");
}

function createRuntime(ctx, options) {
  var config = loadConfigSafe();
  var paths = util.resolveRuntimePaths(config);
  var runtime = {
    ctx: ctx,
    paths: paths,
    config: config,
    versions: null,
    logger: null,
    readOnly: false,
    readOnlyReason: "",
    readOnlyReasonCode: "",
    diag: { webServer: "pending", route: "pending", tapIndex: "pending", loader: "pending", injections: 0 },
    state: loadState(paths),
    job: null,
    previews: {},
    bootId: bootId(paths),
    rawConfigLoaded: config,
  };
  runtime.options = options || {};
  // 初始化必须是“共存未知 + 写入关闭”；只有 detect 明确 absent 后才在 applyCoexistence 开放。
  runtime.coexist = { state: "unknown", writeAllowed: false, reason: "共存状态尚未判定（fail closed）：备份写入关闭" };
  runtime.writeBlocked = true;
  runtime.writeBlockedReason = "共存状态尚未判定（fail closed）：备份写入关闭";
  runtime.started = false;
  runtime.pendingRestartCleanupPending = false;
  runtime.versions = util.collectVersionInfo(paths);
  runtime.logger = util.createLogger(paths.logPath);
  runtime.logger.info(
    "启动 dshm-boot-rescue-backup " +
      version +
      " core=" +
      (runtime.versions.coreVersion || "unknown") +
      " profile=" +
      paths.profileName +
      " home=" +
      paths.home +
      " backupDir=" +
      paths.backupDir
  );
  return runtime;
}

function loadConfigSafe() {
  try {
    var env = process.env;
    var home = env.DSH_HOME || env.DSHM_HOME;
    if (!home) return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    var pathsProbe = { configPath: join(home, "dshm-boot-rescue", "config.json") };
    return loadConfig(pathsProbe);
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

// ── job 管理 ───────────────────────────────────────────────────────────────

function jobSnapshot(runtime) {
  if (!runtime.job) return null;
  var job = runtime.job;
  return {
    id: job.id,
    kind: job.kind,
    phase: job.phase,
    percent: job.percent,
    message: job.message,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    result: job.result || null,
    error: job.error || null,
  };
}

function startJob(runtime, kind, taskFactory) {
  if (runtime.readOnly) throw util.errorWithCode("READ_ONLY", runtime.readOnlyReason || "备份工具处于只读状态", 503);
  if (runtime.writeBlocked) throw util.errorWithCode("COEXISTENCE_READ_ONLY", runtime.writeBlockedReason || "检测到旧备份插件，备份写入处于共存只读模式", 423);
  if (runtime.job && runtime.job.running) throw util.errorWithCode("JOB_BUSY", "已有任务在运行：" + runtime.job.kind, 409);
  var job = {
    id: kind + "-" + util.randomSuffix(),
    kind: kind,
    running: true,
    phase: "queued",
    percent: 0,
    message: "排队中",
    startedAt: util.nowIso(),
    finishedAt: null,
    result: null,
    error: null,
  };
  runtime.job = job;
  var progress = function (phase, percent, message) {
    if (job.running) {
      job.phase = phase;
      job.percent = Math.max(0, Math.min(100, percent));
      job.message = typeof message === "string" ? message : "";
    }
  };

  (async function () {
    var lock = null;
    try {
      lock = await util.acquireLock(runtime.paths.lockPath, kind);
      var result = await taskFactory(progress);
      job.result = result;
      if (result && result.ok === false) {
        // 恢复引擎在失败时会返回结构化报告（已尝试回滚），不能当成成功任务
        job.phase = "failed";
        job.error = {
          message: result.error || "任务失败",
          code: result.code || "JOB_FAILED",
          rolledBack: result.rolledBack === true,
          rollbackMessages: result.rollbackMessages || [],
        };
        job.message = "失败：" + (result.error || "未知错误");
        if (runtime.logger) runtime.logger.error("任务失败 kind=" + kind + "：" + job.error.message);
        finalizeJobState(runtime, kind, null, new Error(job.error.message));
      } else {
        job.phase = "done";
        job.percent = 100;
        job.message = kind === "restore" ? "恢复完成（需要冷重启）" : "完成";
        finalizeJobState(runtime, kind, result, null);
      }
    } catch (error) {
      job.phase = "failed";
      job.error = { message: util.errText(error), code: error.code || "JOB_FAILED" };
      job.message = "失败：" + util.errText(error);
      if (runtime.logger) runtime.logger.error("任务失败 kind=" + kind + "：" + util.errText(error));
      finalizeJobState(runtime, kind, null, error);
    } finally {
      job.running = false;
      job.finishedAt = util.nowIso();
      if (lock) await lock.release();
      await saveState(runtime);
    }
  })();
  return job.id;
}

function finalizeJobState(runtime, kind, result, error) {
  try {
    if (error) return;
    if (kind === "baseline" || kind === "manual" || kind === "emergency") {
      if (!result || result.ok !== true) return;
      var record = {
        file: result.file,
        name: result.name,
        kind: kind,
        createdAt: result.createdAt,
        size: result.size,
        sha256: result.sha256,
        verifiedAt: result.verifiedAt || util.nowIso(),
        counts: result.counts || null,
      };
      if (kind === "baseline") runtime.state.lastBaseline = record;
      else if (kind === "manual") runtime.state.lastManual = record;
      else runtime.state.lastEmergency = record;
      runtime.state.lastBackupAt = record.createdAt;
      // 只有“真实异常抢备成功”才写本次启动的节流标记；
      // manual/baseline 绝不能改变 emergency 的本次启动状态。
      if (kind === "emergency") runtime.state.emergencyBootId = runtime.bootId;
      // 备份引擎在发布前后都实际重新读取校验过；把该结果记入校验缓存，
      // 仅用于展示“确实校验通过”的备份（不是“有旁文件”）。
      if (result.file && result.sha256) {
        runtime.state.verified = runtime.state.verified && typeof runtime.state.verified === "object" ? runtime.state.verified : {};
        runtime.state.verified[result.file] = {
          sha256: result.sha256,
          size: result.size,
          verifiedAt: result.verifiedAt || util.nowIso(),
          source: "backup",
        };
      }
    } else if (kind === "restore") {
      runtime.state.lastRestore = {
        ok: result.ok === true,
        needsColdRestart: result.needsColdRestart === true,
        rolledBack: result.ok === true ? false : result.rolledBack === true,
        rollbackFailures: result.ok === true ? [] : result.rollbackFailures || [],
        finishedAt: result.finishedAt || util.nowIso(),
        counts: {
          sessions: result.restoredSessions,
          workspaces: result.restoredWorkspaces,
          files: result.restoredWorkspaceFiles,
          attachments: result.restoredAttachments,
        },
        reportText: result.reportText || "",
      };
      if (result.ok === true) runtime.state.pendingRestart = true;
    }
  } catch (_) {
    // ignore
  }
}

// ── HTTP 工具 ──────────────────────────────────────────────────────────────

function json(res, statusCode, payload) {
  try {
    if (res.writableEnded) return;
    var body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  } catch (_) {
    // ignore
  }
}

function methodAllowed(req, res, method) {
  if (req.method === method) return true;
  try {
    res.writeHead(405, { allow: method, "cache-control": "no-store" });
    res.end();
  } catch (_) {
    // ignore
  }
  return false;
}

function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  var value = address;
  if (value.indexOf("::ffff:") === 0) value = value.slice(7);
  if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  if (/^127\./.test(value)) return true;
  return false;
}

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== "string") return false;
  var host = hostHeader;
  var colon = host.lastIndexOf(":");
  if (colon !== -1 && host.indexOf("]") === -1) host = host.slice(0, colon);
  if (host === "[::1]" || host === "::1") return true;
  return /^127\./.test(host);
}

function assertMutationRequest(req) {
  try {
    if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
      throw util.errorWithCode("REMOTE_FORBIDDEN", "仅允许本机回环地址调用写接口", 403);
    }
    if (!isLoopbackHost(req.headers && req.headers.host)) {
      throw util.errorWithCode("HOST_FORBIDDEN", "Host 头不是回环地址（防 DNS rebinding）", 403);
    }
    var contentType = String((req.headers && req.headers["content-type"]) || "");
    if (contentType.indexOf("application/json") !== 0) {
      throw util.errorWithCode("CONTENT_TYPE_REQUIRED", "写接口必须使用 application/json", 415);
    }
    var fetchSite = req.headers && req.headers["sec-fetch-site"];
    if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") {
      throw util.errorWithCode("ORIGIN_FORBIDDEN", "跨站请求被拒绝", 403);
    }
    var origin = req.headers && req.headers.origin;
    if (origin !== undefined && String(origin).length > 0) {
      var originHost = null;
      try {
        originHost = String(origin).replace(/^https?:\/\//, "");
      } catch (_) {
        originHost = null;
      }
      var comma = originHost === null ? -1 : originHost.indexOf("/");
      if (comma !== -1) originHost = originHost.slice(0, comma);
      if (originHost !== req.headers.host) throw util.errorWithCode("ORIGIN_FORBIDDEN", "Origin 与 Host 不一致", 403);
    }
    return true;
  } catch (error) {
    if (error && error.statusCode) throw error;
    throw util.errorWithCode("REQUEST_FORBIDDEN", "请求校验失败：" + util.errText(error), 403);
  }
}

function readJsonBody(req, limitBytes) {
  return new Promise(function (done, fail) {
    var chunks = [];
    var total = 0;
    var finished = false;
    function finish(error, value) {
      if (finished) return;
      finished = true;
      if (error) fail(error);
      else done(value);
    }
    req.on("data", function (chunk) {
      total += chunk.length;
      if (total > limitBytes) {
        finish(util.errorWithCode("BODY_TOO_LARGE", "请求体超过上限", 413));
        try {
          req.destroy();
        } catch (_) {
          // ignore
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", function (error) {
      finish(util.errorWithCode("BODY_READ_FAILED", "读取请求体失败：" + util.errText(error), 400));
    });
    req.on("end", function () {
      if (finished) return;
      var text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) return finish(util.errorWithCode("BODY_EMPTY", "请求体为空", 400));
      var value = null;
      try {
        value = JSON.parse(text);
      } catch (error) {
        return finish(util.errorWithCode("BODY_INVALID_JSON", "请求体不是合法 JSON", 400));
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return finish(util.errorWithCode("BODY_INVALID_JSON", "请求体必须是 JSON 对象", 400));
      }
      finish(null, value);
    });
  });
}

// ── 状态快照 ───────────────────────────────────────────────────────────────

async function buildBackupsSnapshot(runtime) {
  var ownEntries = await util.listBackupEntries(runtime.paths.backupDir);
  var entries = [];
  var seenFiles = {};
  var i;
  for (i = 0; i < ownEntries.length; i += 1) {
    var ownEntry = ownEntries[i];
    if (seenFiles[ownEntry.file]) continue;
    seenFiles[ownEntry.file] = true;
    entries.push(Object.assign({ storage: "own" }, ownEntry));
  }
  var legacyDirs = Array.isArray(runtime.paths.legacyBackupDirs) ? runtime.paths.legacyBackupDirs : [];
  for (var d = 0; d < legacyDirs.length; d += 1) {
    var legacyEntries = [];
    try {
      legacyEntries = await util.listBackupEntries(legacyDirs[d]);
    } catch (_) {
      legacyEntries = [];
    }
    for (i = 0; i < legacyEntries.length; i += 1) {
      var legacyEntry = legacyEntries[i];
      if (seenFiles[legacyEntry.file]) continue;
      seenFiles[legacyEntry.file] = true;
      entries.push(Object.assign({ storage: "legacy", legacyDir: legacyDirs[d] }, legacyEntry));
    }
  }
  var verifiedCache = runtime.state && runtime.state.verified && typeof runtime.state.verified === "object" ? runtime.state.verified : {};
  var list = [];
  for (var i = 0; i < entries.length; i += 1) {
    var entry = entries[i];
    // “有旁文件/旁文件 SHA” ≠ “已校验”：只有本插件在本次实例中实际重新计算并核对成功的
    // 记录（state.verified，且 SHA/大小与当前文件一致）才显示 verified=true。
    var cached = verifiedCache[entry.file];
    var verified = !!(
      cached &&
      typeof cached.sha256 === "string" &&
      entry.hasSidecar === true &&
      entry.sidecarSha === cached.sha256 &&
      (typeof cached.size !== "number" || cached.size === entry.size)
    );
    list.push({
      name: entry.name,
      file: entry.file,
      storage: entry.storage || "own",
      kind: entry.kind,
      createdAt: entry.mtime,
      size: entry.size,
      sha256: entry.sha256,
      hasSidecar: entry.hasSidecar === true,
      sidecarSha: entry.sidecarSha || null,
      verified: verified,
      verifiedAt: verified ? cached.verifiedAt || null : null,
      verificationSource: verified ? cached.source || null : null,
    });
  }
  list.sort(function (a, b) {
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });
  var baseline = null;
  for (var b = 0; b < list.length; b += 1) {
    if (list[b].kind === "baseline") {
      baseline = list[b];
      break;
    }
  }
  var lastManual = null;
  for (var m = 0; m < list.length; m += 1) {
    if (list[m].kind === "manual") {
      lastManual = list[m];
      break;
    }
  }
  return { list: list, baseline: baseline, lastManual: lastManual };
}

async function buildState(runtime) {
  var backups = await buildBackupsSnapshot(runtime);
  var loaderState = runtime.diag.loader;
  return {
    ok: true,
    version: version,
    writeAllowed: !runtime.readOnly && !runtime.writeBlocked && !!(runtime.coexist && runtime.coexist.writeAllowed === true),
    writeBlockedReason: runtime.writeBlockedReason || "",
    coexistence: runtime.coexist || { state: "unknown", writeAllowed: false, reason: "共存状态未确认（fail closed）" },
    homeDir: runtime.paths.home,
    backupDir: runtime.paths.backupDir,
    backupDirVisible: runtime.paths.backupDirVisible,
    core: {
      coreVersion: runtime.versions.coreVersion || "unknown",
      coreDirSource: runtime.versions.coreDirSource || "unconfirmed",
      upstreamDshVersion: runtime.versions.upstreamDshVersion || "unknown",
      coreBuiltAt: runtime.versions.coreBuiltAt || null,
      nodeVersion: runtime.versions.nodeVersion || null,
      platform: runtime.versions.platform || null,
      jitless: runtime.versions.jitless === true,
      zstd: runtime.versions.zstd === true,
      profile: runtime.versions.profile || runtime.paths.profileName,
      appVersion: runtime.versions.appVersion || null,
      sessionFormatVersion: runtime.versions.sessionFormatVersion,
      workspaceDomainVersion: runtime.versions.workspaceDomainVersion,
    },
    baseline: backups.baseline,
    lastManual: backups.lastManual,
    backups: backups.list.slice(0, 50),
    job: jobSnapshot(runtime),
    emergency: runtime.state.lastEmergency
      ? { done: true, file: runtime.state.lastEmergency.file, at: runtime.state.lastEmergency.createdAt }
      : null,
    restore: {
      pendingRestart: runtime.state.pendingRestart === true,
      lastResult: runtime.state.lastRestore || null,
    },
    diagnostics: {
      webServer: runtime.diag.webServer,
      route: runtime.diag.route,
      tapIndex: runtime.diag.tapIndex,
      injections: runtime.diag.injections,
      loader: loaderState,
      writable: !runtime.readOnly,
      readOnlyReason: runtime.readOnlyReason || "",
      configLoadError: runtime.config.__loadError || "",
      bootId: runtime.bootId,
      lastBackupAt: runtime.state.lastBackupAt || null,
    },
  };
}

// ── 路由处理 ───────────────────────────────────────────────────────────────

async function handle(runtime, req, res, subpath) {
  if (typeof subpath !== "string" || subpath.indexOf("/backup") !== 0) return false;
  var inner = subpath.slice("/backup".length);
  try {
    if (inner === "" || inner === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("dshm-boot-rescue backup " + version + " — API 前缀 /dshm-boot-rescue/backup/api/");
      return true;
    }
    if (inner === "/api/state") {
      if (!methodAllowed(req, res, "GET")) return true;
      json(res, 200, await buildState(runtime));
      return true;
    }
    if (inner === "/api/backups") {
      if (!methodAllowed(req, res, "GET")) return true;
      var snapshot = await buildBackupsSnapshot(runtime);
      json(res, 200, { ok: true, backups: snapshot.list, baseline: snapshot.baseline, lastManual: snapshot.lastManual, writeAllowed: !runtime.readOnly && !runtime.writeBlocked && !!(runtime.coexist && runtime.coexist.writeAllowed === true), coexistence: runtime.coexist || { state: "unknown", writeAllowed: false } });
      return true;
    }
    if (inner === "/api/backup") {
      if (!methodAllowed(req, res, "POST")) return true;
      assertMutationRequest(req);
      var body = await readJsonBody(req, MAX_BODY_BYTES);
      var kind = body.kind === "baseline" ? "baseline" : "manual";
      var jobId = startJob(runtime, kind, function (progress) {
        return createBackup(runtime, kind, { onProgress: progress });
      });
      json(res, 202, { ok: true, jobId: jobId, poll: JOB_POLL_NOTE });
      return true;
    }
    if (inner === "/api/emergency") {
      if (!methodAllowed(req, res, "POST")) return true;
      assertMutationRequest(req);
      await readJsonBody(req, MAX_BODY_BYTES);
      var started = await triggerEmergencyBackup(runtime, "client-failure-page");
      json(res, 202, started);
      return true;
    }
    if (inner === "/api/inspect") {
      if (!methodAllowed(req, res, "POST")) return true;
      assertMutationRequest(req);
      var inspectBody = await readJsonBody(req, MAX_BODY_BYTES);
      var inspectResolved = await util.resolveBackupFileInput(runtime.paths, inspectBody.file);
      var inspection = await inspectBackup(runtime, inspectResolved.path);
      cleanupPreviews(runtime);
      runtime.previews[inspection.internal.previewId] = inspection.internal;
      json(res, 200, { ok: true, previewId: inspection.preview.previewId, preview: inspection.preview });
      return true;
    }
    if (inner === "/api/restore") {
      if (!methodAllowed(req, res, "POST")) return true;
      assertMutationRequest(req);
      var restoreBody = await readJsonBody(req, MAX_BODY_BYTES);
      if (runtime.writeBlocked) throw util.errorWithCode("COEXISTENCE_READ_ONLY", runtime.writeBlockedReason || "检测到旧备份插件，恢复写入处于共存只读模式", 423);
      if (restoreBody.confirm !== true) throw util.errorWithCode("CONFIRM_REQUIRED", "恢复必须显式确认（confirm:true）", 400);
      cleanupPreviews(runtime);
      var internal = runtime.previews[restoreBody.previewId];
      if (!internal) throw util.errorWithCode("PREVIEW_EXPIRED", "预览已过期或不存在，请重新选择备份并预览", 409);
      if (internal.canRestore !== true) throw util.errorWithCode("RESTORE_PREVIEW_INVALID", "预览结果不可恢复，请重新预览", 409);
      if (Array.isArray(internal.conflicts) && internal.conflicts.length > 0) throw util.errorWithCode("RESTORE_PREVIEW_INVALID", "预览存在冲突，不能恢复；请重新预览", 409);
      // 同核心版本硬门槛：不存在任何跨版本确认/绕过路径。
      if (internal.versionLevel !== "exact") throw util.errorWithCode("BACKUP_CORE_MISMATCH", "核心版本不一致或未知/格式不兼容，禁止恢复（同核心版本是硬门槛）", 409);
      var jobId2 = startJob(runtime, "restore", function (progress) {
        return executeRestore(runtime, internal, { onProgress: progress });
      });
      delete runtime.previews[restoreBody.previewId];
      json(res, 202, { ok: true, jobId: jobId2, poll: JOB_POLL_NOTE });
      return true;
    }
    if (inner === "/api/verify") {
      if (!methodAllowed(req, res, "POST")) return true;
      assertMutationRequest(req);
      var verifyBody = await readJsonBody(req, MAX_BODY_BYTES);
      var verifyResolved = await util.resolveBackupFileInput(runtime.paths, verifyBody.file);
      var filePath = verifyResolved.path;
      var verifyResult = await verifyBackupFile(runtime.paths, filePath);
      if (verifyResult.ok && typeof verifyResult.sha256 === "string" && !runtime.writeBlocked) {
        try {
          var verifiedInfo = await stat(filePath);
          runtime.state.verified = runtime.state.verified && typeof runtime.state.verified === "object" ? runtime.state.verified : {};
          runtime.state.verified[filePath] = { sha256: verifyResult.sha256, size: verifiedInfo.size, verifiedAt: util.nowIso(), source: "verify" };
          await saveState(runtime);
        } catch (cacheError) {
          if (runtime.logger) runtime.logger.error("保存校验状态失败：" + util.errText(cacheError));
        }
      }
      json(res, verifyResult.ok ? 200 : 422, { ok: verifyResult.ok, verified: verifyResult.ok, sha256: verifyResult.sha256, errors: verifyResult.errors, entries: verifyResult.entries });
      return true;
    }
    json(res, 404, { ok: false, error: "未知接口：" + inner, code: "NOT_FOUND" });
    return true;
  } catch (error) {
    try {
      json(res, error.statusCode || 500, { ok: false, error: util.errText(error), code: error.code || "ROUTE_FAILED" });
    } catch (_) {
      // ignore
    }
    return true;
  }
}

// 备份文件解析已统一到 util.resolveBackupFileInput（own/legacy 同一实现）。

function cleanupPreviews(runtime) {
  var now = Date.now();
  var ids = Object.keys(runtime.previews);
  for (var i = 0; i < ids.length; i += 1) {
    var item = runtime.previews[ids[i]];
    if (!item || now - item.createdAt > PREVIEW_TTL_MS) delete runtime.previews[ids[i]];
  }
}

// ── 异常抢备（真实信号触发，单次/节流）────────────────────────────────────

async function triggerEmergencyBackup(runtime, source) {
  try {
    if (runtime.config.emergency.enabled === false) {
      return { ok: true, started: false, reason: "异常抢备已禁用" };
    }
    if (runtime.readOnly) return { ok: true, started: false, reason: runtime.readOnlyReason || "只读状态" };
    if (runtime.job && runtime.job.running) return { ok: true, started: false, reason: "已有任务在运行" };
    var last = runtime.state.lastEmergency;
    var now = Date.now();
    if (runtime.state.emergencyBootId === runtime.bootId) {
      return { ok: true, started: false, reason: "本次启动已执行过异常抢备" };
    }
    if (last && last.createdAt) {
      var lastAt = Date.parse(last.createdAt);
      if (isFinite(lastAt) && now - lastAt < runtime.config.emergency.minIntervalMs) {
        return { ok: true, started: false, reason: "距上次异常抢备不足冷却时间" };
      }
    }
    runtime.logger.info("触发异常抢备：source=" + source);
    var jobId = startJob(runtime, "emergency", function (progress) {
      return createBackup(runtime, "emergency", { onProgress: progress }).then(async function (report) {
        // 只有新紧急备份已生成且校验成功（createBackup 正常 resolve）后才轮换；
        // 轮换只处理 emergency，手动备份永不删除。轮换异常不推翻已成功的备份。
        try {
          await rotateBackups(runtime, "emergency");
        } catch (rotateError) {
          if (runtime.logger) runtime.logger.error("异常抢备轮换失败（新备份仍有效）：" + util.errText(rotateError));
        }
        return report;
      });
    });
    return { ok: true, started: true, jobId: jobId, reason: "已开始异常抢备", source: source };
  } catch (error) {
    if (runtime.logger) runtime.logger.error("异常抢备启动失败：" + util.errText(error));
    return { ok: false, started: false, reason: util.errText(error) };
  }
}

// ── 启动后自动任务：健康基线 + Host 侧插件失败扫描 ────────────────────────

function scheduleStartupTasks(runtime) {
  if (runtime.writeBlocked) {
    runtime.logger.info("共存只读模式：跳过自动健康基线、故障扫描与异常抢备（不写备份目录）");
    return;
  }
  var failureTimer = setTimeout(function () {
    detectHostSidePluginFailures(runtime).catch(function (error) {
      if (runtime.logger) runtime.logger.error("启动后插件失败扫描异常：" + util.errText(error));
    });
  }, STARTUP_FAILURE_SCAN_DELAY_MS);
  try {
    if (failureTimer && typeof failureTimer.unref === "function") failureTimer.unref();
  } catch (_) {
    // ignore
  }
  var timer = setTimeout(function () {
    runBaselineTask(runtime).catch(function (error) {
      if (runtime.logger) runtime.logger.error("启动后基线任务失败：" + util.errText(error));
    });
  }, Math.max(0, runtime.config.baseline.delayMs));
  try {
    if (timer && typeof timer.unref === "function") timer.unref();
  } catch (_) {
    // ignore
  }
}

async function runBaselineTask(runtime) {
  if (runtime.readOnly) return;
  if (runtime.config.baseline.enabled === false) {
    runtime.logger.info("自动基线备份已禁用（config.baseline.enabled=false）");
    return;
  }
  if (runtime.job && runtime.job.running) {
    var retry = setTimeout(function () {
      runBaselineTask(runtime).catch(function () {
        return undefined;
      });
    }, 60000);
    try {
      if (retry && typeof retry.unref === "function") retry.unref();
    } catch (_) {
      // ignore
    }
    return;
  }
  var lastBaseline = runtime.state.lastBaseline;
  if (lastBaseline && lastBaseline.createdAt) {
    var lastAt = Date.parse(lastBaseline.createdAt);
    if (isFinite(lastAt) && Date.now() - lastAt < runtime.config.baseline.minIntervalMs) {
      runtime.logger.info("跳过自动基线备份：距上次基线不足 " + Math.round(runtime.config.baseline.minIntervalMs / 3600000) + " 小时");
      return;
    }
  }
  runtime.logger.info("开始健康基线备份（启动后自动，延迟 " + Math.round(runtime.config.baseline.delayMs / 1000) + "s）");
  startJob(runtime, "baseline", function (progress) {
    return createBackup(runtime, "baseline", { onProgress: progress }).then(async function (report) {
      try {
        await rotateBackups(runtime, "baseline");
      } catch (rotateError) {
        if (runtime.logger) runtime.logger.error("基线轮换失败（新基线仍有效）：" + util.errText(rotateError));
      }
      return report;
    });
  });
}

/**
 * Host 侧软失败检测：loader.await() 之后读取 loader.entries()：
 *   · entry.fiber.state === 3（FAILED）→ 失败
 *   · entry.fiber 不存在且 entry.disabled !== true → 很可能是 import/apply 失败（core 的
 *     loader 在 import 失败时只记日志、entry 无 fiber，证据见 FEVER 报告）
 * 只用于触发一次异常抢备/诊断，不修改任何插件状态。
 */
/**
 * 纯扫描：使用与 coexistence 共用的严格 materializer，接受 Array 或同步 iterable generator。
 * 条目/materialize/字段读取任一异常都返回 ok:false，不静默返回 suspects=[]。
 * 不写状态、不触发备份；副作用只在 detectHostSidePluginFailures() 内发生。
 */
export function scanHostLoaderEntries(loader) {
  if (!loader || typeof loader.entries !== "function") return { ok: false, reason: "loader 不可用" };
  const materialized = materializeLoaderEntries(loader);
  if (!materialized.ok) return { ok: false, reason: "loader.entries() 结构非法：" + materialized.error };
  const entries = materialized.entries;
  const suspects = [];
  let failedCount = 0;
  try {
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const options = entry.options;
      if (options.group) continue;
      if (entry.disabled === true) continue;
      const fiberState = entry.fiber && typeof entry.fiber.state === "number" ? entry.fiber.state : null;
      const failed = fiberState === 3;
      const missingFiber = entry.fiber === undefined || entry.fiber === null;
      if (failed || missingFiber) {
        failedCount += 1;
        suspects.push({
          id: options.id || entry.id || "",
          name: options.name || "",
          state: fiberState === null ? "no-fiber" : String(fiberState),
        });
      }
    }
  } catch (error) {
    return { ok: false, reason: "Host loader entry 字段读取失败：" + util.errText(error) };
  }
  return { ok: true, suspects: suspects, failedCount: failedCount };
}

async function detectHostSidePluginFailures(runtime) {
  try {
    var loader = runtime.ctx && typeof runtime.ctx.get === "function" ? runtime.ctx.get("loader") : null;
    if (!loader || typeof loader.entries !== "function") {
      runtime.diag.loader = "unavailable";
      return { ok: false, reason: "loader 不可用" };
    }
    runtime.diag.loader = "ok";
    try {
      if (typeof loader.await === "function") await loader.await();
    } catch (_) {
      // loader.await 失败不阻断：继续按当前快照探测
    }
    var scanned = scanHostLoaderEntries(loader);
    if (!scanned.ok) {
      runtime.diag.loader = "error: " + scanned.reason;
      return { ok: false, reason: scanned.reason };
    }
    var suspects = scanned.suspects;
    var failedCount = scanned.failedCount;
    if (suspects.length > 0) {
      runtime.logger.error("Host 侧检测到插件软失败：" + JSON.stringify(suspects.slice(0, 10)));
      runtime.state.lastPluginFailure = {
        at: util.nowIso(),
        suspects: suspects.slice(0, 30),
        failedCount: failedCount,
      };
      await saveState(runtime);
      await triggerEmergencyBackup(runtime, "host-loader-failure");
    }
    return { ok: true, suspects: suspects };
  } catch (error) {
    runtime.diag.loader = "error: " + util.errText(error);
    return { ok: false, reason: util.errText(error) };
  }
}

// ── 合并版工厂 ───────────────────────────────────────────────────────────

export function createBackupService(ctx, options) {
  var runtime = createRuntime(ctx, options || {});
  // 注意：pendingRestart 清理推迟到 applyCoexistence() 判定完成之后（受同一写入门禁）。
  runtime.pendingRestartCleanupPending = runtime.state.pendingRestart === true;
  function startSchedulers() {
    if (runtime.started) return;
    if (runtime.writeBlocked || runtime.readOnly) return;
    if (!runtime.coexist || runtime.coexist.writeAllowed !== true) return;
    runtime.started = true;
    scheduleStartupTasks(runtime);
  }
  function applyCoexistence(coexist) {
    var next = coexist && typeof coexist === "object" ? coexist : { state: "unknown", writeAllowed: false, reason: "共存状态未确认（fail closed）" };
    runtime.coexist = next;
    if (next.writeAllowed !== true) {
      runtime.writeBlocked = true;
      runtime.writeBlockedReason = next.reason || "共存只读模式";
      return { writeAllowed: false, started: false, reason: runtime.writeBlockedReason };
    }
    runtime.writeBlocked = false;
    runtime.writeBlockedReason = "";
    if (runtime.pendingRestartCleanupPending) {
      runtime.pendingRestartCleanupPending = false;
      runtime.logger.info("共存判定已明确 absent：处理上次恢复后的冷重启标记");
      runtime.state.pendingRestart = false;
      runtime.state.lastRestore = runtime.state.lastRestore || null;
      saveState(runtime).catch(function () { return undefined; });
    }
    startSchedulers();
    return { writeAllowed: true, started: runtime.started, reason: "" };
  }
  return {
    runtime: runtime,
    buildState: function () { return buildState(runtime); },
    handle: function (req, res, subpath) { return handle(runtime, req, res, subpath); },
    applyCoexistence: applyCoexistence,
    startSchedulers: startSchedulers,
  };
}
