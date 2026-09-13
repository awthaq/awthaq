# 19 — Lifecycle hooks

**What to build:** one `HookPoint` (`veto` before, `observe` after) per
mutating operation across organization/membership/invitation/team CRUD —
`Organization` is the first real plugin consumer of the core `HookPoint`
mechanism (`BEH-EA-089`–`096`).

**Blocked by:** 11, 12, 13, 14, 15, 16, 17.

**Status:** done

- [x] A `veto` + `observe` pair declared for: create/update/delete
      organization; add/remove member, update member role; create/accept/
      reject/cancel invitation; create/update/delete team, add/remove team
      member; create/update/delete dynamic role
- [x] Each `veto` point's `Input` is that operation's own payload/context;
      each `observe` point additionally carries the resulting record
- [x] Every operation above actually runs its hook pair (a `veto` tap can
      abort/amend; an `observe` tap's own failure never affects the
      operation, per `HookPoint`'s existing contract)
- [x] `packages/organization/test/OrganizationHooks.test.ts`: a tapped
      `veto` can abort at least one representative operation per area
      (org/member/invitation/team), and a tapped `observe` fires after a
      representative success without being able to affect its outcome

## Result

Done. `OrganizationHooks.ts` (new) declares 18 `veto`+`observe` pairs (36
`HookPoint` classes total) covering every operation the checklist lists:
organization create/update/delete; member add/remove/updateRole;
invitation create/accept/reject/cancel; dynamic role create/update/delete;
team create/update/delete; team-member add/remove. `Organization.ts`'s
`make` captures all 36 once at its own top level (alongside `orgs`/
`members`/etc.) and each operation's body calls its own pair's `.run(...)`
— a `veto`'s (possibly-amended) output feeds the operation's real logic; an
`observe` fires after success with the resulting record. `OrganizationHooksLive`
bundles every point's default (no-tap) `.layer` into one export so a
consumer that never taps anything still gets a working, empty hook chain
with a single `Layer.provideMerge`. Covered by `OrganizationHooks.test.ts`
(2 tests): a tapped veto aborting or amending organization creation, plus
an always-failing observe tap on the same operation that never surfaces;
and a second, independent operation area (`createTeam`) proving a tapped
veto aborts there too.

**Design decision**: a `veto` tap's `HookAbort` is converted to a defect
(`Effect.orDie`) at the exact point each operation calls `.run(...)` —
never propagated as a typed `OrganizationShape`/`OrganizationApi` contract
error. This keeps the wire contract's error surface exactly what it
already was (no new "operation aborted" error type to design and thread
through 18 endpoints) while still giving an application a real way to
block an operation outright by tapping the veto point and failing.

**Architecture correction, found mid-implementation**: an early version of
this ticket called `yield* OrganizationHooks.BeforeX`/`AfterX` *inside*
each operation's own closure (rather than once at `make`'s top level) and
widened each affected `OrganizationShape` method's own `Effect` signature
with a third (`R`) type parameter naming its hook-point dependencies. That
typechecked at the plugin-package level (`tsc -b tsconfig.json`, which
excludes `test/`) but failed the *workspace* test-file typecheck
(`tsc -p tsconfig.test.json`, `pnpm typecheck`'s second step) with a
genuinely confusing error: `HttpApiBuilder.group`'s own type machinery
wraps a handler's "extra" required services in an
`HttpRouter.Request.From<"Requires", R>` marker — the framework's own
signal that such dependencies are meant to flow through endpoint
middleware, not ambient `Layer.provide`. A plain `Layer.provideMerge` of
the bare service tags could never discharge that wrapped form, no matter
how the test layers were composed. Capturing every hook point once at
`make`'s own top level (exactly like every other captured service in this
file) sidesteps the issue entirely: the dependency becomes part of `make`'s
own `R`, which composes with `Layer.provide`/`Layer.provideMerge` the
ordinary way — and let every `OrganizationShape` method signature revert
to its original, simpler form. Worth flagging for any future plugin that
reaches for a per-call service inside a domain method also exposed over
HTTP: capture it once in `make`, never inside the returned closure itself.

**Bug caught and fixed during implementation**: `HookPoint.veto`/`.observe`
both derive their Context tag key purely from the `id` string passed in
(`` `effect-auth/hook/${id}` ``, independent of `kind`) — an initial draft
gave each pair's veto and observe half the *same* `id` (e.g.
`"organization.create"` for both), which silently collided them onto one
shared context slot; whichever half won the `Layer.mergeAll` composition
order overwrote the other, so calling the losing half's `.run(...)`
actually executed the *other* kind's implementation (an `observe`'s `run`
always returns `void`, surfacing as a mystifying `Cannot read properties of
undefined` at the call site). Fixed by giving every veto a `.before`
suffix and every observe a `.after` suffix on its `id`.

**Verification**: `pnpm --filter @effect-auth/organization typecheck`
clean; `pnpm exec tsc -p tsconfig.test.json` (the workspace-wide test-file
typecheck) clean; `pnpm --filter @effect-auth/organization test` — 12
files, 145 tests, all passing.
