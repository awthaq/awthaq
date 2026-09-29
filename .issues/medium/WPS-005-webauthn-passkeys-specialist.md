---
ID: "WPS-005"
Title: "Expired challenges are never reclaimed; abandoned authenticate ceremonies grow storage without bound"
Level: medium
Category: "performance"
Status: ready-for-agent
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:506"
Auditor: "webauthn-passkeys-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# WPS-005 — Expired challenges are never reclaimed; abandoned authenticate ceremonies grow storage without bound

`MEDIUM` · `performance` · `passkey` · reported by **WebAuthn/Passkeys Implementation Specialist** (`webauthn-passkeys-specialist`)

Status: **ready-for-agent**

## Summary

Registration scopes are keyed by session id, so re-issue overwrites, but the authentication scope embeds a fresh random ceremonyId per call to a public, plugin-unthrottled endpoint — every abandoned sign-in dialog leaves a row nothing will ever delete. layerMemory removes an entry only when consume hits that exact scope (ChallengeStore.ts:95-99), so unconsumed entries also live in the Ref forever; layerSql has the same shape at the table level (popByScope is the only DELETE). TTL is enforced only at consume time, so expiry bounds correctness, not storage. This is the plugin's own denial-of-service surface: unauthenticated traffic mints persisted state monotonically.

## Evidence

Source: `packages/passkey/src/Passkey.ts:506`

```
const ceremonyId = toBase64Url(yield* crypto.randomBytes(16).pipe(Effect.orDie));
const challenge = yield* challengeStore.issue(authenticateScope(ceremonyId));
```

## Recommended fix

Add TTL reclamation: opportunistically evict expired entries on issue, run a DELETE FROM passkey_challenge WHERE expiresAt < now sweeper, or key authentication challenges by session/cookie scope instead of a fresh random ceremonyId.

## Context

- Auditor verdict on this domain: **needs-work** (score 70/100), domain: WebAuthn passkey ceremonies
- Full dossier: [`webauthn-passkeys-specialist`](../../.reports/webauthn-passkeys-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-challenge-store-hardening`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:717`. Fix: Reclaim expired challenges opportunistically on issue, expose an explicit sweep, and throttle the anonymous options endpoint. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
