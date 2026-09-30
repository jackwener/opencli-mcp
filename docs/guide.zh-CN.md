# opencli-mcp 中文指南

opencli-mcp 是一个连接到真实 Chrome 的 MCP browser service。Chrome extension 负责 tab、CDP 和页面操作；本地 host 把这些能力提供给 MCP client。site Adapter 是建立在同一个 browser API 之上的可选能力，用来封装经过验证的站点操作。

## 安装

需要 Node.js 22+、Google Chrome 和一个 MCP client。

1. 从 [Chrome Web Store](https://chromewebstore.google.com/detail/opencli-mcp/lnaoghmfcdnbhgcihkakfobckmfhllkg) 安装 extension。
2. 在终端运行 `npm install -g opencli-mcp`，然后运行 `opencli-mcp setup`。
3. 按提示选择要配置的 MCP client。重启或重新连接 client 后即可使用。`opencli-mcp doctor` 只检查启动依赖与连接状态，不修改配置。

`setup` 注册 Chrome Native Messaging host，按你的选择配置 MCP client，并等待 extension 连接。所选 client 的 `opencli-mcp` entry 会更新为固定的 launcher 路径，其他 server entry 保持不变。Homebrew 同一 formula 内升级时，launcher 使用稳定的 `opt` 路径；切换 Node 安装或移动 package 后，重新运行 setup 即可更新启动路径。它不会自动安装 extension。详细选项与排障步骤见 [安装说明](setup.md)。

使用 DeepSeek Harness (`dsh`) 时，先运行 `opencli-mcp setup --clients none`，再运行 `dsh plugin --profile web add opencli-mcp`。主包内的 bundle 通过 dsh 自带的 MCP client 接入 browser service；具体说明见 [dsh 安装步骤](setup.md#deepseek-harness-dsh)。

使用 OpenCode 时，运行 `opencli-mcp setup --clients opencode`；使用 Pi 时，先安装 `pi-mcp-adapter`，再运行 `opencli-mcp setup --clients pi`。具体见 [OpenCode 与 Pi 安装步骤](setup.md#opencode)。

## Browser 工作流

以 `js` 为 browser 的主要入口。用 `let tab = await browser.tabs.new(url)` 打开新 tab，或用 `await browser.user.openTabs({query:"…"})` 找到现有 tab，再用 `let tab = await browser.user.claimTab({tabId})` 接管。随后按 **observe → act → verify** 工作：

- `tab.observe` 给出可访问性快照和 `eN` 引用；`tab.read` 读取长文档的线性文本。
- `tab.act` 等待目标可操作、定位、执行真实输入并等待页面稳定。所有 API 方法都用 `await`；变量、function 和 class 跨调用保留。
- `tab.expect` 轮询你要确认的结果。页面变化后重新 observe，不要沿用旧引用。
- 如果 `tab.act` 返回 `openedTabs`，可直接使用其中的 `tab`；若为 `pending:true`，稍后用数字 `tabId` 在 `browser.tabs.list()` 中找到它。下载时把 `download.afterSequence` 传给 `tab.download`，确认文件是否完成。

完成后调用 `session_finalize`。没有保留的 agent tab 会关闭；已接管的 user tab 会释放。需要把新 tab 留给用户时标记为 `deliverable`，需要供后续回合继续接管时标记为 `handoff`。也可用 `tab.release` 保留单个 tab，或用 `tab.close` 明确关闭。详见 [tab 生命周期](tab-lifecycle.md)。

## Site Adapter

内置 Adapter 覆盖 Twitter/X、Bilibili 和 Reddit。`sites_search` 查找命令和参数，`site_run` 直接执行；在 `js` 中可用 `await sites.enable('reddit')` 暴露该站的动态工具。Adapter 与交互式 browser 操作使用同一个 `Tab` API 和当前 Chrome 登录状态。

创建自己的 Adapter 时，先用 `tab.network.list()/detail()` 和 `recon.discover(tab)` 找候选 API，再验证鉴权、参数、分页及错误行为。`tools.define` 创建不会立即生效的 draft；用 `tools.try` 传入真实参数和结果断言验证，通过后用 `tools.activate` 发布。系统不会根据一次操作轨迹猜测并生成永久工具。详见 [Adapter 指南](define-tools.md)。

## 架构与开发

```text
MCP client → stdio launcher → local host ⇄ Chrome extension → website
                                   Native Messaging
```

host 由 Chrome 通过 Native Messaging 启动；extension 管理 tab lease、CDP 附着和虚拟光标。每个 MCP client 使用独立的 tab 与 JavaScript session，避免相互清理。`src/api/` 是 browser object model，`src/mcp/` 暴露 MCP tools 与 `js`，`src/sites/` 加载和执行 Adapter。

开发构建与测试命令见 [README](../README.md#development)。Browser 操作的错误代码见 [错误说明](errors.md)，`js` API 见 [生成的参考](api-reference.md)。
