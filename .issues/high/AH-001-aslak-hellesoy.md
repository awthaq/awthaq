---
ID: "AH-001"
Title: "25 duplicate REQ-EA ids: admin feature hand-tagged with ids already allocated to roles/qadi features"
Level: high
Category: "testing"
Status: resolved
Package: "—"
Source: "features/features/09-admin-and-impersonation/27-admin-impersonation.feature:45"
Auditor: "aslak-hellesoy"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-001 — 25 duplicate REQ-EA ids: admin feature hand-tagged with ids already allocated to roles/qadi features

`HIGH` · `testing` · `—` · reported by **Aslak Hellesøy — Creator of Cucumber** (`aslak-hellesoy`)

Status: **resolved**

## Summary

The 25 scenarios in 27-admin-impersonation.feature carry ids REQ-EA-382..406, but those ids are already allocated to scenarios in 18-roles-subject-resolver.feature and 19-qadi-bridge-path-a.feature (verified: uniq -d over all @REQ-EA tags yields exactly 382–406; traceability.md maps 382–406 only to the 06-roles files). This directly violates the allocator's own rule that ids are permanent and never duplicated (allocate-req-ea.py line 12: 'it will not renumber or duplicate existing ids'). Root cause: 27-admin-impersonation.feature is absent from the script's ORDER list (allocate-req-ea.py lines 26–51 end at 26-cli.feature), so the file was tagged by hand outside the deterministic pass. Every traceability query for REQ-EA-382..406 is now ambiguous, and the whole admin feature is invisible in the manifest (0 rows).

## Evidence

Source: `features/features/09-admin-and-impersonation/27-admin-impersonation.feature:45`

```
@REQ-EA-382
```

## Recommended fix

Add 27-admin-impersonation.feature to ORDER in allocate-req-ea.py, strip its 25 hand-added tags, re-run the allocator so the scenarios receive fresh ids (>602), regenerate traceability.md, and make the allocator raise on any id collision instead of silently writing an ambiguous manifest.

## Context

- Auditor verdict on this domain: **needs-work** (score 51/100), domain: BDD acceptance suites
- Full dossier: [`aslak-hellesoy`](../../.reports/aslak-hellesoy/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BDD-001` — 25 REQ-EA ids double-allocated: admin feature reuses ids the manifest assigns to roles/qadi features](high/BDD-001-bdd-gherkin-acceptance-testing-specialist.md) `_(bdd-gherkin-acceptance-testing-specialist, high)_`
- [`IDS-010` — REQ-EA-382..406 identifiers collide between the impersonation feature and the roles/qadi-bridge traceability](low/IDS-010-impersonation-delegation-specialist.md) `_(impersonation-delegation-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — a grep across `features/features/` confirms `27-admin-impersonation.feature` carries `@REQ-EA-382` through `@REQ-EA-406`, all 25 of which are also tagged in `18-roles-subject-resolver.feature` (382-404) and `19-qadi-bridge-path-a.feature` (405-406). `features/scripts/allocate-req-ea.py`'s `ORDER` list (lines 26-51) ends at `26-cli.feature`, confirming `27-admin-impersonation.feature` was never run through the allocator. Fix (add to ORDER, strip tags, re-run allocator) is mechanical. Status → ready-for-agent.

**Resolved (2026-09-20):** Implemented the recommended fix exactly:

- `features/scripts/allocate-req-ea.py`: added `09-admin-and-impersonation/27-admin-impersonation.feature` to `ORDER` (end of list) and its `SOURCE_MD` mapping; added two new safety checks the recommended fix also asked for ("make the allocator raise on any id collision instead of silently writing an ambiguous manifest") — `check_order_matches_disk()` raises before any allocation runs if a `.feature` file on disk isn't listed in `ORDER` (the actual root cause here — a file present in the tree but unscanned can never have its tags cross-checked against anything), and `check_no_duplicate_req_ids()` raises if any `REQ-EA-NNN` id is tagged in more than one file among those actually scanned. `_smoke/smoke.feature` (deliberately outside the numbered specification, no `@BEH-EA`/`@REQ-EA` tags at all) is explicitly exempted from the first check.
- Stripped all 25 hand-added `@REQ-EA-382`..`406` tags from `27-admin-impersonation.feature`; re-running the allocator assigned fresh, non-colliding `REQ-EA-603` through `REQ-EA-627` (continuing past `26-cli.feature`'s own last id, 602) and regenerated `features/traceability.md` (627 rows, formatted via `oxfmt` to match the repo's own table style). Updated the file's own stale header comment (previously claimed "assigned here for the first time," which the finding itself quotes as the misleading evidence).
- `spec/traceability.md` §6: added the missing `09-admin-and-impersonation/27-admin-impersonation.feature` row (`209–220 | 603–627`) to the file-level crosswalk table, updated the "REQ-EA-001 through REQ-EA-627"/"627 rows" prose, and appended a Change History entry (1.4, CCR-EA-005).
- `features/README.md`: added the missing `09-admin-and-impersonation/` row to the directory table, updated "26 total"/"9 directories" to "27 total"/"10 directories".

Verified: `uniq -d` over every `@REQ-EA-NNN` tag across `features/features/**/*.feature` returns empty (no duplicates); re-running the allocator a second time is idempotent (0 newly assigned); `bash spec/scripts/verify-traceability.sh` passes all 19 checks (0 failures) including relative-link and anchor-fragment integrity across the two hand-edited spec docs. Verified to genuinely fail, twice: (1) running the allocator with the file still absent from `ORDER` reproduces exactly this finding's own root cause, caught by the new `check_order_matches_disk` with a message naming the missing file; (2) hand-editing one scenario's fresh tag to collide with an unrelated file's existing id (independent of check 1, since the file was already correctly listed in `ORDER` at that point) reproduces a real collision, caught by `check_no_duplicate_req_ids` naming both files and the colliding id. Both mutations reverted before the final run. Also closes [`BDD-001`](BDD-001-bdd-gherkin-acceptance-testing-specialist.md) (duplicate, high) and [`IDS-010`](../low/IDS-010-impersonation-delegation-specialist.md) (duplicate, low) — cross-referenced.
