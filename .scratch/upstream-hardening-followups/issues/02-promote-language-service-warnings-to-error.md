# 02 — Promote applicable `@effect/language-service` warnings to `error`

**What to build:** `tsc` fails on the `@effect/language-service`
diagnostics that actually matter for this repo's Effect v4 target, not
just genuine Effect *errors* as today.

`tsconfig.base.json`'s `@effect/language-service` plugin config already
sets `ignoreEffectErrorsInTscExitCode: false` (errors already fail
`tsc`), but `ignoreEffectWarningsInTscExitCode: true` is an explicit
**opt-out** of the plugin's own default (`false` — warnings fail `tsc` by
default upstream). `.scratch/upstream-hardening/issues/07-effect-lint-coverage-under-oxlint.md`'s
own research enumerated all 16 diagnostics this repo currently emits only
at warning level, `outdatedApi` most relevant given this repo's Effect v4
target (an API this repo calls that Effect's own language service knows
is outdated for the version pinned).

Decide which of those 16 to promote via `diagnosticSeverity` (per-rule
override, not a global flip of `ignoreEffectWarningsInTscExitCode`) and
how aggressively — some may be noisy or not yet actionable across this
repo's current source; read the research file's own list before deciding
rather than promoting all 16 blind. Fix whatever real diagnostics
promotion surfaces.

**Blocked by:** None — can start immediately

- [ ] `.scratch/upstream-hardening/issues/07-effect-lint-coverage-under-oxlint.md`'s
      research findings read in full before deciding scope
- [ ] `tsconfig.base.json`'s `@effect/language-service` plugin config sets
      `diagnosticSeverity` for the chosen subset of the 16 diagnostics to
      `"error"`, with the reasoning for what was and wasn't promoted
      recorded somewhere durable (a code comment, or this ticket's own
      resolution)
- [ ] Every resulting new `tsc` error across the codebase is fixed for
      real, not suppressed
- [ ] `pnpm typecheck` (and `pnpm check`) is green
