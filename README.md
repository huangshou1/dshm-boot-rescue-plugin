# dshm-boot-rescue

DSHM（HarmonyOS / DeepSeek Harness）安全中心插件：把启动救援、备份、校验和恢复入口合并到一个宿主侧插件中。

## 当前状态

- 版本：**1.1.0 RC**
- 状态：**不是 stable 版本**
- 当前 RC tag：`v1.1.0-rc.1`

## 功能

- 正常页“安全中心”单入口；
- 面板显示真实运行版本；
- 启动器支持单击打开、拖拽定位和视口内 clamp；
- 启动失败页救援入口（由 Host `webServer.tapIndex` 注入）；
- 备份创建、只读列表、完整性校验与导入预览；
- 旧备份插件共存只读；
- 全新、同核心版本实例的恢复预览与恢复入口（默认拒绝非全新目标）。

## 安装

使用固定 tag，不使用浮动 `main`：

```text
github:huangshou1/dshm-boot-rescue-plugin#v1.1.0-rc.1
```

## 使用

1. 安装后冷启动 DSHM；
2. 正常页点击“安全中心”进入面板；
3. 启动失败时，若 Host 仍存活，可在失败页打开救援入口；
4. 救援写入后必须冷重启，并在重启后只读确认是否生效。

## 备份安全

- 备份包中包含**明文聊天记录和工作区内容**；
- 设计上排除凭据文件，插件清单只保存 name/version；
- 不得把真实备份上传到公开仓库、对话、Issue 或 Release；
- 恢复前请确认备份目标、核心版本和冲突提示。

## 旧插件共存

检测到旧 `dshm-backup` 仍安装并启用时，本插件进入共存只读模式：备份写入、恢复、轮换和基线全部禁用，只允许只读列出/校验/预览。

- 只有明确确认旧插件不存在（`absent`）时才可能允许写入；
- 不自动停用、卸载或删除旧插件；
- 旧插件存在但状态无法确认时继续 fail closed。

## 恢复限制

- 只允许**全新实例**；
- 核心版本必须 **exact 匹配**；
- 备份格式必须兼容；
- 非全新目标、核心版本不一致或未知时一律拒绝；
- 不存在“确认后继续”的跨版本或非全新目标旁路；
- 恢复成功后必须冷重启，重启前不要新建会话。

## 当前验收限制

- 首个合并版 baseline 的独立 SHA-256 verify 已通过；
- D6 inspect 因 `TARGET_NOT_FRESH` 未生成 preview/previewId；
- 未执行真实恢复；
- 手机和平板尚未验收；
- 完整真实救援/恢复链尚未验收；
- 完整 rows→Web boot 与完整回滚链尚未闭合。

本版本不是生产可用版本，也不应被描述为“绝对安全”或“完整恢复已验证”。

## 公开文件结构

```text
package.json
cordis.patch.yml
README.md
LICENSE
.gitignore
lib/
  backup-service.js
  backup.js
  client.js
  coexistence-policy.json
  coexistence.js
  format.js
  index.js
  rescue.js
  restore.js
  util.js
  zip.js
```

## License

MIT。见 [LICENSE](LICENSE)。
