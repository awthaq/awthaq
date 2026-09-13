# 21 — Session step-definitions

**What to build:** `Session`'s Gherkin scenarios execute in CI via real
step-definitions.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Step-definitions written for `Session`'s feature files, calling
      into the existing `Session` wire-level seam
      (`packages/server/test/AuthHttp.test.ts`)
- [ ] Scenarios describing behavior not yet built are pruned from the
      executed set and tracked, not force-implemented or left silently
      failing
- [ ] The existing `test:bdd` step executes these scenarios and passes
