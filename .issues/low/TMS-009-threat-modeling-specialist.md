---
ID: "TMS-009"
Title: "spec/invariants.md banner claims 'no line of runtime source exists' while 17 packages ship enforcing code"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/invariants.md:19"
Auditor: "threat-modeling-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TMS-009 — spec/invariants.md banner claims 'no line of runtime source exists' while 17 packages ship enforcing code

`LOW` · `docs` · `—` · reported by **Threat Modeling Specialist** (`threat-modeling-specialist`)

Status: **resolved**

## Summary

The document's authority hinges on its honesty banner, and the banner is false: Sessions, Verification, AuthEvents, RateLimits, the password/OAuth flows, server middleware, and SQL migrations all exist and enforce several listed invariants (INV-EA-007 via hashSecret + constantTimeEqual at Sessions.ts:35-48, INV-EA-015 via UNIQUE(providerId, subject, issuer) at CoreMigrations.ts:93). Every 'Enforcement: planned, no test exists yet' cell is likewise stale where tests do exist. A reader trusting the banner would under-trust the system as much as one ignoring it would over-trust it — for a threat model, a wrong trust-assumption document is itself a vulnerability.

## Evidence

Source: `spec/invariants.md:19`

```
> **Banner — read before relying on anything below.** awthaq is pre-implementation (see `archive/PRD.md` and `spec/README.md`): no package has been published, no line of runtime source exists.
```

## Recommended fix

Regenerate the banner and Enforcement cells against the actual tree (which invariants have code, which have tests), and add a CI check that fails when a code-enforced invariant still claims to be unimplemented.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: STRIDE threat model
- Full dossier: [`threat-modeling-specialist`](../../.reports/threat-modeling-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 21 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`DTWS-007` — spec/invariants.md enforcement cells say tests 'do not exist yet' for files that now exist](low/DTWS-007-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `spec-bdd-traceability-refresh`. Evidence at HEAD ec065a7: `spec/invariants.md:19`. Fix: Regenerate every INV-EA-007..016 Enforcement cell against the real tree (cite the actual test + BEH id, or state honestly 'no test') and add a verify-traceability check that fails when a cell says '(no test exists yet)' for a file that exists, or names a file that doesn't. (effort M). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** spec/invariants.md rev 1.4: banner and the '(planned)' section title replaced; every INV-EA-007..016 Enforcement cell names the test that exists (Sessions.test.ts, Verification.test.ts, Csrf tests, Resolvers.test.ts, Accounts and OAuth tests, Admin tests, runPluginContractTests for the prefix half of 016) or says so when none does (013's refusal is qadi's, 016's DDL half is untested); spec/traceability.md section 3 agrees and cites core/test/Observability.test.ts for ADR-EA-029. New check 10 (enforcement cells vs tree) was red on 8 invariants.md cells before, green after. DTWS-007 closes as its duplicate. Gates: pnpm run typecheck clean, pnpm run spec:verify:strict 28/28, pnpm run check:readmes green.
