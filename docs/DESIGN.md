# dshm-boot-rescue v1.1.0 — 设计与证据说明

> 状态：离线源码候选。**已由外部复核在官方 Node v24.2.0、Linux x64 执行，原有 Node 测试 45/45 通过；Chromium 全量场景（含 pending-only、健康→失败、失败→健康）通过，getterHits=0；非空多帧合成 zstd 会话恢复验证通过；尚未完成 openharmony/arm64/jitless 真机 D 级验收。（本机无 Node/Chromium）。**
> 本文只把“已读源码证实 / 推断 / 未知”分开写，不把历史报告或事故叙述当成已验证事实。

## 0. 版本与基线

| 项 | 值 |
|---|---|
| 合并包名 | `dshm-boot-rescue` |
| 目标版本 | `1.1.0` |
| 救援基线 | `dshm-boot-rescue` v1.0.0，GitHub commit `3c0456576ba9aba327633bd1bc9f296fe854e08b` |
| 备份基线 | `dshm-backup` v0.1.8，GitHub commit `3150aa0aef6413d67a0fad024627ea78761006d8` |
| 本地实际核心 | `0.2.1-rc.2+dshm.73`（builtAt 2026-10-18） |
| DSHM 应用版本 | **未知**（材料不足以证明；不引用浮动 main 当作已安装版本） |

`dshm-boot-rescue` v1.0.0 与 `dshm-backup` v0.1.8 的固定 commit 源码与上传包逐文件 sha256 一致；
设备上已安装副本的 lib 文件也与之 sha256 一致（只读比对）。工作区遗留的本地 v1.1.0 目录**未使用**。

## 1. 运行形态

- 一个 ESM 宿主插件：`export function apply(ctx)`，零第三方运行依赖，只用 Node 内置模块。
- **零静态 `inject`、无 `dsh.client`**：`webServer`/`loader` 全部 `ctx.get` 判空 + `internal/service`
  事件 + 有界定时重试（最多 30 次，`unref`），拿不到服务只写日志降级，绝不进入 pending。
- **统一面板**：宿主通过 `webServer.tapIndex` 注入单文件 `lib/client.js`；该文件包含
  失败页救援中心（v1.0.0 逻辑）与正常页“安全中心”面板（新增），不使用
  `__ModuleLoader__`，不依赖正常客户端插件加载链。
- 失败页与正常页共用宿主统一状态接口 `/dshm-boot-rescue/state`；失败页不依赖正常业务 UI。

## 2. 模块与数据流

```
lib/index.js
  ├─ lib/rescue.js           救援：路由分发、状态、快照、单层写入、目标映射、回滚
  ├─ lib/backup-service.js   备份/恢复服务：任务串行、状态、/backup/api/*
  │    ├─ lib/backup.js      v0.1.8 基线（扫描、ZIP、校验、轮换）
  │    ├─ lib/restore.js     v0.1.8 基线（预览、恢复、回滚）
  │    ├─ lib/zip.js         v0.1.8 基线（自研 ZIP、无 ZIP64、无加密、无符号链接）
  │    ├─ lib/format.js      v0.1.8 基线（格式/限制/清单）
  │    └─ lib/util.js        v0.1.8 基线（原子写、锁、路径、版本信息；已移除 host-ready 读取）
  ├─ lib/coexistence.js      旧 dshm-backup 共存状态机（fail closed）
  └─ lib/client.js           单文件统一面板（tapIndex 注入）
```

宿主路由只有一个 prefix：`/dshm-boot-rescue`。救援路由直接挂在根下；
备份 API 挂在 `/backup/api/*`（`/dshm-boot-rescue/backup/api/*`），**不复用旧插件的 `/dshm-backup`**。

## 3. 统一状态模型

`GET /dshm-boot-rescue/state` 由救援状态 + 备份状态合并：

