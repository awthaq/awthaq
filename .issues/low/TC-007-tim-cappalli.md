---
ID: "TC-007"
Title: "Passkey docs claim the package is unimplemented while it is fully shipped"
Level: low
Category: "docs"
Status: resolved
Package: "passkey"
Source: "packages/passkey/README.md:3"
Auditor: "tim-cappalli"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# TC-007 — Passkey docs claim the package is unimplemented while it is fully shipped

`LOW` · `docs` · `passkey` · reported by **Tim Cappalli — WebAuthn / Passkeys Standards Contributor** (`tim-cappalli`)

Status: **resolved**

## Summary

The README says 'no line of source in this package has shipped yet', spec/models/03-passkey-webauthn.md:69-70 lists 'What is missing: Everything... no Passkey class, no WebAuthn port implementation', and spec/behaviors/17-passkey.md:15 says 'No code implementing it exists yet' — while packages/passkey is fully implemented, wired into AuthHttp, and covered by five test files. Integrators auditing security posture from docs would conclude there is nothing to review. Relatedly, the research requirement that 'plugin docs must state' the recovery pairing (never passkey-only at v1; pair with email verification/magic-link — .scratch/research/06-webauthn-passkeys.md:197) appears nowhere in the package docs; the runtime behavior is actually safe (the cross-plugin LastAccountRefusal guard, Passkey.ts:645-650), but the guarantee a deployer needs is undocumented.

## Evidence

Source: `packages/passkey/README.md:3`

```
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
```

## Recommended fix

Regenerate the README and spec status tables from the shipped code, and add a 'Recovery' section stating the last-credential guard plus the recommended pairing with a second credential type for lost-authenticator recovery.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Passkey standards posture
- Full dossier: [`tim-cappalli`](../../.reports/tim-cappalli/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 17 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `passkey-docs`. Evidence at HEAD ec065a7: `packages/passkey/README.md:3`. Fix: Rewrite the passkey README and passkey spec status text from the shipped code, including a Recovery section. (effort S). Full dossier: `.plan/slices/10-passkey-admin.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Passkey docs rewritten from the shipped code: packages/passkey/README.md (composition, config table, challenge stores, endpoints, client, Recovery with the last-credential guard and pairing recommendation, Limits), spec/behaviors/17-passkey.md banner + shipped-behavior paragraphs under BEH-EA-129..136, spec/models/03-passkey-webauthn.md status/'What is missing'/Verification, spec/traceability.md rows for the new test files. spec:verify:strict passes. Plan note: DTWS-001/002 (P19, shared banner wording) are not done yet; the passkey banner wording here is passkey-specific and P19's sweep should harmonize it. Gates: typecheck clean for passkey/ports/client + tsconfig.test.json; passkey/ports/client vitest all green; test:bdd passkey features green; spec:verify:strict 19/19; oxlint no new findings (pre-existing ClientAddress bigint errors and an existing client no-useless-spread warning only).
