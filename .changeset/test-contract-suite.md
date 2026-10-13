---
"@awthaq/test": minor
---

`runPluginContractTests` checks a plugin's records bundle and no longer needs `host` for a plugin with `dependsOn`.

- `host` defaults to the plugin's transitive `dependsOn` closure (dependencies first), so `{ options: [{}] }` is enough for every plugin; `host: []` still reports `E_PLUGIN_MISSING_DEP`.
- A plugin that declares `records` is checked to have a matched pair: `records.memory` builds over the memory foundation, `records.sql` builds over a SQLite database migrated with core and the composition's migrations, and both hold the same service keys (a failure names the extra or missing keys).
- New opt-in `build: { services }`: the composition is built through `TestAuth.layer` over memory and over SQL, which catches a plugin that composes over memory but not SQL.
- `TestAuth.throwingFramework(describe, it)` replaces the hand-written `TestFramework` adaptor.
- `TestAuth.layer`'s base now provides `AuditChain` (needs only `Crypto`), which `Admin`'s impersonation records read.

Migration: none required. A plugin whose bundles disagree now fails its contract test. A new `pnpm check:contract-tests` (part of `pnpm check`) fails when a plugin class has no `runPluginContractTests` call in its package's `test/Contract.test.ts`, or when a library `src` imports `@awthaq/test` or a package lists it under `dependencies`.
