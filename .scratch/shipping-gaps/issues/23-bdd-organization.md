# 23 — Organization step-definitions

**What to build:** `Organization`'s Gherkin scenarios execute in CI via
real step-definitions.

**Blocked by:** None — can start immediately

**Status:** closed — not applicable as scoped

## Result

This ticket assumed `Organization` has feature files in `features/features/`
to wire, the same way Password/OAuth/Passkey do. It doesn't, and never
did: `spec/behaviors/index.yaml`'s own canonical list (BEH-EA-001 through
BEH-EA-209, files `01-plugin-contract.md` through `27-admin-impersonation.md`)
has no "Organization" entry, and `features/features/` has no
`*-organization.feature` file anywhere in the tree. This isn't an
oversight to fix here — the wayfinder map that produced this ticket
(`.scratch/shipping-gaps/map.md`) says so explicitly in its own Notes:
"`Organization` and `Jwt` (`.scratch/organization/`, `.scratch/jwt/`) are
this map's closest analogs — self-contained `.scratch/<feature>/spec.md`
efforts needing no formal `spec/behaviors/` range." `Organization` was
deliberately built and speced outside the formal `spec/behaviors/`+`features/`
BDD system from the start (see `.scratch/organization/spec.md`), the same
way this very map was — its own coverage is
`packages/organization/test/*.test.ts`, not a Gherkin restatement.

Ticket 22's original 22-ticket plan mis-scoped this ticket by assuming
parity with the plugins that *do* have `spec/behaviors/`+`features/`
coverage (Password, OAuth, Passkey, and Admin via `27-admin-impersonation.md`,
handled in ticket 24). Authoring a brand-new `spec/behaviors/`+`.feature`
range for `Organization` from scratch would be a `/to-spec`-scale task in
its own right, not a "write step-definitions against an existing seam"
ticket — out of this ticket's own remit as scoped, and out of scope for
"resolve everything, excluding the 8-stub-package cleanup and the
unrelated upstream repo" per this session's own governing instruction,
since it isn't a *gap* against this repo's own chosen spec structure, just
a difference in which structure two different plugins were speced under.

- [x] Investigated: no `spec/behaviors/` entry and no `.feature` file
      exist for `Organization`; confirmed this is a deliberate, pre-existing
      scope boundary (the map's own Notes), not a gap
- [x] Not force-implemented — authoring a new spec+feature range from
      scratch is out of this ticket's remit
- [ ] N/A — nothing to wire; `test:bdd` is unaffected
