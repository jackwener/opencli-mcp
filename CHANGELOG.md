# Changelog

## 0.0.26 — 2026-09-30

- Unify element refs across ARIA, DOM, find and actions, with document/frame-scoped identity and actionable stale-ref errors.
- Resolve ARIA refs through the producing engine; prevent unregistered refs and large-capture eviction, and correctly handle quoted snapshot names.
- Clarify persistent REPL output directly in MCP guidance and diagnostics; preserve standard JavaScript semantics and bindings.
- Keep native host and MCP launchers working across Node upgrades, with installation and startup diagnostics.
- Read X search from observed UI evidence and improve Windows browser-connection recovery guidance.
- Ship Chrome extension 0.0.19; update the extension to receive the browser-side ref fixes.

## 0.0.25 — 2026-09-28

- Fix JavaScript execution on Node 26 while retaining Node 22+ support, using one V8 Inspector REPL implementation across Node 22, 24 and 26.
- Preserve bindings after ordinary errors, correctly report falsy exceptions, and support redeclaring top-level bindings across calls.
- Drain dispatched API work within the call timeout; handle unobserved RPC failures and prevent late callbacks from affecting later calls.
- Validate persistent JavaScript execution through the native host and MCP, with Node 22/24/26 release checks.
- Chrome extension remains at 0.0.18; this release changes the local host only.

## 0.0.24 — 2026-09-28

- Expose native Chrome APIs with on-demand signatures, direct CDP commands, and bounded event streams in the REPL.
- Support writable Main World evaluation with frame targeting and explicit uncertain outcomes without replaying dispatched commands.
- Add page console and extension log capture, and improve native tab/window ownership and session cleanup.
- Add frame-aware ARIA/DOM observations and exact DOM reads across nested and cross-origin frames.
- Ship Chrome extension 0.0.18 with updated runtime documentation and Chrome API reference attribution.

## 0.0.23 — 2026-09-28

- Make js the primary browser workspace with seven default MCP tools; browser actions and adapter authoring use the shared object API.
- Use a persistent Node REPL for variables, functions, classes and top-level await, with interruptible worker execution and explicit timeout/reset/cancellation outcomes.
- Return compact browser handles, bounded output and MCP images, and expose focused API documentation directly through docs_get.
- Keep the adapter draft → trial → activation lifecycle and preserve action validation at the object API boundary.
- Fix live Chrome tab identity and adapter capture during initial navigation; report host/extension protocol drift as a warning.
- Bundle Chrome extension 0.0.17.

Migration: typed browser and adapter-authoring tools have been removed. Use js with browser, tab, tools and recon; use docs_get without arguments for the quickstart. Await every API call. Reset or timeout clears JavaScript bindings but does not undo already dispatched browser operations.

## 0.0.22 — 2026-09-25

- feat: include LinkedIn connection count in profile analytics
- feat: complete API-backed social adapters
- feat: add more LinkedIn API adapters and recover stale adapter tabs
- feat: expand API-backed Facebook and LinkedIn adapters
- feat: add API-backed Gmail Facebook LinkedIn and Discord adapters
- test: keep only critical regression checks

## 0.0.21 — 2026-09-25

- test: use current protocol in setup smoke
- test: trim redundant regression coverage
- chore: bump Chrome extension to 0.0.16
- Improve browser action continuation and protocol clarity
- Improve popup and download action evidence
- Improve agent tab claiming and batch cleanup

## 0.0.20 — 2026-09-25

- release: add manual extension asset and bump extension to 0.0.15
- fix: reuse initial tabs in new browser windows

## 0.0.19 — 2026-09-24

- chore: bump Chrome extension to 0.0.14
- feat: improve MCP browser evidence and agent-facing contracts
- test: focus suite on core agent and browser flows
- ci: automate npm and GitHub releases
- feat: make adapter authoring evidence-driven and runtime-aware

## 0.0.18 — 2026-09-24

