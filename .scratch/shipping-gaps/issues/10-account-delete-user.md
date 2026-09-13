# 10 — Wire delete-user endpoint

**What to build:** An authenticated user can delete their own account
over HTTP via the `Account` group, with the existing
cascade-to-Accounts/Sessions behavior invoked explicitly.

**Blocked by:** 09 (needs the `Account` group to exist — see ticket 09's
own note on why this no longer blocks on 08)

**Status:** ready-for-agent

- [ ] `DELETE /user` on the `Account` group wires onto the existing
      `Users.delete` capability
- [ ] The handler explicitly triggers cascade-to-`Accounts`/`Sessions`
      cleanup (matching `Users.ts`'s own documented caller-cascade
      responsibility) — deleting a user leaves no orphaned
      account/session rows
- [ ] Requires authentication; a caller can only delete their own
      account, never an arbitrary user id
- [ ] Wire-level contract test: an authenticated caller deletes their own
      account, a subsequent sign-in with those credentials fails, and no
      orphaned session/account rows remain
