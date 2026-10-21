# 设计复盘：给一个不提供删除能力的产品加上回收站

> English abstract: DeepSeek Harness ships archive but no delete — its persistence
> layer exposes no deletion primitive. This note records how the feature was designed
> on top of supported operations (archive + move the log directory + an atomic index),
> which alternatives were rejected and why, and the four bugs that shaped the result.
> It is also the interview-ready write-up for this project.

## 1. 约束：产品没有删除

先看事实，而不是先写代码：

| 层 | 观察到的事实 |
|---|---|
| UI | 会话行菜单只有 置顶 / 重命名 / 分叉 / 归档 / 会话 ID |
| Host API | 会话控制器里没有任何删除端点；`workspace.delete` 的注释明确写着「保留目录与全部会话日志」 |
| 持久化 | 会话日志层只有写入、加锁、压缩，没有删除或回收原语 |

所以「加个删除按钮」并不成立：**没有可调用的删除语义**。要么改宿主源码（需要拿到仓库并重新打包，升级即冲突），要么用现有能力组合出一个等价语义。

## 2. 三个被否掉的方案

**A. 只做「隐藏」** —— 即直接复用归档。否掉：用户要的是删除，藏起来不叫删除，数据仍在增长。

**B. 真正 `rm` 日志目录** —— 否掉：不可撤销。会话日志是用户唯一的上下文载体，误删不可恢复，风险与收益不成比例。

**C. 直接删除 + 二次确认** —— 否掉：确认框防的是手滑，防不了「想清楚之后后悔」。业内做法（回收站）已经证明软删除才是正解。

**最终方案**：归档（停活 + 隐藏）+ 目录迁移 + 索引，三者组合成「软删除」。撤销 = 反向操作。

## 3. 设计要点

1. **先停活，再动文件。** 直接移走正在写入的日志，宿主会在原位置重建文件，造成「删了又复活」。因此第一步调用 `archiveSession(id, { stopActivity: true })`：它既停掉运行中的工作，又通过归档门（`agent/pre-step`）阻止后续唤醒。
2. **移动而不是删除。** `rename` 是原子的，且可逆；跨目录移动失败时（Windows 文件锁），记录 `moved: false` 并交给启动补扫，而不是报一个假成功。
3. **索引必须原子写。** `index.json` 用「临时文件 + rename」替换，崩溃只会丢失最后一次写，不会写出半个 JSON。
4. **所有写操作串行。** 一个 promise 队列包住 delete/restore/purge，避免并发删除时索引互相覆盖。
5. **边界归一化 id。** 会话 id 从磁盘到 registry 都是 `session-<uuid>`；只在边界做「缺前缀则补」，绝不在中间层重新推导。

## 4. 四个真实的坑

### 坑 1：插件被宿主自己的包管理器删掉

第一次装完能用，之后从市场装另一个插件，本插件消失了。原因：我手工把目录拷进 `node_modules`，没写进 profile 的 `dependencies`；而市场安装会跑一次 `pnpm install`，它把「不在依赖图里的包」当多余包清理。

**教训**：扩展点不只是 API，还包括**安装契约**。修复方式是把插件登记为 `file:` 依赖 + `dsh.profile.bundles`，让它成为一等公民。

### 坑 2：执行策略把工具链整个挡死

某天所有终端命令都失败：`无法加载文件 …dsh-ops\bin\prepare-workspace.ps1，因为在此系统上禁止运行脚本`。宿主每次执行命令前都要跑这个预检脚本，而机器策略是 Restricted。

**教训**：排查要顺着「谁在我之前运行」往上找，而不是盯着自己的命令。修复是 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

### 坑 3：id 前缀，两个方向都错过

- 最初：把侧栏传来的 `session-<uuid>` 直接当目录名，拼成 `session-session-…` → 找不到目录。
- 于是改成剥掉前缀：目录找到了，但 `archiveSession` 收到裸 uuid，registry 在 live 会话、header 索引、持久化列表里都查不到 → `no such session`。
- 最终：**永不剥离**，只在缺失时补前缀；索引里旧条目加载时迁移。

**教训**：约定不一致的 bug，往往不是「改一处」，而是要先确定**哪一层是权威**。这里权威是磁盘上的 header.id。

### 坑 4：同一个行 id 有两个主人

手写的 `- insert:` 行和 bundle 自带的 patch 都声明了同一个 id。加载器对重复 id 的处理是拒绝，表现为「插件时好时坏」。

**教训**：把一个东西迁到「正规安装方式」时，必须同时**撤掉旧的手工痕迹**，否则两套机制会打架。

## 5. 取舍与已知限制

- **删除后到重启前**，会话仍出现在「全部对话（显示已归档）」里：归档是隐藏手段，日志已经移走；重启后彻底消失。
- **不自动跳转**：删的正好是当前会话时，主区域不会自动切走。
- **依赖内部约定**：slot 名、`archiveSession`、日志目录布局。宿主升级可能让功能失效——但失效是「看得见」的（菜单消失/报错），不会是静默的数据损坏。
- **不做多选/设置页**：这些是成熟竞品已经做过的方向，本项目的定位是「最少改动 + 可撤销」。

## 6. 如果重做

1. **先写安装与升级路径**，再写功能——坑 1 和坑 4 都是安装契约问题，与业务逻辑无关。
2. **把「权威 id」写成一个类型**，在边界处转换一次，内部不允许出现裸 uuid。
3. **给「移动失败」设计一等状态**，而不是用重试兜底；`moved: false` 现在是隐式的，应该显式建模为 `pending` / `done` / `failed`。
4. **CI 从第一天就有**：三个测试文件本来就能跑，晚加只是让仓库看起来不可信。

## 7. 这个项目在简历上的一句话

> 在一个不暴露删除 API 的 Electron 应用中，通过逆向宿主插件机制、组合归档与日志迁移，
> 设计并落地了支持 8 秒撤销的会话回收站；期间定位并修复了依赖裁剪、执行策略、
> id 归一化与重复注册四类平台级问题。