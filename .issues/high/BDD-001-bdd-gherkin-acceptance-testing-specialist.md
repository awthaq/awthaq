---
ID: "BDD-001"
Title: "25 REQ-EA ids double-allocated: admin feature reuses ids the manifest assigns to roles/qadi features"
Level: high
Category: "testing"
Status: resolved
Package: "—"
Source: "features/features/09-admin-and-impersonation/27-admin-impersonation.feature:5"
Auditor: "bdd-gherkin-acceptance-testing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BDD-001 — 25 REQ-EA ids double-allocated: admin feature reuses ids the manifest assigns to roles/qadi features

`HIGH` · `testing` · `—` · reported by **BDD/Gherkin Acceptance Testing Specialist** (`bdd-gherkin-acceptance-testing-specialist`)

Status: **resolved**

## Summary

The admin file's header claims ids 382+ were 'assigned here for the first time', but REQ-EA-382..406 are already mapped to scenarios in 18-roles-subject-resolver.feature and 19-qadi-bridge-path-a.feature (features/traceability.md:402-426), and those files currently carry the same @REQ-EA tags (e.g. 18-roles-subject-resolver.feature:190 '@REQ-EA-402' vs 27-admin-impersonation.feature:35 '@REQ-EA-402'). This breaks the allocator's 1:1 'parallel authors never collide' invariant: 627 scenario tags resolve to only 602 unique ids, 'grep @REQ-EA-402' is ambiguous, and ids are declared permanent by spec/process/requirement-id-scheme.md. The file was also never added to allocate-req-ea.py's ORDER list (only 26 entries), so the script cannot detect or heal the collision — exactly the drift-between-authors failure the tooling exists to prevent.

## Evidence

Source: `features/features/09-admin-and-impersonation/27-admin-impersonation.feature:5`

```
# file at spec-authoring time. REQ-EA numbers below continue past 381
# (Passkey's own last), assigned here for the first time.
```

## Recommended fix

Add 09-admin-and-impersonation/27-admin-impersonation.feature to allocate-req-ea.py's ORDER (and SOURCE_MD), strip its 25 hand-taken tags, and re-run the allocator so its 25 scenarios receive 603-627; regenerate features/traceability.md and spec/traceability.md §6, and consider adding a duplicate-id assertion to the script.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: BDD acceptance testing
- Full dossier: [`bdd-gherkin-acceptance-testing-specialist`](../../.reports/bdd-gherkin-acceptance-testing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-001` — 25 duplicate REQ-EA ids: admin feature hand-tagged with ids already allocated to roles/qadi features](high/AH-001-aslak-hellesoy.md) `_(aslak-hellesoy, high)_`
- [`IDS-010` — REQ-EA-382..406 identifiers collide between the impersonation feature and the roles/qadi-bridge traceability](low/IDS-010-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Resolved (2026-09-20):** Duplicate of [`AH-001`](AH-001-aslak-hellesoy.md) (same file, same defect, same recommended fix — this finding's own predicted range, "603-627", is exactly what the allocator assigned). See `AH-001`'s own resolution comment for full detail. No new change needed here — closing as a duplicate resolution, cross-referenced both ways.

**Validation (2026-09-19):** CONFIRMED — `grep -n "@REQ-EA-402" features/features/**/*.feature` returns both `06-roles-and-authorization-bridge/18-roles-subject-resolver.feature:190` and `09-admin-and-impersonation/27-admin-impersonation.feature:35`; `features/traceability.md:402` maps REQ-EA-402 to the roles-subject-resolver file only. `features/scripts/allocate-req-ea.py:25-51`'s `ORDER` list has exactly 26 entries and does not include `09-admin-and-impersonation/27-admin-impersonation.feature`, so the allocator cannot detect the collision. Fix is a mechanical script/data change (add to ORDER, re-run, regenerate traceability). Status → ready-for-agent.
