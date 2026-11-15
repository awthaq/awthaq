---
phase: 07-world-scaffold-and-credentials-split-optional
plan: 02
subsystem: server-credentials
tags: [credentials, split, internal-modules, facade, verbatim-move]
requires: ["07-01"]
provides:
  - "packages/server/src/internal/PrincipalResolver.ts: PrincipalResolverShape, PrincipalResolver, PrincipalResolverLive, PrincipalResolverWithUserFactsLive (userPrincipalOf private)"
  - "packages/server/src/internal/CredentialResolvers.ts: the claimed-credential registry plus resolveClaimed (exported, not re-exported by the facade); findClaim private"
  - "packages/server/src/internal/Presented.ts: Carrier, SessionCarrier, Presented, Source, presented, fromRequest, Tier, tier, userTier, optionalTier, machineTier (isCarrier, nonEmpty, bearerCredential, isUser, isAny private)"
affects: [07-03]
key-files:
  created:
    - packages/server/src/internal/PrincipalResolver.ts
    - packages/server/src/internal/CredentialResolvers.ts
    - packages/server/src/internal/Presented.ts
  modified:
    - packages/server/src/Credentials.ts
decisions:
  - "resolveClaimed is the only moved private helper that gained `export` (the research predicted exactly one); no other helper needed exporting"
  - "The divider comment `the principal resolver and the claimed-credential registry (moved from Authentication.ts)` moved with PrincipalResolver.ts (the verbatim check requires every original non-blank line to survive; the plan's `delete line 37` would have failed it)"
metrics:
  tasks: 2
  commits: 3
  plan_head_before: d743c8215407cd266ca4589f37407f62825cbd43
  plan_head_after: 3dd72e1c62f21026d3629adaea780cf0b94c9970
status: complete
actuals:
  tokens: 45000
  tasks: 2
  commits: 3
---

# Phase 7 Plan 2: Extract the three Credentials leaf modules Summary

The principal resolver, the claimed-credential registry and the presented-credentials/tier module now live in `packages/server/src/internal/`, moved verbatim, with `Credentials.ts` re-exporting every name by name (surface probe diff 0, pin green unedited).

## Commits

- `90f6de14` refactor(07-02): extract PrincipalResolver into internal/
- `46312183` refactor(07-02): extract the claimed-credential registry into internal/
- `3dd72e1c` refactor(07-02): extract the presented-credentials module into internal/

## Measured results

- `Credentials.ts` 678 -> 396 lines; new modules 86 / 163 / 97 lines (oxfmt-formatted).
- Surface probe diff against `07-CRED-SURFACE-BEFORE.txt`: 0 after each of the three commits. `CredentialsSurface.test.ts` green and unedited.
- Verbatim check (VM): OK over the facade plus the three modules; shown to print `FAIL bad=0 new=1` when a stray `const stray = 1;` was appended to `PrincipalResolver.ts` (mutation recorded, line removed, OK again).
- Leaf-name declarations still in `Credentials.ts`: 0 (5-name regex) and 0 (26-name regex). `export const resolveClaimed` in `internal/CredentialResolvers.ts`: 1.
- `new WeakMap` in `packages/server/src`: 3, all still in `Credentials.ts`; none in a leaf module. No `internal/` file imports `../Credentials`.
- CP on SQLite (`packages/server packages/qadi packages/web packages/jwt packages/api-key packages/next packages/test`): 100 files passed, 1593 passed, 1 expected fail (identical to the 07-01 baseline row).
- `tsc -b tsconfig.json` 0 errors; `tsc -p tsconfig.test.json` 0 errors; `pnpm circular` exit 0; `pnpm lint` exit 0 (warnings are the baseline set); `pnpm format:check` clean; `pnpm knip` exit 1 with the baseline rows only (39 `.claude` unused files + 3 `readme-quickstart.ts` unlisted dependencies).
- No change under `packages/api-key|jwt|qadi|web|next|test`, `features`, `examples`, `spec`, `docs`, `.changeset`, `knip.json`, `index.ts`, the ADR or a manifest (path diff against `ee8b80a1` prints 0 lines).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The divider comment at line 37 had to move with the code**
- **Found during:** Task 1
- **Issue:** the plan said to delete the divider through line 110 from the facade; the verbatim check requires every original non-blank line to survive somewhere, so deleting it would have printed FAIL.
- **Fix:** the comment line is kept verbatim in `internal/PrincipalResolver.ts` (the other two dividers, `what a request presents` and `tiers`, sit inside the `Presented.ts` range and moved with it).
- **Files modified:** `packages/server/src/internal/PrincipalResolver.ts`

**2. [Rule 3 - Blocking] `Presented.ts` needs the `Effect` import**
- **Found during:** Task 2 (tsc after the extraction)
- **Issue:** the plan's import list for `Presented.ts` omitted `effect/Effect` (`presented` uses `Effect.fnUntraced`); tsc reported TS2304 and, cascading, the downstream importers' inference failures.
- **Fix:** added `import * as Effect from "effect/Effect";`.
- **Files modified:** `packages/server/src/internal/Presented.ts`

Facade imports removed as unused after the moves (tsc TS6133): `Users`, `DateTime`, `Context`, `Data`, `Layer`, `Record`, `Headers`, `HttpApiSecurity`.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Files present: `internal/PrincipalResolver.ts`, `internal/CredentialResolvers.ts`, `internal/Presented.ts`, `Credentials.ts`. Commits `90f6de14`, `46312183`, `3dd72e1c` are ancestors of HEAD; `git rev-list --count d743c821..HEAD` printed 3.
