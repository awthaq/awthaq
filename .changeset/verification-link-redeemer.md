---
"@awthaq/core": minor
"@awthaq/password": patch
"@awthaq/magic-link": patch
"@awthaq/admin": patch
---

A client-held `Verification` token has a typed purpose (`VerificationLink.forUser`/`forAddress`), minted with `VerificationLink.issue(deps, purpose, input)` and redeemed through `VerificationLink.redeemer(purpose, { verification, budget })`, which owns the per-source and per-token budgets, the purpose check, the foreign-row refusal and one `VerificationLink/Refused` (ADR-EA-039 decision 9, BEH-EA-057).

Migration: `VerificationLink.issue(deps, { purpose: "x", ttl, userId, payload })` -> declare `const X = VerificationLink.forUser({ name: "x", payload })` and call `VerificationLink.issue(deps, X, { ttl, userId, payload })`. `VerificationLink.decode(raw, "x")` -> `decode(raw, X)`. `EmailChange.newEmailOf` is gone: decode with `EmailChange.Payload`, or redeem `EmailChange.Link`.
