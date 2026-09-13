# 22 — OAuth step-definitions

**What to build:** `OAuth`'s Gherkin scenarios execute in CI via real
step-definitions.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Step-definitions written for `OAuth`'s feature files, calling into
      the existing OAuth plugin wire-level seam
- [ ] Scenarios describing behavior not yet built (including anything
      still gated on tickets 16/18/19, if those haven't landed yet) are
      pruned from the executed set and tracked, not force-implemented
- [ ] The existing `test:bdd` step executes these scenarios and passes
