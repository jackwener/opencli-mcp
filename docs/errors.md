## Error codes — branch on `error.code`, never on message text

Every error has `code`, `message`, optional `hint`, and any structured data spread beside them (`candidates`, `details`, `dialog`, `expect`, `failed`, `retryable`). MCP tool errors use this envelope. Inside `js`, caught API errors carry `code`, `message`, `hint`, and structured `data`; an uncaught error is formatted into the MCP envelope.

| family | codes | what to do |
|---|---|---|
| observation | `snapshot_ref_unavailable` | ARIA capture could not establish actionable refs; use `tab.observe({format:"dom"})` for independent DOM evidence |
| locating | `not_found`, `selector_ambiguous` (+`candidates`), `stale_ref`, `invalid_target`, `missing_target` | observe again for fresh refs; scope with `within`, use the `selector` from find; `stale_ref` after navigation |
| actionability | `not_visible`, `not_enabled`, `not_editable`, `not_checkable`, `not_a_select`, `not_a_file_input`, `intercepted` (blocker named), `not_delivered`, `option_not_found` (+`available`), `timeout` | the element exists but cannot take the action; dismiss the blocker, target the real control, or wait with `expect`. `not_delivered`: the mouse event never reached the page. Retry that same target once with `method:"dom"` (HTMLElement.click(), no mouse event) only in that case, or when `not_visible` says the element has no box. A click that already returned ok must not be repeated with `method:"dom"` |
| navigation | `invalid_url`, `page_not_loaded`, `stale_page`, `page_not_in_session`, `page_released`, `tab_create_failed`, `tab_create_cleanup_failed`, `no_tab`, `tab_pending` | the URL was blocked/unreachable, the tab is gone, or finalize handed it back to the user; open or claim a fresh tab. A page handle stays stable during navigation but becomes stale after its tab closes. For `tab_pending`, call `browser.tabs.list()` again and match its numeric `tabId`. If cleanup failed, use `browser.tabs.list()` and `tab.close` on the remaining tab |
| frames | `frame_not_found` (which level is named), `frame_unreachable` | check the chain outermost-first; the frame may still be loading |
| dialogs | `dialog_open` (+`dialog`), `no_dialog`, `dialog_answer_timeout` | read with `tab.dialog.get()`, answer with accept/dismiss, then retry |
| expectations & adapters | `expectation_failed` (+`expect`, `failed`, `state`), `invalid_definition`, `unknown_site`, `unknown_command`, `adapter_load` | inspect the failed expectation or adapter definition |
| adapter drafts | `unknown_draft`, `draft_in_use`, `draft_not_verified`, `draft_changed`, `draft_conflict`, `adapter_result_mismatch` | wait for a running trial, run `tools.try` with a result assertion, or create a new draft from the current adapter; inspect the declared result shape |
| network evidence | `network_entry_not_found`, `capability_unavailable` | call `tab.network.list()` for a current `seq`; inspect `doctor` for extension features |
| document reading | `stale_read` | the saved text capture was replaced or the page navigated; call `tab.read` without `readId` to start a new capture |
| claiming tabs | `claim_not_found`, `claim_ambiguous` (+candidates), `claim_identity_mismatch`, `claim_not_allowed`, `already_claimed` | call `browser.user.openTabs()` and claim by `tabId` |
| ending tabs | `tab_close_failed`, `tab_release_failed` | Chrome refused to close or release the tab; its lease remains active, so retry `tab.close`, `tab.release`, or `session_finalize` |
| host unavailable | `host_unavailable` | Start Chrome and retry. A protocol revision difference is reported by `doctor` as a warning; available browser operations still run |
| unsupported extension action | `unknown_action`, `capability_unavailable` | The connected extension lacks this specific operation. Inspect `doctor` for its advertised features and protocol warning; update the extension if needed |
| runtime | `browser_unavailable`, `unsupported_backend`, `unknown_browser`, `unknown_capability`, `unknown_doc`, `cancelled`, `command_failed` | run `doctor` when the browser bridge is unavailable; use `tab.act` for ordinary input or `tab.evaluate` for page scripts |
| uncertain outcome | `command_outcome_unknown`, `command_lost`, `result_evicted` | the command may already have applied. Inspect the browser or site state before deciding whether to run it again |

| JavaScript | `js_error`, `js_timeout`, `js_cancelled`, `js_reset`, `js_busy`, `js_worker_failed`, `js_worker_exited` | ordinary exceptions preserve bindings; timeout, cancellation, reset and worker failure clear them. `js_busy`: wait for `doctor` javascript.pendingCalls to reach zero. See `repl-session` for execution and recovery semantics |

Native browser APIs report `chrome_api_unavailable`, `chrome_api_error`, `unsupported_call_shape`, and `runtime_state_conflict`. Inspect `browser.chrome.describe(member)` for context/signatures. Streams report loss/reset in their results; `stream_closed` requires a new watch. `command_outcome_unknown` means dispatched page code may have run: inspect before retrying. `result_not_serializable` requires returning plain data.
