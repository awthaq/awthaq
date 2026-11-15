---
phase: 07-world-scaffold-and-credentials-split-optional
plan: 05
subsystem: features-world-scaffold
tags: [bdd, world, event-capture, passwordworld, domainworld, postgres]
requires: ["07-04"]
provides:
  - "PasswordWorld.ts and DomainWorld.ts adopt captureEvents at the old subscriber position; Admin, Password and Domain are the three scaffolded Worlds"
  - "recorded missing-requirement mutation on the scaffolded DomainWorld (red at TestAuth.serve) and the dropped-plugin mutation recorded as found"
  - "07-BASELINE.md adoption section: per-World deltas, NET line, SQLite bdd, Postgres targeted run, integrity checks"
affects: ["07-06", "07-07"]
key-files:
  modified:
    - features/step-definitions/PasswordWorld.ts
    - features/step-definitions/DomainWorld.ts
    - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-BASELINE.md
decisions:
  - "The helper is kept for locality of the reproduced-race fix, not for size: NET is -1 (removed 50, added 7, helper 44), one line larger overall"
  - "The surviving compile-time gate in a scaffolded World is a composed plugin's unmet requirement at TestAuth.serve; dropping a plugin nothing else forces stays green"
metrics:
  tasks: 3
  commits: 3
  plan_head_before: 395cd831ea46e45da89aa7e6d6c3ef416399f786
  plan_head_after: 9e499894a39e38691060f2381af93fd9e06e891f
status: complete
actuals:
  tokens: 3000
  tasks: 3
  commits: 3
---

# Phase 7 Plan 5: PasswordWorld and DomainWorld adopt captureEvents Summary

`PasswordWorld` and `DomainWorld` drop their inline `AuthEvents` subscriber for `captureEvents(events)` / `captureEvents(probes.events)` at the same `services` position; full bdd (SQLite) is unchanged and the three Worlds' five feature files pass on Postgres with equal counts.

## Commits

- `5297eb93` refactor(07-05): PasswordWorld adopts captureEvents
- `1aea6d49` refactor(07-05): DomainWorld adopts captureEvents
- `9e499894` docs(07-05): record the World scaffold adoption on SQLite and Postgres

## Measured results

- Deltas: `ADOPTION-DELTA world=AdminWorld removed=22 added=3`, `world=PasswordWorld removed=14 added=2`, `world=DomainWorld removed=14 added=2`. Helper 44 lines (pin 43 lines, not counted). `NET` 50 - 7 - 44 = -1: no size win; kept for locality of the race fix.
- Password files: 2 files, 72 passed. Domain files: 2 files, 68 passed. Leak-guard lines `apps=0 sqlClients=0`.
- Mutation (a), `NoBreachHttpClient` omitted from DomainWorld `services`: tsc red at `DomainWorld.ts(280,39)` (`TestAuth.serve(appLayer)`), TS2379 + TS377034 (plus TS6133 unused constant). Mutation (b), `Password.Password` dropped from the `Auth.make` tuple: green, recorded as found. Both restored from a byte copy (empty diff, green tsc).
- Full `pnpm test:bdd` on SQLite: 39 files, 1580 passed, 44 skipped; sorted `[leak-guard]` diff against `07-LEAK-GUARD-BEFORE.txt` 0 lines.
- Postgres (fresh `awthaq-p3-pg`, Debian postgres:16, explicit URL), Admin + Password x2 + Domain x2 feature files: exit 0, 5 files, 177 passed, five leak-guard lines `apps=0 sqlClients=0`; no intermittent fired. Run locally on the CI image (Debian postgres:16), CI confirmation open (no git remote).
- `tsc -b` and `tsc -p tsconfig.test.json` 0 errors; `pnpm lint` exit 0 (baseline warnings only); `pnpm format:check` clean; `pnpm circular` exit 0; `pnpm knip` exit 1 with baseline rows only.
- Integrity since `ee8b80a1`: the 28 other Worlds, the five hand-wired Worlds, `OrganizationWorld` and `packages/test`: empty diffs.

## Deviations from Plan

None - plan executed exactly as written. The one deviation-adjacent note: the plan's NET sentence is conditioned on "net not negative"; the measured NET is -1 (code base one line larger), and the record states the locality rationale regardless.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Files edited exist; commits `5297eb93`, `1aea6d49`, `9e499894` are in HEAD's history.
