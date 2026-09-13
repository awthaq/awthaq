# 20 — Password step-definitions

**What to build:** The `Password` plugin's Gherkin scenarios (sign-up,
sign-in, reset, verify-email, change-password) execute in CI via real
step-definitions calling into the existing wire-level seam.

**Blocked by:** 08, 09, 10, 11

**Status:** ready-for-agent

- [ ] Step-definitions written for `Password`'s feature files under
      `features/features/**`, calling into the same wire-level seam
      `packages/password/test`'s own `AuthHttp.test.ts` already uses
- [ ] Scenarios covering verify-email/update-profile/delete-user/
      change-password (tickets 08–11) are included, now that those
      endpoints are real
- [ ] Scenarios describing behavior still not built anywhere in this
      repo are pruned from the executed set and tracked, not
      force-implemented and not left silently failing
- [ ] The existing `test:bdd` step in `pnpm check` executes these
      scenarios and passes
