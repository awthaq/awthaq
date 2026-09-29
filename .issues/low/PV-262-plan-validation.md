---
ID: "PV-262"
Title: "BEH-EA-171/172/173/176 and 22-client-effect.feature describe a client that differs from the shipped one ({ csrf: false } variant, Partial catalog, redirect query, makeQadi facade)"
Level: low
Category: "docs"
Status: open
Package: "client"
Source: "spec/behaviors/22-client-effect.md:78"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-262 — 22-client-effect scenarios and spec text diverge from the shipped client

`LOW` · `docs` · `client` · found while wiring `features/features/07-client-integration/22-client-effect.feature` (P20a)

Status: **open**

## Summary

Wiring surfaced these spec-vs-implementation gaps. The scenario text in the .feature file was corrected where it was factually wrong (marked in the commit), but `spec/behaviors/22-client-effect.md` still needs the same amendments (P19 owns spec prose):

1. **BEH-EA-171 / REQ-EA-482..484**: there is no `{ csrf: false }` contract variant; `Auth.make` has no CSRF opt-out. Decision 24 chose a server-side bearer exemption (MNA-008, resolved: `CsrfProtectionLive` skips requests carrying `Authorization`), and a bearer client is built against the ordinary cookie-mode contract. The three scenarios are `@skip` citing this issue.
2. **BEH-EA-172 / REQ-EA-487**: `satisfies Partial<Record<AuthErrorCode, string>>` accepts a missing key, so an untranslated tag does not fail to type-check; only a total `Record<AuthErrorCode, string>` does. The scenario now says `Record`.
3. **BEH-EA-173 / REQ-EA-488..490**: the OAuth authorize query parameter is `callbackURL`, not `redirect` (an unknown query key is dropped by the encoder).
4. **BEH-EA-174 / REQ-EA-493**: `SessionStore.hydrate` takes a `Session`, not `null`; the scenario now hydrates a second session.
5. **BEH-EA-176 / REQ-EA-498..500**: awthaq's Promise facade is `AuthClient.toPromiseFacade`, not qadi's `makeQadi`; the scenarios now describe it.
6. **BEH-EA-194 / REQ-EA-550** (25-testing-harness): `HttpApiTest.groups` has no seam for a cookie header, so a `TestAuth.signInAs` session cannot ride it; the scenario now dispatches through `TestAuth.layer`'s router (as `TestAuth.ts` documents).

## Recommended fix

Amend `spec/behaviors/22-client-effect.md` and `25-testing-harness.md` to match, and either build the `{ csrf: false }` variant or retire BEH-EA-171 in favour of the bearer exemption.

## Comments

_Triage notes and discussion append here._
