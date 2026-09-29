---
ID: "BPAS-003"
Title: "webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle"
Level: medium
Category: "correctness"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:481"
Auditor: "biometric-platform-authenticator-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BPAS-003 — webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle

`MEDIUM` · `correctness` · `passkey` · reported by **Biometric / Platform Authenticator Specialist** (`biometric-platform-authenticator-specialist`)

Status: **resolved**

## Summary

A fresh random webauthnUserId is generated at every options call (Passkey.ts:389 and :412) and a *second* fresh one is generated at verify time and stored (:481) — so the stored value never equals the user handle actually baked into the credential, and two passkeys for one user get two different handles. WebAuthn's user handle is the per-account stable identifier platform authenticators use: iCloud Keychain and Google Password Manager will surface each passkey as a separate account in the account chooser, fragmenting usernameless sign-in UX. research/06 (line 47) specifies a per-user random webauthnUserID with a UNIQUE constraint; here there is also no read path at all (PasskeyCredentialsShape has no findByWebauthnUserId), and the assertion's userHandle is forwarded to the library (Passkey.ts:164) but never validated against the record.

## Evidence

Source: `packages/passkey/src/Passkey.ts:481`

```
const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
```

## Recommended fix

Generate one webauthnUserId per user (memoized on Users or a plugin table keyed by userId), send that same value in both options ceremonies, store exactly what was sent, add findByWebauthnUserId, and cross-check the assertion userHandle against it during authenticateVerify.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Platform authenticators
- Full dossier: [`biometric-platform-authenticator-specialist`](../../.reports/biometric-platform-authenticator-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 13 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-001` — Passkey enrollment requires only a live session — no re-authentication or step-up](high/BPAS-001-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, high)_`
- [`BPAS-005` — Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX](medium/BPAS-005-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-006` — WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers](medium/BPAS-006-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-001` — Ordinary registration enforces UV=required regardless of the userVerification policy conveyed in options](high/CB-001-christiaan-brand.md) `_(christiaan-brand, high)_`
- [`CB-003` — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies](medium/CB-003-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-004` — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first](medium/CB-004-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`CB-006` — authenticateOptions leaks account existence via allowCredentials population](low/CB-006-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-user-handle`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:591`. Fix: Mint one random WebAuthn user handle per user, persist it in a plugin table, send it in every registration ceremony, store exactly it on the credential, and cross-check assertion userHandle. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Stable per-user handle: new PasskeyUserHandles service (layerMemory/layerSql, getOrCreate atomic via ON CONFLICT DO NOTHING + SELECT, deleteByUser) and migration create_passkey_user_handle (table added to Passkey.tables); all registration ceremonies send it as user.id and credentials.create stores exactly it; sign-in and step-up reject an assertion userHandle that differs from the stored one; beforeUserDeleteErasure erases it. Tests: PasskeyUserHandle.test.ts (stored handle == options.user.id shared across credentials and the conditional ceremony; mismatch rejected on sign-in/step-up; service tests on both layers incl. concurrency), PasskeyErasure.test.ts. Known consequence documented in the README/model: credentials registered before this change hold a random handle no authenticator has, so discoverable assertions for them fail the check and those users re-register (pre-release; no migration possible). Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
