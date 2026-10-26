// dshm-backup 宿主工具模块（util）
//
// 只给宿主插件使用：路径解析、稳定快照读取、zstd 会话校验、SHA-256、
// 原子写、单实例锁、文件遍历、插件/版本清单采集。
// 约束：只用 node: 内置模块；不创建外部进程；不读/不打印任何凭据值。


import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  access,
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import * as fmt from "./format.js";

export const ZSTD_MAGIC = 0xfd2fb528;
const IDENTITY_FIELDS = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];

// ── 错误与文本 ─────────────────────────────────────────────────────────────

export function errText(error) {
  if (error === null || error === undefined) return "unknown error";
  var message = typeof error.message === "string" ? error.message : String(error);
  if (error.code !== undefined) return error.code + ": " + message;
  return message;
}

export function errorWithCode(code, message, statusCode) {
  var error = new Error(message);
  error.code = code;
  error.statusCode = statusCode || 500;
  return error;
}

export function sleep(ms) {
  return new Promise(function (done) {
    setTimeout(done, ms);
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomSuffix() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

// ── 路径解析 ───────────────────────────────────────────────────────────────

function readJsonSyncSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function isCoreDir(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  try {
    if (!existsSync(join(candidate, "dshm-core.json"))) return false;
    return existsSync(join(candidate, "node_modules", "@deepseek-ai", "dsh"));
  } catch (_) {
    return false;
  }
}

/**
 * 确定“当前正在运行的核心树”。
 *
 * 权威来源（按优先级）：
 *   1. 环境变量 DSHM_CORE_DIR：宿主 ArkTS 侧在启动 node 进程时注入，注释明确为
 *      “核心树根目录（内含 node_modules/ 与 profiles/）”（宿主 main.js 顶部环境变量说明）；
 *   2. 兼容环境变量 DSH_CORE_DIR / DSH_CORE_PATH；
 *   3. process.argv 中实际加载路径（包含 cores/<版本>/ 且存在 dshm-core.json）；
 *   4. host-ready.json runtime 内的显式 core 路径字段（若未来版本提供）。
 *
 * 以上都拿不到时返回 { dir: null, source: "unconfirmed" }：**绝不**再用“cores 下
 * 字典序最后一个目录/唯一候选”冒充当前运行版本（多版本共存时会选错）。
 */
function detectCoreDir(env, homeDir, hostReady) {
  var envNames = ["DSHM_CORE_DIR", "DSH_CORE_DIR", "DSH_CORE_PATH"];
  for (var i = 0; i < envNames.length; i += 1) {
    var envValue = env && env[envNames[i]];
    if (typeof envValue === "string" && envValue.length > 0) {
      var envCandidate = resolve(envValue);
      if (isCoreDir(envCandidate)) return { dir: envCandidate, source: "env:" + envNames[i] };
    }
  }

  try {
    var argv = Array.isArray(process.argv) ? process.argv : [];
    for (var a = 0; a < argv.length; a += 1) {
      var arg = typeof argv[a] === "string" ? argv[a] : "";
      var marker = arg.indexOf("/cores/");
      if (marker === -1) continue;
      var rest = arg.slice(marker + "/cores/".length);
      var versionName = rest.split("/")[0];
      if (!versionName) continue;
      var candidate = resolve(arg.slice(0, marker + "/cores/".length) + versionName);
      if (isCoreDir(candidate)) return { dir: candidate, source: "process.argv" };
    }
  } catch (_) {
    // ignore
  }

  try {
    var runtime = hostReady && hostReady.runtime;
    var runtimeKeys = ["coreDir", "corePath", "dshCoreDir", "dshmCoreDir"];
    if (runtime && typeof runtime === "object") {
      for (var r = 0; r < runtimeKeys.length; r += 1) {
        var runtimeValue = runtime[runtimeKeys[r]];
        if (typeof runtimeValue === "string" && runtimeValue.length > 0) {
          var runtimeCandidate = resolve(runtimeValue);
          if (isCoreDir(runtimeCandidate)) return { dir: runtimeCandidate, source: "host-ready:" + runtimeKeys[r] };
        }
      }
    }
  } catch (_) {
    // ignore
  }

  // 最后不再做“cores 下唯一候选/字典序最后一个”的猜测：无法取得权威路径时
  // 明确标记未确认，交给兼容性判断按 unknown 处理（多版本共存时不会选错）。
  return { dir: null, source: "unconfirmed" };
}

function deriveHomeFromModule() {
  // 插件位于 <DSH_HOME>/profiles/<name>/node_modules/dshm-backup/lib/index.js
  // 此处 util.js 位于同一 lib 目录，向上一共 6 层到 <DSH_HOME>。
  try {
    var here = fileURLToPath(import.meta.url);
    var dir = dirname(here); // lib
    return resolve(dir, "..", "..", "..", "..", ".."); // dshm-backup -> node_modules -> profile -> profiles -> home
  } catch (_) {
    return null;
  }
}

/**
 * 解析宿主运行时路径。所有路径都是 host（DSHM 宿主 node 进程）视角的普通绝对路径。
 * 不读取、不保存 host-ready.json 的 token/url 字段。
 */
export function resolveRuntimePaths(config) {
  var env = process.env;
  var home = env.DSH_HOME || env.DSHM_HOME || deriveHomeFromModule();
  if (!home) throw errorWithCode("DSH_HOME_MISSING", "无法定位 DSH_HOME（DSHM 数据目录）", 500);
  home = resolve(home);
  // 合并版刻意不读取 host-ready.json：该文件含 token/URL 等凭据字段。
  var profileName = env.DSHM_PROFILE || env.DSH_PROFILE || "ondevice";
  var profileDir = env.DSH_PROFILE_DIR || join(home, "profiles", profileName);
  var detectedCore = detectCoreDir(env, home, null);
  var coreDir = detectedCore.dir;
  var coreDirSource = detectedCore.source;
  var sessionsDir = join(home, "sessions");
  var storagesDir = join(home, "storages");
  var workspaceRegistryPath = join(storagesDir, "workspace.json");
  var attachmentsDir = join(home, "attachments");
  var stateDir = join(home, "dshm-boot-rescue");

  // DSHM_PUBLIC_DOWNLOAD 是“公开宿主证据 + 本机工作区能力”的来源，不是普遍保证的变量：
  // 缺失/空/非绝对/非目录/无法确认时，可见工作区能力降级，绝不使用空前缀。
  var publicDownload = "";
  var publicDownloadEvidence = {
    variable: "DSHM_PUBLIC_DOWNLOAD",
    present: false,
    validated: false,
    reason: "变量缺失或为空；可见下载目录能力降级",
  };
  try {
    var rawPublic = typeof env.DSHM_PUBLIC_DOWNLOAD === "string" ? env.DSHM_PUBLIC_DOWNLOAD : "";
    if (rawPublic.length > 0) {
      publicDownloadEvidence.present = true;
      if (!isAbsolute(rawPublic)) {
        publicDownloadEvidence.reason = "不是绝对路径；可见下载目录能力降级";
      } else {
        var candidatePublic = resolve(rawPublic);
        var publicInfo = lstatSync(candidatePublic);
        if (!publicInfo.isDirectory()) {
          publicDownloadEvidence.reason = "不是目录；可见下载目录能力降级";
        } else {
          publicDownload = candidatePublic;
          publicDownloadEvidence.validated = true;
          publicDownloadEvidence.reason = "已确认为目录（宿主环境变量证据）";
        }
      }
    }
  } catch (error) {
    publicDownload = "";
    publicDownloadEvidence.validated = false;
    publicDownloadEvidence.reason = "无法确认该路径（fail closed 降级）：" + errText(error);
  }
  var workspaceRoot = publicDownload.length > 0 ? publicDownload : null;
  var allowedDownloadPrefix = "";
  if (workspaceRoot) {
    var parent = dirname(workspaceRoot);
    try {
      if (isAbsolute(parent) && parent !== workspaceRoot && lstatSync(parent).isDirectory()) {
        allowedDownloadPrefix = parent;
      }
    } catch (_) {
      allowedDownloadPrefix = "";
    }
    if (!allowedDownloadPrefix) {
      workspaceRoot = null;
      publicDownloadEvidence.validated = false;
      publicDownloadEvidence.reason = "工作区父目录无法确认；可见下载目录能力降级";
    }
  }
  var backupDir = null;
  var backupDirVisible = false;
  if (config && typeof config.backupDir === "string" && config.backupDir.length > 0) {
    var configuredDir = resolve(config.backupDir);
    var configuredAllowed = isInsidePath(home, configuredDir) ||
      (allowedDownloadPrefix.length > 0 && isInsidePath(allowedDownloadPrefix, configuredDir));
    if (configuredAllowed) {
      backupDir = configuredDir;
      backupDirVisible = allowedDownloadPrefix.length > 0 && isInsidePath(allowedDownloadPrefix, configuredDir);
    } else {
      config.__pathRejected = "config.backupDir 不在 DSH_HOME 或已验证的下载根内，已拒绝并回退到安全目录";
    }
  }
  if (!backupDir) {
    if (workspaceRoot) {
      backupDir = join(workspaceRoot, "dshm-boot-rescue-backups", "backups");
      backupDirVisible = true;
    } else {
      backupDir = join(home, "dshm-boot-rescue", "backups");
      backupDirVisible = false;
    }
  }
  var legacyBackupDirs = [];
  if (workspaceRoot) legacyBackupDirs.push(join(workspaceRoot, "dshm-backup", "backups"));
  var legacyHomeDir = join(home, "dshm-backup", "backups");
  if (legacyBackupDirs.indexOf(legacyHomeDir) === -1) legacyBackupDirs.push(legacyHomeDir);
  var restoreFallbackBase = workspaceRoot
    ? join(workspaceRoot, fmt.RESTORE_FALLBACK_DIRNAME)
    : join(home, "restored-workspaces");
  return {
    home: home,
    profileName: profileName,
    profileDir: profileDir,
    coreDir: coreDir,
    coreDirSource: coreDirSource,
    sessionsDir: sessionsDir,
    storagesDir: storagesDir,
    workspaceRegistryPath: workspaceRegistryPath,
    attachmentsDir: attachmentsDir,
    stateDir: stateDir,
    configPath: join(stateDir, "config.json"),
    statePath: join(stateDir, "state.json"),
    lockPath: join(stateDir, "dshm-boot-rescue.lock"),
    logPath: join(home, "dshm-boot-rescue.log"),
    stagingRoot: join(stateDir, "staging"),
    backupDir: backupDir,
    backupDirVisible: backupDirVisible,
    legacyBackupDirs: legacyBackupDirs,
    workspaceRoot: workspaceRoot,
    allowedDownloadPrefix: allowedDownloadPrefix,
    publicDownloadEvidence: publicDownloadEvidence,
    restoreFallbackBase: restoreFallbackBase,
    hostReady: null,
  };
}

export function isInsidePath(base, candidate) {
  try {
    var b = resolve(base);
    var c = resolve(candidate);
    if (b === c) return true;
    return c.indexOf(b + sep) === 0;
  } catch (_) {
    return false;
  }
}

/**
 * 允许的下载根（只来自已确认的 DSHM_PUBLIC_DOWNLOAD 父目录）。
 * 为空表示“可见下载目录能力不可用”，任何依赖它的 keep/写入授权必须拒绝。
 */
export function allowedDownloadRoot(paths) {
  if (!paths || typeof paths.allowedDownloadPrefix !== "string") return "";
  var value = paths.allowedDownloadPrefix;
  if (!isAbsolute(value) || value === "/") return "";
  return value;
}

/** 路径是否在“已确认的下载根”内（不含根本身）。空根一律 false，禁止 indexOf("")===0 类放行。 */
export function isAllowedDownloadTarget(paths, candidate) {
  var root = allowedDownloadRoot(paths);
  if (!root) return false;
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  var target = resolve(candidate);
  var base = resolve(root);
  if (target === base) return false;
  return isInsidePath(base, target);
}

/** 路径是否在恢复专用兜底目录内（不含兜底根本身）。 */
export function isRestoreFallbackTarget(paths, candidate) {
  if (!paths || typeof paths.restoreFallbackBase !== "string" || paths.restoreFallbackBase.length === 0) return false;
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  var base = resolve(paths.restoreFallbackBase);
  if (!isAbsolute(base)) return false;
  var target = resolve(candidate);
  if (target === base) return false;
  return isInsidePath(base, target);
}

/** 备份根列表：own + legacy，全部 resolve 后去重；不返回空条目。 */
export function listBackupRoots(paths) {
  var roots = [];
  function add(dir, storage) {
    if (typeof dir !== "string" || dir.length === 0) return;
    var abs = resolve(dir);
    if (!isAbsolute(abs)) return;
    for (var i = 0; i < roots.length; i += 1) {
      if (roots[i].root === abs) return;
    }
    roots.push({ root: abs, storage: storage });
  }
  add(paths && paths.backupDir, "own");
  var legacy = paths && Array.isArray(paths.legacyBackupDirs) ? paths.legacyBackupDirs : [];
  for (var i = 0; i < legacy.length; i += 1) add(legacy[i], "legacy");
  return roots;
}

/**
 * 统一 own/legacy 备份文件 resolver（inspect/verify/restore 共用）。
 * 安全约束：只接受普通 .zip 文件；路径必须经 resolve 后位于允许的备份根内；
 * 拒绝目录本身、.. 穿越、相似前缀 sibling、空/控制字符、非 ZIP；
 * 用 lstat（拒绝符号链接）与 realpath（拒绝逃逸）做二次复核。
 */
export async function resolveBackupFileInput(paths, fileInput) {
  if (typeof fileInput !== "string" || fileInput.length === 0) {
    throw errorWithCode("BACKUP_FILE_REQUIRED", "请选择备份文件", 400);
  }
  var name = fileInput;
  try {
    name = decodeURIComponent(fileInput);
  } catch (_) {
    throw errorWithCode("BACKUP_FILE_INVALID", "备份文件名编码非法", 400);
  }
  if (name.length === 0 || name.indexOf("\u0000") !== -1) {
    throw errorWithCode("BACKUP_FILE_INVALID", "备份文件名非法", 400);
  }
  if (!/\.zip$/i.test(name)) {
    throw errorWithCode("BACKUP_FILE_INVALID", "只支持 .zip 备份包", 400);
  }
  var roots = listBackupRoots(paths);
  if (roots.length === 0) {
    throw errorWithCode("BACKUP_ROOT_UNRESOLVED", "备份目录未确认，拒绝解析备份文件（fail closed）", 500);
  }
  var absoluteInput = isAbsolute(name);
  var candidates = [];
  if (absoluteInput || name.indexOf("/") !== -1 || name.indexOf("\\") !== -1) {
    candidates.push(resolve(name));
  } else {
    for (var r = 0; r < roots.length; r += 1) candidates.push(resolve(join(roots[r].root, name)));
  }
  for (var c = 0; c < candidates.length; c += 1) {
    var candidate = candidates[c];
    var rootEntry = null;
    for (var k = 0; k < roots.length; k += 1) {
      if (candidate === roots[k].root) continue;
      if (isInsidePath(roots[k].root, candidate)) {
        rootEntry = roots[k];
        break;
      }
    }
    if (rootEntry === null) continue;
    var info = null;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw errorWithCode("BACKUP_FILE_INVALID", "无法确认备份文件状态：" + errText(error), 400);
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) {
      throw errorWithCode("BACKUP_FILE_INVALID", "备份路径不是普通非空文件：" + candidate, 400);
    }
    var realFile = await realpath(candidate);
    var realRoot = await realpath(rootEntry.root);
    if (realFile === realRoot || !isInsidePath(realRoot, realFile)) {
      throw errorWithCode("BACKUP_FILE_INVALID", "备份文件解析后不在允许目录内：" + candidate, 400);
    }
    return { path: realFile, root: realRoot, storage: rootEntry.storage, size: info.size };
  }
  throw errorWithCode("BACKUP_FILE_INVALID", "备份文件不存在或不在允许的备份目录内", 400);
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  return dirPath;
}

export async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

export async function isDirectory(filePath) {
  try {
    var info = await stat(filePath);
    return info.isDirectory();
  } catch (_) {
    return false;
  }
}

// ── SHA-256 ────────────────────────────────────────────────────────────────

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(filePath) {
  return new Promise(function (done, fail) {
    var hash = createHash("sha256");
    var stream = createReadStream(filePath);
    stream.on("error", fail);
    stream.on("data", function (chunk) {
      hash.update(chunk);
    });
    stream.on("end", function () {
      done(hash.digest("hex"));
    });
  });
}

// ── 原子写 / 稳定读 ───────────────────────────────────────────────────────

export async function fsyncFile(filePath) {
  // 只读打开即可 fsync；避免目标文件被系统收紧权限后 "r+" 打开失败。
  var handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function fsyncDir(dirPath) {
  try {
    var handle = await open(dirPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (_) {
    // 目录 fsync 在部分文件系统上不支持；失败不视为备份失败
  }
}

export async function writeFileAtomic(filePath, data, options) {
  var settings = options || {};
  await ensureDir(dirname(filePath));
  var tmp = filePath + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tmp, data, { mode: settings.mode === undefined ? 0o600 : settings.mode, flag: "wx" });
    await fsyncFile(tmp);
    await rename(tmp, filePath);
    await fsyncDir(dirname(filePath));
  } catch (error) {
    try {
      await rm(tmp, { force: true });
    } catch (_) {
      // ignore
    }
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

export async function readJsonFile(filePath) {
  var text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

export async function statIdentity(filePath) {
  var info = await stat(filePath, { bigint: true });
  var identity = {};
  for (var i = 0; i < IDENTITY_FIELDS.length; i += 1) identity[IDENTITY_FIELDS[i]] = String(info[IDENTITY_FIELDS[i]]);
  return identity;
}

export function identityEqual(a, b) {
  if (!a || !b) return false;
  for (var i = 0; i < IDENTITY_FIELDS.length; i += 1) {
    if (a[IDENTITY_FIELDS[i]] !== b[IDENTITY_FIELDS[i]]) return false;
  }
  return true;
}

/**
 * 按 core 的 readStableSnapshot 思路读取文件：
 *   stat → readFile → stat；identity 一致 → 稳定快照；
 *   不一致重试一次；仍不一致时返回“第一次 stat 的 size 前缀”，并标记 stable=false。
 */
export async function readStableFile(filePath, options) {
  var settings = options || {};
  var retries = typeof settings.retries === "number" ? settings.retries : 1;
  var last = null;
  for (var attempt = 0; attempt <= retries; attempt += 1) {
    var before = null;
    try {
      before = await statIdentity(filePath);
    } catch (error) {
      throw errorWithCode("SESSION_READ_FAILED", "读取会话文件失败：" + errText(error), 500);
    }
    var bytes = await readFile(filePath);
    var after = await statIdentity(filePath).catch(function () {
      return null;
    });
    last = { before: before, after: after, bytes: bytes };
    if (identityEqual(before, after)) {
      return {
        bytes: bytes,
        stable: true,
        before: before,
        after: after,
        truncatedFrom: null,
      };
    }
  }
  var prefix = last.bytes;
  var wanted = Number(last.before.size);
  if (isFinite(wanted) && wanted >= 0 && prefix.length >= wanted) {
    prefix = prefix.subarray(0, wanted);
  }
  return {
    bytes: prefix,
    stable: false,
    before: last.before,
    after: last.after,
    truncatedFrom: last.bytes.length,
  };
}

// ── zstd 帧扫描 / 会话文件校验 ─────────────────────────────────────────────

/** 移植自 core 的 scanZstdFrames：只看结构，不压缩数据块，返回完整帧范围与末尾残缺帧起点。 */
export function scanZstdFrames(buffer, maxFrames) {
  var limit = typeof maxFrames === "number" ? maxFrames : Number.POSITIVE_INFINITY;
  var frames = [];
  var offset = 0;
  while (offset < buffer.length) {
    var start = offset;
    if (buffer.length - offset < 4) return { frames: frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw errorWithCode("SESSION_ZSTD_CORRUPT", "会话日志 zstd 帧魔数损坏（offset=" + offset + "）", 422);
    }
    offset += 4;
    if (offset === buffer.length) return { frames: frames, tornStart: start };
    var descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw errorWithCode("SESSION_ZSTD_CORRUPT", "会话日志保留帧头位非零", 422);
    var contentSizeFlag = descriptor >>> 6;
    var singleSegment = (descriptor & 32) !== 0;
    var checksum = (descriptor & 4) !== 0;
    var dictionaryFlag = descriptor & 3;
    var dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    var contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    var remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames: frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames: frames, tornStart: start };
      var blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      var lastBlock = (blockHeader & 1) !== 0;
      var blockType = (blockHeader >>> 1) & 3;
      var blockSize = blockHeader >>> 3;
      if (blockType === 3) throw errorWithCode("SESSION_ZSTD_CORRUPT", "会话日志保留块类型", 422);
      var payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames: frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames: frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start: start, end: offset });
    if (frames.length === limit) return { frames: frames };
  }
  return { frames: frames };
}

export function decompressZstdFrame(frameBuffer) {
  return zlib.zstdDecompressSync(frameBuffer);
}

export function compressZstdFrame(plainBuffer) {
  return zlib.zstdCompressSync(plainBuffer, {
    params: (function () {
      var params = {};
      if (zlib.constants && zlib.constants.ZSTD_c_checksumFlag !== undefined) params[zlib.constants.ZSTD_c_checksumFlag] = 1;
      return params;
    })(),
  });
}

/**
 * 解析/校验一个会话工件。支持 zstd 多帧与明文 jsonl。
 * 返回：
 *   { header, headerLine, eventCount, frameCount, torn, complete, compression, errors }
 * 只在结构/checksum/JSON 层校验；不输出正文。
 */
export function inspectSessionBytes(bytes, compression) {
  var errors = [];
  var headerLine = null;
  var frameCount = 0;
  var torn = false;
  var lines = [];

  if (compression === "zstd") {
    var scan = null;
    try {
      scan = scanZstdFrames(bytes);
    } catch (error) {
      return { header: null, headerLine: null, eventCount: 0, frameCount: 0, torn: false, complete: false, compression: compression, errors: ["zstd-structure: " + errText(error)] };
    }
    frameCount = scan.frames.length;
    torn = scan.tornStart !== undefined;
    for (var i = 0; i < scan.frames.length; i += 1) {
      var frame = scan.frames[i];
      var plain = null;
      try {
        plain = decompressZstdFrame(bytes.subarray(frame.start, frame.end));
      } catch (error) {
        return { header: null, headerLine: null, eventCount: 0, frameCount: frameCount, torn: torn, complete: false, compression: compression, errors: ["zstd-decode-frame-" + i + ": " + errText(error)] };
      }
      var text = plain.toString("utf8");
      var parts = text.split("\n");
      for (var p = 0; p < parts.length; p += 1) {
        if (parts[p].length > 0) lines.push(parts[p]);
      }
    }
  } else if (compression === "none") {
    var all = bytes.toString("utf8");
    var allParts = all.split("\n");
    for (var q = 0; q < allParts.length; q += 1) {
      if (allParts[q].length > 0) lines.push(allParts[q]);
    }
    frameCount = 1;
    torn = false;
  } else {
    return { header: null, headerLine: null, eventCount: 0, frameCount: 0, torn: false, complete: false, compression: compression, errors: ["unknown-compression"] };
  }

  if (lines.length === 0) {
    return { header: null, headerLine: null, eventCount: 0, frameCount: frameCount, torn: torn, complete: false, compression: compression, errors: ["empty-session-log"] };
  }
  headerLine = lines[0];
  var parsed = fmt.parseSessionHeaderLine(headerLine);
  if (!parsed.ok) errors = errors.concat(parsed.errors);
  var events = 0;
  for (var e = 1; e < lines.length; e += 1) {
    try {
      JSON.parse(lines[e]);
      events += 1;
    } catch (error) {
      errors.push("bad-event-json:" + e);
      break;
    }
  }
  return {
    header: parsed.header,
    headerLine: headerLine,
    eventCount: events,
    frameCount: frameCount,
    torn: torn,
    complete: errors.length === 0 && !torn,
    compression: compression,
    errors: errors,
  };
}

/** 把会话日志第一帧（header）改写为新 cwd，其余帧字节保持不变。 */
export function rewriteSessionCwd(bytes, compression, newCwd) {
  if (compression !== "zstd") {
    // 明文 jsonl：直接替换第一行
    var text = bytes.toString("utf8");
    var nl = text.indexOf("\n");
    var first = nl === -1 ? text : text.slice(0, nl);
    var rest = nl === -1 ? "" : text.slice(nl);
    var parsed = fmt.parseSessionHeaderLine(first);
    if (!parsed.ok) throw errorWithCode("SESSION_HEADER_INVALID", "会话 header 校验失败：" + parsed.errors.join(","), 422);
    var rewritten = fmt.rewriteSessionHeaderCwd(parsed.header, newCwd);
    return Buffer.from(JSON.stringify(rewritten) + rest, "utf8");
  }
  var scan = scanZstdFrames(bytes);
  if (scan.frames.length === 0) throw errorWithCode("SESSION_ZSTD_EMPTY", "会话日志没有完整 zstd 帧", 422);
  var firstFrame = bytes.subarray(scan.frames[0].start, scan.frames[0].end);
  var plain = decompressZstdFrame(firstFrame).toString("utf8");
  var firstLine = plain.split("\n")[0];
  var parsedHeader = fmt.parseSessionHeaderLine(firstLine);
  if (!parsedHeader.ok) throw errorWithCode("SESSION_HEADER_INVALID", "会话 header 校验失败：" + parsedHeader.errors.join(","), 422);
  var newHeader = fmt.rewriteSessionHeaderCwd(parsedHeader.header, newCwd);
  var newFirstPlain = Buffer.from(JSON.stringify(newHeader) + "\n", "utf8");
  var newFirstFrame = compressZstdFrame(newFirstPlain);
  var restStart = scan.frames[0].end;
  var restBytes = bytes.subarray(restStart);
  return Buffer.concat([newFirstFrame, restBytes]);
}

// ── 单实例锁 ───────────────────────────────────────────────────────────────

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * wx 创建锁文件；已存在时读取 pid 判 stale（进程不存在则清理后重试一次）。
 * 返回 { release }；失败抛 LOCK_BUSY。
 */
export async function acquireLock(lockPath, label) {
  await ensureDir(dirname(lockPath));
  for (var attempt = 0; attempt < 2; attempt += 1) {
    try {
      var handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, label: label || "", at: nowIso() }) + "\n", "utf8");
      await handle.close();
      var released = false;
      return {
        path: lockPath,
        release: async function () {
          if (released) return;
          released = true;
          try {
            await unlink(lockPath);
          } catch (_) {
            // ignore
          }
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      var stale = false;
      try {
        var text = await readFile(lockPath, "utf8");
        var record = JSON.parse(text);
        stale = !pidAlive(record && record.pid);
      } catch (_) {
        stale = true;
      }
      if (!stale) throw errorWithCode("LOCK_BUSY", "已有备份/恢复任务在运行（锁文件：" + lockPath + "）", 409);
      try {
        await unlink(lockPath);
      } catch (_) {
        // ignore
      }
    }
  }
  throw errorWithCode("LOCK_BUSY", "无法获取任务锁：" + lockPath, 409);
}

// ── 目录遍历（工作区产出文件 / 附件）──────────────────────────────────────

export var DEFAULT_SKIP_DIR_NAMES = [
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".cache",
  "__pycache__",
  ".Trash",
  ".Recent",
  ".virtfs_metadata",
];

/**
 * 递归列出普通文件（跳过符号链接/特殊文件与排除目录），返回 {rel, abs, size}。
 * 使用 lstat，符号链接不跟随（防止越界/循环）；错误写 warnings，不中断。
 */
export async function walkFiles(rootDir, options) {
  var settings = options || {};
  var skipNames = settings.skipDirNames || DEFAULT_SKIP_DIR_NAMES;
  var skipAbsPrefixes = settings.skipAbsPrefixes || [];
  var maxFiles = typeof settings.maxFiles === "number" ? settings.maxFiles : fmt.MAX_BACKUP_FILES;
  var files = [];
  var warnings = [];
  var visitedDirs = 0;

  async function walk(dirAbs, relBase) {
    visitedDirs += 1;
    if (visitedDirs > 20000) {
      warnings.push("目录数量超过 20000，已停止扫描：" + relBase);
      return true;
    }
    var entries = null;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch (error) {
      warnings.push("目录读取失败（已跳过）：" + relBase + "：" + errText(error));
      return true;
    }
    entries.sort(function (a, b) {
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      var abs = join(dirAbs, entry.name);
      var rel = relBase === "" ? entry.name : relBase + "/" + entry.name;
      var skip = false;
      for (var k = 0; k < skipAbsPrefixes.length; k += 1) {
        if (abs === skipAbsPrefixes[k] || abs.indexOf(skipAbsPrefixes[k] + sep) === 0) skip = true;
      }
      if (skip) continue;
      if (entry.isDirectory()) {
        if (skipNames.indexOf(entry.name) !== -1) {
          warnings.push("按排除规则跳过目录：" + rel);
          continue;
        }
        var stop = await walk(abs, rel);
        if (stop) return true;
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) {
          warnings.push("文件数量超过上限 " + maxFiles + "，已停止扫描（备份将失败而不是静默截断）");
          return true;
        }
        var info = null;
        try {
          info = await lstat(abs);
        } catch (error) {
          warnings.push("文件 stat 失败（已跳过）：" + rel + "：" + errText(error));
          continue;
        }
        if (!info.isFile()) {
          warnings.push("跳过非普通文件：" + rel);
          continue;
        }
        files.push({ rel: rel, abs: abs, size: info.size });
      } else {
        warnings.push("跳过符号链接/特殊文件：" + rel);
      }
    }
    return false;
  }

  var existed = await isDirectory(rootDir);
  if (!existed) {
    return { files: files, warnings: ["目录不存在：" + rootDir], exists: false };
  }
  await walk(rootDir, "");
  return { files: files, warnings: warnings, exists: true };
}

// ── 工作区注册表 / 附件 / 插件清单 ────────────────────────────────────────

export async function readWorkspaceRegistry(registryPath) {
  var result = { exists: false, known: true, text: null, sha256: null, registry: null, errors: [] };
  var text = null;
  try {
    text = await readFile(registryPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return result;
    return {
      exists: false,
      known: false,
      text: null,
      sha256: null,
      registry: null,
      errors: ["无法读取 workspace.json（状态未知，fail closed）：" + errText(error)],
    };
  }
  result.exists = true;
  result.text = text;
  result.sha256 = sha256Buffer(Buffer.from(text, "utf8"));
  try {
    result.registry = JSON.parse(text);
  } catch (error) {
    result.known = false;
    result.errors.push("workspace.json 不是合法 JSON：" + errText(error));
    return result;
  }
  if (result.registry === null || typeof result.registry !== "object" || Array.isArray(result.registry)) {
    result.known = false;
    result.errors.push("workspace.json 顶层不是对象");
    return result;
  }
  var check = fmt.validateWorkspaceRegistry(result.registry);
  if (!check.ok) {
    result.known = false;
    result.errors = result.errors.concat(check.errors);
  }
  return result;
}

export async function scanAttachmentFiles(attachmentsRoot) {
  if (!(await isDirectory(attachmentsRoot))) return { files: [], warnings: [] };
  var result = await walkFiles(attachmentsRoot, {
    skipDirNames: DEFAULT_SKIP_DIR_NAMES.concat(["tmp"]),
    maxFiles: fmt.MAX_BACKUP_FILES,
  });
  var mapped = [];
  for (var i = 0; i < result.files.length; i += 1) {
    var file = result.files[i];
    mapped.push({ rel: file.rel, abs: file.abs, size: file.size, entry: fmt.attachmentZipEntry(file.rel) });
  }
  return { files: mapped, warnings: result.warnings };
}

function readPackageJsonSyncSafe(packagePath) {
  try {
    return JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function resolveInstalledPackageDir(profileDir, name) {
  var candidates = [join(profileDir, "node_modules", name), join(profileDir, "node_modules", "." + name)];
  for (var i = 0; i < candidates.length; i += 1) {
    try {
      if (lstatSync(candidates[i])) return candidates[i];
    } catch (_) {
      // ignore
    }
  }
  return null;
}

/**
 * 采集插件清单：**严格只含 name + version**（用户要求），不含 spec/kind/id/bundle/
 * disabled/profileBundles 或任何目录信息。版本无法取得时写 "unknown"。
 * 用户插件来自 profile/package.json dependencies + node_modules/<pkg>/package.json；
 * 核心插件来自 dshm-core.json 的 plugins[]，版本按包名（scoped 取前两段）解析。
 */
export function readPluginInventory(paths) {
  var inventory = {
    core: [],
    user: [],
    warnings: [],
  };
  var profilePackage = readPackageJsonSyncSafe(join(paths.profileDir, "package.json"));
  if (profilePackage) {
    var dependencies = profilePackage.dependencies;
    if (dependencies && typeof dependencies === "object") {
      var names = Object.keys(dependencies).sort();
      for (var i = 0; i < names.length; i += 1) {
        var name = names[i];
        if (name.indexOf("@deepseek-ai/") === 0) continue; // 核心包由 core 清单负责
        var packageDir = resolveInstalledPackageDir(paths.profileDir, name);
        var version = "unknown";
        var packageName = name;
        if (packageDir) {
          var manifest = readPackageJsonSyncSafe(join(packageDir, "package.json"));
          if (manifest) {
            if (typeof manifest.version === "string" && manifest.version.length > 0) version = manifest.version;
            if (typeof manifest.name === "string" && manifest.name.length > 0) packageName = manifest.name;
          }
        } else {
          inventory.warnings.push("插件目录缺失，版本标记 unknown：" + name);
        }
        inventory.user.push({ name: packageName, version: version });
      }
    }
  } else {
    inventory.warnings.push("读取 profile/package.json 失败，用户插件清单为空");
  }

  if (paths.coreDir) {
    var coreInfo = readJsonSyncSafe(join(paths.coreDir, "dshm-core.json"));
    if (coreInfo && Array.isArray(coreInfo.plugins)) {
      for (var c = 0; c < coreInfo.plugins.length; c += 1) {
        var plugin = coreInfo.plugins[c];
        if (!plugin || typeof plugin.name !== "string" || plugin.name.length === 0) continue;
        var moduleName = plugin.name;
        var packageNameForCore = fmt.packageNameOf(moduleName) || moduleName;
        var coreVersion = "unknown";
        var corePackage = readPackageJsonSyncSafe(join(paths.coreDir, "node_modules", packageNameForCore, "package.json"));
        if (corePackage && typeof corePackage.version === "string" && corePackage.version.length > 0) {
          coreVersion = corePackage.version;
        }
        inventory.core.push({ name: moduleName, version: coreVersion });
      }
    } else {
      inventory.warnings.push("读取核心 dshm-core.json 的 plugins[] 失败");
    }
  } else {
    inventory.warnings.push("未确认当前运行 core 目录（coreDir unconfirmed），核心插件清单为空");
  }
  return inventory;
}

// ── 版本采集（不同维度分开，不合并）───────────────────────────────────────

export function collectVersionInfo(paths) {
  var versions = {
    coreVersion: "unknown",
    coreBuiltAt: null,
    coreNodeFloor: null,
    coreDirSource: paths.coreDirSource || "unconfirmed",
    upstreamDshVersion: "unknown",
    nodeVersion: typeof process.version === "string" ? process.version : null,
    platform: null,
    jitless: null,
    zstd: typeof zlib.zstdCompressSync === "function",
    profile: paths.profileName,
    appVersion: null,
    backupToolVersion: null,
    sessionFormatVersion: fmt.SESSION_FORMAT_VERSION,
    workspaceDomainVersion: fmt.WORKSPACE_DOMAIN_VERSION,
  };
  var toolPackage = readPackageJsonSyncSafe(fileURLToPath(new URL("../package.json", import.meta.url)));
  if (toolPackage && typeof toolPackage.version === "string") versions.backupToolVersion = toolPackage.version;
  if (paths.coreDir) {
    var coreInfo = readJsonSyncSafe(join(paths.coreDir, "dshm-core.json"));
    if (coreInfo) {
      versions.coreVersion = typeof coreInfo.coreVersion === "string" && coreInfo.coreVersion.length > 0 ? coreInfo.coreVersion : "unknown";
      versions.coreBuiltAt = typeof coreInfo.builtAt === "string" ? coreInfo.builtAt : null;
      versions.coreNodeFloor = typeof coreInfo.nodeFloor === "string" ? coreInfo.nodeFloor : null;
      versions.platform = typeof coreInfo.platform === "string" ? coreInfo.platform : null;
      versions.profile = typeof coreInfo.profile === "string" ? coreInfo.profile : versions.profile;
    }
    var dshPackage = readPackageJsonSyncSafe(join(paths.coreDir, "node_modules", "@deepseek-ai", "dsh", "package.json"));
    if (dshPackage && typeof dshPackage.version === "string" && dshPackage.version.length > 0) versions.upstreamDshVersion = dshPackage.version;
  }
  versions.jitless = Array.isArray(process.execArgv) && process.execArgv.indexOf("--jitless") !== -1;
  return versions;
}

// ── 磁盘空间 / 备份目录 ───────────────────────────────────────────────────

export async function statfsFreeBytes(targetPath) {
  try {
    if (typeof statfs !== "function") return null;
    var info = await statfs(targetPath);
    var free = Number(info.bavail) * Number(info.bsize);
    return isFinite(free) ? free : null;
  } catch (_) {
    return null;
  }
}

export async function probeWritableDir(dirPath) {
  var created = false;
  try {
    if (!(await pathExists(dirPath))) {
      await mkdir(dirPath, { recursive: true, mode: 0o700 });
      created = true;
    }
    var probe = join(dirPath, ".dshm-backup-probe-" + randomSuffix());
    await writeFile(probe, "ok", { flag: "wx", mode: 0o600 });
    await unlink(probe);
    return { ok: true, created: created };
  } catch (error) {
    return { ok: false, created: created, error: errText(error) };
  }
}

export async function listBackupEntries(backupDir) {
  var result = [];
  var names = null;
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  names.sort();
  for (var i = 0; i < names.length; i += 1) {
    var name = names[i];
    if (!/\.zip$/i.test(name)) continue;
    var filePath = join(backupDir, name);
    var info = null;
    try {
      info = await stat(filePath);
    } catch (_) {
      continue;
    }
    if (!info.isFile()) continue;
    var kind = "manual";
    var match = /^dshm-backup-(manual|baseline|emergency|pre-restore)-/.exec(name);
    if (match) kind = match[1];
    var sidecarSha = null;
    try {
      var sidecar = await readFile(filePath + ".sha256", "utf8");
      var m = /^([0-9a-f]{64})/.exec(sidecar);
      if (m) sidecarSha = m[1];
    } catch (_) {
      sidecarSha = null;
    }
    result.push({
      name: name,
      file: filePath,
      kind: kind,
      size: info.size,
      mtime: info.mtime.toISOString(),
      // 注意：这里只报告“是否有旁文件/旁文件记录的 SHA”，**不代表已实际校验**。
      // verified 由 index.js 根据本次真实校验缓存（重新计算并核对成功）另行标记。
      hasSidecar: sidecarSha !== null,
      sidecarSha: sidecarSha,
      sha256: sidecarSha,
      verified: false,
      verifiedAt: null,
    });
  }
  return result;
}

// ── 日志 ───────────────────────────────────────────────────────────────────

export function createLogger(logPath) {
  var queue = Promise.resolve();
  function write(line, isError) {
    var text = "[" + nowIso() + "] " + (isError ? "ERROR " : "") + line + "\n";
    queue = queue
      .then(function () {
        return appendFile(logPath, text, "utf8");
      })
      .catch(function () {
        // 日志失败不影响主流程
      });
    try {
      if (isError) console.error("[dshm-backup] " + line);
      else console.log("[dshm-backup] " + line);
    } catch (_) {
      // ignore
    }
    return queue;
  }
  return {
    info: function (line) {
      return write(line, false);
    },
    error: function (line) {
      return write(line, true);
    },
    flush: function () {
      return queue;
    },
  };
}

// ── 其它小工具 ─────────────────────────────────────────────────────────────

export async function readJsonFileSafe(filePath) {
  try {
    return await readJsonFile(filePath);
  } catch (_) {
    return null;
  }
}

export async function removeTreeQuietly(targetPath) {
  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
}

export async function removeFileQuietly(targetPath) {
  try {
    await rm(targetPath, { force: true });
  } catch (_) {
    // ignore
  }
}

/**
 * 严格删除文件：不使用会吞错误的 Quietly 版本。
 * 返回 { ok, error, stillExists }；ENOENT 视为“已不存在 = 成功”。
 */
export async function removeFileStrict(targetPath) {
  try {
    await rm(targetPath, { force: false });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: true, error: null, stillExists: false };
    }
    return { ok: false, error: errText(error), stillExists: await pathExists(targetPath) };
  }
  return { ok: true, error: null, stillExists: await pathExists(targetPath) };
}

/** 严格删除目录树：返回 { ok, error, stillExists }；ENOENT 视为已不存在。 */
export async function removeTreeStrict(targetPath) {
  try {
    await rm(targetPath, { recursive: true, force: false });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: true, error: null, stillExists: false };
    }
    return { ok: false, error: errText(error), stillExists: await pathExists(targetPath) };
  }
  return { ok: true, error: null, stillExists: await pathExists(targetPath) };
}

export function toPosixRel(rootPath, absPath) {
  var rel = absPath.indexOf(rootPath + sep) === 0 ? absPath.slice(rootPath.length + 1) : absPath;
  return rel.split(sep).join("/");
}

/**
 * 原子复制文件（流式读写，**不使用 fs.copyFile，也不对目标 chmod**）。
 *
 * 手机实测演进：
 * - v0.1.3：copyFile 在沙箱→用户可见 Download 方向 EPERM（D2）；
 * - v0.1.4：改为流式复制，但复制后对目标临时文件 chmod 仍被 OHOS 拒绝（EPERM，D3）。
 *
 * 因此目标文件权限只通过 createWriteStream 的 mode 参数设置（默认 0o600），
 * 复制后不再 chmod；fsync 以只读 fd 完成，避免权限收紧后的写打开失败。
 * 源文件 0o400（附件）只需读权限，不受影响。
 *
 * options.mode 可选，缺省 0o600（临时文件与最终文件同 mode）。
 */
export async function copyFileAtomic(source, destination, options) {
  var settings = options || {};
  var targetMode = settings.mode === undefined ? 0o600 : settings.mode;
  await ensureDir(dirname(destination));
  var tmp = destination + "." + randomUUID() + ".tmp";
  try {
    // 普通 read/write 流：避开 OHOS 对 copyfile 系统调用的拒绝；
    // 目标 mode 由 createWriteStream 创建时设置，不做 chmod。
    await pipeline(
      createReadStream(source),
      createWriteStream(tmp, { flags: "wx", mode: targetMode })
    );
    await fsyncFile(tmp);
    await rename(tmp, destination);
    await fsyncDir(dirname(destination));
  } catch (error) {
    try {
      await rm(tmp, { force: true });
    } catch (_) {
      // ignore
    }
    throw error;
  }
}

/**
 * 直接流式复制到最终目标（**不建临时文件，不 chmod，不 fsync，不 rename**）。
 *
 * 仅用于“目标已确认不存在”且位于 OHOS 用户可见目录的场景（恢复工作区文件）。
 * 该目录已实测允许普通 read/write，但禁止 copyfile/chmod 等元数据操作；
 * 为避免 v0.1.3/0.1.4 的 copyfile、chmod 以及潜在 fsync/rename 限制，直接用
 * createReadStream → createWriteStream 写最终路径。
 *
 * 所有权规则（v0.1.7 阻断修复）：
 * - 必须先用 open(destination, "wx") 排他创建成功，才算“本次调用创建的文件”；
 * - 只有创建成功后，才调用 options.onCreated(destination) 让调用方登记回滚 journal；
 * - 目标已存在（EEXIST）或 open 失败时：不调用 onCreated、不删除 destination，
 *   既有文件原样保留；
 * - 创建成功后的读取/写入失败：只清理本次创建的文件；若清理失败则保留 journal 登记，
 *   由外层回滚继续严格清理并如实报告。
 */
export async function copyFileDirect(source, destination, options) {
  var settings = options || {};
  var targetMode = settings.mode === undefined ? 0o600 : settings.mode;
  await ensureDir(dirname(destination));
  var handle;
  try {
    handle = await open(destination, "wx", targetMode);
  } catch (error) {
    // EEXIST 等：目标不是本次创建的，绝不删除、绝不登记。
    throw error;
  }
  var stream = null;
  try {
    // 创建成功后才登记；必须在开始流式复制之前完成。
    if (typeof settings.onCreated === "function") {
      await settings.onCreated(destination);
    }
    stream = handle.createWriteStream({ autoClose: true });
    await pipeline(createReadStream(source), stream);
  } catch (error) {
    if (stream) {
      try {
        stream.destroy();
      } catch (_) {
        // ignore
      }
    }
    try {
      await handle.close();
    } catch (_) {
      // ignore
    }
    // 只清理本次排他创建的文件；清理失败不吞掉 journal（onCreated 已登记）。
    try {
      await rm(destination, { force: true });
    } catch (_) {
      // 保留文件；外层回滚会依据 journal 继续清理并如实报告
    }
    throw error;
  }
  // 成功路径：autoClose 通常已关闭句柄；再 close 一次并忽略已关闭错误。
  try {
    await handle.close();
  } catch (_) {
    // ignore
  }
}

export { realpath, realpathSync, readFileSync, readdirSync, lstatSync };
