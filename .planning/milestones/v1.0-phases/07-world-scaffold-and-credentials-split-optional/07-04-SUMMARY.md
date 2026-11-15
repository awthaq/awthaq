---
phase: 07-world-scaffold-and-credentials-split-optional
plan: 04
subsystem: features-world-scaffold
tags: [bdd, world, event-capture, type-pin, adminworld]
requires: ["07-03"]
provides:
  - "features/step-definitions/shared/EventCapture.ts: captureEvents, the shared AuthEvents subscriber layer (startImmediately, optional narrowing predicate), needs only AuthEvents"
  - "features/step-definitions/shared/EventCapture.types.ts: three tsc claims (exact requirement, closed composition, refused foreign tap)"
  - "AdminWorld.ts adopts captureEvents at the taps position"
affects: ["07-05"]
key-files:
  created:
    - features/step-definitions/shared/EventCapture.ts
    - features/step-definitions/shared/EventCapture.types.ts
  modified:
    - features/step-definitions/AdminWorld.ts
    - .planning/phases/07-world-scaffold-and-credentials-split-optional/07-BASELINE.md
decisions:
  - "captureEvents is overloaded (PublishedAny Ref without predicate; narrowed Ref with a type predicate) over one generic implementation with an accept-all default: compiled and linted first time, no two-export fallback, no cast"
  - "Closed-composition claim is stated as Layer.Services extends never (a Layer<unknown, unknown, never> assignment is rejected by variance)"
metrics:
  tasks: 2
  commits: 3
  plan_head_before: b8b3ee9825a8b1d08576dc485ff657acf05ededd
  plan_head_after: 30dfee3aa1f4285f81ac77dc90376b42f478806d
status: complete
actuals:
  tokens: 2300
  tasks: 2
  commits: 3
---

# Phase 7 Plan 4: captureEvents helper, its type pin, Admin adoption Summary

`captureEvents` (44 lines) is the one shared `AuthEvents` subscriber layer, composing with `TestAuth.layer` through `taps`/`services` and wrapping nothing; a three-claim type pin proves it adds no plugin requirement; `AdminWorld` adopts it (22 lines removed, 3 added) with bdd counts and leak-guard lines unchanged.

## Commits

- `c727c75a` test(07-04): add captureEvents and its type-level pin
- `c34c34e3` refactor(07-04): AdminWorld adopts captureEvents
- `30dfee3a` docs(07-04): record the captureEvents helper, its pin and the Admin adoption

## Measured results

- Helper: overloaded form accepted by `tsc` and `pnpm lint`; no fallback used. Imports only `AuthEvents` (core) and effect modules; no `@awthaq/test`, `@awthaq/server` or `Auth.make`.
- Pin mutations (each restored by byte copy, `cmp` clean): implementation reading `Sessions` is rejected inside the helper by its `Capture` annotation (TS2375); declared requirement widened with `Sessions` or `Mailer` turns claim 1 red only (the harness provides both); widened with a service no harness provides turns claims 1 and 2 red; claim 3 without `@ts-expect-error` gives TS2379.
- `ADOPTION-DELTA world=AdminWorld removed=22 added=3`.
- Admin feature: 37 passed, `[leak-guard] ... apps=0 sqlClients=0`.
- bdd: Test Files 39 passed, Tests 1580 passed, 44 skipped (equal to baseline); sorted `[leak-guard]` lines diff against `07-LEAK-GUARD-BEFORE.txt` is 0 lines.
- `tsc -b` and `tsc -p tsconfig.test.json` 0 errors; `pnpm lint` exit 0 (baseline warnings only); `pnpm format:check` clean; `pnpm circular` exit 0; `pnpm knip` exit 1 with the baseline rows only.
- `git diff --name-only ee8b80a1 HEAD -- packages/test features/step-definitions/OrganizationWorld.ts` prints nothing.

## Deviations from Plan

None in outcome. Notes:

1. The plan's mutation "make the helper require one more service" is caught by the helper's own return annotation, not by the pin; the pin goes red when the declared requirement is widened (see above). Claim 2 stays green for `Sessions`/`Mailer` because `TestAuth.layer` provides them; a service nobody provides turns it red. All recorded in `07-BASELINE.md`.
2. Claim 2 uses `[Layer.Services<typeof closed>] extends [never]` instead of the plan's `Layer<unknown, unknown, never>` assignment, which `exactOptionalPropertyTypes` variance rejects for a non-empty `ROut`.
3. The `@effect-diagnostics-next-line` directive was dropped from the pin (TS377000: no effect); `@ts-expect-error` alone holds.
4. The pin file is checked by `npx tsc -b tsconfig.json`, not by `tsconfig.test.json`.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Files present: `shared/EventCapture.ts`, `shared/EventCapture.types.ts`, `AdminWorld.ts` (adopting), `07-BASELINE.md` section. Commits `c727c75a`, `c34c34e3`, `30dfee3a` are ancestors of HEAD; `git rev-list --count b8b3ee98..HEAD` printed 3 before this summary.
