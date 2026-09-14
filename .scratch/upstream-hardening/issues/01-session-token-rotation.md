# Session token rotation on refresh

Type: grilling
Status: resolved

## Question

`Sessions.verify` (`packages/core/src/Sessions.ts:227-286`) already
idle-slides `lastActiveAt`/`idleExpiresAt` on touch, but the session
secret and its stored hash never change for the session's lifetime — no
session-fixation defense.

Decide: what triggers rotation (every touch? only past some idle
threshold? only on privilege-relevant events like password change?); how
the new secret reaches the client (a `set-auth-token`-style response
header/cookie write from within `verify`, analogous to upstream); what
happens to the old secret/hash after rotation (immediate invalidation vs.
a short grace window for in-flight concurrent requests); and how this
interacts with the existing idle-slide touch hook — one write path or two.

## Answer

Grilled against the actual current code (`Sessions.ts:227-286`'s `verify`,
`Authentication.ts`'s `AuthenticationLive`/`PostAuthResponseHook`,
`OAuth.ts:333-340`'s existing `HttpServerResponse.setCookie` precedent).

**Trigger — piggyback on the existing `touchEvery` throttle, one write
path.** Rotation happens on exactly the same already-throttled write that
today only refreshes `lastActiveAt`/`idleExpiresAt` (`dueForTouch`,
default once per hour per `SessionConfig.touchEvery`). No new config
field, no second timer, no second write path — the same `Ref.update`
(memory) / `SqlModels.Session.update` (SQL) call that already exists also
mints a new secret and swaps `secretHash` atomically. A session carrying
`actingAs` still never touches this path at all (same existing carve-out,
BEH-EA-210) — an impersonation session's hard expiry is its whole
security model; there's no idle window to rotate within.

**Delivery — scheme-specific, both mechanisms, per the user's explicit
"richest, most idiomatic, complexity is not a concern" steer.** A
`set-auth-token` response header alone would not actually rotate anything
for a browser — only `Set-Cookie` updates a browser's own cookie jar, a
custom header is inert unless something reads and re-stores it. So the
richest *correct* design splits by how the request authenticated, not a
single universal mechanism:

- **`cookie` scheme**: `HttpServerResponse.setCookie` with
  `Sessions.SESSION_COOKIE_NAME`/`SESSION_COOKIE_ATTRIBUTES` — the exact
  existing delivery mechanism `OAuth.ts` already uses after `issue`, now
  also invoked after a rotating `verify`.
- **`bearer` scheme**: a `set-auth-token` response header carrying the new
  token — matches upstream's own mechanism, and is the only way a bearer
  client (one presenting the raw session secret directly via
  `Authorization: Bearer`, not through a plugin like `@awthaq/jwt`) can
  ever learn its token rotated.
- Both get written whenever a rotation actually occurred this request —
  never both a stale and a fresh credential handed back.

**Wiring**: `AuthenticationLive`'s `cookie` and `bearer` slots currently
share one literal `handle` reference (`{ cookie: handle, bearer: handle
}`) — that collapses the two schemes indistinguishably. Splits into two
closures over one shared `resolvePrincipal`-plus-rotation core, each
applying its own delivery step. This is separate from, and runs before,
the existing `PostAuthResponseHook` (`Authentication.ts`'s own doc
comment: a *plugin* decoration seam, e.g. `@awthaq/jwt`'s auto-minting) —
rotation is core session-security machinery, always-on, not something a
deployment opts into or out of the way a plugin hook is, so it stays
orthogonal to that extension point rather than reusing it.

**`verify`'s return shape changes**: from bare `SessionView` to something
carrying an optional freshly-minted token (e.g. `{ session: SessionView;
rotated: Option.Option<Redacted.Redacted<string>> }`) — a real, deliberate
break to `SessionsShape["verify"]`'s public contract. Every current
caller (`Authentication.ts`'s `resolvePrincipal`, `@awthaq/qadi`'s
`SubjectExtractor.ts`, `@awthaq/test`'s `TestAuth.ts`, and any other
direct `sessions.verify` call site) needs updating to destructure
`.session` — full audit of call sites is `/to-tickets`' job, not
re-litigated here.

**Old secret — immediate invalidation, no grace window.** The atomic
swap (new `secretHash` overwrites the old one in the same update) matches
every other write in this codebase (`revoke`, `revokeOthers`, the
existing touch-refresh itself) — none of them carry dual-valid state. A
concurrent in-flight request already holding the pre-rotation cookie
fails and must retry with the response's freshly-set one; accepted as
the standard, simple behavior — a grace window would be the first
dual-valid-state mechanism anywhere in this codebase's session/credential
handling, and the user's own "richest but still idiomatic" framing reads
as richness in *delivery*, not as license to introduce a new state shape
nothing else here has.
