# 24 — Admin step-definitions

**What to build:** `Admin`'s Gherkin scenarios execute in CI via real
step-definitions.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Step-definitions written for `Admin`'s feature files, calling into
      the existing `Admin` wire-level seam
      (`packages/admin/test/AuthHttp.test.ts`)
- [ ] Scenarios describing behavior not yet built are pruned from the
      executed set and tracked, not force-implemented
- [ ] The existing `test:bdd` step executes these scenarios and passes