- Make site capabilities browsable without a search term and return actionable metadata after defining an adapter. Validate replacements before installing them, refresh discovery and typed tool schemas when definitions change, and reject unknown or malformed command arguments.
- Load the JavaScript API reference on demand instead of attaching it to the first `js` result. Keep the result envelope first, isolate concurrent call output, and update MCP guidance and connection documentation.
- Serialize adapter workflows sharing a site tab. Stop replaying tool calls after a host disconnect; report uncertain outcomes from interrupted or timed-out operations so agents can inspect state before retrying.

## 0.0.17 — 2026-09-24

- Export the adapter SDK directly from the main package as `opencli-mcp/adapter-sdk`. Built-in and user-defined adapters now use the same package path without a separate bundled SDK dependency.

## 0.0.16 — 2026-09-24

- Keep the stdio MCP connection available when Chrome is not running yet. Core tools, docs, and prompts remain discoverable; tool calls report `host_unavailable` until the Chrome host connects. Notify MCP clients when the host appears or changes so they can refresh site tools.
- Include the Apache-2.0 license in the bundled adapter SDK and align its package metadata with the main package.

## 0.0.15 — 2026-09-24

- Add OpenCode to the client choices in `setup`, preserving existing JSONC config and MCP entries.
- Add Pi to the client choices in `setup` through `pi-mcp-adapter`, preserving other Pi MCP servers.

## 0.0.14 — 2026-09-24

- Let DeepSeek Harness install `opencli-mcp` directly as a bundle. Bundle the local adapter SDK in the npm tarball so pnpm can install the main package without resolving a source-tree `file:` dependency.
- Retire the separate `dsh-plugin-opencli-mcp` package and document one-package setup.

## 0.0.13 — 2026-09-24

- Center the product on one Chrome-backed browser service: remove the embedded stdio runtime, standalone `serve` path, and browser-free adapter mode. The launcher requires a connected Chrome host, and adapters use that same browser connection.
- Remove trace-based tool compilation and its stored evidence. Adapters are explicit functions that must be verified before use; keep network inspection and endpoint discovery as browser capabilities. Update MCP guidance and remove the obsolete embedded smoke test.
- Remove unused favicon-badge hooks, protocol-version and context IDs, ignored adapter options, dead CLI flags, and misleading resource-change notifications for tab events. Restore idle cleanup timers after a service-worker restart, and require bearer tokens in headers rather than URL query strings.
- Redesign the virtual cursor with a compact rounded pointer, blue glow, curved long moves, and reduced-motion support. Interrupted moves now report that they did not arrive.
- Give each MCP client its own browser and JavaScript session. Local stdio launchers create a session ID automatically and clean up on disconnect; direct HTTP clients provide `X-OpenCLI-Session-ID`.
- Clean up tabs when opening fails, and keep tab leases if releasing cannot finish. Closing a tab already removed by Chrome is treated as complete.
- Persist command journal snapshots before executing and before replying, so a retried write cannot silently run twice after a service-worker restart when session storage is available.
- Make browser tab ownership explicit: operations no longer create a tab or adopt an unknown page implicitly. Add searchable `tab_list` discovery with bounded user-tab results and expose tab origin/state.
- Separate `tab_release` / `tab.release()` (leave open) from `tab_close` / `tab.close()` (close), for both agent-created and claimed tabs. Session cleanup reports failed tab closures and leaves their leases available for retry.
- Serialize extension lease persistence to prevent out-of-order state writes. Allow long document reads to continue with `nextStart` and `start`.

## 0.0.12 — 2026-09-23

- Add `tab_read` / `tab.read()` for bounded document text, including lazy content, deduplication, and scroll restoration.
- Collapse large accessibility snapshots into an action map and allow expanding a branch by ref.
- Detect clicks that never reach the page and support explicit `method:"dom"` for single-click activation; real mouse input remains the default.

- Remove the unused OpenCLI CLI dependency tree, legacy page wrappers and CLI argument filtering; use the adapter SDK argument type throughout. Keep only runtime docs in the npm package, clean build output before compilation, and remove historical release artifacts, obsolete design drafts and scripts. Remove unused extension transport operations and error-code compatibility mapping; adapters emit native error codes.

