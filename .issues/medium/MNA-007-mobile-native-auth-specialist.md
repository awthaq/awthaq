---
ID: "MNA-007"
Title: "Passkey origin validation rejects Android-native assertions"
Level: medium
Category: "correctness"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:135"
Auditor: "mobile-native-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MNA-007 — Passkey origin validation rejects Android-native assertions

`MEDIUM` · `correctness` · `passkey` · reported by **Mobile/Native Auth Specialist** (`mobile-native-auth-specialist`)

Status: **resolved**

## Summary

decodeClientData's own comment scopes it to "the browser's clientDataJSON" (Passkey.ts:106-112), and originMatchesRpId parses the origin as a web URL. Android Credential Manager assertions carry origin "android:apk-key-hash:<hash>", which has no hostname (opaque-path non-special URL), so the check returns false and every native Android passkey sign-in fails as InvalidCredentials, indistinguishable from a real attack per the uniform-error design. iOS app-attached assertions (https origin from Associated Domains) work only by coincidental shape.

## Evidence

Source: `packages/passkey/src/Passkey.ts:135`

```
    const host = new URL(origin).hostname;
    return host === rpId || host.endsWith(`.${rpId}`);
```

## Recommended fix

Accept platform origins explicitly: exact-match android:apk-key-hash:<sha256-of-cert> entries against configured values (plus the standard web-origin rpId suffix check), and document the Associated Domains / Digital Asset Links setup the persona's platform requires.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: mobile client readiness
- Full dossier: [`mobile-native-auth-specialist`](../../.reports/mobile-native-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

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

**Plan validation (2026-09-29):** PARTIAL (confidence high); workstream `passkey-ceremony-policy`. Evidence at HEAD ec065a7: `packages/passkey/src/Passkey.ts:146`. Fix: Treat configured platform (android:apk-key-hash:) origins as exact-match origins exempt from the web rpId-suffix check, consistently across all ceremonies. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Platform origins: checkOrigin treats android:apk-key-hash: origins listed verbatim in origins as exact-match and exempt from the web rpId-suffix check, applied identically to registration, sign-in and step-up (sign-in now runs the same pre-check). Tests: PasskeyCeremony.test.ts (configured android origin accepted on register/sign-in/step-up; unconfigured rejected). README documents the origin format and Digital Asset Links setup. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
