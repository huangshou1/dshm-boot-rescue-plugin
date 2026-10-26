// dshm-boot-rescue v1.1.0 — 合并版入口（安全中心：启动救援 + 备份/恢复）。
//
// 形态（与 v1.0.0 安全插件同一套端侧约束）：
//   · 纯宿主插件，export function apply(ctx)；零第三方运行依赖；只用 Node 内置模块；
//   · 零静态 inject、无 dsh.client：webServer/loader 全部 ctx.get 判空 + 有界重试，
//     拿不到服务只降级写日志，绝不让插件进入 pending（这正是事故要救的故障模式）；
//   · 统一面板 = 单文件、零依赖、由 webServer.tapIndex 注入的 lib/client.js；
//     失败页救援与正常页安全中心共用同一套宿主状态接口；
//   · 救援、备份、恢复、快照写接口全部走本机回环 + 同源 + Host/Origin 校验；
//   · 备份/恢复服务在 lib/backup-service.js（由 lib/index.js 挂载），
//     既有 dshm-backup 插件共存时进入「共存只读」（见 lib/coexistence.js）。
//
// 已验证环境：离线 Node v24.2.0/Linux x64 与 Chromium 场景；当前真机部分验收已完成。
// 手机、平板及完整真实救援/恢复链尚未验收。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attachRescue } from "./rescue.js";
import { createBackupService } from "./backup-service.js";
import { detectLegacyBackupCoexistence, unknownCoexistence } from "./coexistence.js";

export const name = "dshm-boot-rescue";
export const version = readOwnVersion();

const appliedContexts = new WeakSet();

function readOwnVersion() {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    return typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
}

function errText(error) {
  if (error === null || error === undefined) return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message.length > 0) return error.message;
  try {
    return String(error);
  } catch (_) {
    return "unknown error";
  }
}

function unavailableBackupService(error) {
  var reason = "备份服务初始化失败（已降级为不可用，不影响救援与宿主启动）：" + errText(error);
  return {
    runtime: { coexist: { state: "unknown", writeAllowed: false, reason: reason }, writeBlocked: true, writeBlockedReason: reason, readOnly: true, readOnlyReason: reason },
    buildState: async function () {
      return {
        ok: false,
        unavailable: true,
        error: reason,
        writeAllowed: false,
        writeBlockedReason: reason,
        coexistence: null,
        backups: [],
      };
    },
    handle: async function (req, res, subpath) {
      if (typeof subpath === "string" && subpath.indexOf("/backup") === 0) {
        try {
          if (res && !res.writableEnded) {
            res.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, error: reason, code: "BACKUP_UNAVAILABLE" }));
          }
        } catch (_) {
          // ignore
        }
        return true;
      }
      return false;
    },
    applyCoexistence: function () { return { writeAllowed: false, started: false, reason: reason }; },
    startSchedulers: function () {},
  };
}

export function apply(ctx) {
  try {
    if (!ctx || typeof ctx.effect !== "function") {
      try { console.error("[dshm-boot-rescue] apply：ctx.effect 不可用，跳过（不影响宿主启动）"); } catch (_) { /* ignore */ }
      return;
    }
    if (appliedContexts.has(ctx)) return;
    appliedContexts.add(ctx);

    const clientPath = fileURLToPath(new URL("./client.js", import.meta.url));

    let backup = null;
    try {
      backup = createBackupService(ctx, { mergedVersion: version });
    } catch (error) {
      backup = unavailableBackupService(error);
      try { console.error("[dshm-boot-rescue] 备份服务初始化失败（救援继续）：" + errText(error)); } catch (_) { /* ignore */ }
    }

    const options = {
      clientPath: clientPath,
      enrichState: async function (state) {
        try {
          state.backup = await backup.buildState();
        } catch (error) {
          state.backup = { ok: false, unavailable: true, error: errText(error), writeAllowed: false, backups: [] };
        }
        state.coexistence = backup.runtime && backup.runtime.coexist ? backup.runtime.coexist : null;
        const writeAllowed = !!(state.backup && state.backup.writeAllowed === true);
        state.capabilities = {
          rescue: true,
          rescueWritable: state.writable === true,
          backupReadOnly: !writeAllowed,
          backupWrite: writeAllowed,
          backupImportPreview: true,
          legacyBackupReadOnlyDiscovery: true,
          advancedBundlesQuarantine: false,
        };
        state.limitations = [
          "离线 Node 24/Chromium 和当前真机部分验收已完成；手机、平板及完整真实救援/恢复链尚未验收。",
          "Host 未启动、webServer 未监听或 tapIndex 不可用时，插件内救援与面板不可用。",
          "Host 因 required entry 未激活而退出时没有救援页面，只能外部恢复。",
          "救援写入后必须冷重启（划掉后台重新打开）；重启前不得新建会话。",
          "共存只读模式下旧 dshm-backup 备份只可读列出/校验/预览，写入全部禁用。",
          "高级 bundles 隔离本轮只在代码与文档中保留设计，不提供默认/自动操作。",
        ];
      },
      extraRoute: async function (rescueRuntime, req, res, subpath) {
        if (typeof subpath === "string" && subpath.indexOf("/backup") === 0) {
          return backup.handle(req, res, subpath);
        }
        return false;
      },
      onAttach: function (rescueRuntime) {
        let coexist = null;
        try {
          coexist = detectLegacyBackupCoexistence(rescueRuntime, ctx);
        } catch (error) {
          coexist = unknownCoexistence("无法确认旧备份插件状态（fail closed）：" + errText(error));
        }
        if (!coexist || typeof coexist !== "object" || coexist.writeAllowed !== true) {
          if (!coexist) coexist = unknownCoexistence("共存检测未返回结果（fail closed）");
        }
        try {
          backup.applyCoexistence(coexist);
        } catch (error) {
          try {
            backup.applyCoexistence(unknownCoexistence("共存判定应用失败（fail closed）：" + errText(error)));
          } catch (_) {
            // ignore：备份服务不可用时由 fallback 服务保持写入关闭
          }
        }
      },
    };

    Promise.resolve(attachRescue(ctx, options)).catch(function (error) {
      try { console.error("[dshm-boot-rescue] attachRescue 失败（已忽略，不影响宿主启动）：" + errText(error)); } catch (_) { /* ignore */ }
    });
  } catch (error) {
    try { console.error("[dshm-boot-rescue] apply 失败（已忽略，不影响宿主启动）：" + errText(error)); } catch (_) { /* ignore */ }
  }
}
