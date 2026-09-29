---
ID: "PHS-005"
Title: "Rehash-on-login upgrade path has no positive test; @skip'd BDD scenarios claim coverage that does not exist"
Level: medium
Category: "testing"
Status: resolved
Package: "—"
Source: "features/features/05-authentication-methods/15-password.feature:110"
Auditor: "password-hashing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# PHS-005 — Rehash-on-login upgrade path has no positive test; @skip'd BDD scenarios claim coverage that does not exist

`MEDIUM` · `testing` · `—` · reported by **Password Hashing Specialist** (`password-hashing-specialist`)

Status: **resolved**

## Summary

The only domain-level rehash test in the repo (packages/password/test/Password.test.ts:174-205) asserts the NEGATIVE case ('does not spuriously rehash'). Nothing anywhere signs in against a hash stored under outdated parameters and asserts the stored credential is replaced - the actual BEH-EA-116 security migration. The feature file skips REQ-EA-313/315 with a comment claiming the behavior is 'already covered at the domain level by packages/password/test/Password.test.ts's own rehash-on-login tests', which grep shows is false (the plural claim reduces to the single negative test). The upgrade path also interacts with finding PHS-002 (a downgrade would currently pass unnoticed), so the most security-relevant branch of signIn ships untested.

## Evidence

Source: `features/features/05-authentication-methods/15-password.feature:110`

```
@skip
    @REQ-EA-313
    Scenario: A sign-in against a hash stored under outdated parameters triggers a rehash with current parameters
```

## Recommended fix

Add a domain test: signUp under a layer configured with low params, rebuild the plugin with stronger params (or hand-write a stale PHC into the account), signIn, and assert findCredentialHash now returns a hash whose parsed parameters equal the new config and that the new hash verifies. Then either implement or correct the @skip justification text in the feature file.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Password hashing
- Full dossier: [`password-hashing-specialist`](../../.reports/password-hashing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 6 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-skip-debt`. Evidence at HEAD ec065a7: `features/features/05-authentication-methods/15-password.feature:108`. Fix: Add a positive domain test for BEH-EA-116 rehash-on-login, then un-skip REQ-EA-313/314 via a PasswordWorld credential-hash read handle (or correct the skip text to cite the new test). (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** P20a: positive unit test for rehash-on-login added to packages/password/test/Password.test.ts and REQ-EA-313/314/315 un-skipped through a credential-hash read handle in PasswordWorld.
