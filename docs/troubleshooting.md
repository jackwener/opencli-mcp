## Troubleshooting the browser bridge

- `host_unavailable`: the stdio MCP connection stays open, but the Chrome-owned host is not reachable yet. Open Chrome with the extension enabled and retry the same tool call; restarting the MCP client is unnecessary. Run `opencli-mcp doctor` if it stays unavailable.
- `browser_unavailable`: no extension connected. Run `doctor`. Chrome must be running with the opencli-mcp extension enabled; the runtime is spawned by Chrome through Native Messaging (`opencli-mcp setup` configures the browser connection).
- A protocol revision warning in `doctor` does not block the browser. The host uses the extension's advertised capabilities and tries core commands; update the extension only if the operation you need fails or is unavailable.
- `dialog_open`: a native JavaScript dialog is blocking the tab. `tab.dialog.get()/accept()/dismiss()` (in `js`) read and answer it. `no_dialog`: nothing is pending (dialogs are tracked only while the debugger is attached, so one opened before the first command may need a first `tab_observe` to surface).
- Empty tab lists after finalize are normal. A missing/stale tab does not mean the browser disconnected: open or claim a fresh tab.
