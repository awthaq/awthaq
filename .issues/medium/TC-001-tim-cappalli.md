---
ID: "TC-001"
Title: "Anonymous authenticate/options response leaks account existence via allowCredentials"
Level: medium
Category: "security"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:513"
Auditor: "tim-cappalli"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TC-001 — Anonymous authenticate/options response leaks account existence via allowCredentials

`MEDIUM` · `security` · `passkey` · reported by **Tim Cappalli — WebAuthn / Passkeys Standards Contributor** (`tim-cappalli`)

Status: **resolved**

## Summary

authenticateOptions is a public, unauthenticated endpoint (the passkey.authenticate group has no middleware, PasskeyApi.ts:227-240). When the supplied email resolves to an existing user with passkeys, the returned PublicKeyCredentialRequestOptionsJSON carries a non-empty allowCredentials list (real credential ids and transports); unknown emails or users without passkeys get an empty list. Diffing the two responses is a registered-email oracle, and it exposes the victim's credential ids to targeted phishing — precisely the class of distinction the plugin's own BEH-EA-136 design works hard to suppress on the error channel (all verification failures collapse into Api.InvalidCredentials). The plugin applies no rate limiting or response fuzzing on this endpoint.

## Evidence

Source: `packages/passkey/src/Passkey.ts:513`

```
const userOpt = yield* users.findByEmail(email);
          if (Option.isSome(userOpt)) {
            const owned = yield* credentials.listByUser(userOpt.value.id);
```

## Recommended fix

Either stop varying the response by account existence (always return empty allowCredentials and rely on discoverable-credential sign-in, accepting the UX cost), or keep the username-first flow but fuzz it: return uniformly-shaped options with decoy descriptors and rate-limit authenticate/options per IP and per email. Add a regression test asserting byte-identical option shapes for known and unknown emails.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Passkey standards posture
- Full dossier: [`tim-cappalli`](../../.reports/tim-cappalli/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-001` — Passkey enrollment requires only a live session — no re-authentication or step-up](high/BPAS-001-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, high)_`
- [`BPAS-003` — webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle](medium/BPAS-003-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-005` — Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX](medium/BPAS-005-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-006` — WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers](medium/BPAS-006-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-001` — Ordinary registration enforces UV=required regardless of the userVerification policy conveyed in options](high/CB-001-christiaan-brand.md) `_(christiaan-brand, high)_`
- [`CB-003` — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies](medium/CB-003-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-004` — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first](medium/CB-004-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-enumeration-safety`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:723`. Fix: Keep username-first but make its response indistinguishable for unknown emails via deterministic decoy descriptors, and rate-limit the endpoint. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Options half of BEH-EA-136: authenticateOptions with an email answers deterministic HMAC(enumerationSecret, email, i) decoy allowCredentials (k=1+(h[0] mod 2), 43-char ids, transports mix) for an unknown email or a known user with no credentials; lookups run unconditionally (findByEmail + listByUser against a sentinel id); per-IP/per-email rate limits (see WPS-005); new PasskeyConfig.enumerationSecret (random per process with a build-time warning when unset). Tests: PasskeyEnumeration.test.ts (non-empty, stable, case-insensitive, differs per email/secret, known-user-without-credentials, shape matches a real user's). Red before: allowCredentials was []. BEH-EA-136 updated. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
