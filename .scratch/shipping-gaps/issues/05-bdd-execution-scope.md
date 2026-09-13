# 05 — BDD scenario execution scope

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately

## Question

27 `.feature` files under `features/features/**` carry roughly 602
tracked Gherkin scenarios; only `features/features/_smoke/smoke.feature`
has step-definitions and runs (`features/vitest.config.ts`'s own comment
confirms: "the real 602 spec scenarios ... have no step-definitions yet").
The runner is already real (`@effect-cucumber/gherkin` +
`@effect-cucumber/vitest`, wired into `pnpm check` via `test:bdd`) — this
isn't a tooling gap, it's an unwritten-step-definitions gap.

Decide: (a) is "execute a real slice" for this map's destination about
writing step-definitions for every already-implemented plugin's feature
files (password, session, oauth, organization, admin, passkey, jwt —
whatever's real today), or a smaller representative slice that proves the
mechanism works end-to-end for at least one full plugin? Given the scale
(602 scenarios is not a one-session job even split across many tickets),
what's the actual target this map commits to, versus what gets pushed
into "Not yet specified" as follow-on work beyond this map's destination?
(b) for scenarios describing behavior that doesn't exist yet (e.g.
anything gated on ticket 01's account-lifecycle endpoints, or on
capabilities behind the still-stub packages this map explicitly excludes)
— pruned from the 602, or left unimplemented-but-tracked? (c) does
step-definition authoring belong in this map's spec at all, or is it
better scoped as its own follow-on `.scratch/<feature>/` effort once this
map's other five workstreams land and the feature files they touch are
stable targets rather than moving ones?

## Answer

**(a) Target — every currently-implemented plugin, not a representative
slice.** Step-definitions for Password, Session, OAuth, Organization,
Admin, Passkey, and Jwt all get written, not just one plugin proving the
mechanism. Given the scale (602 tracked scenarios total, and this
repo's plugins almost certainly account for the large majority of them),
this is explicitly the single largest workstream in this map — likely
needs splitting into one ticket-set per plugin at `/to-tickets` time,
not one flat ticket range.

**(b) Not-yet-real behavior — pruned, not force-implemented.** Scenarios
gated on this map's own still-in-flight tickets (01's new endpoints, 03's
persistent backend, 04's encryption) or on the genuinely-still-stub
packages this map excludes (`api-key`, `two-factor`, `magic-link`,
`next`, `cli`) get pruned from the executed set for now, tracked rather
than deleted, and picked up once the underlying capability actually
exists.

**(c) Scope boundary — this ticket decides the target; writing the 602
step-definitions is `/to-tickets`' and the resulting implementation
tickets' job, not this map's own grilling round.**
