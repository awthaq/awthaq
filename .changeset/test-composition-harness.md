---
"@awthaq/core": minor
"@awthaq/server": minor
"@awthaq/test": minor
---

A plugin declares its record stores and its hook points, and `TestAuth.layer` stands a whole composition up from `Auth.make(...)` alone.

- `@awthaq/core`: `AuthPlugin.Service` accepts `records: { memory, sql }` (two matched layers providing the plugin's `/records/` stores, and nothing else) and `hookPoints` (the default layers of the hook points the plugin owns). Both are static members of the class (`Layer.empty` when absent); `AuthPlugin.layer` refuses, at compile time, a layer that requires a `/records/` store no bundle (its own or a `dependsOn` plugin's) provides, a `memory` and `sql` that differ, and a non-core hook point nothing declares. `Auth.Built` gains `plugins`, the tuple as given.
- `@awthaq/server`: `AuthHttp.middlewareFor(api, { csrf, principalResolver? })` builds exactly the host middleware (`Authentication`, `OptionalAuthentication`, `MachineAuthentication`, `AdminAuthentication`, `CsrfProtection`) the groups of an api declare; `DeclaredMiddleware` is its type.
- `@awthaq/test`: `TestAuth.layer(built, options)` derives that middleware, selects every composed plugin's records bundle and hook points, merges `options.services` into the output (a service only `services` provides is now really present), and runs over memory (default) or a migrated database (`records: "sql", suite`). New: `TestAuth.app` (handler, `run`, a CSRF-aware `request`, `signIn`, `dispose`), `csrfToken`, `TestCsrfConfig`, `httpClient.{noBreach,returning,unavailable}`, `encryption`, `recordModes`, `throwingFramework`, `TestSql` (moved from `packages/sql/test/support`).

Migration: `TestAuth.layer(built, services, opts)` becomes `TestAuth.layer(built, { services, ...opts })`; drop `Authentication.AuthenticationLive`, `Csrf.CsrfProtectionLive`, a `CsrfConfig` and a `CredentialResolversLive` from `services` (the harness provides them; `options.csrf` tunes the config). `import * as TestSql from "../../sql/test/support/TestSql.ts"` becomes `import { TestSql } from "@awthaq/test"`. A plugin that owns hook points adds `hookPoints: <its merged point layer>`; a hand-built layer that taps a non-core hook point it does not own declares it too. BEH-EA-193.
