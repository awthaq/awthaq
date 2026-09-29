---
ID: "TIR-006"
Title: "revokeAll missing from BEH-EA-031 spec and BDD endpoint table"
Level: low
Category: "docs"
Status: ready-for-agent
Package: "—"
Source: "features/features/01-contract-and-persistence/04-contract-stratum.feature:200"
Auditor: "token-introspection-revocation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TIR-006 — revokeAll missing from BEH-EA-031 spec and BDD endpoint table

`LOW` · `docs` · `—` · reported by **Token Introspection & Revocation Specialist** (`token-introspection-revocation-specialist`)

Status: **ready-for-agent**

## Summary

The contract ships six session endpoints - packages/api/src/Session.ts:58 adds POST /session/revoke-all, and server Session.ts:120-124 implements it - but BEH-EA-031's requirement text and this feature file's endpoint table still enumerate five (current, list, signOut, revoke, revokeOthers). Consequence: the only bulk revocation that kills the caller's own session too (used by password reset, TIR-004) has zero BDD coverage and no spec text defining its contract, and traceability REQ-EA-079 asserts a five-endpoint surface the code no longer matches.

## Evidence

Source: `features/features/01-contract-and-persistence/04-contract-stratum.feature:200`

```
| signOut       | POST   | /auth/session/sign-out      |
| revoke        | POST   | /auth/session/revoke        |
| revokeOthers  | POST   | /auth/session/revoke-others |
```

## Recommended fix

Amend BEH-EA-031 to six endpoints, add the revoke-all row to the feature table with a scenario (revoke-all kills the caller's current session; next request with the old cookie is rejected), and add a SessionSteps definition.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token revocation & introspection
- Full dossier: [`token-introspection-revocation-specialist`](../../.reports/token-introspection-revocation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-suite-docs`. Evidence at HEAD ec065a7: `spec/behaviors/04-contract-stratum.md:142`. Fix: Amend BEH-EA-031 to six endpoints, add revokeAll to the 04-contract-stratum endpoint table, and add a wired sessions scenario for revoke-all under BEH-EA-054. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.
