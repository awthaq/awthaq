---
ID: "TSS-004"
Title: "Passkey authenticateVerify early-returns for unknown credential IDs before any signature work"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:551"
Auditor: "timing-side-channel-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TSS-004 — Passkey authenticateVerify early-returns for unknown credential IDs before any signature work

`MEDIUM` · `security` · `passkey` · reported by **Timing / Side-Channel Specialist** (`timing-side-channel-specialist`)

Status: **ready-for-agent**

## Summary

An unregistered credential ID fails after one DB lookup, while a registered one proceeds to full WebCrypto ECDSA/Ed25519 signature verification (line 556) — measurably more work. The error content is uniform (Api.InvalidCredentials, satisfying BEH-EA-136), but the timing distinguishes registered from unregistered credential IDs in the usernameless authenticate ceremony; the password plugin introduced dummyHash (Password.ts:447) precisely to deny this class of existence oracle. Only the challenge gate (ChallengeStore.consume, line 539) — obtainable by anyone via authenticateOptions — stands between an attacker and the probe. Practical risk is bounded by the 128-bit+ credential ID space, but an attacker who has observed a victim's credential ID (shared device, relayed ceremony, logs) can confirm RP membership.

## Evidence

Source: `packages/passkey/src/Passkey.ts:551`

```
const storedOpt = yield* credentials.findById(input.credential.id);
if (Option.isNone(storedOpt)) {
  return yield* Effect.fail(new Api.InvalidCredentials());
}
```

## Recommended fix

On the unknown-credential path, perform a dummy WebCrypto importKey/verify (or verify the signature against a fixed decoy public key) so both paths pay comparable verification cost, mirroring the password plugin's dummyHash pattern with a comment citing it.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: timing side channels
- Full dossier: [`timing-side-channel-specialist`](../../.reports/timing-side-channel-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence medium); workstream `passkey-enumeration-safety`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:761`. Fix: Equalize cost on the unknown-credential path with a decoy verification, mirroring Password's dummyHash. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.
