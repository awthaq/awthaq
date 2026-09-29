---
ID: "BPAS-006"
Title: "WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers"
Level: medium
Category: "dx"
Status: ready-for-agent
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:651"
Auditor: "biometric-platform-authenticator-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BPAS-006 — WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers

`MEDIUM` · `dx` · `passkey` · reported by **Biometric / Platform Authenticator Specialist** (`biometric-platform-authenticator-specialist`)

Status: **ready-for-agent**

## Summary

removeCredential deletes the RP-side record with no signalAllAcceptedCredentials follow-up, and authenticateVerify's unknown-credential path returns InvalidCredentials with no way for the client to fire signalUnknownCredential — research/06 specifies both (line 97: unknown-credential failures should trigger signalUnknownCredential; line 149: delete + signalAllAcceptedCredentials; a PasskeyClientSignals module was planned at line 136). Consequence on real iOS/Android ecosystems: after deleting a passkey here, iCloud Keychain and Google Password Manager keep offering the dead credential, producing repeated NotAllowedError dead-ends during sign-in — a hygiene gap that directly depresses the passkey login rate the research adopts as its north-star metric.

## Evidence

Source: `packages/passkey/src/Passkey.ts:651`

```
yield* credentials.delete(id, userId).pipe(Effect.orDie);
```

## Recommended fix

Expose the deleted credential id set and unknown-credential outcomes to the client (the response taxonomy must stay enumeration-safe — use an out-of-band channel such as the list endpoint plus a client helper), and add a passkeySignals() client helper calling signalAllAcceptedCredentials after delete and signalUnknownCredential on failed sign-ins, fire-and-forget.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Platform authenticators
- Full dossier: [`biometric-platform-authenticator-specialist`](../../.reports/biometric-platform-authenticator-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 13 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-001` — Passkey enrollment requires only a live session — no re-authentication or step-up](high/BPAS-001-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, high)_`
- [`BPAS-003` — webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle](medium/BPAS-003-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-005` — Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX](medium/BPAS-005-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-001` — Ordinary registration enforces UV=required regardless of the userVerification policy conveyed in options](high/CB-001-christiaan-brand.md) `_(christiaan-brand, high)_`
- [`CB-003` — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies](medium/CB-003-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-004` — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first](medium/CB-004-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`CB-006` — authenticateOptions leaks account existence via allowCredentials population](low/CB-006-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-user-handle`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:879`. Fix: Add WebAuthn L3 Signals to the client, fed by an enumeration-safe server surface keyed on the (now stable) user handle. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
