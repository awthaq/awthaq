---
ID: "SMS-001"
Title: "JWT private signing keys persisted as plaintext JWK JSON in the database"
Level: high
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/SigningKeyRecords.ts:224"
Auditor: "secrets-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-001 — JWT private signing keys persisted as plaintext JWK JSON in the database

`HIGH` · `security` · `jwt` · reported by **Secrets Management Specialist** (`secrets-management-specialist`)

Status: **resolved**

## Summary

The jwt plugin writes the EdDSA/ES256 private key JWK - the material that mints every access token - straight into jwt_signing_key.privateKeyJwk as plaintext JSON (INSERT at lines 176-179). Redacted guards only logging, not storage; unlike @awthaq/sql's ticket-18 treatment of provider tokens (AES-256-GCM under the Encryption service with row+column AAD), no at-rest encryption wraps this column. A single read-only database compromise (backup, replica, captured row) yields token-forging capability for the entire deployment - strictly worse than leaking any one provider token, and inconsistent with the bar the codebase itself sets one package over.

## Evidence

Source: `packages/jwt/src/SigningKeyRecords.ts:224`

```
onNone: () => null,
          onSome: (redacted) => JSON.stringify(Redacted.value(redacted)),
        }),
```

## Recommended fix

Route privateKeyJwk through @awthaq/ports Encryption (kid + AAD binding on the kid column), or default the plugin to the existing remote-signing seam (KeyRing.registerRemoteKey / a KMS-backed signer) so private material never lands in the table at all; keep local plaintext only for the in-memory test layer.

## Context

- Auditor verdict on this domain: **needs-work** (score 64/100), domain: secrets management
- Full dossier: [`secrets-management-specialist`](../../.reports/secrets-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 38 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`JJS-004` — Key rotation has no concurrency guard: multi-instance rotation mints duplicate current keys and re-extends grace periods](medium/JJS-004-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, medium)_`
- [`KRS-001` — JWT private signing keys stored as plaintext JSON in the database](high/KRS-001-key-rotation-specialist.md) `_(key-rotation-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — SigningKeyRecords.ts:224 `JSON.stringify(Redacted.value(redacted))` matches verbatim and is written straight into `jwt_signing_key.privateKeyJwk` with no encryption; packages/sql/src/Repositories.ts:172 already wires an `Encryption` port for provider tokens, giving a directly reusable pattern. Status → ready-for-agent.

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `jwt-signing-key-at-rest-encryption`. Duplicate of `KRS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/jwt/src/SigningKeyRecords.ts:224`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `KRS-001-key-rotation-specialist` — closed by its fix (see that issue's Resolved comment).
