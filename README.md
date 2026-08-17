# 会话删除（dsh-session-delete）

一个 DeepSeek Harness Web 插件：在**会话头部右侧**（"Session log" 导出按钮旁边）添加一个**悬停显现的红色垃圾桶按钮**，点击后**二次确认**删除当前会话。

删除走官方 `workspaces.archiveSession` 客户端 API：会话会被持久化归档隐藏（从侧边栏会话列表移除），若删除的是当前会话还会自动清除当前选中、回到新建会话界面。

## 功能

- ✅ 会话头部右侧红色垃圾桶按钮，悬停显现（半透明 → 全亮红 + 高亮背景），与头部其他图标按钮交互一致
- ✅ 点击弹出二次确认对话框（中文/英文跟随界面语言）
- ✅ 确认后调用官方归档 API 删除会话，删除中显示"正在删除…"，失败显示错误信息
- ✅ 无 host 端副作用、不替换任何官方 UI，卸载即完全移除

## 安装

### 方式一：本地 profile 部署（推荐开发/自用）

把本目录放入你的 profile（例如 `C:\Users\<你>\.dsh\profiles\web\`），然后在 profile 的 `package.json` 中：

1. 在 `dependencies` 添加：

   ```json
   "dsh-session-delete": "file:./dsh-session-delete"
   ```

2. 在 `dsh.profile.bundles` 数组追加：

   ```json
   "dsh-session-delete"
   ```

3. 在 profile 目录运行安装并重启 Web：

   ```bash
   pnpm install
   # 重启 dsh web 服务
   ```

> `cordis.patch.yml` 会把插件行插入 profile 层；client 端由 `dsh-client-modules` 扫描 `dsh.client` 声明自动注入浏览器。

### 方式二：从 npm / Git 安装

```bash
pnpm add dsh-session-delete
# 并在 profile package.json 的 dsh.profile.bundles 中注册
```

## 工作原理

- **client 端**（`lib/client.js`）：以 `window.__ModuleLoader__.load` 注册为 Web 客户端插件，注入 `conversation.session.header.utilities` 槽位（会话级、右对齐工具区），`order: 100` 使其显示在 "Session log" 之后。
- **删除动作**：点击确认后调用 `ctx.workspaces.archiveSession(sessionId)` —— 官方客户端 API，映射到 host 的 `workspaceRegistry.archiveSession`，持久化归档 + 通过 `host/archived-sessions-changed` 帧即时同步 UI。

## 位置说明

侧边栏会话行上的 ⋯ 菜单是产品内置组件硬编码的，**没有给插件留槽位**，因此删除按钮放在会话头部右侧的官方可扩展槽位（`conversation.session.header.utilities`）——这是唯一安全、不遮蔽官方 UI 的会话级入口。

## 许可证

MIT
