---
phase: 06-record-store-scaffolding
plan: 06
subsystem: testing
tags: [wave-0, ordering, comparator, equal-createdAt, rec-03, rec-04]

requires:
  - phase: 06-record-store-scaffolding
    provides: 06-BASELINE.md (path allowlist, comparison rule), 06-SPIKE.md comparator adopters and tie fields, 06-05 source-scan pin
provides:
  - four RecordOrderPins.test.ts files (organization, saml, scim, webhooks), the Wave 0 equal-createdAt ordering oracle for the comparator helper
  - 06-BASELINE.md "06-06" record: the 11-site comparator map and the allowlist line
affects: [06-07, 06-08, 06-09, 06-10, 06-11, 06-12]

requirements-completed: []

actuals:
  tokens: 12000
  tasks: 2
  commits: 3
commits: 3
plan_head_before: 8d09eceddb22ddccdb8766de4ba014d9e331e4aa
plan_head_after: ea6d4cc57db41c2949bfce9bba4a32bc38cba63b

tech-stack:
  added: []
  patterns: ["tie pin: X inserted first, then C, A, B one millisecond later, expected order a literal; memory and SQL built from one case list", "store-minted ids (TeamRecords): expected order is the ids sorted by Array.prototype.sort() with no comparator"]

key-files:
  created:
    - packages/organization/test/RecordOrderPins.test.ts
    - packages/saml/test/RecordOrderPins.test.ts
    - packages/scim/test/RecordOrderPins.test.ts
    - packages/webhooks/test/RecordOrderPins.test.ts
  modified:
    - .planning/phases/06-record-store-scaffolding/06-BASELINE.md

key-decisions:
  - "No pin was red on unchanged src: memory and SQL agree on every equal-createdAt case for canonical ids, so no finding to report"
  - "saml, scim and webhooks pin files share one commit (the plan's choice); each pin file still has exactly one commit"

duration: ~25m
completed: 2026-11-14
status: complete
---

# Phase 6 Plan 06: Equal-createdAt order pins Summary

Four pin files fix, before any `src` change, the equal-`createdAt` order of every listing the comparator helper will rewrite and that had no tie case (ConnectionRecords, TeamRecords descendants and subtree, SamlRecords both directions, ScimRecords connections, links and linksOfResource, WebhookRecords endpoints, enabled endpoints and deliveries by subject); 06-BASELINE.md maps all 11 comparator sites to the case that pins each.

## Task Commits

1. Task 1: `3b75b1ea` test(06-06): pin organization listing order on equal createdAt before the comparator change
2. Task 2: `726235f8` test(06-06): pin saml, scim and webhooks listing order on equal createdAt before the comparator change
3. Task 2 (record): `ea6d4cc5` docs(06-06): record the equal-createdAt pins and the comparator site map

## Results

- 22 new tests (11 cases x 2 modes): organization 6, saml 4, scim 6, webhooks 6. Five-file command (the four pins plus `packages/sql/test/RecordsScaffoldPins.test.ts`): `Test Files 5 passed (5)`, `Tests 26 passed (26)` on SQLite and on Postgres (`AWTHAQ_POSTGRES_URL=postgres://postgres:pw@localhost:55433/awthaq`, Debian postgres:16, 16.16). run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote).
- `npx tsc -b tsconfig.json` and `npx tsc -p tsconfig.test.json` clean; `pnpm lint` exit 0 with no finding for the files; `pnpm format:check` clean; `pnpm check:contract-tests` prints `all 21 plugin classes run the contract suite`.
- Grep gate `Keyset|localeCompare|toEpochMillis` over the pins: 0. `git diff --name-only 3be32564 -- packages examples | grep -cE '/src/|/test/contract/'`: 0.
- The five reused contract cases (sites 1, 2, 3, 5, 7) were re-read and each ties on `createdAt`; recorded in 06-BASELINE.md. Site 5's tie rests on the frozen test clock (no advance between the three creates), noted there.
- Allowlist gained the four pin paths. No full-suite run was needed, so no known intermittent fired; no pin was run more than once per leg.

## Deviations from Plan

None - plan executed as written.

## Known Stubs

None.

## Threat Flags

None.

## Not done

- No mutation check (breaking a `src` comparator to see a pin go red): the plan forbids any `src` change and does not ask for one; the pins are shown green on both adapters only.

## Self-Check: PASSED

- FOUND: packages/organization/test/RecordOrderPins.test.ts, packages/saml/test/RecordOrderPins.test.ts, packages/scim/test/RecordOrderPins.test.ts, packages/webhooks/test/RecordOrderPins.test.ts
- FOUND commits: 3b75b1ea, 726235f8, ea6d4cc5
