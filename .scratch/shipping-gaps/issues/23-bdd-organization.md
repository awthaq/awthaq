# 23 — Organization step-definitions

**What to build:** `Organization`'s Gherkin scenarios execute in CI via
real step-definitions.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Step-definitions written for `Organization`'s feature files,
      calling into the existing `Organization` wire-level seam
      (`packages/organization/test/AuthHttp.test.ts`)
- [ ] Scenarios describing behavior not yet built are pruned from the
      executed set and tracked, not force-implemented
- [ ] The existing `test:bdd` step executes these scenarios and passes
