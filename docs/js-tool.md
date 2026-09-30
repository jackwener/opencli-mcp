## Browser REPL quickstart

`js` runs a persistent Node REPL with top-level `await`. End with an expression to return its value; do not use top-level `return` (it is only valid inside functions). Pre-bound `browser`, `sites`, `tools`, `recon`, `agent`, `session`, `nodeRepl`; no imports or bootstrap. Await API methods. Each call drains already-dispatched API work before returning; an ordinary error preserves bindings. Variables, functions and classes survive calls. Prefer `let` for working bindings; reuse bindings across calls; redeclaration is also supported.

Use `browser.chrome.call(method, argsArray)` for native browser management, `tab.cdp.send(method, params)` for Tab-level CDP, and `tab.evaluate(script, {arg})` for Main World page code. These execute in different contexts from the host REPL. Query `browser.chrome.describe("tabs.query")` or read `capabilities/chrome` for native API signatures and events.

Open and inspect:
```js
let tab = await browser.tabs.new('https://example.com/');
await tab.observe();
```

Or borrow a user tab:
```js
let matches = await browser.user.openTabs({query: 'example.com', limit: 20});
matches;
```
Copy its numeric `tabId` into `await browser.user.claimTab({tabId: ...})`. Store the returned Tab handle, then observe it. Session handles come from `await browser.tabs.list()` and `await browser.tabs.get(id)`.

After reading the observation, call `await tab.act({action:'click', target:{ref: '...'}})` using a returned ref, then `await tab.observe()` or `await tab.expect({text:'...'})` with the expected result. `await tab.read()` reads document text. Batch determined steps; return at new decision points.

When ARIA lacks detail, `await tab.observe({format:'dom'})` returns visible controls with live attributes and the same actionable refs. `await tab.read({target:{ref:'...'}})` reads full text/attributes without scrolling. DOM previews flag `truncated`; use `dom.nextStart` as `start` to continue a live list in the same frame. Child observations are in `frames`; copy each child's `frame` path alongside its local ref into `target.frame` for `find/read/act`, or pass `frame` to `observe`. A screenshot remains the evidence for canvas, layout and colors.

The last expression is returned. `nodeRepl.write(value)` adds output; `await tab.screenshot()` returns an image. Keep large results in variables and return summaries; truncation is explicit. API handles print only their public identity. `Tab.id` is a property; methods are awaited.

For example, return a screenshot as the cell result:
```js
let shot = await tab.screenshot({format: 'jpeg', quality: 80});
shot;
```

Refs are opaque Element identities shared by ARIA, DOM and find. Copy them unchanged with the observed frame path. They remain valid while the same Element lives in that document; after replacement or navigation, `stale_ref` means observe again. A semantic locator can find a replacement Element; an old ref does not.

Finish with `session_finalize`. Use `doctor` for connection/execution status and `js_reset` to stop JavaScript, clear bindings and close explicit subscriptions; tabs stay open. Read `repl-session` for Node declaration semantics, errors, timeout/reset and images. Request `api-reference` with `member:"Tab.act"`, `"Tab.network"`, `"Browser"` or another class/member for exact signatures; omit member for the full reference.
