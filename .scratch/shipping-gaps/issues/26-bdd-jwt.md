# 26 — Jwt step-definitions

**What to build:** `Jwt`'s Gherkin scenarios execute in CI via real
step-definitions.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Step-definitions written for `Jwt`'s feature files, calling into
      the existing `Jwt` wire-level seam (its own `AuthHttp.test.ts`
      equivalent)
- [ ] Scenarios describing behavior not yet built are pruned from the
      executed set and tracked, not force-implemented
- [ ] The existing `test:bdd` step executes these scenarios and passes
