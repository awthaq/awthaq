# @awthaq/migrate-better-auth

Bridges still-live better-auth sessions into freshly minted awthaq
sessions during a cutover, without forcing a mass re-login. Closes the gap
[`BAM-003`](../../.issues/high/BAM-003-better-auth-migration-specialist.md)
identified: awthaq sessions are `id.secret` pairs under a `__Host-session`
cookie, verified by parsing that exact shape; a better-auth session is a
single opaque token under a differently named cookie, so it can never
parse — cutting over with no bridge installed forces every live session to
re-authenticate.

This package ships four pieces:

- `LegacySessionBridgeLive` — a `SqlClient`-backed
  `@awthaq/ports` `LegacySessionBridge` implementation, querying a
  **retained, read-only** better-auth database for a still-live session
  matching the raw token presented.
- `AliasLegacyCookieMiddleware` — a thin `HttpMiddleware` that rewrites the
  ambient request's cookie header so `@awthaq/api`'s `__Host-session`
  extraction point picks up a still-present better-auth cookie, without
  teaching the typed contract a second cookie name.
- Together with `@awthaq/core`'s own `Sessions.verify` (which consults
  `LegacySessionBridge` on any parse/lookup miss), these make a live
  better-auth session mint a real awthaq session transparently, on its
  next request — delivered through the same `rotated` → `Set-Cookie`
  channel every ordinary session rotation already uses.

- `BetterAuthScryptVerifier` — a `LegacyPasswordVerifier` so imported
  better-auth **password** users keep their password (BAM-004). better-auth
  stores `${saltHex}:${keyHex}` (scrypt over the NFKC-normalized password,
  N=16384, r=16, p=1, 64-byte key, the hex salt string used as the salt);
  that cannot be re-serialized into awthaq's own `$scrypt$` form, so import
  each `account.password` value verbatim as the credential hash and install
  the verifier next to your primary hasher:

  ```ts
  import { BetterAuthScryptVerifier } from "@awthaq/migrate-better-auth";

  const HasherLive = PasswordHasher.layerArgon2id.pipe(
    Layer.provideMerge(BetterAuthScryptVerifier.layer),
  );
  ```

  On the user's first successful sign-in `rehashOnLogin` replaces the hash
  with argon2id. The verifier holds one list: to accept several legacy formats
  (this one plus bcrypt or Firebase), provide
  `Layer.succeed(PasswordHasher.LegacyPasswordVerifiers, [a, b])` with each
  package's verifier instead of merging their `layer`s. Carry
  `emailVerified` across too, or set `Password.config({ requireVerifiedEmail: false })`
  if part of your population was never verified.

Confirm the retained database's `session` table matches the column
names this package queries (`token`, `userId`, `ipAddress`, `userAgent`,
`expiresAt`) against your actual better-auth schema version before
installing this in a real cutover — this package was written against
better-auth's documented, stable `session` table shape, not against a copy
of better-auth's own source.

## Field mapping (BAM-009)

Import users through `@awthaq/core`'s `UserImport.importUser` (idempotent,
transactional) with these mappings from better-auth's `user`/`account` tables:

| better-auth                                                     | awthaq                                                                                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.email`, `user.emailVerified`                              | `identity: { _tag: "Email", email }`, `verified: emailVerified`                                                                                                                                 |
| `user.name`                                                     | `name`                                                                                                                                                                                          |
| `user.image`                                                    | `image` (an `http(s)` URL; anything else is refused by the profile schema, so drop or re-host non-URL values)                                                                                   |
| `user.phoneNumber`, `phoneNumberVerified` (phone-number plugin) | `identity: { _tag: "Phone", phone }` (normalize with `Phone.normalizePhone`), `verified: phoneNumberVerified`                                                                                   |
| anonymous plugin users (`isAnonymous`)                          | `identity: { _tag: "Anonymous" }`                                                                                                                                                               |
| `user.banned`, `banReason`, `banExpires` (admin plugin)         | after import: `Users.setStatus(id, "suspended", { reason: banReason, until: banExpires })` — the shared `Users.assertCanSignIn` gate then refuses sign-in; a lapsed `banExpires` needs no write |
| `user.role` (admin plugin)                                      | not a user field: assign through `@awthaq/roles`/your qadi policy (ADR-EA-009)                                                                                                                  |
| `account.password`                                              | credential hash, verbatim, with `BetterAuthScryptVerifier` installed (above)                                                                                                                    |
| `account.providerId`, `accountId`                               | `credentials: [{ providerId, subject: accountId }]`                                                                                                                                             |
| `session.*`                                                     | bridged live by `LegacySessionBridgeLive` (below); never imported                                                                                                                               |

## Install

**1. Point a `SqlClient` at the retained better-auth database** (a
read-only replica or snapshot — never the live production database you're
cutting away from) and install the bridge:

```ts
import { LegacySessionBridgeLive } from "@awthaq/migrate-better-auth";
import * as Layer from "effect/Layer";

const AppLive = MyAppLayer.pipe(
  Layer.provideMerge(LegacySessionBridgeLive.layer.pipe(Layer.provide(BetterAuthSqlLive))),
);
```

**2. Install the cookie-aliasing middleware** ahead of your composed app,
naming better-auth's own configured cookie name:

```ts
import { AliasLegacyCookieMiddleware } from "@awthaq/migrate-better-auth";

const handler = HttpRouter.toWebHandler(AppLive, {
  middleware: AliasLegacyCookieMiddleware.make({ legacyCookieName: "better-auth.session_token" }),
});
```

**3. Nothing else.** The first request a still-live better-auth session
makes gets bridged transparently: `Sessions.verify` mints a fresh awthaq
session through the same code path every other session goes through,
`LegacySessionBridge.consume` deletes the source row so the legacy token
is single-use, and the response carries a fresh `Set-Cookie` via the
already-shipped session-rotation delivery channel — the client's next
request presents the new awthaq cookie and never touches the bridge again.

## Rollout

1. Run the one-time user/account/credential migration first (sessions can
   only bridge for users that already exist as awthaq rows).
2. Deploy with both pieces above installed, for a dual-read window —
   recommend better-auth's own configured absolute session TTL, so every
   live session either bridges or naturally expires within it.
3. Watch the bridge hit rate (each hit is a real query against the
   retained database, so it's directly observable) fall to zero.
4. Once the window elapses or the hit rate flatlines, drop both pieces
   from the composed layer/middleware and decommission the retained
   database.

A deployment that never installs this package sees zero behavior change —
`LegacySessionBridge`'s own default is a true no-op, so cutover means
forced re-login unless this package is explicitly installed.
