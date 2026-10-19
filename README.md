# dsh-conversation-trash

给 DSH Web 侧栏加一个**「删除对话」**：软删除进回收站，8 秒内可撤销，子代理会话级联删除，分叉保留。

> 为什么需要插件：DSH 的会话域目前只有归档（`workspaceRegistry.archiveSession`），Host API、持久化层都没有删除原语，工作区删除的注释也明确写着“保留每一个会话日志”。所以这个功能不是加个按钮，而是一套「归档 + 移出会话目录 + 回收站索引」的组合动作。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

然后**完全退出 DSH**（托盘图标 → 退出）再启动。安装脚本会：

1. 把本包复制到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-conversation-trash`
2. 在 profile 的 `cordis.patch.yml` 里追加一条带标记的 loader 条目（原文件自动备份为 `.bak-时间戳`）

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

## 用起来是什么样

- 侧栏会话行 → 悬停 → `…` 菜单 → **删除对话**（危险色，排在归档下面）
- 确认框会先向 Host 预检：会话标题、将被一起删除的子代理数量、正在运行的工作会被停止
- 确认后：先 `archiveSession(id, { stopActivity: true })`（停掉在跑的工作、行立即从默认列表消失），再把 `~/.dsh/sessions/<工作区>/session-<id>/` 移到 `~/.dsh/session-trash/<id>/`，并写入索引
- 右下角 toast：**已删除「标题」· 撤销**（8 秒）
- 撤销 = 目录移回原处 + 取消归档

## 数据在哪

| 路径 | 内容 |
|---|---|
| `~/.dsh/session-trash/<session-id>/` | 被删除会话的原始日志目录 |
| `~/.dsh/session-trash/index.json` | 条目：id、标题、父会话、删除时间、大小、是否已移动 |
| `~/.dsh/sessions/<workspace>/session-<id>/` | 恢复后回到的位置 |

彻底删除（purge）目前只暴露了 HTTP 接口（`POST /dsh-conversation-trash/purge`、`/purge-all`），还没有设置页入口——见「后续」。

## HTTP 接口

全部只接受 loopback Host、同源 Origin、`application/json` 的 POST（与官方 Web 插件同款 fence）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-conversation-trash/list` | 回收站条目 + 总大小 |
| POST | `/dsh-conversation-trash/preview` | `{sessionId}` → 标题、子代理 id 列表 |
| POST | `/dsh-conversation-trash/delete` | `{sessionId, displayTitle}` |
| POST | `/dsh-conversation-trash/restore` | `{sessionId}`（父会话会连同子代理一起恢复） |
| POST | `/dsh-conversation-trash/purge` | `{sessionId}` 真删 |
| POST | `/dsh-conversation-trash/purge-all` | 清空回收站 |

## 实现要点

**Host（`lib/index.mjs`）**

- `ctx.get("workspaceRegistry").archiveSession(id, { stopActivity: true })` 负责停工作 + 隐藏行；未知会话静默跳过
- 会话目录通过扫描 `~/.dsh/sessions/*/session-<id>` 定位，不依赖工作区目录名的编码规则
- 级联：优先用 `ctx.sessionQuery.listSessions()`（能看到已落盘的会话）建父子图，退回 `ctx.sessions.list()`（只能看到活跃会话）
- Windows 上日志文件可能仍被打开，`rename` 会 `EBUSY`：按 0/1.2/2.5/5/8/12 秒重试，仍失败则标记 `pending`，下次启动时 `sweep()` 补做（那时写入器还没附着）
- 所有写操作走一条串行队列，索引文件用「临时文件 + rename」原子替换

**Client（`lib/client.cjs`）**

- 手写 `window.__ModuleLoader__.load({...})` 工厂，`require("react")` / `require("@deepseek-ai/dsh-client-ui-primitives")` 由平台模块表提供，无需构建
- 注册 `sidebar.workspaces.session.menu.item`（`id: trash-delete`, `order: 500`）和 `shell.overlay`（确认框 + toast）
- 中英文案按 `navigator.language` 切换

## 测试

```powershell
node test/smoke.mjs          # host：临时的假 HOME + 假 ctx，跑 preview→delete→list→restore→purge 与 fence
node test/client-shape.mjs   # client：bundle 注册、导出、两个 slot 的 id/order
node test/dry-run.mjs        # 只读扫真实 ~/.dsh，确认能找到会话目录（不修改任何数据）
```

面向使用者的分步说明见 [`使用说明.md`](./使用说明.md)。

## 已知限制

- **删除后立刻重启前**，该会话仍会出现在「全部对话（显示已归档）」里（它已被归档、日志已移走）。重启后彻底消失。
- **子代理级联**依赖会话摘要里的 `parentSession`；如果某个子代理从未落盘也没在内存里，删不到。
- **删除当前正在看的会话**：行会消失、归档门会拦住新回合，但主区域不会自动跳走——原型阶段没接导航。
- **回收站没有设置页**，`purge` 目前只能走 HTTP；下一步是在设置壳里加一节（图标位 `archived-sessions` 已预留）。
- 属于社区扩展点用法：上游一旦把 `session/delete` 做进协议，这个插件应整体退役。

## 后续可做

1. 设置 → 回收站页面（列表、恢复、彻底删除、清空、显示占用大小）
2. 删除后自动导航到最近会话
3. 快捷键（`Ctrl+Shift+Backspace`）与命令面板入口
4. 定时任务 / Goal 引用被删会话时先提示
