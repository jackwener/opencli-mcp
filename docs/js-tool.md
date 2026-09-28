## Browser REPL quickstart

`js` runs a persistent Node REPL. Pre-bound `browser`, `sites`, `tools`, `recon`, `agent`, `session`, `nodeRepl`; no imports or bootstrap. Await API methods. Variables, functions and classes survive calls. Prefer `let` for working bindings; reuse a binding by assignment instead of redeclaring it.

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

The last expression is returned. `nodeRepl.write(value)` adds output; `await tab.screenshot()` returns an image. Keep large results in variables and return summaries; truncation is explicit. API handles print only their public identity. `Tab.id` is a property; methods are awaited.

Finish with `session_finalize`. Use `doctor` for connection/execution status and `js_reset` to stop JavaScript, clear bindings and close explicit subscriptions; tabs stay open. Read `repl-session` for Node declaration semantics, errors, timeout/reset and images. Request `api-reference` with `member:"Tab.act"`, `"Tab.network"`, `"Browser"` or another class/member for exact signatures; omit member for the full reference.
