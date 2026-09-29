---
ID: "SOS-005"
Title: "qadi has no factor-strength/assurance vocabulary, so an SMS factor could not be policy-ranked below a passkey"
Level: medium
Category: "security"
Status: resolved
Package: "qadi"
Source: "packages/qadi/src/index.ts:3"
Auditor: "sms-otp-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SOS-005 — qadi has no factor-strength/assurance vocabulary, so an SMS factor could not be policy-ranked below a passkey

`MEDIUM` · `security` · `qadi` · reported by **SMS OTP Specialist** (`sms-otp-specialist`)

Status: **resolved**

## Summary

A grep for strength|assurance|aal|trust|weak|mfa|factor across packages/qadi returns zero matches: the bridge carries subjects, resolvers, and obligations, but nothing records HOW a principal authenticated. The research corpus is explicit that this vocabulary is required before SMS ships — research/07-passwords-2fa.md:142 demands the sms-otp plugin be 'marked degraded: never a default factor, requires the operator to attest alternatives exist', and NIST 800-63B-4's restricted-authenticator status (research/07-passwords-2fa.md:132) only makes sense if a policy layer can demand a stronger factor for sensitive operations. Without an assurance-level notion on the session/subject, the first SMS-OTP implementation would authenticate at exactly the same strength as a passkey, and no qadi rule could tell them apart.

## Evidence

Source: `packages/qadi/src/index.ts:3`

```
// AuthorizedSubject middleware (Path A), SubjectExtractor layer (Path B),
// the SubjectResolver slot, and resolvers/obligation handlers — the bridge
// to qadi, not an authorizer of its own (ADR-EA-009).
```

## Recommended fix

Add an assurance/strength field to the session or subject model (an AAL-like enum: password < otp/sms < totp < passkey), set it at session issuance from the factor used, and expose it to qadi resolvers so policies can require minimum strength. Land this before, not after, the first SMS plugin — retrofitting assurance onto existing sessions is a migration.

## Context

- Auditor verdict on this domain: **needs-work** (score 42/100), domain: SMS OTP readiness
- Full dossier: [`sms-otp-specialist`](../../.reports/sms-otp-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 25 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-assurance-channel`. Evidence at HEAD ec065a7: `packages/qadi/src/index.ts:3`. Fix: Add the assurance vocabulary on top of AAPS-006's amr channel so SMS can be policy-ranked below TOTP/passkey before any SMS plugin ships. (effort M). Full dossier: `.plan/slices/08-authz-org-roles-qadi.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Assurance vocabulary on the amr channel: Assurance.assuranceLevel/assurance/satisfies and isRestrictedFactor (sms ranks below totp/passkey and never reaches aal2 alone), Sessions.AuthMethod includes sms before any SMS plugin exists. Tests: packages/core/test/Assurance.test.ts. BEH-EA-258, ADR-EA-021.
