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

**Status:** done

- [x] `.scratch/upstream-hardening/issues/07-effect-lint-coverage-under-oxlint.md`'s
      research findings read in full before deciding scope
- [x] `tsconfig.base.json`'s `@effect/language-service` plugin config sets
      `diagnosticSeverity` for the chosen subset of the 16 diagnostics to
      `"error"`, with the reasoning for what was and wasn't promoted
      recorded somewhere durable (a code comment, or this ticket's own
      resolution)
- [x] Every resulting new `tsc` error across the codebase is fixed for
      real, not suppressed
- [x] `pnpm typecheck` (and `pnpm check`) is green

## Resolution

Promoted all 16 warning-level diagnostics the research file listed
(`duplicatePackage`, `genericEffectServices`, `outdatedApi`,
`outdatedEffectCodegen`, `unsupportedServiceAccessors`, `effectFnIife`,
`effectGenUsesAdapter`, `effectInFailure`, `effectInVoidSuccess`,
`globalErrorInEffectCatch`, `globalErrorInEffectFailure`,
`layerMergeAllWithDependencies`, `lazyPromiseInEffectSync`,
`multipleEffectProvide`, `scopeInLayerEffect`, `unknownInEffectCatch`) to
`"error"` via per-rule `diagnosticSeverity` in `tsconfig.base.json` —
not all 16 blind; considered dropping the noisier-sounding ones
(`effectFnIife`, `lazyPromiseInEffectSync`) but a clean full-repo
typecheck (see below) meant there was no actual noise to weigh against
promoting them, so kept the full set rather than under-promoting on a
hypothetical. `ignoreEffectWarningsInTscExitCode` itself was left
untouched (still `true`) — the ticket's own instruction was a per-rule
override, not a global flip, and any *future* 17th+ warning-level
diagnostic this plugin ships should have to earn promotion the same way
these 16 did, not inherit it for free.

Before trusting a clean `pnpm typecheck`, verified the plugin's
diagnostics actually flow through `tsc -b` at all in this repo's TS7/
`@effect/tsgo` setup (not a given — `node_modules/@effect/language-service/cli.js`
refuses to run directly against TS7, "for TypeScript 7.x and forward use
@effect/tsgo"): planted a deliberate `Effect.fail(new Error("probe"))` in
a throwaway file, confirmed `tsc -b` reported it as
`error TS377023 ... effect(globalErrorInEffectFailure)`, then removed the
file and cleared every `.tsbuildinfo` to force a genuine full rebuild
(incremental build info doesn't reliably invalidate on a
plugin-diagnostics-only tsconfig change).

Result: zero real diagnostics surfaced across the whole repo (source +
test project) for all 16 promoted rules — this codebase's existing Effect
usage already avoids every one of these anti-patterns, so no source
fixes were needed, only the config change. Full `pnpm check` (typecheck,
package:smoke, lint, knip, format, circular, coverage, BDD,
spec:verify:strict) is green.
