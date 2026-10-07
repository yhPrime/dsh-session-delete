# 会话删除（dsh-session-delete）

一个 DeepSeek Harness 插件：在**侧栏会话行的「⋯」菜单里**加一行 **「删除会话…」**，点开后可以

- **归档（隐藏）** —— 走官方 `workspaces.archiveSession`，从列表移除，日志仍在磁盘上；
- **移入回收站** —— 连同投影缓存一起移到 `.dsh/trash/dsh-session-delete/`，**可以还原**；
- 在**设置 → 回收站**里查看、还原、或（二次确认后）**彻底清除**。

> **1.1.0 的位置变更。** 1.0.0 把按钮放在会话头部，因为当时认为侧栏会话行的「⋯」菜单由官方硬编码、没有插件槽位。**这个判断在当前官方版已经不成立**：宿主声明了专用的列表槽位 `sidebar.workspaces.session.menu.item`，且它的 ownerProps 会把每一行的 `sessionId` 与 `displayTitle` 一并交给插件。所以 1.1.0 把入口搬进了「⋯」菜单。

## 功能

- ✅ 「⋯」菜单里一行 `role="menuitem"` 的「删除会话…」，排在官方的 pin(100) / rename(200) / fork(300) / archive(400) **之后**（本插件 `order: 500`）
- ✅ 二次确认对话框挂在官方 `shell.overlay` 浮层，遮罩、Esc、焦点都自己管，不会随菜单卸载
- ✅ 中文/英文跟随界面语言（同一套字典，键集合经测试校验一致）
- ✅ 回收站页在官方 `settings.section` 里：列出条目、**还原**、**彻底清除**、**清空**（后两者要求点第二次）
- ✅ 不替换任何官方 UI：所有注册都用官方槽位 + 自己的包名命名空间 id

## 安装

### 方式一：本地 profile 部署（开发/自用）

把本目录放进 profile（例如 `~/.dsh/profiles/desktop/`），然后在 profile 的 `package.json` 里：

1. `dependencies` 加 `"dsh-session-delete": "file:./dsh-session-delete"`
2. `dsh.profile.bundles` 追加 `"dsh-session-delete"`
3. 在 profile 目录 `pnpm install`，然后重启 DSH

`cordis.patch.yml` 把插件行插进 profile 层；client 端由官方 `dsh-client-modules` 扫描 `dsh.client` 声明后自动注入浏览器。

### 方式二：从 npm 安装

```bash
pnpm add dsh-session-delete
```

并在 profile `package.json` 的 `dsh.profile.bundles` 中注册。

## 工作原理

- **client 端**（`lib/client.js`）：`window.__ModuleLoader__.load({ id, factory })` 注册为 Web 客户端插件，`apply()` 里注册三处官方槽位：
  1. `sidebar.workspaces.session.menu.item` —— 菜单行（`order: 500`）
  2. `shell.overlay` —— 确认对话框（帧级浮层，不随菜单卸载）
  3. `settings.section` —— 回收站页（`order: 60`）
- **host 端**（`lib/index.js`）：注册三条 HTTP 路由（`/dsh-session-delete/trash`、`/trash/restore`、`/trash/purge`），由 client 端经宿主自身的 HTTP 载体调用。
- **归档**走官方 `workspaces.archiveSession(sessionId, { stopActivity: true })` —— `stopActivity` 会先停掉正在跑的 Agent，这是移文件前的必要一步。

### 为什么 host 端要自己写

官方**没有**删除会话的 API：`workspaceRegistry` / `uiWorkspace` 只有 archive / unarchive / pin / unpin，`sessionPersistence` 只有 create / open / flush / stat / list，`sessions` 只有 retain / using / fork / search / scope / binding / refreshProjections。所以「归档隐藏」是官方唯一路径，**任何真的移动字节的动作都只能由本包自己的 host 半体做**。

### 为什么不用 `host.call`

`host.call(method, args)`（"Package-private JSON RPC from Client to this Package's Host half"）属于**动态定义插件**（`cordis_define`）那套的能力，不是打包插件的 `dsh.client` bundle 的通道——`host` Builtin 的可达性无法从官方文档确认，而 HTTP 载体是市场（同版本最成熟的第三方插件）48 条路由在用的路径。所以这里选后者。

## 回收站的安全边界

移入回收站**不是删除**，是 `rename`：

```
<dsh home>/sessions/<工作区>/session-<id>/                      ← 移走
<dsh home>/storages/session_projcache/sessions/session-<id>.json ← 一起移走
        ↓
<dsh home>/trash/dsh-session-delete/<时间戳>--<session-<id>>/
    ├─ session-<id>/…            会话目录原样
    ├─ session_projcache.json    投影缓存原样
    └─ trash.json                记录 sessionId / project / origin / movedAt
```

还原就是反向 `rename`，所以是**真还原**而不是近似。只有 `purge`（UI 里要求点第二次）才真正 unlink 字节。

四条守卫，都在 `lib/index.js` 里：