- Remove origin and write-approval policies. Site commands and WebMCP calls execute directly without confirmation prompts; remove policy configuration, `session.allowOrigin`, and confirmation arguments.

## 0.0.11 — 2026-09-23

- Reject ambiguous browser actions and missing action values before execution. Return full snapshots by default, with diff available explicitly.
- Include complete argument metadata in site search and validate site arguments before write approval.
- Update adapter-definition guidance and Chrome Web Store installation documentation.

- Let users select which MCP clients `setup` configures. Interactive setup defaults to manual configuration; scripts use `--clients claude,codex`, `manual`, or `none`. Unselected clients are left untouched and cancelling the prompt makes no changes.

- Make `setup` the single connection-configuration command: register the browser host and selected MCP client CLIs, guide Chrome Web Store installation only when disconnected, and verify the live connection. Existing MCP client settings are preserved; failed registrations are reported as incomplete.
- Remove the separate `install` command. Native Messaging registration is internal to `setup`, with no extension ID or unpacked assets required for normal use.
- Make `doctor` a read-only, human-readable connection check (`--json` for structured output). Diagnose missing or invalid registrations instead of checking local extension build artifacts.
- Keep unpacked extension loading in the developer guide. Add isolated setup E2E coverage for registration, reruns, repair, Native Messaging, and MCP connectivity.

## 0.0.10 — 2026-09-20

- **Fix: `SyntaxError: Illegal return statement` on any fetchJson-based adapter** (e.g. `sites.twitter.bookmarks()`).
  `evaluateWithArgs` built a bare `{ …return… }` block, but the page evaluates the string via CDP `Runtime.evaluate`
  as a script, where a top-level `return` is illegal. It now emits an async IIFE. (Extension unchanged — stays 0.0.9.)

## 0.0.9 — 2026-09-20

- **New adapter architecture — path-addressed, self-describing modules over a source loader.** An adapter is now just a
  file `adapters/<site>/<command>.js` that `export default defineAdapter({ description, access, args, run })`; the file
  path is its identity and the module is its definition. There is no manifest and no global registry: a `SourceLoader`
  lists adapters by directory, imports them on demand, and keeps a small mtime-keyed index for search. Sources are an
  ordered list (built-in `adapters/` + the user's `~/.opencli-mcp/adapters/`), a later source overriding an earlier one
  — so built-in adapters and `tools.define` outputs are one mechanism.
- **The adapter interface is the agent's own object model.** `run(ctx)` receives `{ tab, args, sites, recon }` — the same
  surface an agent drives in the `js` tool. No CDP shadow page, no pipeline DSL, no columns, `access` is the only safety
  field, args are snake_case, and paging is `{ rows, nextCursor }`.
- **`@opencli-mcp/adapter-sdk`** carries the contract (defineAdapter + errors + the tab interface), so the corpus is
  separable and independently versionable.
- **Curated built-in adapters, all API-first (never DOM when an API exists):** twitter (44 commands),
  bilibili (20, incl. WBI signing), reddit (20). Writes go through each site's API and the runtime's approval flow.
- Removed the vendored OpenCLI command corpus and the CLI-projection layer (archived on branch corpus-archive-2026-09-19).

## 0.0.8 — 2026-09-19

- **The client channel survives host restarts (fix "Transport closed").** The Chrome-spawned host dies whenever the
  extension's Native port drops (an extension reload/update, a crash, or the service worker being replaced). The stdio
  launcher used to exit on that drop, permanently killing the client's MCP channel (Codex/Claude don't auto-reconnect a
  dead server). The launcher now keeps the channel up and reconnects to the host on demand — re-reading the fresh
  port/token a respawned host writes — and returns a retryable `host_unavailable` while the host is briefly down.
  Combined with the extension's existing auto-reconnect, the channel self-heals after a reload instead of going
  "Transport closed". See docs/design/host-resilience-2026-09-19.md for the architecture review behind this.

