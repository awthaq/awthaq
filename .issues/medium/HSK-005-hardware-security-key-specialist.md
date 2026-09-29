---
ID: "HSK-005"
Title: "Passkey sign-in emits no assurance signal, so a qadi-level 'hardware key required' policy is unimplementable"
Level: medium
Category: "api"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:599"
Auditor: "hardware-security-key-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# HSK-005 — Passkey sign-in emits no assurance signal, so a qadi-level 'hardware key required' policy is unimplementable

`MEDIUM` · `api` · `passkey` · reported by **Hardware Security Key (FIDO U2F/CTAP) Specialist** (`hardware-security-key-specialist`)

Status: **resolved**

## Summary

Sessions.issue accepts only userId/request/supersedes (core/src/Sessions.ts:137-141), so nothing about the authentication survives onto the session: not UV, not the assertion's userVerified flag, not deviceType (singleDevice hardware-bound vs multiDevice synced), not the provider/AAGUID. Combined with the absence of any factor-strength concept in packages/qadi and packages/organization, the organization-level "require hardware key" enforcement point this architecture intends (policy signals surfaced to qadi, effect-auth not enforcing) does not exist — the only enforcement available is the plugin's own global authenticatorSelection.userVerification:"required", which is all-or-nothing per deployment and cannot distinguish a hardware key from a synced platform passkey.

## Evidence

Source: `packages/passkey/src/Passkey.ts:599`

```
const issued = yield* sessions.issue({ userId: stored.userId }).pipe(Effect.orDie);
```

## Recommended fix

Extend session issuance with an authentication-method/assurance record (amr/AAL-style: provider id, UV flag, credential deviceType) contributed by the authenticating plugin, and expose it to qadi's decision input so org policy can require e.g. providerId==passkey && deviceType==singleDevice.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 67/100), domain: Hardware security keys
- Full dossier: [`hardware-security-key-specialist`](../../.reports/hardware-security-key-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-assurance`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:832`. Fix: Record per-session authentication assurance (amr + UV + credential facts) at issuance and expose it to qadi policies. (effort L). Needs a decision first — see `.plan/DECISIONS.md`. Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-human.

**Plan note (2026-09-29, P08):** left open (session-assurance, P15). P08 did not add an `amr`/assurance signal: `Sessions.issue` in `authenticateVerify` (`packages/passkey/src/Passkey.ts`) still passes only `{ userId }`. Passing the client `ip`/`userAgent` and an authentication-method claim into `Sessions.issue` needs the P01/P07/P16 session-issuance work first (Sessions.ts is being edited by P01). The plumbing point is ready: `authenticateVerify` already takes `ip` in its input and its handler resolves it through `ClientAddress`.

**Resolved (2026-09-29):** Decision (2026-09-29): adopted recommended option A per plan: record amr at issuance (Passkey passkeyAmr: hwk or swk plus user when user-verified) and expose amr, authenticatedAt and derived assurance to qadi policies through SubjectResolver.principalAttributes. Tests: packages/passkey, packages/qadi, packages/roles suites; Assurance.test.ts.