1. `sessionId` 先按窄字符集校验，**再**拼路径——做不出穿越形状的 id，而不是事后补救；
2. 每条路径都用 `relative()` 做包含性检查（不是字符串前缀比较：`/home/.dsh-evil` 会被前缀比较放过）；
3. 只读写 `<dsh home>` 以内；`DSH_HOME` 优先，与 `@deepseek-ai/dsh-home-paths` 同一套语义；
4. `purge` 必须带 `confirm: true`；跨源请求（`Origin` 与 `Host` 不一致）直接 403。

### 已知限制（诚实地写在这里）

**彻底清除之后，会话 id 仍留在 `storages/workspace.json` 的 `global.archivedSessionIds` 里。** 原因：「移入回收站」前会先调用官方归档（否则侧栏不会隐藏该行、运行中的 Agent 也不会停），而 `workspace.json` 的**内存态归官方 `workspaceRegistry` 所有**——在宿主运行期间改这个文件会被内存态覆盖回去。所以本插件不动它。

后果：如果官方 UI 里某处会列出已归档会话，那一行会指向一个已经没有日志的会话。**清理方法**：完全退出 DSH 后，从 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds` 里删掉那个 id，再启动。

## 发布前注意事项

### `dsh.client.inject` 是**硬门禁**

宿主会一直扣着客户端入口，直到清单里**每一个 seam 都存在**。列了一个不在宿主机组合里的名字 = 这个插件在该宿主上**永远不会加载**。市场为这条规则付过代价（issue #554：列了没用的 `@deepseek-ai/dsh-client-runtime`，结果让另一个插件无法注册命令）。

本包的清单只列**确实存在于组合里、且确实用到**的三个包：

| seam | 用途 |
|---|---|
| `@deepseek-ai/dsh-client-locale` | `ctx.locale` |
| `@deepseek-ai/dsh-client-ui-settings` | `ctx.slots` |
| `@deepseek-ai/dsh-client-ui-workspace` | `ctx.workspaces`、会话行菜单槽位 |

**不要**再加 `@deepseek-ai/dsh-client-runtime`（市场已从自己的清单里删掉；它是宿主基础设施链上的包）或 `@deepseek-ai/dsh-client-ui-slots`（它是被 runtime 内联的纯核心库，npm 清单里连 `dsh` 字段都没有，**不是客户端模块**）。

### 客户端 bundle 的文件头是发布契约

文件必须**以单行** `window.__ModuleLoader__.load({ id: "dsh-session-delete", factory: (require) => {` **开头**，且**不能有 BOM**：宿主会从文件头嗅探 loader id。同时它必须是 **classic script**（官方用 `vm.Script` 编译校验），所以 bundle 里不能出现 `import`/`export`。

### 刻意没有声明的东西

- **`peerDependencies` / `engines.dsh` 故意留空。** 宿主会按 **dsh peer range** 决定是否**跳过**整个 bundle（`hostPeerGate`；只闸 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`）。声明一个与被测宿主不匹配的区间，代价是**插件在该宿主上完全不被加载**——比不声明更糟。等你确定了目标运行时版本，再按下面这副样子加上：

  ```json
  "peerDependencies": { "@deepseek-ai/dsh": "^<你验证过的版本>" },
  "engines": { "dsh": "^<同一个版本>" }
  ```

  两者机制不同：`engines.dsh` 是**市场安装时**的前置校验（可以拒绝安装或提示强制继续），`peerDependencies` 是**宿主启动时**的跳过判定。
- **`"private"` 已移除**，`files` 已声明，`license: MIT` 已补上。

## 自测（不安装）

`tools/dry-run.mjs` 会在**系统临时目录**里搭一个暂存 profile，把本包按 profile 的样子放进去，然后跑 70 项检查——**全程不写 `~/.dsh`**，并在最后断言真实 Harness 家目录没被动过：

```bash
node tools/dry-run.mjs --composition ~/.dsh/profiles/desktop/cordis.yml
# --scratch <dir>  指定暂存根目录（拒绝落在真实家目录内）
# --keep           保留暂存目录供检查
```

覆盖：安装形态、发布契约（文件头/无 BOM/classic script/exports 可解析/patch 按包名 insert）、**inject ∩ 运行中组合清单**、客户端半体在沙箱页面里 `apply()` 与三处注册、中英字典键一致、菜单行有/无 `sessionId` 的两种渲染、host 半体的 移入/列出/还原/清除 **四条守卫全流程**、以及隔离与卸载残留。

## 尚未验证的部分

dry-run 证明的是**能静态与单元证明的一切**。它**不能**替代一次真实安装，以下三点只有装上去才知道：

1. 宿主在真实组合下是否放行该入口（inject 门禁的最终判定）；
2. `sidebar.workspaces.session.menu.item` 的 ownerProps 里 `displayTitle` 的实际取值形态；
3. `settings.section` 页面在真实设置面板里的排版。

如果宿主没有 `@deepseek-ai/dsh-client-ui-primitives` 的 `MenuItemButton`，菜单行会退化成自带样式的 `role="menuitem"` 按钮——菜单的键盘遍历读的是 DOM，所以两种形态都能被键盘走到。

## 许可证

MIT
