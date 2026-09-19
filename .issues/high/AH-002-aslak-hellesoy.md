---
ID: "AH-002"
Title: "Security-claim Then steps are no-ops: green scenarios asserting nothing"
Level: high
Category: "testing"
Status: resolved
Package: "—"
Source: "features/step-definitions/OAuthSteps.ts:137"
Auditor: "aslak-hellesoy"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# AH-002 — Security-claim Then steps are no-ops: green scenarios asserting nothing

`HIGH` · `testing` · `—` · reported by **Aslak Hellesøy — Creator of Cucumber** (`aslak-hellesoy`)

Status: **resolved**

## Summary

Several Thens that exist to verify security properties have empty bodies, so their scenarios pass while the claim is never checked. Examples: PKCE verifier/nonce never sent to the browser (OAuthSteps.ts:137 — the captured redirect `location` is never inspected); "the two issuers' accounts are never treated as the same account" (OAuthSteps.ts:557 — the preceding Then at 552 only asserts Exit.isSuccess of a link call and never compares account ids); "neither callback is matched or merged by the shared email" (OAuthSteps.ts:592). For a suite whose stated purpose is executable specification, a green no-op security Then is worse than a skipped scenario: it manufactures false confidence in exactly the properties (PKCE hygiene, account-conflation) the suite exists to pin.

## Evidence

Source: `features/step-definitions/OAuthSteps.ts:137`

```
Then("neither the PKCE verifier nor the nonce is ever sent to the browser", function* () {
    yield* Effect.void;
  });
```

## Recommended fix

Either implement each claim (assert the captured authorize location contains code_challenge but not code_verifier/nonce; compare Account ids across issuers) or move the scenario to @skip with the same rationale discipline used elsewhere in the suite. Add a review/lint rule that a Then body may not be a bare Effect.void.

## Context

- Auditor verdict on this domain: **needs-work** (score 51/100), domain: BDD acceptance suites
- Full dossier: [`aslak-hellesoy`](../../.reports/aslak-hellesoy/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `features/step-definitions/OAuthSteps.ts:137-139` is a bare `yield* Effect.void` Then body, exactly as quoted. The two other cited examples also check out: `OAuthSteps.ts:557-559` ("the two issuers' accounts are never treated as the same account") is a no-op following a Then at 552 that only asserts `Exit.isSuccess`, never comparing account ids; `OAuthSteps.ts:592-594` ("neither callback is matched or merged by the shared email") is likewise an empty body. Status → ready-for-agent.

**Resolved (2026-09-20):** Implemented all three claims for real, per the recommended fix's first option:

- **"neither the PKCE verifier nor the nonce is ever sent to the browser"**: now inspects the `location` outcome the earlier Given already captures — asserts it contains `code_challenge` (the public PKCE value) but neither `code_verifier` nor `nonce`. This fixture's own provider (`google()` = `oauth2Provider`, not `oidcProvider`) confirmed via `OAuth.ts`'s own `authorize` (`nonce` is `undefined` whenever `provider.kind !== "oidc"`) to never emit a `nonce` param at all, so the assertion is exact, not approximate.
- **"the two issuers' accounts are never treated as the same account"**: the `When` step now also persists the second issuer as an outcome; the `Then` looks up both issuers' accounts via `accounts.findByProviderSubject(providerId, subject, issuer)` and asserts their `AccountId`s are distinct — the only thing that can actually prove they weren't collapsed into one row.
- **"neither callback is matched or merged by the shared email"**: the `Given` now persists both users' own ids; the `Then` looks up each account by `(providerId, subject)` and asserts each resolves to its own expected `userId` — directly catching the risk this scenario names (a callback handler resolving/merging by self-reported email instead of the identity tuple, which would leave both accounts pointing at the same user).

TDD: ran the real BDD suite (`pnpm run test:bdd`) — `16-oauth.steps.test.ts` (23 passed, 4 skipped). Verified all three genuinely load-bearing by mutating each in turn (contradictory regex assertion; flipping `notStrictEqual`→`strictEqual`; swapping which expected userId each account is checked against) and confirming each mutation produces a real scenario failure at exactly that step, then reverting. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (694 passed, 7 skipped) — unaffected, since this fix touches only `features/step-definitions/OAuthSteps.ts`.

Note: `pnpm run test:bdd` also surfaced 2 pre-existing failures in `15-password.steps.test.ts` ("expected a reset-password mail"), unrelated to this finding — `PasswordSteps.ts`/`15-password.feature` were not touched by this fix or by anything else in this session (confirmed via `git log`/`git diff`), so left untouched and out of scope here.
