# 25 — Passkey step-definitions

**What to build:** `Passkey`'s Gherkin scenarios execute in CI via real
step-definitions.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Step-definitions written for `Passkey`'s feature files, calling
      into the existing `Passkey` wire-level seam
      (`packages/passkey/test/AuthHttp.test.ts`)
- [ ] Scenarios describing behavior not yet built are pruned from the
      executed set and tracked, not force-implemented
- [ ] The existing `test:bdd` step executes these scenarios and passes
