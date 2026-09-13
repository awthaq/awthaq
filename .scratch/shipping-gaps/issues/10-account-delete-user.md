# 10 — Wire delete-user endpoint

**What to build:** An authenticated user can delete their own account
over HTTP via the `Account` group, with the existing
cascade-to-Accounts/Sessions behavior invoked explicitly.

**Blocked by:** 09 (needs the `Account` group to exist — see ticket 09's
own note on why this no longer blocks on 08)

**Status:** done

## Result

Delivered together with ticket 09 in the same
`packages/api/src/Account.ts`/`packages/server/src/Account.ts` pass,
since both endpoints share one new group's scaffolding.

**Discovery, not in the original ticket checklist:** `Accounts` had no
bulk "delete every account for this user regardless of the last-account
rule" capability — only `unlink(id)`, which *refuses* to remove a user's
last credential (BEH-EA-045), the wrong behavior when the whole user is
being deleted (ending up with zero accounts is the expected outcome, not
a lockout). Added `AccountsShape.deleteAllByUser` (both `layerMemory` and
`layerSql`, plus a new `AccountsRepositoryShape.deleteAllByUser` raw
bulk-delete statement in `packages/sql`, mirroring
`SessionsRepositoryShape.deleteAllForUserExcept`'s existing precedent).
Session cleanup reuses `Password.confirmReset`'s own sentinel-empty-id
trick: `sessions.revokeOthers(userId, Sessions.SessionId(""))` revokes
every session including the one making the delete request itself, since
no real session can ever have that id.

**Known limitation, deliberately not fixed here:** the three-step cascade
(delete accounts → revoke sessions → delete user) is not atomic — a
failure partway through can leave a partial cascade. Ticket 16 (the new
`SqlTransaction` port) is exactly where that gets closed; wrapping this
handler is noted as that ticket's own first real consumer candidate
alongside OAuth account-linking.

Wire-level test added to `packages/server/test/AuthHttp.test.ts`: delete
removes the user, every linked account, and revokes the session (a
follow-up `/session` request with the same cookie answers 401). Same
green run as ticket 09 (`pnpm test` — 564 tests; typecheck/lint/format
clean).

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
