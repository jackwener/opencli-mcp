# Installation and configuration

For the recommended npm + Chrome Web Store installation, follow the [README quick start](../README.md#quick-start).

## What setup does

`npm install -g opencli-mcp` installs the software. `opencli-mcp setup` configures the two connections it needs:

1. **Chrome → local program:** writes the Native Messaging registration so Chrome can start the program when the extension connects.
2. **MCP client → local program:** asks you to select `claude`, `codex`, `opencode`, `pi`, or a combination when their CLIs are on your PATH. Only selected clients are configured; their `opencli-mcp` entry is set to the managed launcher. Other server entries are unchanged. Pi requires `pi-mcp-adapter`. Choose `manual` (the default) for a ready-to-copy configuration using absolute paths, or `none` to configure only the browser connection.

It then checks the live browser connection. If disconnected, it opens the Chrome Web Store and waits for the extension to connect. The extension retries automatically, so you can install it before or after running setup. Already connected? No store page is opened.

`setup` never installs an extension silently. Add it through the Chrome Web Store or from the manual-install zip in GitHub Releases. Rerunning setup updates the managed launcher. Selecting a client also replaces its `opencli-mcp` entry, so setup can repair an incorrect command.

### Setup options

In a terminal, enter client IDs separated by commas at the prompt. Press Enter to show manual configuration without modifying any client.

For scripts, select clients explicitly. Without `--clients`, non-interactive setup prints manual configuration and leaves all MCP client settings unchanged:

```bash
opencli-mcp setup --clients codex
opencli-mcp setup --clients claude,codex
opencli-mcp setup --clients opencode
opencli-mcp setup --clients pi
opencli-mcp setup --clients manual  # show configuration for any MCP client
opencli-mcp setup --clients none    # configure only the browser connection
opencli-mcp setup --no-open       # print the store link without opening it
opencli-mcp setup --wait 60       # wait up to 60 seconds (default: 180)
opencli-mcp setup --no-open --wait 0  # configure and check once without waiting
```

A timeout leaves the configuration in place: enable the extension and rerun setup. A detected client registration failure is reported as incomplete even if the browser is connected. If a selected CLI is unavailable, setup reports it before writing any configuration. In an interactive terminal, invalid input can be corrected and Ctrl+C cancels without making changes.

`opencli-mcp doctor` checks registration and the live connection without changing settings. It is for troubleshooting; it is not a required setup step.

## Stable launch entrypoint

Both Chrome and MCP clients use `~/.opencli-mcp/bin/opencli-mcp-launcher` (`.cmd` on Windows). Chrome starts the launcher in host mode; MCP clients pass `stdio`. Paths and arguments are printed by setup, so desktop apps do not need your terminal's npm `PATH`.

Setup records the Node executable and package entry in `~/.opencli-mcp/installation.json` and generates the launcher from that record. Treat both as setup-managed files. Doctor checks the runtime, program entry, launcher, browser registration, and live connection separately. A running host does not hide missing files needed at the next start.

For Homebrew installations, setup uses the corresponding formula's stable `opt` path when it resolves to the current file. This applies to both Node and the package entry. Other installations use their current absolute paths. The launcher does not search version managers, download Node, or fetch an npm package on startup.

## OpenCode

Run `opencli-mcp setup --clients opencode`. Setup adds a local MCP server to your global OpenCode config (`~/.config/opencode/opencode.json`, or `opencode.jsonc` if that is your existing file). It updates the `opencli-mcp` entry while preserving comments outside that entry and other settings. Restart OpenCode, then use `opencode mcp list` to check the connection. The launcher path is absolute, so OpenCode does not need your terminal's npm `PATH`.

## DeepSeek Harness (dsh)

After installing the Chrome extension and `opencli-mcp` globally, connect the browser without configuring another MCP client, then add the dsh bundle to your active profile:

```bash
opencli-mcp setup --clients none
dsh plugin --profile web add opencli-mcp
```

Restart `dsh web`. The main package's bundle inserts one `@deepseek-ai/dsh-mcp-client` entry using the launcher created by setup, so dsh discovers the same MCP tools without depending on npm's `PATH`. Set `OPENCLI_MCP_BIN` only if you need a different executable. To remove the dsh registration, run `dsh plugin --profile web remove opencli-mcp`. Replace `web` with your active dsh profile when needed.

## Pi

Pi does not include an MCP client. Install the community [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter), then select Pi in setup:

```bash
pi install npm:pi-mcp-adapter
opencli-mcp setup --clients pi
```

Restart Pi. Setup adds one entry to Pi's own global `mcp.json` (normally `~/.pi/agent/mcp.json`) using absolute paths, without changing other servers. Use the adapter's `mcp` tool to discover and call browser tools.

## Other Chromium browsers

Setup recognizes Chrome, Chromium, Edge, and Brave on macOS and Linux, plus Chrome Beta, Canary, Chrome for Testing, and Arc on macOS. On Windows it registers the Chrome Native Messaging host. Extension availability depends on the browser.

Chrome is registered even before its first launch. Other browsers are detected from their existing profile directories, or can be selected explicitly:

```bash
opencli-mcp setup --browsers edge --no-open
```

Install the extension in that browser. For a browser launched with a custom user data directory:

```bash
opencli-mcp setup --user-data-dir /absolute/path/to/profile
```

Setup also detects running custom profiles on macOS and Linux.

## From source

```bash
git clone https://github.com/jackwener/opencli-mcp.git
cd opencli-mcp
npm install
node dist/src/main.js setup
```

`npm install` runs the build through `prepare`. The same setup flow works with the Web Store extension. For manual MCP client configuration, use the absolute paths printed by setup.

### Developing the extension

Only extension developers need an unpacked build:

1. Run `node dist/src/main.js extension-path` to find the built extension directory.
2. In `chrome://extensions`, enable **Developer mode**, disable the store extension if installed, and **Load unpacked** from that directory.
3. Run `node dist/src/main.js setup --no-open` to configure and verify the connection.

The development manifest uses the published extension's key, so it has the same ID. Use one build at a time. After changing extension code, run `npm run build:ext` and click **Reload** in Chrome.

## Manual extension installation

Starting with v0.0.20, each [GitHub Release](https://github.com/jackwener/opencli-mcp/releases) includes `opencli-mcp-extension-manual-install-<extension-version>.zip`. The extension version is separate from the npm package version.

1. Download and extract the zip. Select the extracted directory containing `manifest.json`; Chrome cannot load the zip directly.
2. In `chrome://extensions`, enable **Developer mode**. Disable the Web Store copy if present, then choose **Load unpacked** and select that directory.
3. Run `opencli-mcp setup --no-open` and `opencli-mcp doctor` to verify the connection.

Keep the extracted directory in place while using the extension. For an update, extract the newer zip to a stable directory and reload the extension in Chrome. The manual zip includes `manifest.key`, so Chrome uses the same extension ID as the Web Store copy. Do not use the separate Web Store upload zip with **Load unpacked**.

## From a release tarball

Download a package from [GitHub Releases](https://github.com/jackwener/opencli-mcp/releases), then run:

```bash
npm install -g ./opencli-mcp-<version>.tgz
opencli-mcp setup
```

Install the Chrome extension from the Web Store or use the manual-install zip above.

## Updating

```bash
npm install -g opencli-mcp@latest
opencli-mcp setup
```

Homebrew upgrades within the same formula normally need no configuration change: the `opt` path follows the installed version. This assumes the package is still installed at its recorded location. Switching formulas (for example, `node@22` to `node@24`), switching version managers, moving the source checkout, or losing the global npm package requires installing the package under the chosen runtime and rerunning setup. Existing clients using the managed launcher keep the same command.

When configuring a client for the first time with the managed launcher, select it explicitly, for example `opencli-mcp setup --clients claude,codex`. For other clients, copy the configuration printed by `--clients manual`.

Chrome updates the store extension independently. If the old host is still running, disable and re-enable the extension to start the updated program, then reconnect the MCP client. Use `doctor` to check both the live connection and the files needed for the next startup.

## Remote clients

The host serves Streamable HTTP at `http://127.0.0.1:19991/mcp`. Configure the client with:

```text
Authorization: Bearer <contents of ~/.opencli-mcp/token>
X-OpenCLI-Session-ID: <a stable random UUID for this client connection>
```

Each direct HTTP client needs its own `X-OpenCLI-Session-ID`; requests from the same client reuse that value. The stdio launcher creates it automatically. When a direct client is done, send `DELETE /session` with the same two headers to finalize its browser tabs. `session_finalize` also closes or releases tabs at the end of a task.

For access from another machine, use an authenticated tunnel, such as SSH, cloudflared, or ngrok with authentication, and point the client at the tunneled `/mcp` endpoint. Keep bearer authentication enabled and treat the token as a secret. Chrome and the extension must stay running on the host machine.

## Configuration

Settings live in `~/.opencli-mcp/config.json`. For example:

```json
{
  "port": 19991,
  "cursor": true,
  "sites": ["twitter", "reddit"],
  "sitesWrite": []
}
```

| Setting | Effect |
|---|---|
| `port` | Local HTTP port; default `19991` |
| `cursor` | Show the agent cursor overlay |
| `sites` | Site commands to enable at startup, read-only |
| `sitesWrite` | Sites whose write commands should also be enabled |

The same state directory contains the HTTP token, `run/host.json`, and user-defined adapters under `adapters/<site>/<name>.js`.

## Troubleshooting

Run `opencli-mcp doctor` first. It reports startup dependencies, browser registration, and whether the local host and extension are connected, with recovery steps for failures. Use `doctor --json` for machine-readable diagnostics.

| Symptom | What to check |
|---|---|
| `browser_unavailable` or host unreachable | Keep Chrome running, enable the extension, and verify the host registration |
| Web Store extension cannot connect | Run `opencli-mcp setup`; if it stays disconnected, disable and re-enable the extension |
| No host manifest was written | Rerun `setup`; for custom profiles, pass `--user-data-dir` |
| Node runtime or program entry missing | Install Node/package as needed, then run `opencli-mcp setup`; select clients if their commands also need repair |
| MCP client cannot find `opencli-mcp` | Use the absolute executable path in the client configuration |
| Development changes do not appear | Rebuild the extension and click **Reload** on the extensions page |

For runtime errors such as `dialog_open` or stale tabs, see [browser troubleshooting](troubleshooting.md) and [error codes](errors.md).
