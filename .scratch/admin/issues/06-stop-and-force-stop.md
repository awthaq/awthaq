# 06 — `stopImpersonating` and `forceStop`

**What to build:** The two ways an impersonation episode ends before its
hard expiry: the impersonating admin can end it themselves
(`stopImpersonating`), or another admin passing the same gate can force it
to end (`forceStop`, identified by the impersonation session's own
`SessionId`). Neither issues a replacement session — the caller already
holds their own original session's token from before `impersonate` was
ever called (ticket 05).

**Blocked by:** Ticket 05.

**Status:** done

- [x] `stopImpersonating` revokes the caller's own current session, which
      must itself carry `actingAs` or the call fails; sets the matching
      `admin_impersonation` row's `endedAt`/`endedBy: "self"`; publishes
      `auth.admin.impersonationStopped`; issues no replacement session
      (BEH-EA-216)
- [x] `forceStop` is gated by the identical `canImpersonate` predicate
      `impersonate` uses; given a `sessionId`, revokes that session (which
      must carry `actingAs`, or `AdminImpersonationNotFound` (404)); sets
      `endedAt`/`endedBy: "forcedByAdmin"`; publishes
      `impersonationStopped` (BEH-EA-217)
- [x] Neither operation ever revokes, lists, or otherwise touches any
      session belonging to the *target* user — only the impersonation
      session itself is affected (BEH-EA-220)
- [x] Both endpoints (`stopImpersonating`, `forceStop`) exist on the
      `admin` `HttpApiGroup` in `AdminApi.ts`, answering `204` on success
- [x] `packages/admin/test/Admin.test.ts` gains cases: `stopImpersonating`
      ends the caller's own episode correctly; `forceStop` ends another
      admin's episode correctly and refuses an unknown/already-ended
      session id; the target user's own sessions are provably unaffected
      by either path

## Result

Done. `stopImpersonating` fails `AdminImpersonationNotFound` up front when
`caller.actingAs === undefined` (nothing to stop), otherwise ends the
matching audit row (`endedBy: "self"`) and revokes the caller's own
session — no replacement issued. `forceStop` is gated by the same
`canImpersonate` predicate as `impersonate`, then reuses
`ImpersonationRecords.endEpisode`'s own not-found/already-ended rejection
(mapped to `AdminImpersonationNotFound`) before revoking. Both publish
`auth.admin.impersonationStopped` with the correct `endedBy`. Neither path
ever names or touches the target's own sessions — proven in
`Admin.test.ts` by issuing a real, separate session for the target and
confirming it still verifies afterward. Both endpoints exist on `AdminApi`
(`POST /admin/stop-impersonating`, `POST /admin/force-stop/:sessionId`),
answering `204`.
