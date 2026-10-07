# 会话删除（dsh-session-delete）

一个 DeepSeek Harness 插件：在**侧栏会话行的「⋯」菜单里**加一行 **「删除会话…」**。确认后：

- 该会话的**日志目录**与**投影缓存**被移到**操作系统自己的回收站**（Windows 的「回收站」）；
- 它同时从工作区会话列表里摘掉，归档集合里的残留也一并清掉。

回收站就是你电脑上那个：还原用你熟悉的方式（资源管理器 → 回收站 → 还原）。**本插件不在 DSH 里面另造回收站**。

## 功能

- ✅ 「⋯」菜单里一行 `role="menuitem"` 的「删除会话…」，排在官方 pin(100) / rename(200) / fork(300) / archive(400) **之后**（本插件 `order: 500`），左侧是官方垃圾桶图标
- ✅ 二次确认对话框挂在官方 `shell.overlay` 浮层（遮罩、Esc、焦点自己管，不随菜单卸载）
- ✅ 中文/英文跟随界面语言（同一套字典，键集合经测试校验一致）
- ✅ 不替换任何官方 UI：只用自己的包名命名空间 id 往官方槽位里加
- ✅ 动手前先做**只读定位**；定位不到就什么都不做

## 删除到底做了什么（顺序是重点）

| 步 | 做什么 | 官方依据 |
|---|---|---|
| 1 | **定位** `~/.dsh/sessions/<工作区>/<session-id>` | 只读扫描，不拼用户输入 |
| 2 | **停住**该会话 | `workspaceRegistry.archiveSession(id, { stopActivity: true })` —— 归档集合正是 `agent/pre-step` 门读的东西，这就是官方的「停」信号，避免日志被还在跑的 Agent 写 |
| 3 | **回收**日志目录 + 投影缓存 | `Microsoft.VisualBasic.FileIO.FileSystem … SendToRecycleBin` |
| 4 | **摘掉**该行 | `Workspace.detachSession(id)`，随后 `unarchiveSession(id)` 清掉第 2 步留下的归档记录 |

全程在一次 HTTP 请求里完成（宿主半体拥有整条链）。

**失败是回滚，不是半途状态。** 第 3 步失败就什么都不摘、并把第 2 步的归档撤销，会话的可见性回到原样。**没有「直接永久删除」的兜底**——回收站拒绝时静默抹掉用户日志，不是这个插件该做的决定。

## 平台

