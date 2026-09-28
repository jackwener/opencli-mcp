# opencli-mcp

Use `js` as a persistent browser workspace. Pre-bound: `browser` (your logged-in Chrome), `sites`, `tools`, `recon`, `agent`, `session`, and `nodeRepl`. Await API methods; keep Tab handles and working data in variables across calls.

Start with `docs_get {}` for a short quickstart and available topics. For exact signatures, request `docs_get {name:"api-reference",member:"Tab.act"}` (or another class/member). These documents describe the connected runtime; no repository access or imports are needed.

- If a ready-made adapter fits, use `sites_search` then `site_run`. Enabled adapters can also appear as typed site tools.
- Otherwise open or claim a tab in `js`, then `tab.observe()` → `tab.act(...)` → `tab.expect(...)` or a relevant observation. `tab.read()` reads content; `tab.find()` locates a target in a large action map. Use a ref returned by the current observation.
- If ARIA misses a control, use `tab.observe({format:"dom"})` for visible DOM controls and live values; `tab.read({target:{ref}})` reads exact text/attributes. Child-frame refs require the returned `frame` path in `target.frame` (or `observe.frame`/`read.frame`). Use a screenshot for visual meaning absent from DOM.
- Batch already determined steps and data processing. Return new evidence when the next step needs model judgment. Await every API operation before returning.
- An action's input delivery or control verification does not prove the site's task is complete. Verify the cheapest authoritative result; inspect before retrying uncertain actions.
- Finish with `session_finalize`, keeping only deliverable/handoff tabs. `js_reset` clears JavaScript bindings and stops its worker; it does not close browser tabs. `doctor` reports connection and JavaScript execution status.
- To create an adapter, read `define-tools`, explore and verify its workflow, then use `tools.define`, `tools.try`, and `tools.activate` in `js`.
