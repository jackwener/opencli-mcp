## JavaScript session semantics

Each MCP client session owns one persistent JavaScript REPL worker on Node.js 22 or newer. It retains top-level `let`, `const`, `var`, function and class declarations and supports top-level `await`. Calls in the same session run sequentially; use `Promise.all` inside a call for independent work across tabs. Operations on a single tab remain serialized by the browser runtime.

Execution uses V8's REPL mode through Node's in-process Inspector API. Top-level bindings persist, and `let`/`const` declarations can be redeclared in later calls. Assignment to a `const` still fails; prefer `let` for working bindings. Function declarations and classes persist normally. Ordinary exceptions preserve existing state and output, including any operations already completed. This does not roll back variable changes or browser actions. Node globals, `require()` and dynamic `import()` are available; no network debugging port is opened.

Await browser/site API methods to consume results and order dependent steps. The browser object model runs in the host; JavaScript runs in its worker. A Tab handle can be passed to `recon.discover(tab)` or `browser.tabs.finalize({keep:[{tab,status:'deliverable'}]})`. Adapter functions passed to `tools.define` are saved as source, not closures: include dependencies in the function and use its explicit `{tab,args,sites,recon}` inputs. A trial executes outside this REPL.

### Results

The last expression is the cell result: write `shot;`, not `return shot;`. Top-level `return` is invalid; function-local `return` works normally. Use `nodeRepl.write(value)` for explicit output. A syntax diagnostic does not by itself prove no actions ran: code may also throw a `SyntaxError` at runtime.

The first text block is the result envelope, followed by explicit writes and image blocks. `nodeRepl.write(value)` adds text; `await nodeRepl.emitImage({base64,mimeType})` adds an image. Returned screenshot values, including an image inside `tab.observe({mode:'both'})`, become image blocks. Observation methods return data and do not print automatically.

`js.maxChars` bounds the returned text (default 12000). A truncated result reports `truncated`, `chars`, `limit` and `preview`; it is not a complete dataset. Retain large data in a variable, then filter, aggregate or slice it in subsequent calls. Explicit writes are also bounded. Browser/Tab handles display identity only, never their internal runtime.

### Execution and recovery

A call finishes after its code and already-dispatched browser/site API operations settle, within the same timeout budget. Unawaited RPC failures are reported unless the code has observed the operation through `await`, `.then`, `.catch` or `.finally`; handled failures do not override the snippet result. An ordinary code error still drains dispatched operations and preserves bindings and output. This is not a rollback. Continue to await API calls to order dependent work; arbitrary timers and detached JavaScript tasks are not awaited. A timeout terminates the JavaScript worker and clears bindings. `js_timeout` means no API call was still in flight; it does not undo earlier actions. `command_outcome_unknown` means an API operation was in flight and may still complete.

MCP cancellation also stops the worker (`js_cancelled`, or `command_outcome_unknown` while an API operation is in flight). `js_reset` also terminates the worker and clears bindings while leaving tabs open. Its `pendingCalls` count reports host operations that were already dispatched. Until they settle, new `js` calls fail with `js_busy`; `doctor` reports `javascript.state` and `javascript.pendingCalls`. Inspect the current page before retrying an uncertain action. Reset/timeout invalidates calls queued before it; those calls do not silently run in a new session.

Unhandled asynchronous failures outside evaluation reset the worker. Late callbacks cannot write output or dispatch API operations into a later call. A host restart or MCP session ending discards REPL bindings. After reconnecting, list the session tabs or claim a tab and obtain a fresh handle. Finalize browser work explicitly with `session_finalize`; resetting JavaScript is not browser cleanup.