## 0.0.7 — 2026-09-19

- **Fix a CSP error on strict sites.** The favicon-badge feature rewrote the page favicon to a `data:` SVG, which pages
  with a strict `img-src` CSP (e.g. Hacker News) block — logging a Content-Security-Policy violation from the content
  script on every such page. Removed the favicon badge (it was decorative; agent tabs are marked by the named tab group
  and the cursor overlay). Reload the extension to clear existing errors.

## 0.0.6 — 2026-09-19

- **We own the site corpus.** The OpenCLI adapter corpus (1387 adapters + manifest) and its runtime are vendored into
  `vendor/opencli/` and consumed via a local `file:` dependency — git-tracked and editable, no pull from upstream.
- **One engine, no shadow.** `ExtensionPage` no longer extends OpenCLI's `CDPBasePage`; every adapter now runs on the
  single Playwright injected-script engine (the second locator/AX engine is gone). The corpus-used methods (wait,
  autoScroll, interceptors, fetchJson, snapshot→aria, …) are served on our transport.
- **Agent-friendly output formats.** One result envelope everywhere — `{ok:true,…}` / `{ok:false,error:{code,message,
  hint?,…}}` with an in-band `ok`; `js` errors now carry the same branchable envelope; `tab_act` returns only what
  changes the next move (full telemetry stays in the trace); every actionable error carries a next-step hint; results
  are compact JSON and no longer double-sent as structuredContent.
- **Leaner startup.** The always-on instructions bundle is ~21% smaller (mechanics moved to on-demand docs; safety
  de-duplicated; the site catalogue is now a lookup doc) with no capability or safety content lost.
- **New icon.**

## 0.0.5 — 2026-09-19

- **MCP 2026-07-28 (v2 SDK).** Migrated to `@modelcontextprotocol/server`/`core`/`client`/`node` 2.0.0: stateless HTTP
  via `createMcpHandler`, subscription-bus list-changed notifications, output schemas, and tool icons.
- **Native confirmations via MRTR.** Human-in-the-loop for write site commands now uses `input_required`
  (multi-round-trip): the tool call pauses, the client collects the user's approval, and it resumes — one handler serves
  both protocol eras. Replaces the elicitation path that threw under 2026-07-28.
- **Progress & cancellation** are forwarded again through the stdio launcher for long browser ops (and restored for
  site commands).
- **Signer/replay hook for signed endpoints.** `tab.cookie(name)` reads a per-request token at replay; `tools_compile`
  re-reads csrf/xsrf headers from the cookie automatically and names computed signatures (wbi, x-s) in a warning instead
  of freezing dead values.
- **One error vocabulary.** Corpus/adapter error codes are normalized to the object model's lowercase families, so a
  model branches on a single vocabulary.
