---
ID: "MLO-008"
Title: "Spec's uniform-response requirement stops at status/body and does not cover the timing channel the code itself names"
Level: info
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/behaviors/08-verification-tokens.md:121"
Auditor: "magic-link-email-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# MLO-008 — Spec's uniform-response requirement stops at status/body and does not cover the timing channel the code itself names

`INFO` · `docs` · `—` · reported by **Magic Link / Email OTP Specialist** (`magic-link-email-otp-specialist`)

Status: **resolved**

## Summary

BEH-EA-064's requirement is literally satisfied by the always-202 handlers, yet signUp's implementation comment cites research/05-oauth-oidc.md Q48 acknowledging that response latency is itself an enumeration side channel - knowledge the spec text does not encode. MLO-001 shows the gap is not hypothetical: code can comply with the written requirement while violating its evident intent. The cross-check confirms docs and code otherwise agree (410 TokenConsumed, purpose-scoped identifiers, hashed-at-rest, 24h/1h TTLs all match).

## Evidence

Source: `spec/behaviors/08-verification-tokens.md:121`

```
REQUIREMENT: A verification-token-issuing endpoint (password reset,
             email-verification resend) MUST return the same status and
             body whether or not the submitted identifier (email) resolves
```

## Recommended fix

Extend BEH-EA-064 (or add a note) to require latency uniformity for verification-token-issuing endpoints - e.g. mail dispatch must be asynchronous with respect to the response - so the timing oracle becomes a spec violation, not just a review finding.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Passwordless Email Tokens
- Full dossier: [`magic-link-email-otp-specialist`](../../.reports/magic-link-email-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `verification-timing-uniformity`. Evidence at HEAD ec065a7: `spec/behaviors/08-verification-tokens.md:120`. Fix: Extend BEH-EA-064 so latency uniformity is normative (mail dispatch asynchronous to the response; equal work in both branches), matching what bd1625c implemented. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** BEH-EA-064 extended: latency uniformity is normative (token issue + send for the exists branch run in the background so both branches do the same work before responding). BEH-EA-113 describes the owned dispatch.
