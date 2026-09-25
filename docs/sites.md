## Sites as capabilities

Built-in adapters cover Twitter/X (`twitter`), Bilibili (`bilibili`), and Reddit (`reddit`). The source directories are the command catalog; use search to discover the current commands and their parameters.

- `sites_search` without a query lists available sites; with a task, keyword, or domain it finds commands and returns their argument schemas.
- `site_run` executes a command directly without enabling it first.
- A site's optional `site.json` can declare `aliases` for task search (for example, `{"aliases":["B站"]}`); `sites_search` returns them with the site list. Command descriptions and aliases remain part of the adapter descriptor.
- `sites.enable(site, {write?})` in `js` exposes typed tools named `<site>_<command>` and emits `tools/list_changed`. By default it exposes read commands; `write:true` also exposes write commands. `sites.disable(site)` removes those tools.
- Commands are also callable in `js` as `await sites.<site>.<command>({...args})`.
- Adapters use the same `tab` object API as interactive exploration and run in a background tab of the connected Chrome profile. Each command binds to the site's current live background tab when it starts; a closed tab is replaced on the next command. Opening an interactive agent tab does not change the adapter's tab.
- Results contain `rows` (optionally `nextCursor`) or a `value`. Failures contain `error.code`, `error.message`, and optional `error.hint` / details; inspect the returned error to recover.
- `tools_define` creates an inactive draft. `tools_try` executes it with real arguments and checks an explicit result assertion. `tools_activate` publishes a passing draft under `~/.opencli-mcp/adapters/<site>/<command>.js`; only then does it appear in search and `site_run`. User adapters override built-ins with the same site and command. A typed tool appears after `sites.enable(site)` in `js` (`write:true` for write commands).

For authoring, call `docs_get` with `name: "define-tools"`.
