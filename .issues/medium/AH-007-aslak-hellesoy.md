---
ID: "AH-007"
Title: "Catch-all Given(\"{string}\") step dispatches on substring content"
Level: medium
Category: "testing"
Status: resolved
Package: "—"
Source: "features/step-definitions/PasswordSteps.ts:481"
Auditor: "aslak-hellesoy"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-007 — Catch-all Given("{string}") step dispatches on substring content

`MEDIUM` · `testing` · `—` · reported by **Aslak Hellesøy — Creator of Cucumber** (`aslak-hellesoy`)

Status: **resolved**

## Summary

A parameterless-structure Given whose pattern is just {string} matches any quoted string in any Given position of the password feature, and routes by substring sniffing (includes("onUnavailable"), includes("minLength: 12")) with a fallback branch the comment admits is unreachable. It coexists with an overlapping specific step Given("{string} with no {string} override") at line 499. This is the unmaintainable-glue failure mode in Cucumber-expression form: adding any new Given sentence containing a quoted string to this feature silently routes into this matcher, and the dispatch key is invisible in the .feature file. The in-file comment shows the authors know Cucumber-expression metacharacters caused this; the workaround chose maximum ambiguity instead of escaping.

## Evidence

Source: `features/step-definitions/PasswordSteps.ts:481`

```
Given("{string}", function* (configExpr: string) {
    if (configExpr.includes("onUnavailable")) {
```

## Recommended fix

Replace with explicitly escaped literal steps (escape (, ), {, } in the pattern) or distinctive step sentences, and delete the fallback branch. A suite-wide check that no step pattern is a bare {string} would prevent recurrence.

## Context

- Auditor verdict on this domain: **needs-work** (score 51/100), domain: BDD acceptance suites
- Full dossier: [`aslak-hellesoy`](../../.reports/aslak-hellesoy/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-004` — Given/When inversion: Given performs the action while When is a stub](medium/AH-004-aslak-hellesoy.md) `_(aslak-hellesoy, medium)_`
- [`AH-008` — Scenario text documents fiction: named sessions and emails are silently replaced in wiring](low/AH-008-aslak-hellesoy.md) `_(aslak-hellesoy, low)_`
- [`AH-009` — Replay scenario asserts the same status twice and no-ops its non-repetition claim](low/AH-009-aslak-hellesoy.md) `_(aslak-hellesoy, low)_`
- [`CSD-009` — 5xx breach-check scenario passes coincidentally and cannot detect the CSD-001 defect](low/CSD-009-credential-stuffing-defense-specialist.md) `_(credential-stuffing-defense-specialist, low)_`
- [`TIR-005` — BDD step asserting the reset transaction is an empty stub](medium/TIR-005-token-introspection-revocation-specialist.md) `_(token-introspection-revocation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `bdd-step-definition-quality`. Evidence at HEAD ec065a7: `features/step-definitions/PasswordSteps.ts:492`. Fix: Replace the bare {string} Given with a dedicated custom parameter type that maps the exact literal config expressions to Password.config values (failing on an unknown literal), delete the fallback branch, and add a lint guard forbidding bare-{string} step patterns. (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** P20a: bare Given({string}) replaced by the typed parameter types passwordConfig/breachFailure (PasswordParameterTypes.ts), oauthConfig and passkeyConfig; an unknown literal fails loudly at feature load. Guard test features/features/_guard/step-patterns.steps.test.ts fails on any exactly-{string} step pattern in step-definitions.
