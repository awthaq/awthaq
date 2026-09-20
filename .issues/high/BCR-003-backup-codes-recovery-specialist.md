---
ID: "BCR-003"
Title: "verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows"
Level: high
Category: "compliance"
Status: resolved
Package: "sql"
Source: "packages/sql/src/Models.ts:161"
Auditor: "backup-codes-recovery-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BCR-003 — verification_token rows carry no userId, so user deletion cannot clean up long-lived code rows

`HIGH` · `compliance` · `sql` · reported by **Backup Codes & Account Recovery Specialist** (`backup-codes-recovery-specialist`)

Status: **resolved**

## Summary

AccountsRepository and SessionsRepository both have deleteAllByUser for account deletion, but verification rows only encode the user inside the identifier string by convention (BEH-EA-057's 'verify-email:<userId>'), unindexed and unqueryable. Today that is tolerable because reset/verify tokens live one hour; backup-code rows are durable recovery credentials — a deleted account would leave valid recovery material for that user orphaned in the table with no way to sweep it, which is both a data-minimization failure and a latent correctness hazard if identifiers are ever reused.

## Evidence

Source: `packages/sql/src/Models.ts:161`

```
export class VerificationToken extends Model.Class<VerificationToken>("VerificationToken")({
  id: Model.UuidV7Insert(VerificationTokenId),
  identifier: Schema.String.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
```

## Recommended fix

Add an indexed userId column to verification_token plus VerificationRepository.deleteAllByUser (mirroring migration 8/9's pattern of indexing real filter keys), and make account-deletion flows sweep verification rows in the same transaction.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: Backup Codes & Recovery
- Full dossier: [`backup-codes-recovery-specialist`](../../.reports/backup-codes-recovery-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-009` — Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay](low/BCR-009-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, low)_`
- [`CSG-006` — Core PII columns are plaintext at rest with no documented encryption boundary](medium/CSG-006-compliance-soc2-gdpr-specialist.md) `_(compliance-soc2-gdpr-specialist, medium)_`
- [`ESS-010` — Documented latent decode asymmetry in VerificationToken.payload](low/ESS-010-effect-schema-specialist.md) `_(effect-schema-specialist, low)_`
- [`ESS-011` — core/sql brand bridging is runtime-unchecked by design](info/ESS-011-effect-schema-specialist.md) `_(effect-schema-specialist, info)_`
- [`MA-008` — Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors](low/MA-008-michael-arnaldi.md) `_(michael-arnaldi, low)_`
- [`NAM-007` — Existing Auth.js sessions cannot be migrated — forced global re-authentication](medium/NAM-007-nextauth-authjs-migration-specialist.md) `_(nextauth-authjs-migration-specialist, medium)_`
- [`SCP-001` — No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists](high/SCP-001-scim-provisioning-specialist.md) `_(scim-provisioning-specialist, high)_`
- [`SMS-007` — Spec's model-level Redacted typing for provider tokens is not what shipped](low/SMS-007-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`
- … 1 more findings touch `packages/sql/src/Models.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/sql/src/Models.ts:161-163` matches exactly; `VerificationToken`'s fields are `id`, `identifier`, `valueHash`, `expiresAt`, `consumedAt`, `createdAt`, `payload` — no `userId` column, unlike `AccountsRepository`/`SessionsRepository`, which both have `deleteAllByUser`. Adding an indexed `userId` column plus a `deleteAllByUser` method mirrors the existing pattern used elsewhere in the same file. Status → ready-for-agent.

**Resolved (2026-09-20):**

- `packages/sql/src/Models.ts`: `VerificationToken` gains `userId: Schema.NullOr(UserId)` — nullable, since not every token names a real user at issue time (an OAuth sign-in flow's own state token, `packages/oauth/src/OAuth.ts`, has none until the callback resolves one, unlike `accounts.userId`/`sessions.userId`). Defaults to `null` via `Schema.withConstructorDefault` so no other existing insert call site needed updating.
- `packages/sql/src/CoreMigrations.ts`: migration 15 (`ALTER TABLE verification_tokens ADD COLUMN userId`) + migration 16 (an index on it — the finding's own recommended fix precedent, migrations 8/9's `accounts_user_id`/`sessions_user_id`).
- `packages/sql/src/Repositories.ts`: `VerificationRepositoryShape.upsertLive`'s input gains `userId: UserId | null`, wired into the insert/upsert SQL; new `deleteAllByUser: (userId: UserId) => Effect.Effect<void, SqlError>`, mirroring `AccountsRepositoryShape`/`SessionsRepositoryShape`'s own signature exactly.
- `packages/core/src/Verification.ts`: `VerificationTokenView`/`VerificationShape.issue`'s input both gain `userId`/`userId?` (`Option.Option<UserId>` / `UserId | undefined`); new `deleteAllByUser: (userId: UserId) => Effect.Effect<void>` on both `layerMemory` (HashMap filter) and `layerSql` (delegates to the new repository method).
- `packages/password/src/Password.ts`: all three `verification.issue` call sites that already embed a real `userId` inside their own `identifier` string (`signUp`'s verify-email, `requestReset`'s reset-password, `resendVerification`'s verify-email) now also pass it explicitly as `userId`, so the new column actually gets populated for the two token kinds this finding's own evidence names (verify-email/reset-password). `OAuth.ts`'s own flow-state `issue` call is deliberately left without a `userId` — a fresh sign-in flow has no real user yet, matching `Verification.ts`'s own new column comment.
- `packages/server/src/Account.ts`: `deleteUser`'s existing `accounts.deleteAllByUser`/`sessions.revokeOthers` cascade (inside the same `SqlTransaction`) gains `verification.deleteAllByUser(userId)` — the concrete data-minimization fix this finding asks for. Header comment updated: verification tokens removed from the "still open, not this fix's scope" list (they were core's own gap, not a plugin-owned-table layering problem the way passkey/organization/admin genuinely still are).

TDD: `packages/core/test/Verification.test.ts` gained 4 new dual-layer test cases (8 tests: `userId` `None` when omitted, `userId` round-trips through issue/consume, `deleteAllByUser` removes the target user's live token while leaving another user's untouched, `deleteAllByUser` doesn't die on a userId with only already-consumed history) — each proves deletion via the *real* captured token value now failing (not a wrong-guess rejection, which BEH-EA-059's uniform `TokenConsumed` response would otherwise make indistinguishable from a genuine miss). `packages/server/test/AuthHttp.test.ts`'s existing `DELETE /user` end-to-end test extended with the same real-value-now-fails assertion for a live verify-email token, proving the actual HTTP cascade — not just the underlying service — sweeps it. Also converted `Verification.test.ts`'s `layerSql` suite from a hand-maintained schema fixture to the real `CoreMigrations.coreMigrations` via `Migrator.make`, the same `packages/sql/test/Repositories.test.ts` precedent, so this suite now also proves the real migration produces a working schema (including the new column). Mutation-verified: no-op'd both `deleteAllByUser` implementations (broke 2 tests, correct reason), removed `Account.ts`'s new cascade line (broke the HTTP-level test, correct reason) — each confirmed, then reverted. Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (744 passed, up from 736); `pnpm run test:bdd` unaffected (same 2 pre-existing, unrelated `15-password.steps.test.ts` failures) — confirmed no BDD World composition needed updating: `features/step-definitions/SessionWorld.ts` is the only one composing `Account.AccountHandlers`, and its own `CoreLive` already provides `Verification.layerMemory` independently (pre-existing, unrelated to this change).
