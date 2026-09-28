## Capability: cdp

Use `await tab.cdp.send(method, params, target?)` on an explicit Tab. Native CDP method names and parameters pass through unchanged. `target:{frameId}` selects a frame target from `tab.frames()`; routing is separate from protocol parameters. Chrome decides method availability. Browser-wide and arbitrary extension/worker targets are not exposed.

The connection is shared with the runtime. `Runtime.disable`, `Page.disable`, `Network.disable`, `Target.setAutoAttach` and `Target.detachFromTarget` conflict with its internal observers and return `runtime_state_conflict`. Other methods are not restricted to a feature allowlist. State-changing calls are never automatically replayed.

`let events = await tab.cdp.watch('Network.requestWillBeSent')` registers a root-target listener before returning. Enable any required CDP domain with `tab.cdp.send`, then perform the action and `await events.read()`. Finish with `await events.close()`. Child-session events are not mixed in. See `capabilities/chrome` for cursor, loss and subscription lifecycle semantics.
