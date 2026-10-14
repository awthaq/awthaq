---
"@awthaq/core": minor
"@awthaq/scim": minor
---

A user can only be deleted by `Erasure.AccountErasure.eraseAccount` (BEH-EA-046, ADR-EA-031). `Users` no longer has `delete`; the row store primitive is the new `Users.UserRemoval` service, whose `remove` takes an `Erasure.ErasureClearance` that only `AccountErasure` can mint, after the `BeforeUserDelete` veto passes. The veto therefore runs exactly once per erasure (it ran twice). New: `Users.createWith(input, complete)` creates a user and abandons it (no veto, no event) if `complete` fails; `@awthaq/scim`'s provisioning uses it, so a refused `POST` no longer consults the delete veto nor sweeps invitations addressed to the same email in other organizations.

Migration: replace `users.delete(id)` with `erasure.eraseAccount(id, Erasure.ErasureInitiator.…)`; a caller that deleted a user it had just created as a rollback uses `users.createWith`. `Users.layerMemory` / `layerSql` now provide `Users | UserRemoval` and no longer require `Hooks.BeforeUserDelete`; a test double of `Users` built as `Layer.effect(Users.Users, …).pipe(Layer.provide(Users.layerMemory))` must use `Layer.provideMerge` so the real `UserRemoval` comes along, and a hand-written `UsersShape` replaces `delete` with `createWith`. A `BeforeUserDelete` tap no longer needs to be idempotent across one erasure. A test that needs an orphaned row (a plugin row whose user is gone) erases through `Erasure.layer` over a fresh, empty `Erasure.registryLayer`.
