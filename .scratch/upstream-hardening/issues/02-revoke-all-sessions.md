# `revoke-all` session operation

Type: grilling
Status: resolved

## Question

Today `Sessions.ts` ships `revoke` (one session) and `revokeOthers` (all
but the caller's own, `Sessions.ts:159-160,308-311,469-470`). There's no
`revokeAll` that also kills the caller's own current session.

Decide: the exact semantics (does it end the calling session too, forcing
immediate re-auth, or is that still `revokeOthers`'s job and this is
purely an additive "nuke everything including me" op?); the HTTP surface
(`POST /auth/sessions/revoke-all` per the pasted report, or a shape more
consistent with this repo's existing session endpoints); and whether
password-reset should call this by default (the pasted report frames
`revoke-all` as "what password-reset should call" — check what
password-reset currently does on success and whether that's already
equivalent to `revokeOthers`, a gap, or intentionally narrower).

## Answer

Grounded against `packages/api/src/Session.ts`/`packages/server/src/Session.ts`'s
existing `session` group (`current`/`list`/`signOut`/`revoke`/
`revokeOthers`) and `Password.ts:578-581`'s `confirmReset`.

**Semantics — `revokeAll` truly means all, no exceptions.** Completes the
naming symmetry already established: `revoke` (one), `revokeOthers` (all
but one), `revokeAll` (all). An authenticated caller invoking it kills
their own current session too, as a natural consequence of "all" meaning
all — not a special case to carve out. This matches
`SessionsShape["revokeOthers"]`'s existing signature shape
(`(userId: UserId) => Effect.Effect<void>`, no `keep` parameter needed).

**HTTP surface — `POST /session/revoke-all`**, added to the existing
`session` `HttpApiGroup` (`api/src/Session.ts`) alongside `revoke`/
`revoke-others`, authenticated the same way, no payload — mirrors
`revokeOthers`'s own endpoint shape exactly, not the pasted report's
`/auth/sessions/revoke-all` (that's upstream's own route namespace, not
this repo's). Cookie-clearing in the response: **not added** — `signOut`
(which already kills the caller's own session) doesn't clear the
`Set-Cookie` server-side today either; matching that existing precedent
for consistency rather than introducing new response behavior this
ticket wasn't scoped to design.

**Password-reset — real gap confirmed, not equivalent.**
`confirmReset` (`Password.ts:578-581`) already achieves "revoke
everything" today, but via a workaround: `sessions.revokeOthers(userId,
Sessions.SessionId(""))`, exploiting the fact that an empty string can
never be a real session id so nothing is ever kept. This is exactly the
kind of thing a real `revokeAll` primitive should replace — once it
exists, `confirmReset` should call `sessions.revokeAll(userId)` directly,
retiring the empty-string-id trick for the honest primitive it was
clearly standing in for. That one-line swap is `/to-tickets`' job
alongside the endpoint/`SessionsShape` addition, not re-litigated here.
