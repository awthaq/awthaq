# 26 — Jwt step-definitions

**What to build:** `Jwt`'s Gherkin scenarios execute in CI via real
step-definitions.

**Blocked by:** None — can start immediately

**Status:** closed — not applicable as scoped

## Result

Same finding as ticket 23 (`Organization`), for the same reason: this
ticket assumed `Jwt` has feature files in `features/features/` to wire,
the same way Password/OAuth/Passkey do. It doesn't. `spec/behaviors/index.yaml`
has no "Jwt" entry, and `features/features/` has no `*-jwt.feature` file
anywhere in the tree. The wayfinder map that produced this ticket
(`.scratch/shipping-gaps/map.md`) says so explicitly in its own Notes:
"`Organization` and `Jwt` (`.scratch/organization/`, `.scratch/jwt/`) are
this map's closest analogs — self-contained `.scratch/<feature>/spec.md`
efforts needing no formal `spec/behaviors/` range." `Jwt` was deliberately
speced outside the formal `spec/behaviors/`+`features/` BDD system from
the start (see `.scratch/jwt/spec.md`); its own coverage is
`packages/jwt/test/*.test.ts`, not a Gherkin restatement.

Ticket 22's original 22-ticket plan mis-scoped this ticket the same way it
mis-scoped ticket 23, by assuming parity with the plugins that *do* have
`spec/behaviors/`+`features/` coverage. Authoring a brand-new spec+feature
range for `Jwt` from scratch would be a `/to-spec`-scale task, out of this
ticket's own remit as scoped, and not a real gap against this repo's own
chosen spec structure for this plugin.

- [x] Investigated: no `spec/behaviors/` entry and no `.feature` file
      exist for `Jwt`; confirmed this is a deliberate, pre-existing scope
      boundary (the map's own Notes), not a gap
- [x] Not force-implemented — authoring a new spec+feature range from
      scratch is out of this ticket's remit
- [ ] N/A — nothing to wire; `test:bdd` is unaffected
