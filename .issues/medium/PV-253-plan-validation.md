---
ID: "PV-253"
Title: "`AuthPlugin.Service`'s `tables` prefix constraint (BEH-EA-005) is bypassable by type inference, and `@awthaq/roles` already violates it"
Level: medium
Category: "correctness"
Status: open
Package: "core"
Source: "packages/core/src/AuthPlugin.ts:152"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-253 — `AuthPlugin.Service`'s `tables` prefix constraint (BEH-EA-005) is bypassable by type inference, and `@awthaq/roles` already violates it

`MEDIUM` · `correctness` · `core` · found while wiring `05-persistence-stratum.feature` (P20a, REQ-EA-105)

Status: **open**

## Summary

`AuthPlugin.Service` declares `tables?: ReadonlyArray<`${Id}_${string}`>`, but `Id` is also an inference site for that template-literal type. A table named `<x>_<y>` therefore *widens* `Id` to `"<id>" | "<x>"` instead of being rejected, so the compile-time rule "every table starts with `<id>_`" (BEH-EA-005, INV-EA-016's persistence analogue) only rejects names with no underscore at all.

```ts
class ForeignTable extends AuthPlugin.Service<ForeignTable, {}>()("password", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
  tables: ["oauth_account"], // compiles; `ForeignTable.id` is typed "oauth" | "password"
}) {}
```

`@awthaq/roles` is the live instance: its id is `"roles"` but it declares and creates `role_assignments` (`packages/roles/src/Roles.ts:452`, migrations at :326-354). Every other shipped plugin with migrations (organization, jwt, passkey, admin, api-key, scim) creates only `<id>_*` tables (checked by the wired scenario, which is `@skip`ped only for this).

## Recommended fix

1. `tables?: ReadonlyArray<`${NoInfer<Id>}_${string}`>` in `AuthPlugin.Service`'s options.
2. Rename `roles`' table to `roles_assignments` (SQL in `Roles.ts`, its migrations, `packages/roles/test`, `packages/cli/test/{Seed,Migration.postgres}.test.ts`, `features/step-definitions/CliSteps.ts`, `packages/roles/README.md`); pre-release, so no data migration is needed.
3. Add a type gate (`features/step-definitions/PluginTypeGates.ts`, `table-foreign-prefix`) and un-skip REQ-EA-105.

## Evidence

- `packages/core/src/AuthPlugin.ts` `Service`'s `tables` option; the failing type check above (`ForeignTable.id` is `"oauth" | "password"`).
- `features/features/01-contract-and-persistence/05-persistence-stratum.feature` REQ-EA-105: run with `Roles.Roles` excluded from the shipped-plugin list, it passes; with it, `roles created "role_assignments", outside its own prefix`.

## Comments

_Triage notes and discussion append here._