- **Leaner by design.** Removed dead/over-built machinery found in a first-principles audit: the unused docs-gating
  subsystem, a recon secret scanner, the single-browser "fleet" API, dead tab-mark methods, an unused hooks system, and
  stealth injection on every navigation (a no-op driving the user's own Chrome). Recon no longer runs as a hidden side
  effect of reading network requests; docs are memoized; the cursor overlay never blocks input; the write policy is
  in-memory only.

## 0.0.4 — 2026-09-18

- **API-first freezing.** Every session tab is captured from attach; `tools_compile` freezes the JSON request that
  actually carried the data (method, contract headers and body, inputs parameterized; per-request tokens and credentials
  are named, not frozen) instead of scraping the DOM, and falls back to UI steps with an explanation. `recon.discover`
  candidates are returned by `tab.network.read()` by default. Captured evidence lives in its own bounded store, never in
  the step trace.
- **Stable observe refs.** `eN` refs are pinned to the element and survive a node inserted above them, so a held ref does
  not break and the diff stays clean.
- **One transport.** Local and remote clients use the same loopback HTTP endpoint with a bearer token; default port 19991.
- **One-command, client-agnostic setup.** `opencli-mcp setup` writes the host manifest, registers with Claude Code and
  Codex when their CLIs are present, prints the standard config for any other client, and opens `chrome://extensions`.
- **New extension icon.**
- **Hardening (architecture review).** Frozen-tool code generation is injection-safe; the network dedup key is stable and
  bounded; the stable-ref map is pruned everywhere; harvesting can never fail a step; the site executor reads the error
  envelope at its real shape; dead fields and stale docs removed.

## 0.0.3 — 2026-09-18

- The extension ID is fixed by the project: the public key lives in `extension/manifest.json`, so the ID is
  `bpjiolaihhdecffckoljgckkcbglbpih` on every machine (and will stay so on the Chrome Web Store). The per-machine key
  file, manifest patching and build-time key preservation are gone. Releases ship an extension zip that can be loaded
  from anywhere.
- `setup` prints the standard MCP configuration for any client instead of registering with one.
- Default port 19991; local and remote clients use the same loopback HTTP endpoint with a bearer token.

## 0.0.2 — 2026-09-18

- `opencli-mcp setup`: the first run in one command — writes the host manifests and the stable extension key, prints
  the MCP configuration any client accepts (stdio command, or the HTTP endpoint and token location), opens
  chrome://extensions with the unpacked-extension path on the clipboard, and waits until the extension connects.
- One home: the `OPENCLI_MCP_HOME` / `OPENCLI_MCP_TOOLS_DIR` overrides are gone; state is `~/.opencli-mcp`, defined
  tools live in `~/.opencli-mcp/tools`, the extension build keeps the key from the existing dist manifest.
- Chinese project guide `docs/guide.zh-CN.md` (architecture, install, hosting, usage, lifecycle, freezing flows,
  configuration, troubleshooting, development and release).
- README: stale `css` target and `session.name()` mentions removed.

## 0.0.1 — 2026-09-18

First release. opencli-mcp is an MCP-native browser runtime for your logged-in Chrome: a Chrome-spawned native host
plus an MV3 extension, driven by agents through one object model.

**Browser operation, step by step (Codex-style)**
- One engine: Playwright's injected script runs in the extension's isolated world; observe refs (`eN`), `find`, `act`,
  site adapters and frozen tools all resolve targets through it.
- `tab.observe`: accessibility snapshot with `[ref=eN]` refs, semantic diff against the previous observe, viewport
  filter, focused element, credential redaction.
- `tab.act`: wait + act in one call — strict resolution (several matches only when one is visible), actionability
  states, scroll into view, hit-test, real CDP mouse/keyboard input, navigation wait, settle. `within` scoping,
  frame chains (same-origin, srcdoc and cross-origin OOPIF), native dialogs, console and network capture, downloads,
  file uploads through the file chooser.
- Tabs are the user's: claim by id/url/title (fail-closed), agent tab groups, cursor overlay and badges, `finalize`
  with `deliverable` / `handoff`, automatic finalize on session end; handoff tabs can be claimed back later.
- `js` code mode over the full object model (`agent.browsers`, `browser.tabs/user/capabilities`, `tab.*`, `sites`,
  `recon`, `tools`, `session`), plus a small set of typed entry tools. The API reference is generated from the
  TypeScript declarations and shipped in `browser.documentation()`.

**Freezing explored flows into tools**
- `tools.define` takes the function you just ran in `js`; `tools_compile` drafts one from the session trace —
  network-first (`tab.fetchJson`), else `tab.goto/act/expect` with the locator intent you used and the checkpoints
  you asserted; one-time refs and structural CSS are reported in `warnings`.
- Frozen tools run on the same object model and fail with structured `error.details` (step, label, state, expect).
- The OpenCLI site corpus (1200+ commands) is available through `sites.<site>.<command>()` and `site_run`.

**Hosting**
- stdio launcher for Claude Code / Cursor / Claude Desktop; loopback Streamable HTTP with a bearer token for cloud
  agents; `install` writes the Native Messaging manifest and a stable extension key; `doctor` checks the chain.
- One error model everywhere: `code`, `message`, `hint`, structured data (`docs/errors.md`).