| | 状态 |
|---|---|
| **Windows** | ✅ 支持。`Microsoft.VisualBasic.FileIO.FileSystem`（Windows PowerShell 5.1 与 7 都带）让 shell 回收而不是 unlink。PowerShell 走**绝对路径** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`——GUI 启动不继承 shell 的 PATH，所以不能假设 `pwsh` 在 PATH 上 |
| **macOS / Linux** | ⛔ **未实现**。会明确回 `501` 且**不做任何改动**，而不是猜一种删除方式 |

## 已知边界

- **只有「清空回收站」不可逆** —— 那是 Windows 自己的行为，不是本插件的。
- **「幽灵行」：被删的会话若在本次运行里被加载过**（新建或点开），它仍活在宿主的**内存会话表**里。官方**没有**把它移除的接口——`ctx.sessions` 只有 `create / prepare / enter / announce / flush / get / list / fork`；`AgentHandle.dispose()` 属于创建它的那一方（agent 工厂的复合拆除链），插件拿不到。于是那一行会留在侧栏（失去工作区归属后落到「未分组」），**要等下次启动 DSH 才彻底消失**。
  - **实测：刷新页面清不掉它。** 曾有一版把确认按钮绑成「确认并刷新界面」（`location.reload()`），验证结果是**那一行依然在**——因为尸体在**宿主**内存里，页面重取也拿得到；该绑定已移除，按钮回到单纯的「确认」。
  - 宿主会把这种情形标成 `wasLive`，弹窗会**显示一条提示**告诉你这一行要等重启，而不是让你自己猜（也不会给你一个做不到的按钮）。
  - 注意：**字节此时已经在回收站里**，那行只是一条指向空处的记录；**没被本次运行加载过的会话**删掉**不会**留行。
- 宿主若没有 `workspaceRegistry`（非 Web 组合），**回收照做**，但列表行可能要等到下次启动才消失；这一步会在返回结果里说明，不会假装成功。
- **归档**（把行藏起来但保留日志）仍是官方 ⋯ 里那一行的职责，本插件不提供。

## 安装

### 官方插件管理器（本机验证过的方式）

用 Settings → Plugins 安装，或让插件管理器装本地目录。它会写成：

```json
"dependencies": { "dsh-session-delete": "link:<本目录绝对路径>" }
```
并把 `"dsh-session-delete"` 追加进 profile 的 `dsh.profile.bundles`。装的是 **`link:`（符号链接）**，所以本目录就是唯一真源。

### 手工部署

把本目录放进 profile（例如 `~/.dsh/profiles/desktop/`），然后：

1. `dependencies` 加 `"dsh-session-delete": "file:./dsh-session-delete"`
2. `dsh.profile.bundles` 追加 `"dsh-session-delete"`
3. 在 profile 目录 `pnpm install`，然后重启 DSH

`cordis.patch.yml` 把插件行插进 profile 层；client 端由官方 `dsh-client-modules` 扫描 `dsh.client` 声明后自动注入浏览器。

**卸载**：Settings → Plugins 里卸载，或从 `dependencies` / `dsh.profile.bundles` 里删掉再 `pnpm install`。

## 改代码后什么时候生效

| 改哪半 | 生效方式 |
|---|---|
| `lib/client.js`（浏览器半体） | 宿主每次投递都从磁盘读 → **刷新页面**即可 |
| `lib/index.js`（宿主半体） | 模块在挂载时导入一次，**改文件不会重新导入** → 需要**重启 DSH** |

## 自测（不安装）

```bash
node tools/dry-run.mjs [--scratch <dir>] [--composition <module-list>] [--keep]
```

在系统临时目录里搭一个暂存 profile 跑 **85 项检查**，最后断言**真实 Harness 家目录一字未动**（包括逐个比对真实会话日志目录）。覆盖：安装形态、发布契约、`dsh.client.inject ∩ 组合`、classic-script 编译、客户端 `apply()` 与两处注册、菜单行有/无 `sessionId` 的渲染、官方 `MenuItemButton` 的 `onSelect` 契约、有序删除流程、以及宿主半体的**定位/删除/回滚/隔离**。

> 回收站在 dry run 里是**可注入的 stand-in**：它把字节**搬走**而不是交给系统回收站，所以 dry run **绝不会往你的回收站放任何东西**。真实回收站路径由一次单独的一次性目录探针验证（见提交历史）。

## 发布前注意事项

### `dsh.client.inject` 是**硬门禁**

宿主会一直扣着客户端入口，直到清单里**每一个 seam 都存在**。列了不在组合里的名字 = 这个插件在该宿主上**永远不会加载**（市场为这条规则付过代价，issue #554）。

本包只列**确实存在于组合里、且确实用到**的三个包：

| seam | 用途 |
|---|---|
| `@deepseek-ai/dsh-client-locale` | `ctx.locale` |
| `@deepseek-ai/dsh-client-ui-settings` | `ctx.slots`（市场的映射里，提供 slot 服务的 seam） |
| `@deepseek-ai/dsh-client-ui-workspace` | 它声明了 `sidebar.workspaces.session.menu.item` 这个槽位 |

**不要**加 `@deepseek-ai/dsh-client-runtime`（市场已从自己的清单删掉；它属于宿主基础设施链）或 `@deepseek-ai/dsh-client-ui-slots`（被 runtime 内联的纯核心库，npm 清单里连 `dsh` 字段都没有，**不是客户端模块**）。

### 客户端 bundle 的文件头是发布契约

文件必须**以单行** `window.__ModuleLoader__.load({ id: "dsh-session-delete", factory: (require) => {` **开头**，且**不能有 BOM**（宿主会从文件头嗅探 loader id）。同时必须是 **classic script**（官方用 `vm.Script` 编译校验），所以 bundle 里不能出现 `import`/`export`。

### 刻意没有声明的东西

**`peerDependencies` / `engines.dsh` 故意留空。** 宿主会按 **dsh peer range** 决定是否**跳过**整个 bundle（只闸 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`）。声明一个与被测宿主不匹配的区间，代价是**插件完全不被加载**——比不声明更糟。本机已验证的运行时是 **`0.2.0-rc.2`**，等确定要支持哪些版本后再补：

```json
"peerDependencies": { "@deepseek-ai/dsh": "^<验证过的版本>" },
"engines": { "dsh": "^<同一个版本>" }
```

两者机制不同：`engines.dsh` 是**市场安装时**的前置校验，`peerDependencies` 是**宿主启动时**的跳过判定。

## 许可证

MIT
