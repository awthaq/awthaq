---
ID: "MLO-006"
Title: "No concurrent-consume test for BEH-EA-062's 'at most one concurrent caller succeeds' guarantee"
Level: low
Category: "testing"
Status: resolved
Package: "core"
Source: "packages/core/test/Verification.test.ts:112"
Auditor: "magic-link-email-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MLO-006 — No concurrent-consume test for BEH-EA-062's 'at most one concurrent caller succeeds' guarantee

`LOW` · `testing` · `core` · reported by **Magic Link / Email OTP Specialist** (`magic-link-email-otp-specialist`)

Status: **resolved**

## Summary

The dual-layer suite covers sequential consume-then-replay, concurrent issue races (lines 192-211, one live token), and replay events - but never races two concurrent consume calls for the same live token and asserts exactly one success. BEH-EA-062 is the module's headline race guarantee ('at most one MUST receive the non-expired row'); its memory-layer guard lives inside Ref.modify and the SQL guard inside UPDATE..RETURNING, and a regression that moved the win/lose decision outside the atomic step would pass the current suite while breaking under load. This is the exact test a magic-link double-click (prefetch plus real click) depends on.

## Evidence

Source: `packages/core/test/Verification.test.ts:112`

```
it.effect("BEH-EA-058/062: consuming succeeds exactly once, and a replay is refused", () =>
```

## Recommended fix

Add to the shared suite: issue one token, then Effect.all two consumes with concurrency unbounded and assert successes.length === 1 (mirroring the concurrent-issue test); runs against both layers via the existing suite() harness.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Passwordless Email Tokens
- Full dossier: [`magic-link-email-otp-specialist`](../../.reports/magic-link-email-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `verification-hardening`. Evidence at HEAD ec065a7: `packages/core/test/Verification.test.ts:99`. Fix: Add a concurrent-consume race test to the dual-layer Verification suite. (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Concurrent-consume race tests added: dual-layer Verification suite (exactly one success, one auth.token.replay) and a tryConsume race in packages/sql/test/Repositories.test.ts. The Postgres variant is not added (suite is skipped without a database).
