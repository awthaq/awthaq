---
phase: 07-world-scaffold-and-credentials-split-optional
plan: 03
subsystem: server-credentials
tags: [credentials, split, internal-modules, facade, verbatim-move, single-flight]
requires: ["07-02"]
provides:
  - "packages/server/src/internal/Resolution.ts: Rotation, Scope, Resolved, principalFields, make, with the three memo WeakMaps, once, Failure and annotatePrincipal kept file-private beside make"
  - "packages/server/src/internal/Scopes.ts: httpScope, collecting (rotationDelivery private)"
  - "packages/server/src/Credentials.ts: the pure facade (header comment plus 30 named re-exports, no import, no declaration)"
  - "07-CRED-SURFACE-AFTER.txt equal to 07-CRED-SURFACE-BEFORE.txt"
affects: []
key-files:
  created:
    - packages/server/src/internal/Resolution.ts
    - packages/server/src/internal/Scopes.ts
    - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-CRED-SURFACE-AFTER.txt
  modified:
    - packages/server/src/Credentials.ts
    - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-BASELINE.md
decisions:
  - "The memo tables, once and make moved together in one commit into one file, so single-flight (PCS-006/TS-003) stays one module instance; 3 WeakMaps in Resolution.ts, 3 across packages/server/src, 0 in the facade"
  - "No ADR, spec, docs or changeset change: ADR-EA-042 pins a module named Credentials, not a file layout; recorded in 07-BASELINE.md"
metrics:
  tasks: 3
  commits: 3
  plan_head_before: 07a0382106784dc5fec199945e18730fb25e5c02
  plan_head_after: eb91013b0bec0bfea81d3b94961b15f981bfe5a2
status: complete
actuals:
  tokens: 30000
  tasks: 3
  commits: 3
---

# Phase 7 Plan 3: Resolution and Scopes extraction, Credentials facade Summary

The resolution engine (with its memo tables) and the two scopes moved verbatim into `internal/Resolution.ts` and `internal/Scopes.ts`; `Credentials.ts` is now a 52-line pure facade of 30 named re-exports, and the after-split surface snapshot is byte-identical to the before snapshot.

## Commits

- `89702458` refactor(07-03): extract the resolution engine and its memo tables into internal/Resolution
- `29b590b6` refactor(07-03): split the scopes out and make Credentials.ts the facade
- `eb91013b` docs(07-03): record the Credentials split closure and the no-changeset decision

## Measured results

- Lines: `Credentials.ts` 678 (at `0b8c11f0`) -> 52; `internal/` PrincipalResolver 86, CredentialResolvers 163, Presented 97, Resolution 255, Scopes 107.
- Surface: AFTER snapshot 81 lines, 30 headings, sha256 `efbf9b94...9a1d`, `diff` against BEFORE 0 lines; live probe diff 0; `CredentialsSurface.test.ts` green and unedited (one commit since phase base).
- Probe mutation (drop `Source` from the type re-export): tsc green, pin green, probe diff non-empty (`## Source [type]`); restored, facade diff empty.
- VM verbatim check over the facade plus five internal modules: OK. Facade declarations 0 (was 45), imports 0 (was 19), `export *` 0.
- Single-flight: `new WeakMap` 3 in `Resolution.ts`, 3 in `packages/server/src`, 0 in the facade; no `internal/` file imports `../Credentials`.
- CP on SQLite: 100 files, 1593 passed, 1 expected fail (equal to the baseline row). Four behavioural server suites: 191 tests pass unedited.
- `tsc -b` and `tsc -p tsconfig.test.json` 0 errors; `pnpm circular`, `pnpm lint` exit 0; `pnpm format:check` clean; `pnpm knip` exit 1 with the baseline rows only (39 `.claude` files + 3 `readme-quickstart.ts`); `knip.json` unchanged.
- Empty diffs over `ee8b80a1..HEAD` for api-key, jwt, qadi, web, next, test, features, examples, spec, docs, `.changeset`, manifests and lockfile.

## Deviations from Plan

None - plan executed as written. Two small notes: the `// ---- the seam: a scope ---` and `// ---- the two scopes ---` divider comments moved with their code (the verbatim check requires every original non-blank line to survive), and no cross-file helper needed exporting beyond `resolveClaimed` (done in 07-02).

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Files present: `internal/Resolution.ts`, `internal/Scopes.ts`, `Credentials.ts`, `07-CRED-SURFACE-AFTER.txt`. Commits `89702458`, `29b590b6`, `eb91013b` are ancestors of HEAD; `git rev-list --count 07a03821..HEAD` printed 3.
