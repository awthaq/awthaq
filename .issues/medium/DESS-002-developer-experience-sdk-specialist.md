---
ID: "DESS-002"
Title: "Memory example cannot complete a sign-in: verification token is unrecoverable"
Level: medium
Category: "dx"
Status: resolved
Package: "—"
Source: "examples/memory-server/README.md:27"
Auditor: "developer-experience-sdk-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DESS-002 — Memory example cannot complete a sign-in: verification token is unrecoverable

`MEDIUM` · `dx` · `—` · reported by **Developer Experience / SDK Specialist** (`developer-experience-sdk-specialist`)

Status: **resolved**

## Summary

The example is the intended zero-friction onboarding path (no DATABASE_URL, no encryption key), but the canonical login flow dead-ends: sign-in always returns 403 EmailNotVerified, and the example neither logs the mailed verification token nor exposes Mailer.layerMemory's recorded messages (packages/ports/src/Mailer.ts:64-68 records them in-process only), so a newcomer can never mint the token that POST /verify-email requires. The first login a new developer attempts against the reference workspace is an unresolvable failure — precisely the friction this example exists to prevent. The README is honest about it, but honesty is not a workaround.

## Evidence

Source: `examples/memory-server/README.md:27`

```
# -> 403 EmailNotVerified — signIn hard-blocks until the mailed token is
#    consumed via POST /verify-email (the memory Mailer just drops the
#    mail; there is no console-log stand-in wired into this example)
```

## Recommended fix

Make the example's Mailer a wrapper around Mailer.layerMemory that also console.logs the verification link/token, or add a dev-only GET /debug/mail endpoint returning the recorded messages; then update the README's curl walkthrough to include the verify-email step so sign-in succeeds end-to-end.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: consumer SDK DX
- Full dossier: [`developer-experience-sdk-specialist`](../../.reports/developer-experience-sdk-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 29 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `examples-memory-server`. Evidence at HEAD ec065a7: `examples/memory-server/README.md:27`. Fix: Ship a dev `Mailer.layerConsole` in @awthaq/ports (logs recipient/template/data incl. the token via Effect.logInfo, and records for `sent`), wire it into the memory example through TestAuth.layer's middleware slot, and extend the example README walkthrough with the verify-email step. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Mailer.layerConsole in @awthaq/ports (records like layerMemory, logs recipient/template/data with Redacted values unwrapped, sets `development`), test written first (red: layerConsole undefined). Wired into examples/memory-server through TestAuth.layer's services slot (the plugin resolves it before the bundle's memory mailer); the README walkthrough now works verbatim (checked against a live server: CSRF cookie jar, token from the log, /verify-email, sign-in 200) and a new smoke test drives the same path, verified red by removing the console mailer. Gates: pnpm typecheck (clean build, 0 errors), oxlint clean, knip clean, format:check clean, circular, package:smoke, coverage thresholds, test:bdd, spec:verify:strict.
