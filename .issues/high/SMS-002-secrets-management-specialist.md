---
ID: "SMS-002"
Title: "Key rotation is a data-losing dead end: single-key env provider plus Effect.orDie on decrypt"
Level: high
Category: "correctness"
Status: ready-for-agent
Package: "sql"
Source: "packages/sql/src/Repositories.ts:199"
Auditor: "secrets-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-002 — Key rotation is a data-losing dead end: single-key env provider plus Effect.orDie on decrypt

`HIGH` · `correctness` · `sql` · reported by **Secrets Management Specialist** (`secrets-management-specialist`)

Status: **ready-for-agent**

## Summary

KeyProvider.layerEnv holds exactly one key and fails UnknownKeyId for any other kid (packages/ports/src/KeyProvider.ts:97-100), so rotating AWTHAQ_ENCRYPTION_KEY makes every previously stored provider-token ciphertext permanently undecryptable. decryptToken then converts DecryptionFailed/UnknownKeyId into a process defect via Effect.orDie - the next findById of an account with tokens crashes rather than degrading. The kid plumbing was explicitly designed for rotation without synchronous re-encryption (KeyProvider.ts:16-24), but the only shipped implementation cannot honor old kids, and the OAuth callback path handles the identical failure as a typed OAuthCallbackFailed (packages/oauth/src/OAuth.ts:552-566) while the SQL path dies. Net effect: the rotation story the schema was built for is unusable, and its failure mode is a crash loop.

## Evidence

Source: `packages/sql/src/Repositories.ts:199`

```
: encryption
            .decrypt(value, tokenAad(providerId, userId, field))
            .pipe(Effect.map(Redacted.value), Effect.orDie);
```

## Recommended fix

Ship a multi-key env provider (e.g. AWTHAQ_ENCRYPTION_KEYS as a kid=base64 list, current kid designated) so an old kid stays decryptable after rotation; and surface DecryptionFailed/UnknownKeyId in decryptToken as a typed RepositoryError (or a null token plus event) instead of Effect.orDie.

## Context

- Auditor verdict on this domain: **needs-work** (score 64/100), domain: secrets management
- Full dossier: [`secrets-management-specialist`](../../.reports/secrets-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 38 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-002` — No bulk-invalidate, list, or count primitives anywhere in the Verification stack](high/BCR-002-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, high)_`
- [`DRS-005` — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding](medium/DRS-005-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ERAS-006` — SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented](info/ERAS-006-edge-runtime-auth-specialist.md) `_(edge-runtime-auth-specialist, info)_`
- [`EOTS-008` — Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets](medium/EOTS-008-effect-observability-tracing-specialist.md) `_(effect-observability-tracing-specialist, medium)_`
- [`ESR-001` — AccountsRepository.update is a non-transactional read-modify-write that can lose concurrently refreshed tokens](medium/ESR-001-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-003` — Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization](medium/ESR-003-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-004` — Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations](medium/ESR-004-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, medium)_`
- [`ESR-005` — findByIdentifier cannot use the identifier index for consumed history and sorts unindexed](low/ESR-005-effect-sql-repository-specialist.md) `_(effect-sql-repository-specialist, low)_`
- … 19 more findings touch `packages/sql/src/Repositories.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — Repositories.ts:199 (`Effect.orDie` on decrypt) matches verbatim, `KeyProvider.ts`'s `layerEnv` fails `UnknownKeyId` for any non-current kid, and OAuth.ts:552-566 already converts the identical `DecryptionFailed`/`UnknownKeyId` pair into a typed `OAuthCallbackFailed` — a directly reusable pattern for `decryptToken`. A multi-key env provider is a natural extension of `KeyProvider`'s already-kid-based interface. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `sql-encrypted-token-read-path`. Evidence at HEAD ec065a7: `packages/sql/src/Repositories.ts:223`. Fix: Replace `Effect.orDie` on decrypt with a typed, per-row failure policy. Point token reads surface a typed error; identity/list reads degrade the unreadable column to null and log. Token-only writes stop decrypting the old value. Add lazy re-encryption once KRS-002's multi-key provider and `staleKid` result land (ticket 22). (effort L). Full dossier: `.plan/slices/05-sql.md`.