```json
{
  "ok": true, "mode": "rows|patch-fallback|readonly", "writable": true,
  "entries": [{"id":"...","packageName":"...","name":"...","actionable":true,"risk":"..."}],
  "rescueRows": ["..."],
  "backup": {"ok":true,"writeAllowed":true,"writeBlockedReason":"","coexistence":{...},
              "backups":[...],"job":{...},"restore":{"pendingRestart":false,"lastResult":null}},
  "coexistence": {"state":"absent|enabled|disabled|registered-unmounted|unknown",
                   "writeAllowed":true,"reason":"..."},
  "capabilities": {"rescue":true,"backupReadOnly":false,"backupWrite":true,
                    "advancedBundlesQuarantine":false},
  "limitations": ["..."]
}
```

状态机要点：

- `已写入` ≠ `已生效`：救援写入成功后只返回“已写入（需冷重启）”；重启后由 loader 的
  `entry.disabled` 状态证明生效，面板不得把“配置已写入”显示成“故障已修复”。
- 救援 + 备份各自独立队列：大型备份任务不阻塞紧急救援快照；救援写操作串行；
  快速重复点击以按钮禁用 + 服务端任务互斥（`JOB_BUSY`）兜底。
- 面板初始化有界：一次健康探测 + 打开面板时拉取状态；`/backup/api/state` 轮询仅在任务运行中、
  有次数上限（600 × 1200ms），停止条件为任务结束/面板关闭；不使用 `setInterval`。

## 4. DSHM 加载链证据（决定救援写点）

以下为本机安装核心树源码证据（只读）：

