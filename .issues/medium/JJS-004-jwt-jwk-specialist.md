---
ID: "JJS-004"
Title: "Key rotation has no concurrency guard: multi-instance rotation mints duplicate current keys and re-extends grace periods"
Level: medium
Category: "correctness"
Status: ready-for-agent
Package: "jwt"
Source: "packages/jwt/src/SigningKeyRecords.ts:210"
Auditor: "jwt-jwk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# JJS-004 — Key rotation has no concurrency guard: multi-instance rotation mints duplicate current keys and re-extends grace periods

`MEDIUM` · `correctness` · `jwt` · reported by **JWT/JWK Specialist** (`jwt-jwk-specialist`)

Status: **ready-for-agent**

## Summary

markRotated updates by kid alone (no WHERE rotatedAt IS NULL guard) and layerFromStore's find-then-mark-then-mint sequence (KeyRing.ts:157-164) is not transactional or locked. Two instances (or two concurrent refreshes) that both observe a stale current key each mark it rotated and mint their own replacement, leaving two rows with rotatedAt NULL; findCurrent picks the newest and the other lingers as an eternally-eligible current key that only self-heals at the next rotation interval. The double markRotated also overwrites retiresAt, extending the old key's grace window. Verification still works (all keys are JWKS-published), but key hygiene and rotation cadence guarantees dissolve under concurrency.

## Evidence

Source: `packages/jwt/src/SigningKeyRecords.ts:210`

```
          UPDATE jwt_signing_key SET rotatedAt = ${r.rotatedAt}, retiresAt = ${r.retiresAt}
          WHERE kid = ${r.kid}
```

## Recommended fix

Make markRotated conditional (WHERE rotatedAt IS NULL) and serialize rotation — a transaction with SELECT ... FOR UPDATE on the current row, a partial unique index on rotatedAt IS NULL, or an advisory lock — so exactly one replacement key is minted per rotation event.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: JWT/JWK security
- Full dossier: [`jwt-jwk-specialist`](../../.reports/jwt-jwk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`KRS-001` — JWT private signing keys stored as plaintext JSON in the database](high/KRS-001-key-rotation-specialist.md) `_(key-rotation-specialist, high)_`
- [`SMS-001` — JWT private signing keys persisted as plaintext JWK JSON in the database](high/SMS-001-secrets-management-specialist.md) `_(secrets-management-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-key-rotation-integrity`. Evidence at HEAD ec065a7: `packages/jwt/src/SigningKeyRecords.ts:209`. Fix: Enforce one current signing key at the store (unique partial index + conditional markRotated), and run mark+mint atomically in `SqlTransaction`, with losers re-reading the winner. (effort L). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.
