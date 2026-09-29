---
ID: "FAMS-010"
Title: "No bulk user-import tooling; the planned CLI import command is unimplemented"
Level: medium
Category: "dx"
Status: resolved
Package: "cli"
Source: "packages/cli/src/index.ts:3"
Auditor: "firebase-auth-migration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# FAMS-010 — No bulk user-import tooling; the planned CLI import command is unimplemented

`MEDIUM` · `dx` · `cli` · reported by **Firebase Auth Migration Specialist** (`firebase-auth-migration-specialist`)

Status: **resolved**

## Summary

A Firebase migration starts from auth.listUsers exports (batched, including hash_config and providerUserInfo). effect-auth has no importer: packages/cli exports nothing, and the import command exists only as a roadmap line (spec/roadmap.md:62). Without it, every migration team hand-writes scripts against core services — precisely where the FAMS-001/FAMS-002/FAMS-006 traps (hash format, required email, provider-subject shape) get tripped independently per team. There is also no spec guidance for the import path; Firebase appears nowhere in spec/.

## Evidence

Source: `packages/cli/src/index.ts:3`

```
// doctor, plugin list --graph, routes, migration status|apply, openapi, seed admin, import — reads the plugin manifest, never runs the application.
```

## Recommended fix

Ship the CLI import command ahead of M6 certification with a Firebase-shaped adapter (users.json + hash_config), enforcing: preserve email_verified via Users.verifyEmail, write federated identities with the exact (providerId, subject, issuer) triple, and reject email-less source users with an explicit report until FAMS-002 lands.

## Context

- Auditor verdict on this domain: **needs-work** (score 52/100), domain: Firebase migration parity
- Full dossier: [`firebase-auth-migration-specialist`](../../.reports/firebase-auth-migration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BE-003` — CLI is an empty placeholder — no schema/migration tooling exists](high/BE-003-bereket-engida.md) `_(bereket-engida, high)_`
- [`CTA-001` — CLI package has zero auth surface and its planned command set contains no login command](high/CTA-001-cli-tool-auth-specialist.md) `_(cli-tool-auth-specialist, high)_`
- [`DAG-002` — CLI package is an empty placeholder — no login flow exists to consume a future device flow](high/DAG-002-device-authorization-grant-specialist.md) `_(device-authorization-grant-specialist, high)_`
- [`ELC-008` — Operator-facing layer-graph tooling (cli plugin list --graph) is an empty placeholder](info/ELC-008-effect-layer-context-architect.md) `_(effect-layer-context-architect, info)_`
- [`ERS-008` — CLI package is an empty placeholder: no runtime-adjacent tooling exists](info/ERS-008-effect-runtime-scheduler-specialist.md) `_(effect-runtime-scheduler-specialist, info)_`
- [`MW-006` — Operational CLI is an empty stub; migrations apply only in-process at app startup](medium/MW-006-matias-woloski.md) `_(matias-woloski, medium)_`
- [`RRM-011` — Seed-admin path (BEH-EA-206) is absent — cli is a placeholder](info/RRM-011-rbac-role-modeling-specialist.md) `_(rbac-role-modeling-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-manifest-tooling`. Evidence at HEAD ec065a7: `packages/cli/src/index.ts:3`. Fix: Ship a Firebase import recipe in @awthaq/migrate-firebase and expose it as `awthaq import --from firebase`. (effort M). Full dossier: `.plan/slices/09-ports-apikey-cli.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Firebase import recipe: packages/migrate-firebase/src/ImportFirebaseUser.ts (readUsers/readHashConfig/mapUser onto UserImport.ImportUserInput; password via FirebaseScryptVerifier.encodeHash, photoUrl -> image, google.com-style providerUserInfo -> accounts with the caller's issuer, email-less and disabled records reported as unmappable) registered as `awthaq import --from firebase --source users.json --source-option hash-config=hash_config.json`. Proof: migrate-firebase/test/ImportFirebaseUser.test.ts (the published firebase/scrypt vector verifies and is flagged for rehash) and cli/test/Import.test.ts (end to end through the CLI). Note: the fixtures follow Firebase's documented export shape around the published test vector; there is no real Firebase project export.
