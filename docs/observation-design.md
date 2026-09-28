# Observation and precise reading

## Evidence from the ChatGPT/Codex Chrome service

Inspected locally installed `openai-bundled/chrome/26.924.22138/scripts/browser-service.mjs`.
SHA-256: `6c68bc878c60855ead557a058c33d54c20574de93a840de201ee12e9453e8b4b`.
These findings describe this bundle, not every ChatGPT deployment. The readable copy was produced by formatting the bundle, without executing it. Symbol names below are search anchors for this version.

| Layer | Verified implementation | Important boundary |
| --- | --- | --- |
| ARIA capture | `playwright_dom_snapshot` calls the injected Playwright `incrementalAriaSnapshot` in AI mode and reads `full` | It is a semantic overview, not all DOM data |
| Child frames | `yB` / `$X` resolve iframe refs, enter child frames recursively, add owner id/name, and nest the text under the owner | Invisible/aria-hidden frames are excluded. A failed child read can return null. IAB-specific deadlines must not be generalized to every backend |
| Formatting | `HX` / `wB` strip ref/cursor markers, flatten unnamed generic/listitem/group wrappers, drop unnamed images | The service intentionally discards some snapshot information |
| Independent DOM evidence | `dom_cua_get_visible_dom` → `XR` → `Iy` / `JR` → injected `bV` | Controls are inferred from tags, roles, contenteditable, tabindex, href and inline onclick; this cannot discover all delegated event handlers |
| DOM details | `bV` emits selected attributes and live form properties, traverses open shadow roots, maintains element identity, clips to the viewport | Bounded to 200 entries / 20,000 characters and 160 characters of element text; not a full DOM export |
| Frame transport | `YR` resolves a frame owner to a CDP frame id; frame target acquisition handles OOPIFs | DOM observation docs explicitly say visible DOM output omits frame ownership and recommend `domSnapshot` + `frameLocator` |
| Precise/visual reads | Locator text/attribute/evaluate methods and screenshots complement snapshots | The presence of multiple tools is not evidence of an automatic fallback algorithm |
| Separate AX implementation | `captureAX` combines per-frame AX with DOM metadata and records warnings | Capability-gated; it is not proof that default Chrome `playwright.domSnapshot` uses this path |

The useful principle is recoverable summarization: the overview establishes context; a specific target must have a clear path to exact evidence and then to action. No snapshot can expose virtual rows that have not been rendered or recover canvas business semantics from an absent DOM representation.

## OpenCLI design

Keep the existing REPL and MCP entrypoints. Add options to the existing Tab methods:

- `observe()` remains an ARIA overview. Child observations carry an explicit frame path and owner metadata. Frame-local refs remain frame-local; do not invent a second global node-id system.
- `observe({format:'dom'})` independently discovers visible controls, useful attributes and live form state, including open shadow roots. Its refs use the same stable identity map as ARIA, find and act. Paginate the live list with `start/nextStart`; clipped entry fields have `truncated:true`.
- `read({target})` returns full current text, name and selected attributes/live properties for one strictly resolved target. This is the detail path, not another overview. Document `read()` retains its bounded scan and continuation semantics, with a selectable frame.
- `find({query})` searches DOM evidence independently of the ARIA tree. Exact find/read/action resolution uses the same locator compiler and frame routing.
- `routeFrames` is shared by observations and actions. Observation does not scroll. Actions can scroll frame owners before input dispatch. Frame owners in open shadow roots are resolved through an element reference, not a document-only querySelector.
- Child traversal is bounded and failures are explicit (`framesComplete:false`, per-frame `unavailable`). A direct `observe({frame})` can inspect a child independently. Each frame is diffed in its own ref space against the exact requested snapshot id.
- ARIA ref remapping accepts trailing Playwright metadata such as `[cursor=pointer]`. Otherwise the raw Playwright ref escapes remapping and can collide with an unrelated stable ref. DOM/ARIA identity is verified across both observations.
- After action resolution scrolls a target into view, frame offsets are refreshed before input dispatch; nested scrolls can move the outer frame as well.
- Capability probing preserves main-frame ARIA on older extensions and returns an explicit warning. A scoped read must never silently execute in the main document when an older edge ignores the frame field. Only the unavailable new capability requires an extension update.
- No early clipping of long ARIA labels or URLs. Branch collapsing happens only in the model-facing copy; exact target reads bypass preview clipping. MCP/REPL output budgets still apply and can be handled by keeping results in REPL variables and selecting fields.

Runtime instructions and the REPL quickstart explain the observation choices. The generated API reference includes the new return types and overloads, accessible via `docs_get` without repository access.

## Validation

`npm run build && npm run smoke:observation` launches a temporary Chromium profile and a test extension using the production engine, chrome.debugger transport, frame routing and action implementation. The host uses the actual Tab API and ExtensionPage. Only Native Messaging delivery is substituted with a service-worker call, so the test does not touch an installed extension or native-host registration.

The fixture covers long labels/URLs, custom controls, live form values, open shadow roots, same-origin/cross-origin/nested/shadow iframe owners, non-scrolling observation, exact reads, DOM pagination and query, scoped diffs, and observation-derived refs used for real click/fill. Set `OPENCLI_TEST_CHROMIUM` to an installed Chromium executable if needed. Canvas interpretation, closed shadow roots and exhaustive virtual-grid extraction are outside this change.
