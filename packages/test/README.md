# @awthaq/test

Test harness (dev-only: no `src` imports it, no package lists it under `dependencies`; `pnpm check:contract-tests` enforces it). `TestAuth.layer(Auth.make([...]), options)` runs a composed plugin tuple over memory, or over a migrated SQL database with `records: "sql", suite`, so a wire-level test needs no hand-built middleware and no database setup (BEH-EA-193–200).

- It derives the host middleware the composed groups declare (`AuthHttp.middlewareFor`), selects every plugin's `records` bundle and `hookPoints`, and provides the core services over `Persistence.memory` / `Persistence.sql()`, the test ports and the redaction guard; its `RIn` is `never` exactly when the composition is complete.
- `options`: `services` (the test's own config, adapters and doubles, merged into the output), `decorate`, `taps`, `csrf`, `principalResolver`, `rateLimiter`, `openapiPath`/`docsPath`.
- `TestAuth.app(layer)` serves it (`handler`, `run`, a CSRF-aware `request`, `signIn`, `dispose`, plus `runtime`, `memoMap`, `context()` and, with `{ testClock: true }`, `advance`); `buildContext` builds any layer into a context on the real clock; `csrfToken`, `httpClient`, `encryption`, `recordModes`, `throwingFramework` and `TestSql` complete the kit; `runPluginContractTests` is the plugin contract suite (every plugin class runs it from `test/Contract.test.ts`).

See [`docs/plugin-authoring.md`](../../docs/plugin-authoring.md#testing-a-plugin) and [`spec/behaviors/25-testing-harness.md`](../../spec/behaviors/25-testing-harness.md).
