---
ID: "KRS-001"
Title: "JWT private signing keys stored as plaintext JSON in the database"
Level: high
Category: "security"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/SigningKeyRecords.ts:224"
Auditor: "key-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# KRS-001 — JWT private signing keys stored as plaintext JSON in the database

`HIGH` · `security` · `jwt` · reported by **Key Rotation Specialist** (`key-rotation-specialist`)

Status: **resolved**

## Summary

The SQL layer serializes the private Ed25519/ECDSA JWK (including the d parameter) straight into the jwt_signing_key.privateKeyJwk column. Redacted is an in-memory concealment type only; at rest the most sensitive key material in the system sits plaintext in a table any DB read can dump, while the same codebase encrypts far less sensitive OAuth provider tokens through the kid-versioned AES-256-GCM Encryption service. A database read therefore yields the ability to mint arbitrary valid tokens for every principal, past and future, with no rotation able to remediate silently-issued forgeries.

## Evidence

Source: `packages/jwt/src/SigningKeyRecords.ts:224`

```
onSome: (redacted) => JSON.stringify(Redacted.value(redacted)),
```

## Recommended fix

Route privateKeyJwk through the existing Encryption service (envelope already carries kid/AAD) or the KeyProvider port before it reaches layerSql, and prefer KeyRing.registerRemoteKey (privateKeyJwk: None) for production deployments so private material never lands in the database at all.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: Key lifecycle & rotation
- Full dossier: [`key-rotation-specialist`](../../.reports/key-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`JJS-004` — Key rotation has no concurrency guard: multi-instance rotation mints duplicate current keys and re-extends grace periods](medium/JJS-004-jwt-jwk-specialist.md) `_(jwt-jwk-specialist, medium)_`
- [`SMS-001` — JWT private signing keys persisted as plaintext JWK JSON in the database](high/SMS-001-secrets-management-specialist.md) `_(secrets-management-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/jwt/src/SigningKeyRecords.ts:224` (`onSome: (redacted) => JSON.stringify(Redacted.value(redacted)),`) matches verbatim, and the column is confirmed to be persisted as a plain string (`privateKeyJwk: Schema.NullOr(Schema.String)`, lines 143/171). `Redacted` is confirmed to be an in-memory-only concealment type (unwrapped here before persistence). The contrast with encrypted OAuth secrets is confirmed real: `packages/oauth/src/OAuth.ts:110,413` shows `codeVerifier`/`nonce` already routed through the `Encryption` service. Applying that same, already-proven-in-repo `Encryption` pattern to `privateKeyJwk` is a well-scoped, mechanical fix. Status → ready-for-agent.

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-signing-key-at-rest-encryption`. Evidence at HEAD ec065a7: `packages/jwt/src/SigningKeyRecords.ts:221`. Fix: Encrypt `privateKeyJwk` at rest through the existing `@awthaq/ports` Encryption port (AAD bound to the row's kid) and decode both JWK columns with Schema instead of `JSON.parse`. (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`.

**Resolved (2026-09-29):** packages/jwt/src/SigningKeyRecords.ts layerSql: privateKeyJwk is now an @awthaq/ports Encryption envelope (AAD jwt_signing_key:<kid>:privateKeyJwk), both JWK columns decoded via Schema.fromJsonString instead of JSON.parse (no casts), undecryptable/malformed rows die with a clear message; layerSql now requires SqlClient | Encryption (inferred, no annotation); layerMemory unchanged (documented). packages/jwt/package.json: @awthaq/ports moved to dependencies (lockfile updated); packages/jwt/README.md rewritten. Tests (packages/jwt/test/KeyRing.test.ts, red first: privateKeyJwk was plaintext JWK JSON and a swapped ciphertext was accepted): 'never stores the private JWK in plaintext', 'a privateKeyJwk ciphertext copied onto another kid's row fails to decrypt'. Gates: typecheck, full vitest, oxlint packages/jwt clean. No legacy-plaintext shim (pre-release).
