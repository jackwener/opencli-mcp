## How to act on a page

The core loop and the discipline that makes it reliable. Use `js` and await every API method. Exact signatures are available through `docs_get {name:"api-reference",member:"Tab.act"}`; error families are in `errors`.

1. **Loop:** `browser.tabs.new` (or `browser.user.claimTab` a tab the user already has) → `tab.observe` → `tab.act` → `tab.observe`. One
   `tab.act` call does everything (waits for actionable, scrolls, hit-tests, dispatches real input, settles).
2. **Locators come from the latest observe — never guess one.** Use a `{ref:"..."}` from the last observe, or a
   role/name/label/text/testid you can read there. `tab.act` is strict: exactly one visible match acts; several fail
   with `selector_ambiguous` (no `nth`/first shortcut through ambiguity). Scope generic labels (Close, Search, Add to
   cart, S/M/L) with `within` (a container's selector or its observed ref). After a strict failure, observe or `find` again —
   never retry the same target unchanged. `tab.find(target)` (in `js`) runs the same engine; pass an entry's `selector`
   back to act on that exact element. Durability order: `testid` → stable `id`/`data-*` → stable `href` → `role`+`name`
   → `label` → `text` → structural css.
3. **Refs identify Elements in one document/frame.** Copy them unchanged. The same living Element keeps its ref across observations; replacement, navigation or engine reset invalidates it. On `stale_ref`, observe again in the intended frame. A ref never automatically resolves to a replacement Element.
4. **Branch on `error.code`, never message text.** Full families and what to do for each are in the `errors` doc.
5. **iframes:** add `frame` to the target — `{frame:"#checkout", role:"button", name:"Pay"}`, `frame:0`, or a chain
   outermost-first `frame:["#checkout", 0]` / `"#checkout >> iframe.card"`. Same-origin, data:/srcdoc, and cross-origin
   are entered the same way. `observe()` includes child observations in `frames`, each with a reusable `frame` path and local refs. Copy that path into `target.frame` for `find/read/act` or `frame` for `observe/read`. `framesComplete:false` and `unavailable` identify a failed or bounded child capture. Observe that frame directly to retry; `includeFrames:false` limits observation to the selected document. Observations never scroll iframe owners.
6. **Don't re-`goto` a URL the tab is already on** (it reloads and loses form state); use `await tab.act({action:"reload"})`
   when a reload is intended.
7. **`tab.evaluate(script, {arg, frame, timeoutMs})` runs in page Main World and can read or modify it.** Functions receive only `arg`, not host closures. Results must be serializable data. Prefer `tab.act()` for ordinary input and its verification. Dispatched scripts are never replayed; a timeout does not cancel page code.
8. **Choose the data path for the task.** For a reusable adapter, start from the UI behavior and inspect the request that carried the data. Every session tab captures from attach: `tab.network.list()` returns compact request summaries; detail by `seq` returns headers and a bounded request or response body. Continue with `body.nextStart` when needed. In `js`, use `tab.network.list()` and `tab.network.detail({seq})`. `recon.discover(tab)` ranks captured requests, and `{includeStatic:true}` adds script analysis only when needed. Replay a candidate with `tab.fetchJson(url,{method,headers,body})` inside the logged-in page, then compare its result to the captured response. An adapter should handle changing tokens at run time. For a one-off UI task, complete it directly; there is no need to reverse-engineer every endpoint.
9. **Dialogs:** a native `alert`/`confirm`/`prompt` freezes the page (`dialog_open`, details in `error.dialog`). Read
   with `tab.dialog.get()` and answer `tab.dialog.accept(text?)` / `tab.dialog.dismiss()` (in `js`), then retry — never
   answer a dialog the user didn't ask you to.
10. **Observe discipline:** one observe to orient, then act on its refs. The snapshot is the action map, not the
    document — read an article, doc, or chat log with `tab.read` (linear text, no refs; scroll is restored). If it returns
    `nextStart`, pass it with `readId` as `start` and `readId` to continue that same capture. `reason:"unbounded"` means a growing feed stopped the scan; `scan_limit` means the scan ended before the page did. Branches marked `(collapsed)`
    keep their ref; `tab.observe` with `{ref:"..."}` opens that one branch. The snapshot is the full tree unless you pass
    `since` with the `snapshotId` of a state still in your context for an exact diff; otherwise you get the full state. `viewport: true` is the
    on-screen subtree, not a page of the full tree. `click` is a real mouse event and fails with `not_delivered` when
    the page did not receive it, or the element has no box; only then, once, `method:"dom"`. Don't re-verify a fact an authoritative signal already shows
    (checked state, selected option, success toast, URL parameter). No fixed sleeps — `tab.expect` waits for the state
    you need. Credential field values read as `<redacted>`.
11. **WebMCP:** pages that register their own tools show them in `tab.webmcp.list()` (in `js`); prefer one over clicking
    the DOM, but a page tool never authorizes a consequential action.
12. **Lookups:** one focused direct navigation to an obvious result or search URL is fine; don't iterate guessed URL
    variants. On localhost apps, reload after a code/build change before verifying, and read `tab.console.read()` for
    errors the page logged.
13. **Answers:** screenshots the user asked for go inline in your final answer (Markdown image), not as bare links. If
    browser control is interrupted by the user or the extension, say so plainly ("browser use was stopped in Chrome")
    without quoting runtime error text.
14. **Popup and download outcomes:** If an action returns `openedTabs`, get handles for its `tab` ids with `await browser.tabs.get(id)`; each is a child of the source tab observed while the action ran and already belongs to the session. A `pending:true` child has no page handle yet; call `browser.tabs.list()` and match its numeric `tabId` to obtain the handle when ready. For a download, keep `download.afterSequence` from the action, then call `await tab.download(afterSequence)` on the same tab. A `download.started` entry proves that page began a download, while `downloaded:true` means Chrome reports a completed file whose new start event was paired with the page event by URL. `not_started`, `unconfirmed`, `ambiguous`, and `cursor_expired` do not prove completion. Chrome's download event has no source-tab id, so a file match is reported with `association:"url+event"` rather than as exact provenance.

## Choose an observation, then read precisely

- Older extensions retain basic main-frame ARIA with a warning; DOM and frame-scoped reads require the new extension capability. Host and extension package versions need not match.
- `tab.observe()` is the ARIA action map, including child-frame observations. Each frame has its own ref space; never use a child's ref in the parent frame. `since` uses the returned `snapshotId` and diffs each captured frame independently.
- `tab.observe({format:'dom'})` independently reads visible controls and live attributes, including open shadow roots. It is viewport-scoped by default; `viewport:false` covers rendered controls in the selected document. It does not discover every delegated event handler or unrendered virtual row.
- DOM `total/start/nextStart` describe a live list per frame. Continue with `observe({format:'dom',frame,start:nextStart})`; page changes can change that list. `truncated:true` on an entry means some preview fields were shortened.
- `tab.read({target:{ref,frame}})` reads one element's full current text, accessible name, selected attributes and live form state without scrolling. This is the detail path for a clipped DOM preview or long ARIA label. It uses strict locator resolution, just like actions. For document text, `tab.read({frame})` performs the existing bounded scroll-and-read scan; its `readId/start` continuation is tied to that frame.
- `tab.find({query,frame})` searches DOM text, attributes and current values independently of ARIA. It returns locator candidates; it is not an exhaustive text export. Exact selector/role/label/ref lookup also accepts `frame`.
- Use `screenshot()` for visual relationships, charts and canvas. A snapshot is not evidence about data not yet rendered. Scroll a virtualized region or inspect an observed network response when the task requires more data.

```js
let overview = await tab.observe();
// Choose a child based on its owner metadata and observed content.
let billing = overview.frames.find(f => f.owner.name === 'billing');
let controls = await tab.observe({format:'dom', frame:billing.frame});
// Choose a ref from that result, then use the same frame path throughout.
let amount = controls.dom.entries.find(e => e.attrs.placeholder === 'Amount');
await tab.read({target:{frame:billing.frame, ref:amount.ref}});
await tab.act({action:'fill', target:{frame:billing.frame, ref:amount.ref}, value:'42'});
await tab.read({target:{frame:billing.frame, ref:amount.ref}});
```

### Input results

`fill` replaces the control's contents; `type` appends text using browser text insertion, not a sequence of key presses. Use `press` for individual keys and shortcuts. Native date/color/range controls and `select` use their control setters and report `method:"dom"`.

For `fill` and `type`, `filled:true` and `controlState:"verified"` mean the value matched after settling. If the page formats, rejects, or resets the input during settling, the result is `delivery:"dispatched"`, `filled:false`, `controlState:"unverified"`, with `actual` when the original control is still readable. An unavailable/replaced control is also unverified. Inspect the result before continuing; use `tab.expect` for application-specific success. The engine does not overwrite the page's result with a DOM fallback. `settleMs:0` requests an immediate check only.

Failure to focus a targeted control returns an error before sending input. Target `body` or `html` explicitly when a key should go to the page's current focus.
