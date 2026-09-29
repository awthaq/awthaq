---
ID: "THS-006"
Title: "BEH-EA-110 default rate-limit rule for /two-factor/verify exists only in spec, BDD, and a fake-plugin fixture"
Level: medium
Category: "compliance"
Status: resolved
Package: "—"
Source: "features/features/04-cross-cutting/14-rate-limiting.feature:174"
Auditor: "totp-hotp-mfa-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# THS-006 — BEH-EA-110 default rate-limit rule for /two-factor/verify exists only in spec, BDD, and a fake-plugin fixture

`MEDIUM` · `compliance` · `—` · reported by **TOTP/HOTP MFA Specialist** (`totp-hotp-mfa-specialist`)

Status: **resolved**

## Summary

The 3-attempts/10-seconds default is specified (spec/behaviors/14-rate-limiting.md:127-138, REQUIREMENT: brute-force-target plugins MUST ship a default rule) and mechanically rehearsed in core/test/RateLimits.test.ts:74-78 — but through a fakePlugin('two-factor'), so the test proves registry scoping, not any shipped rule. Since the plugin is a placeholder, nothing today enforces the requirement for this endpoint, and the BDD scenario is unrunnable (no two-factor steps file exists). The pattern to copy is proven: the password plugin registers six default rules in its own layer (packages/password/src/Password.ts:392-440, e.g. signIn 5/15min at :157), keyed on identity rather than IP.

## Evidence

Source: `features/features/04-cross-cutting/14-rate-limiting.feature:174`

```
      Then "/two-factor/verify" is rate limited to 3 attempts per 10 seconds by a rule the plugin itself ships
```

## Recommended fix

When the plugin lands, register the default rule in TwoFactor's own layer exactly as password does (group: 'two-factor', endpoint: 'verify', limit 3 / 10 s), keyed on the challenge identifier (an unauthenticated endpoint has no principal); consider whether TOTP and recovery-code verification share one per-account counter, which is still an open Q58 question.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 24/100), domain: TOTP/HOTP MFA
- Full dossier: [`totp-hotp-mfa-specialist`](../../.reports/totp-hotp-mfa-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 23 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence medium); workstream `bdd-feature-wiring`. Duplicate of `THS-001` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/two-factor/src/index.ts:8`. Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → resolved.