1. **patch 层顺序**：bundle 层 → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`
   → `--patch` overlays（`@deepseek-ai/dsh/lib/profile-boot-*.js` L74-83、L236-247、L302；
   `@deepseek-ai/dsh-app-boot/lib/index.js` L1127-1137）。
2. **patch 语义**：按 `id` 覆盖字段、insert 追加、未知 id/name 不匹配 warn 跳过
   （`dsh-app-boot` L61-110）。
3. **profile 挂载**：全部 patch 层先在空根上 compose，再作为单个 insert patch 交给 Loader
   （`dsh-app-boot` L2404-2417、L4153、L4522-4557）。
4. **Host 启动审计**：仅 `agent-loop/webserver/web-runtime/modules/connection/headless-runner/acp/
   sdk-jsonrpc-server` 与 bootstrap include 未激活是致命的；普通 entry pending 只 warn，
   Host 继续运行（`dsh-app-boot` L4285-4294、L4348-4417、L4479-4490）。⇒ 失败页仍可由 Host 注入救援。
5. **Web boot 图来源**：`dsh-client-modules` 扫描 Loader live entries 中声明 `dsh.client` 的包，
   `processOne` 跳过 `entry.disabled`/无 fiber 的 entry（L852-875，过滤条件 L854-855），
   图通过 `webserver/index-inject` 注入为 `window.__DSH_BOOT__`（L571-573、L500-503）。
6. **app 侧 rows 链**：`ensureProfile()` → `composeUserRows()` 把“种子 patch + carry 条目 + 受管块”
   写进 profile `cordis.patch.yml`（`hostcore/app/dshm-user-rows.js` L538-653；
   `hostcore/app/main.js` L4790-4917、L4950-4977）；disabled 行无条件保留（L265-318）。
7. **Host fatal 自愈**：`$DSH_HOME/.dshm-boot-failed` + 下次启动隔离用户行/dependencies/home patch
   （dshm-user-rows L658-669、L1029-1114）。这是 Host 致命失败路径，与 Web client pending 不同。

**事故冲突（未闭合）**：按第 5/6 条推导，rows disabled 应当使 loader entry disabled，从而使
`__DSH_BOOT__` 不包含该客户端 entry；但事故报告称“仅写 rows disabled 未可靠阻止 Web boot”。
现有材料无法证明断点（可能是 row id 映射、compose 未执行、rows 被自愈隔离、冷重启未真正重启 Host、
或 rescue 写入未落盘）。因此 v1.1.0 **不把 rows 单独当已验证可靠**：必须做 C 级可执行回归。
在 C 级回归通过前，救援只能承诺“已写入 + 需冷重启 + 面板复核”，不能承诺“已修复”。

## 5. 救援写入流程（单层、可复核、可回滚）

1. 只处理用户明确选择的疑似故障插件；先展示目标包名、版本、loader entry id/name、预计变更。
2. 目标映射：从 live loader 取 entry；解析 profile 中已安装包 package.json 与 bundle patch insert 行，
   建立 package ↔ entry id 映射；无法证明 ⇒ 拒绝（fail closed）。
3. 保护：不得是自己、`@deepseek-ai/*` 内置、无法确认的核心覆盖行；未映射候选拒绝。
4. 写前快照：保存将修改文件 + 操作元数据（dev/ino/size/mtimeNs/ctimeNs 指纹），重新读取校验；
   失败禁止写入。
5. 原子写（同目录 tmp + rename），文件级串行队列，外部修改复核（指纹不一致拒绝），写后重读校验，
   幂等（重复点击不重复追加标记块）。
6. 精确回滚：只删除本插件标记前缀 + 精确 3 行块；用户改过的块、其它行原样保留；
   回滚前警告“可能重新启用故障插件”。
7. **不自动叠加写入层**：默认仅 `.dshm-plugin-rows.yml`。若该层无法证明有效，停止并报告；
   不做 rows → home patch → bundles 的自动升级。高级 bundles 隔离本轮不提供 UI 操作入口，
   只在设计中保留其适用条件（用户明确选择、映射证明、直接 bundle 条目存在、删除可覆盖阻塞条目、
   非自身/非内置/非无法确认核心、快照/预览/二次确认/原子写/写后复核/回滚全部可用）。
   **保留的 v1.0.0 降级模式说明**：当 `.dshm-plugin-rows.yml` 在“写入前”就结构不可解析时，
   该次救援会选择写 profile `cordis.patch.yml` 的 `patch-fallback` 单一层（不会同时写 rows/home
   patch/bundles）；这不是“rows 失败后的自动升级”，且该层本次操作后不再自动换层。
   若要求严格只允许 rows 一个写入点，需在后续发布门槛评估时显式关闭该降级模式。

## 6. 旧备份插件共存只读策略

策略数据在 `lib/coexistence-policy.json`，运行时由 `lib/coexistence.js` 判定，测试直接校验同一份数据。

| 状态 | 条件（本次启动的事实） | 备份写入 |
|---|---|---|
| `absent` | 未安装且未在 profile 登记（仅残留目录也算） | 允许 |
| `enabled` | 已安装并登记，loader entry 启用 | **禁止**（共存只读） |
| `disabled` | 已安装并登记，row/entry disabled | **禁止**（未移除前仍只读） |
| `registered-unmounted` | 已登记但 loader 无该 entry | **禁止**（fail closed） |
| `unknown` | profile/loader 无法确认 | **禁止**（fail closed） |

- 只读能力：列表、校验、预览（包括旧插件既有备份的只读发现）。
- 禁止：新建备份、紧急备份、基线备份、恢复、轮换、状态迁移、备份目录写入。
- 不自动停用/卸载旧插件；用户移除旧插件并冷重启后重新评估（仅启动时判定，不在运行中动态放开）。
- 数据隔离：新备份写入 `<可见下载目录>/dshm-boot-rescue-backups/backups`；
  旧目录 `<可见下载目录>/dshm-backup/backups` 与 `$DSH_HOME/dshm-backup/backups` 只读发现；
  合并版状态/锁/日志使用 `$DSH_HOME/dshm-boot-rescue/` 与 `dshm-boot-rescue.log`，不覆盖旧状态。

## 7. 备份/恢复

沿用 v0.1.8 引擎（固定 commit）与能力：手动/基线/紧急/恢复前备份、列表、导入预览、冲突检查、
SHA-256 校验、任务串行/进度/失败报告/轮换/临时清理、发布前后重读校验、同核心版本全新实例恢复、
恢复后冷重启提示。新增/保持：

- 故障状态手动备份 kind 恒为 `manual`，不会写 `lastBaseline`；自动基线只在非共存只读时运行。
- 恢复必须 `previewId` + `confirm:true`；预览不可恢复/有冲突/版本不一致（未显式确认）均拒绝。
- 备份含明文聊天/工作区内容，不含凭据；插件清单只 name/version；单包 <4GiB、无 ZIP64、无加密、
  无符号链接。
- 恢复目标必须全新实例；不覆盖真实实例是文档与预览/确认流程的硬约束，不是“提示一下”。

## 8. 安全校验与限制

- 写接口：本机回环地址 + 回环 Host + `application/json` + `Origin`/Host 一致 +
  `sec-fetch-site` 同源/none；请求体上限（救援 32KiB；备份 64KiB）；救援单次最多 32 个 ID、
  ID 长度 ≤200、控制字符拒绝、整批 fail closed。
- 不读取 `host-ready.json`（含 token/URL 凭据）；不读取 `.credentials.yaml`；零遥测；
  不读 cookie/localStorage；无硬编码真机路径/固定端口。
- 日志只写诊断信息，不写凭据；备份清单只 name/version。
- 路径：`DSH_HOME`/`DSHM_HOME` 内写；可见下载目录按既有工作区规则；不猜测 homedir。

## 9. 已知边界 / 不能承诺项

1. Host 未启动、webServer 未监听、tapIndex 不可用 ⇒ 插件内救援/面板不可用（注入依赖 Host）。
2. Host 因 required entry 未激活而退出 ⇒ 没有救援页面，只能外部恢复。
3. **rows disabled 对真实 Web boot 的效力尚未被 C 级回归证明**（事故中曾未可靠生效）；
   本源码候选不承诺“写了就修复”。C 级回归是发布门槛。
4. 外部复核已在官方 Node v24.2.0、Linux x64 执行原有 Node 测试 45/45 通过，Chromium 全量场景通过（含 pending-only、健康→失败、失败→健康），并完成非空多帧合成 zstd 恢复验证；但 Linux x64 ≠ openharmony/arm64/jitless，真机 D 级验收仍未完成。B 级 Python 测试不能替代 C/D 级。
5. app 侧源码代理（GitHub main 1cb0db6）早于本地核心 builtAt；只有与安装核心/固定源码哈希一致的
   证据才可标明适用版本。本次 app 侧行为只按“源码代理”标注，不写成“已验证当前安装应用”。
6. 高级 bundles 隔离本轮不提供 UI 操作入口；不得把“配置已写入”显示为“故障已修复”。

## 10. 证据等级

- A：静态检查（`tools/check_static.py`，实际执行结果见 TEST_REPORT）。
- B：Python 辅助测试（格式、状态机、ZIP、快照、模型；不执行 JS）。
- C：Node 24 行为测试（`test/node/`）。外部复核已在官方 Node v24.2.0、Linux x64 执行原有 45 项测试并通过；Chromium 全量场景通过。本机无 Node/Chromium，r6 新增/修改用例未在本机执行。
- D：真机验收（**未执行**）。


## 11. r2 修正补充（路径/共存/恢复/入口/写后复核）

### 11.1 DSHM_PUBLIC_DOWNLOAD 的公开宿主证据与适用版本

- Host 运行时可通过 `DSHM_PUBLIC_DOWNLOAD` 提供工作区下载根；具体值按部署环境不同
  （来源：Agent 宿主运行时上下文；对应设备 DSHM 核心 `0.2.1-rc.2+dshm.73`，DSHM 应用版本未知）。
- 该变量**不是所有环境都保证存在**：r2 把它当作“可见工作区能力证据”，仅在存在、绝对、
  确为目录、父下载根可确认时才启用；缺失/为空/非绝对/非目录/无法确认时能力降级，
  使用 `$DSH_HOME/dshm-boot-rescue/backups` 作为安全兜底目录，并记录 `paths.publicDownloadEvidence`。
- 适用版本：本次观测只证明“本机当前核心版本下该变量被设置为该值”，**不证明其它 DSHM 版本**；
  文档与测试不得把它写成普遍保证。

### 11.2 路径授权唯一策略

- 删除 format 中的 `DOWNLOAD_ROOT_PREFIX`；不再存在空字符串前缀。
- `util.allowedDownloadRoot/isAllowedDownloadTarget/isRestoreFallbackTarget` 是唯一授权实现；
  `buildTargetMapping` 与 `assertTargetAllowed` 共用同一策略；空根一律 false、不含根本身。
- 任意绝对路径只有在“已确认下载根内且不是根本身”或“恢复专用兜底目录内”时才可作为目标。

### 11.3 统一 own/legacy 备份 resolver

- `util.resolveBackupFileInput(paths, input)` 是 inspect/verify/restore 唯一入口；
  先 resolve 规范化，再限定于 own/legacy 备份根；拒绝目录、`..`、相似前缀、非法编码、NUL、非 `.zip`；
  `lstat` 拒绝符号链接与非普通文件，`realpath` 后二次确认未逃逸。
- 旧备份继续支持只读列出/校验/预览；恢复仍受共存只读门禁。

### 11.4 恢复目标与核心版本严格 fail closed

- `readWorkspaceRegistry` 与 `scanSessionArtifacts` 均为三态；`readTargetState` 汇总 `targetKnown`；
  未知状态（registry 损坏、会话目录读取失败、无法识别目录名、非 v4 工件、无可识别日志）
  一律不是 fresh target，预览与执行前都拒绝，不进入 staging。
- `describeVersionComparison` 结果必须 `exact`；core-mismatch/unknown/format-mismatch 直接拒绝。
  删除 `allowVersionMismatch`/`requiresVersionConfirm`：不存在 confirm 跨版本绕过。
- 保留预览、冲突检查、`confirm:true`、执行前 SHA/指纹复核、恢复后冷重启。

### 11.5 attachRescue 与写后复核

- `attachRescue` 的 runtime 在 try 外声明；正常路径返回 runtime，不产生 ReferenceError/未处理 rejection。
- rename 后调用 `verifyWrittenContent` 重读目标文件比对；不一致抛 `write-unverified`，
  只报告“写入未确认”，**不自动升级写入层**（不 rows→home patch→bundles）。

### 11.6 共存写入门禁

- 备份运行时初始 `coexist={state:"unknown",writeAllowed:false}`、`writeBlocked=true`；
- home/profile/manifest/installed/rows/loader 任一 known=false ⇒ unknown/writeAllowed:false；
- `saveState`、新建/基线/紧急/恢复/轮换、校验缓存、`pendingRestart` 清理全部受同一门禁；
  `pendingRestart` 清理延迟到 `applyCoexistence` 明确 absent 后。


## 12. r3 修正补充

- `lib/util.js` 显式导入 `isAbsolute`；`lib/backup-service.js` 恢复被误删的 `cleanupPreviews`；
  静态检查新增 lib 全目录 AST 未定义标识符扫描。
- `lib/coexistence.js`：
  - `manifestStructuralFact` 要求 manifest 顶层对象与相关字段结构可确认；null/数组/标量/字段结构非法
    一律 known=false → unknown/writeAllowed=false；
  - rows 使用严格支持格式解析；不支持内容、畸形缩进、重复 id/disabled 一律 known=false，
    不再默认 known=true/disabled=false。
- Node 共存测试改用统一 baseFacts 事实结构；符号链接测试只对 symlinkSync 做平台能力捕获；
  roundtrip 使用完整环境快照并在 finally 恢复/删除新增键。
- **本轮仍无可执行 Node**，C/D 均为 0；静态/结构检查不等于行为验证。


## 13. r4 修正补充

- `findLoaderEntry`：`loader.entries()` 只有明确返回数组才可确认；`null/undefined/对象/字符串/数字`
  等非数组返回一律 `known=false`（不再 `|| []` 转化为空数组），最终 unknown/writeAllowed:false。
- 新增真实 `detectLegacyBackupCoexistence()` 行为测试（合成 profile + 合成 loader 形状），
  不依赖手写 facts。
- 路径拒绝测试断言稳定错误码 `BACKUP_FILE_INVALID`（不依赖自然语言文案）。
- roundtrip 改为递归检查 manifest 字段名（识别 token/cookie/apikey/password 等组合），
  说明文字值不误报；单独断言 ZIP 条目不含 host-ready.json/凭据文件；完整往返执行保留。
- 保留 r3 全部修复；本机仍无 Node，C/D 为 0。


## 14. r6 修正补充

- 健康页误判：共享页面状态判定改为“明确启动失败容器/标记优先；存在非本插件健康 UI 时，
  不得仅因聊天正文出现事故关键词判 failure；pending-only 仍可在无健康 UI 时按正文失败信号识别”。
  本插件 overlay/launcher/panel/input/textarea 继续排除。
- Node 链测试：`client-modules-excerpt.mjs` 正确导出 `parseDshClient/optionalStringArray`，
  修复 Node 24 下模块加载失败（测试总数 46 中 1 项失败的直接原因）。
- 回滚生命周期：链测试增加“种子重置适配器”模拟下一次冷启动；但固定版本 app 侧 ensureProfile
  源码不可得，`CHAIN_GAPS` 增加回滚生命周期缺口，完整回滚链仍标未闭合。
- Chromium 测试：增加 healthy-incident-text、healthy→failure、failure→healthy 三个场景（总计 10 个），
  为启动/导航/CDP 请求/场景增加有界超时；server.close 前调用 closeAllConnections/closeIdleConnections，
  并清理 Page/Target/WebSocket，失败必须非零退出并输出场景。
- 历史 r5 报告保留在 `docs/history/`，当前状态文案更新为外部 Node/Chromium 复核结论。


## 15. r7 补充

- 正常页 `[data-dshm-security-launcher]` 增加 Pointer Events 拖拽：阈值 7 CSS px、只处理主指针、
  mouse 仅主按钮、setPointerCapture/release、pointerup/pointercancel/lostpointercapture、
  left/top 定位并清 right/bottom、视口 clamp、resize/orientationchange 重夹、移除时清监听；
  拖拽后抑制本次 click，下一次独立单击/键盘 Enter/Space 仍打开面板。
- 正常面板标题下显示“运行版本”：来自既有 `/health.version`；只接受 ok=true 的非空字符串；
  缺失/非法/请求失败显示“未知”；不硬编码、不新增写请求、不轮询、不影响启动器。
- 以上仅离线候选 r7；Node/Chromium 真实执行需外部复跑；不改变 D1B 状态，不安装/重启真机。


## 16. r8 补充

- core.96 `loader.entries()` 是 generator（可迭代，非 Array）。r8 在 `lib/coexistence.js` 新增唯一
  `materializeLoaderEntries()`：接受 Array/同步 generator；限制 4096 项；拒绝 null/标量/Map/Set/
  plain object/async-only/array-like/异常 iterator 与非法 entry；失败调用 `iterator.return()` 且保持 fail closed。
- coexistence 的 `findLoaderEntry()` 与 backup-service 的 `scanHostLoaderEntries()` 共用该 materializer；
  Host 扫描失败显式 ok:false，不再把 generator 当零项静默扫描。
- 合法空 generator 仍需 manifest/installed/rows/home/profile 等其余事实已知时才可能 absent/writeAllowed；
  旧 dshm-backup 命中时继续禁止写入。r8 仅为离线候选，未安装/重启。


## 17. r9 补充

- loader 测试不再读取公开 facts 中不存在的 `entry` 字段；改为 state/writeAllowed/loaderKnown 公开契约。
- `isMapOrSetValue()` 改用 `Map.prototype.size` / `Set.prototype.size` 的真实 getter brand 检查，
  不再依赖 `Object.prototype.toString`/`Symbol.toStringTag`；伪装和跨 realm Map/Set 均拒绝。
- 其它 materializer 规则（4096、Array/generator、条目校验、fail closed）不变；r9 仅为离线候选。
