---
"@awthaq/core": minor
---

Sign-in completion is one core module, `SignIn` (BEH-EA-322, ADR-EA-038): `clear` returns a branded `Clearance` (lookup, suspension gate, `BeforeSignIn`, `BeforeSessionIssue`), `issue` is the only way to mint a session from it, and `resume` is the divert owner's entry.

- `Hooks.BeforeSessionIssue`'s input now always carries `amr` and may carry a `handoff` (`{ tenantId?, continuation? }`).
- `SignIn.continuation` registers work a first factor owes once its session exists; the registry rides `Hooks.HooksLive`.

Migration: a custom `BeforeSessionIssue.run` caller must pass `amr`. A custom divert tap that later completes the sign-in itself must return the `handoff` it received to `SignIn.resume`. Plugin authors: finish a sign-in with `SignIn.make` (`complete`, or `clear`/`issue`), never `Sessions.issue`.
