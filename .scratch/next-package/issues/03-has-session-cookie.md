# 03 — hasSessionCookie: presence-only check for proxy.ts

**What to build:** `hasSessionCookie` returns `true`/`false` purely from
whether the configured session cookie is present on an incoming request —
no database call, no session verification, no principal resolution. It
returns `true` even for an expired or forged cookie, since it checks
presence only; its own documentation states plainly, citing BEH-EA-188,
that a passing check proves nothing and exists only so `proxy.ts` (Next's
routing layer, renamed from `middleware.ts` in Next 16.3) can redirect an
obviously-anonymous visitor away from an app shell before a page renders —
never as a substitute for `getSession`'s real, database-backed
verification (ticket 02).

This ticket has no code dependency on ticket 02's `getSession` — it needs
only `@effect-auth/api`'s `Api.SessionCookie` (the configured cookie name),
already available once ticket 01 lands.

**Blocked by:** 01 — Wire @effect-auth/next's package dependencies

**Status:** done

## Result

- [x] Returns `false` when the session cookie is absent from the request
- [x] Returns `true` when the cookie is present, valid, and unexpired
- [x] Returns `true` when the cookie is present but the session it names
      has expired — proving the function performs no verification at all,
      not just that it happens to allow expired sessions through
- [x] Pure and synchronous: no database call, no runtime argument needed
- [x] Doc comment states explicitly that this is not a security boundary,
      citing BEH-EA-188 and that `getSession` is the real check
