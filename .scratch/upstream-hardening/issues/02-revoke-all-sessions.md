# `revoke-all` session operation

Type: grilling
Status: open

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
