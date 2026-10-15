---
"@awthaq/sql": minor
"@awthaq/ports": minor
"@awthaq/core": minor
"@awthaq/server": minor
"@awthaq/test": minor
---

`@awthaq/sql` gains the plugin-table substrate (plan 05): `TenantScoped`, `SealedColumn` and `StoreFailure`, and `TenantScope` learns plugin tables.

- `TenantScoped`: the tenancy kinds (`partitioned`, `keyed`, `derived`, `global`), one index-friendly predicate and one memory matcher for the same rule, and the `CrossTenant` witness (`crossTenant(reason)`) whose `lift` clears `awthaq.tenant_id` for one statement inside an RLS transaction. The stamp rule is `Tenant.stamp` in `@awthaq/ports`; `Repositories` no longer carries a private copy.
- `SealedColumn`: declare an encrypted column once, get a `Sealed<A>` whose `open` is the only place the plaintext appears, the canonical AAD `<table>:<rowKey>:<column>`, lazy re-seal by compare-and-swap, a typed `SealedColumn/Unreadable` handled by `orDie` or `option`, and a `sweep` batch job. Core's PII and account-token codecs now run on `SealedColumn.reveal` with unchanged behaviour.
- `StoreFailure`: `storeUnavailable`, `orStoreUnavailable`, `retryTransient` moved here from `@awthaq/core`'s `Errors` (which re-exports them). `@awthaq/sql` now depends on `@awthaq/api`.
- `TenantScope.enableRls` takes `{ plugins, includeKeyed }`; `disableRls` removes the `awthaq_tenant` policy from every table that has one; `withTenant` marks the RLS scope for `lift`.
- `@awthaq/server`: a credential-resolver contribution's `StoreUnavailable` is recorded as the request's outage, like the cookie scheme's.
- `@awthaq/test`: `TestAuth.runTenantIsolationTests` and `TestAuth.runSealedColumnTests`.

Migration: `TenantScope.disableRls` now removes the policy from every table that has one, not only the core tables. `Errors.storeUnavailable` now dies (`Defects/InvariantViolation`, `store.statementRefused`) on a SQL syntax or authorization error instead of answering 503 (ADR-EA-028). BEH-EA-324..327.
