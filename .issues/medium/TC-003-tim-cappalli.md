---
ID: "TC-003"
Title: "No ceremony timeout knob; browser ceremony lifetime and server challenge TTL are unaligned"
Level: medium
Category: "api"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/ChallengeStore.ts:56"
Auditor: "tim-cappalli"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TC-003 — No ceremony timeout knob; browser ceremony lifetime and server challenge TTL are unaligned

`MEDIUM` · `api` · `passkey` · reported by **Tim Cappalli — WebAuthn / Passkeys Standards Contributor** (`tim-cappalli`)

Status: **resolved**

## Summary

The server fixes the challenge TTL at 5 minutes and makes it non-configurable, while RegistrationOptionsInput (packages/ports/src/WebAuthn.ts:88-100) and AuthenticationOptionsInput (:121-128) expose no timeout field at all — neither the plugin nor the port ever passes one, so the browser-side ceremony runs on the library/browser default with no relationship to the server's window. The two halves of one ceremony are therefore governed by different, invisible timers: a client that idles past the browser timeout gets a NotAllowedError, while a captured challenge stays replayable server-side for up to 5 minutes. The port also exposes no hints (WebAuthn L3 'hybrid'/'security-key'/'client-device') or extensions (credProps, largeBlob, prf) passthrough, so RPs cannot steer cross-device or report discoverability — the levers current passkey adoption guidance actually uses.

## Evidence

Source: `packages/passkey/src/ChallengeStore.ts:56`

```
const TTL = Duration.minutes(5);
```

## Recommended fix

Add timeout to PasskeyConfig and the port input shapes, set it explicitly in both options generators to a value at or below the challenge TTL (and document the pairing), and add optional hints/extensions passthrough so the config surface reaches WebAuthn L3 parity.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Passkey standards posture
- Full dossier: [`tim-cappalli`](../../.reports/tim-cappalli/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-008` — Challenge value compared with === in memory/SQL stores while the cookie store uses constantTimeEqual](low/BPAS-008-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, low)_`
- [`CB-007` — Challenge comparison is non-constant-time in memory and SQL layers but constant-time in the cookie layer](low/CB-007-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`HSK-010` — Challenge value comparison is plain === in memory/SQL layers while the cookie layer ships a constantTimeEqual](info/HSK-010-hardware-security-key-specialist.md) `_(hardware-security-key-specialist, info)_`
- [`WPS-003` — Dual-scope challenge probe in registerVerify destroys the non-matching sibling challenge](medium/WPS-003-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, medium)_`
- [`WPS-008` — Memory/SQL challenge comparison uses plain === while the cookie layer is constant-time](low/WPS-008-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`
- [`WPS-009` — layerCookie violates ChallengeStoreShape's documented issue-replacement contract](low/WPS-009-webauthn-passkeys-specialist.md) `_(webauthn-passkeys-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-ceremony-policy`. Evidence at HEAD ec065a7: `packages/passkey/src/ChallengeStore.ts:55`. Fix: Expose ceremony timeout (≤ challenge TTL), hints and extension passthrough on the port and PasskeyConfig; set them explicitly in every options generator. (effort M). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Explicit ceremony timing: port RegistrationOptionsInput/AuthenticationOptionsInput gain timeout/hints/extensions (ports tests echo them); ChallengeStore exports CHALLENGE_TTL; PasskeyConfig gains ceremonyTimeout (default 4m30s), hints, extensions, and Passkey.layer refuses to build when ceremonyTimeout exceeds the TTL; every options generator (register, conditional, authenticate, reauthenticate) sets them. Tests: PasskeyCeremony.test.ts (all four options carry timeout 270000; configured timeout/hints/extensions reach the port; over-TTL config fails to build), ports WebAuthn.test.ts, PasskeyRealPort.test.ts (real options timeout). Decision: extensions default left to the library's own default (credProps on registration). Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
