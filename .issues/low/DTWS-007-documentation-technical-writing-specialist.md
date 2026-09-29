---
ID: "DTWS-007"
Title: "spec/invariants.md enforcement cells say tests 'do not exist yet' for files that now exist"
Level: low
Category: "docs"
Status: resolved
Package: "—"
Source: "spec/invariants.md:87"
Auditor: "documentation-technical-writing-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# DTWS-007 — spec/invariants.md enforcement cells say tests 'do not exist yet' for files that now exist

`LOW` · `docs` · `—` · reported by **Documentation & Technical Writing Specialist** (`documentation-technical-writing-specialist`)

Status: **resolved**

## Summary

INV-EA-007's enforcement cell names packages/core/test/Sessions.test.ts as 'no test exists yet', but that file exists and passes spec-referencing assertions (e.g. line 343: 'BEH-EA-055: the session cookie name and attributes are fixed'). The same '(no test exists yet)' pattern repeats across the runtime-invariant section (INV-EA-008 through INV-EA-016). The banner-and-cell scaffolding was built to make absence loud; now that tests landed, the cells that haven't been flipped make the document overstate what is unverified, and a reader cannot tell which invariants genuinely lack enforcement.

## Evidence

Source: `spec/invariants.md:87`

```
**Enforcement**: Planned: `packages/core/test/Sessions.test.ts` (no test exists yet).
```

## Recommended fix

Flip each enforcement cell whose named test file now exists from 'Planned ... (no test exists yet)' to a citation of the actual test and the behavior id it asserts; consider a spec/scripts check that greps '(no test exists yet)' against the filesystem.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Documentation & Spec Drift
- Full dossier: [`documentation-technical-writing-specialist`](../../.reports/documentation-technical-writing-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 24 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`TMS-009` — spec/invariants.md banner claims 'no line of runtime source exists' while 17 packages ship enforcing code](low/TMS-009-threat-modeling-specialist.md) `_(threat-modeling-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `spec-bdd-traceability-refresh`. Duplicate of `TMS-009` — closed by that issue's fix. Evidence at HEAD ec065a7: `spec/invariants.md:87`. Full dossier: `.plan/slices/12-spec.md`. Status → resolved.
