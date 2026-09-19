---
ID: "IDS-010"
Title: "REQ-EA-382..406 identifiers collide between the impersonation feature and the roles/qadi-bridge traceability"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "features/features/09-admin-and-impersonation/27-admin-impersonation.feature:6"
Auditor: "impersonation-delegation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# IDS-010 — REQ-EA-382..406 identifiers collide between the impersonation feature and the roles/qadi-bridge traceability

`LOW` · `docs` · `—` · reported by **Impersonation & Delegation Specialist** (`impersonation-delegation-specialist`)

Status: **resolved**

## Summary

The feature file asserts REQ-EA-382+ are 'assigned here for the first time', but features/traceability.md already maps REQ-EA-382 through REQ-EA-406 to BEH-EA-137..146 scenarios in 18-roles-subject-resolver.feature and 19-qadi-bridge-path-a.feature (traceability.md:402-426), and assigns REQ-EA-399/400-406 there too - the exact ids the impersonation feature uses for its 25 scenarios. Every impersonation scenario tag is therefore ambiguous in the central traceability index; requirement-to-test rollups will silently merge two different features' coverage.

## Evidence

Source: `features/features/09-admin-and-impersonation/27-admin-impersonation.feature:6`

```
# file at spec-authoring time. REQ-EA numbers below continue past 381
# (Passkey's own last), assigned here for the first time.
```

## Recommended fix

Reassign the impersonation feature's REQ-EA ids to an unclaimed range, regenerate its tags, and add the missing 27-admin-impersonation rows to traceability.md.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 71/100), domain: Impersonation & Delegation
- Full dossier: [`impersonation-delegation-specialist`](../../.reports/impersonation-delegation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 18 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-001` — 25 duplicate REQ-EA ids: admin feature hand-tagged with ids already allocated to roles/qadi features](high/AH-001-aslak-hellesoy.md) `_(aslak-hellesoy, high)_`
- [`BDD-001` — 25 REQ-EA ids double-allocated: admin feature reuses ids the manifest assigns to roles/qadi features](high/BDD-001-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, high)_`

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-20):** Duplicate of [`AH-001`](../high/AH-001-aslak-hellesoy.md) (same file, same defect). Its 25 scenarios now carry fresh, non-colliding `REQ-EA-603` through `REQ-EA-627`, and `features/traceability.md`/`spec/traceability.md` §6 both carry the `27-admin-impersonation.feature` rows this finding's own recommended fix asked for. See `AH-001`'s own resolution comment for full detail. No new change needed here — closing as a duplicate resolution, cross-referenced both ways.
