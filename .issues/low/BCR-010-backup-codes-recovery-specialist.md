---
ID: "BCR-010"
Title: "No BDD or behavior-spec coverage for backup codes despite the suite's own hook for it"
Level: low
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "spec/models/06-two-factor-totp.md:112"
Auditor: "backup-codes-recovery-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BCR-010 — No BDD or behavior-spec coverage for backup codes despite the suite's own hook for it

`LOW` · `testing` · `—` · reported by **Backup Codes & Account Recovery Specialist** (`backup-codes-recovery-specialist`)

Status: **ready-for-agent**

## Summary

features/05-authentication-methods contains 15-password, 16-oauth, and 17-passkey but no two-factor feature, spec/behaviors has no two-factor file, and features/traceability.md allocates no REQ-EA ids to recovery codes. The codebase's own BDD suite demonstrates exactly the scenarios backup codes will need (concurrent single-use consumption, consume+state-change in one transaction, replay events) for password reset — the pattern is proven but nothing extends it to the recovery-code domain, so Phase 2 would start with zero acceptance harness.

## Evidence

Source: `spec/models/06-two-factor-totp.md:112`

```
None yet — no test exists.
```

## Recommended fix

When the plugin lands, add a two-factor feature mirroring BEH-EA-057/058's reset-token scenarios: a code consumes exactly once under concurrency, regeneration keeps the old set valid until the new set persists, a consumed code never both succeeds and replays silently.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: Backup Codes & Recovery
- Full dossier: [`backup-codes-recovery-specialist`](../../.reports/backup-codes-recovery-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BCR-006` — Shared per-account lockout counter for code brute-force is undecided and unowned](medium/BCR-006-backup-codes-recovery-specialist.md) `_(backup-codes-recovery-specialist, medium)_`
- [`SOS-006` — SIM-swap / NIST restricted-authenticator policy exists only in research; zero ADRs, decision explicitly undecided in spec](medium/SOS-006-sms-otp-specialist.md) `_(sms-otp-specialist, medium)_`
- [`THS-004` — TOTP secret encryption-at-rest left undecided despite a proven Encryption port](medium/THS-004-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, medium)_`
- [`THS-007` — Pre-session challenge state (challenge cookie) has no implementation and an undecided TTL/binding design](low/THS-007-totp-hotp-mfa-specialist.md) `_(totp-hotp-mfa-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `mfa-two-factor-hardening`. Evidence at HEAD ec065a7: `spec/models/06-two-factor-totp.md:112`. Fix: Write the two-factor behaviors + feature (including recovery codes) as the first artifact of the TwoFactor build decided in ticket 05, mirroring BEH-EA-057/058's reset-token scenarios. (effort M). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Progress note (2026-09-29, P15):** left open. The behaviors half is done: spec/behaviors/31-two-factor.md (BEH-EA-257..239) covers enable/confirm/verify, recovery codes, the challenge, the divert, the BeforeCredentialReset veto and the failure budget, backed by packages/two-factor/test. The Gherkin feature file and its REQ-EA id allocation were deliberately not written here: features/, features/traceability.md and allocate-req-ea.py are being edited by the concurrent BDD wiring agents and REQ ids are permanent, so allocating them from this branch would collide. Do it after those land (add features 29-31 to ORDER, then run allocate-req-ea.py).
