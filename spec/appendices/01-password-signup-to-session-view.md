# Password Sign-Up to Session View
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-APP-01 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | effect-auth Engineering |
> | Classification | Appendix — Worked Example |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-12): Added inline BEH-EA citations per section and an ADR-EA-003 citation, beyond the header-only citation this appendix previously had (CCR-EA-002) |
---

Every code block in this appendix is reproduced here as an uncompiled
illustration; nothing in this repository compiles yet, so every fence below
is `ts` even where the source material it is drawn from marks a fence
`tsx` or `typescript`. This differs from qadi's own appendices, which are
gate-compiled by `check-doc-examples.mjs`-style tooling — effect-auth has no
such tooling yet (see [`../process/definitions-of-done.md`](../process/definitions-of-done.md)
gate 8). This walkthrough reproduces material from `archive/design/usage-examples-v4.md`
§§1, 4, 5, and 6 as a single narrative rather than a sequence of disconnected
cookbook entries; it exercises
[BEH-EA-065–072 Authentication Middleware](../behaviors/09-authentication-middleware.md),
[BEH-EA-073–080 CSRF Protection](../behaviors/10-csrf.md),
[BEH-EA-049–056 Sessions](../behaviors/07-sessions.md), and
[BEH-EA-113–120 Password Authentication](../behaviors/15-password.md). The
contract shape everything below is built against is
[ADR-EA-003](../decisions/003-httpapi-as-contract.md#adr-ea-003-httpapi-is-the-api-contract).

## 1. Standing up the smallest server

*(Exercises [BEH-EA-081](../behaviors/11-http-error-mapping.md#beh-ea-081-a-plugins-handlers-are-built-with-httpapibuildergroup-against-its-own-contract) and [BEH-EA-083](../behaviors/11-http-error-mapping.md#beh-ea-083-authhttproutesauthapi-registers-the-composed-api-with-the-router).)

A team's first contact with effect-auth is composing one plugin and getting a
running HTTP server out of it. `password()` is the only plugin installed —
no OAuth, no passkeys, no roles — so the composed API surface is exactly
sign-up, sign-in, session, and sign-out.

```ts
// auth.ts
import { Auth } from "@effect-auth/core"
import { password } from "@effect-auth/password"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Config, Effect, Layer } from "effect"

const plugins = [password()] as const

export const AuthApi = Auth.api(plugins.map((p) => p.contract))

const Sql = SqliteClient.layer({ filename: "auth.db" })
const Migrations = Layer.unwrap(Effect.map(Auth.link(plugins), (linked) =>
  SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(linked.migrations) })))

export const AuthLive = Auth.layer(plugins).pipe(
  Layer.provide(Migrations.pipe(Layer.provideMerge(Sql))),
  Layer.provide(NodeServices.layer)          // Crypto, FileSystem, Path
)
```

```ts
// server.ts
import { NodeHttpServer, NodeRuntime, NodeServices } from "@effect/platform-node"
import { HttpRouter } from "effect/unstable/http"
import { AuthHttp } from "@effect-auth/server"
import { createServer } from "node:http"

const Routes = AuthHttp.routes(AuthApi).pipe(Layer.provide(AuthLive))

Layer.launch(HttpRouter.serve(Routes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)).pipe(NodeRuntime.runMain)
```

Nothing above names a hasher, a rate limiter, a mailer, a session lifetime, or
a cookie name — those are all secure-by-default: argon2id hashing, an
in-memory rate limiter, a console mailer for development, 30-day absolute /
7-day idle sessions, an `__Host-session` cookie, and CSRF enforcement on
every unsafe method. `AUTH_SECRET` is read from the environment rather than
configured in code. The composed router exposes:

```
POST /auth/password/sign-up    POST /auth/password/sign-in
GET  /auth/session             POST /auth/session/sign-out
GET  /auth/openapi.json        GET  /auth/docs
```

A sign-up and a sign-in against that server look like this on the wire:

```ts
// curl -c jar -b jar -X POST localhost:3000/auth/password/sign-up \
//   -H 'content-type: application/json' -H 'x-csrf-token: <from __Host-csrf cookie>' \
//   -d '{"email":"ada@example.com","password":"correct horse battery staple"}'
// 200 {"principal":{"_tag":"User",...},"user":{...},"session":{...},"subject":{"id":"user:…","roles":[],"permissions":[],"attributes":{}}}

// curl -b jar localhost:3000/auth/session
// 200 same shape

// curl -b jar -X POST localhost:3000/auth/password/sign-in -d '{"email":"ada@example.com","password":"wrong"}'
// 401 {"_tag":"InvalidCredentials"}
```

The `x-csrf-token` header on sign-up is not incidental — it is the next
section's subject, and it is required here for the same reason it would be
required on any application endpoint this team writes.

## 2. Protecting an endpoint the same way effect-auth protects its own

*(Exercises [BEH-EA-065](../behaviors/09-authentication-middleware.md#beh-ea-065-the-authentication-middleware-tries-a-cookie-handler-first-in-its-declared-security-record) and [BEH-EA-073](../behaviors/10-csrf.md#beh-ea-073-sec-fetch-site-is-the-primary-csrf-signal).)

Once the auth plugin is wired, the team's own `projects` API group is
protected by composing the same two pieces of middleware effect-auth uses
internally: `Authentication`, which resolves a signed-in principal or fails
with 401, and `CsrfProtection`, which rejects unsafe methods lacking the CSRF
header with 403.

```ts
import { Authentication, CurrentPrincipal, CsrfProtection } from "@effect-auth/api"

export class ProjectsApi extends HttpApiGroup.make("projects")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(ProjectView) }),
    HttpApiEndpoint.post("create", "/", { payload: Project.jsonCreate, success: ProjectView })
  )
  .middleware(Authentication)          // 401 Unauthenticated when no valid cookie or bearer token
  .middleware(CsrfProtection)          // 403 CsrfRejected on unsafe methods without the header
  .prefix("/projects")
{}

export const ProjectsHandlers = HttpApiBuilder.group(AppApi, "projects", Effect.fn(function*(handlers) {
  const projects = yield* Projects
  return handlers.handleAll({
    list: () => Effect.gen(function*() {
      const principal = yield* CurrentPrincipal          // provided by Authentication
      return yield* projects.forOwner(principal.ref)
    }),
    create: ({ payload }) => Effect.gen(function*() {
      const principal = yield* CurrentPrincipal
      if (principal._tag !== "User") return yield* new HttpApiError.Forbidden()
      return yield* projects.create({ ...payload, ownerId: principal.userId })
    })
  })
}))
```

`CurrentPrincipal` is what `Authentication` puts in the environment — the
handler never touches a cookie or a header directly. A public feed endpoint
that wants to personalize for signed-in visitors without requiring sign-in
uses `OptionalAuthentication` instead, which resolves `CurrentPrincipal` to
an `AnonymousPrincipal` rather than failing:

```ts
import { OptionalAuthentication } from "@effect-auth/api"

HttpApiGroup.make("feed")
  .add(HttpApiEndpoint.get("home", "/", { success: Feed }))
  .middleware(OptionalAuthentication)      // CurrentPrincipal is AnonymousPrincipal when no credential

// handler
home: () => CurrentPrincipal.use((p) => p._tag === "Anonymous" ? feed.public : feed.forUser(p))
```

Different endpoint groups can even mix authentication *strategies* — a
machine-to-machine group authenticated by an API key header alongside a
human-facing group authenticated by the cookie-to-bearer flow:

```ts
import { ApiKeyAuthentication } from "@effect-auth/api-key/api"   // its own scheme: x-api-key header

HttpApiGroup.make("machine").add(/* … */).middleware(ApiKeyAuthentication)   // ServicePrincipal
HttpApiGroup.make("app").add(/* … */).middleware(Authentication)             // cookie → bearer
```

## 3. What a session actually is, and how a user manages it

*(Exercises [BEH-EA-049](../behaviors/07-sessions.md#beh-ea-049-a-session-token-is-an-opaque-idsecret-pair).)

Signing in issued a session; the client and server views of that session are
the next stop. The derived client exposes device listing and revocation
directly:

```ts
const client = yield* HttpApiClient.make(AuthApi, { baseUrl })

const devices = yield* client.session.list()
// [{ id, createdAt, lastActiveAt, expiresAt, userAgent: "Mozilla/…", current: true }, …]

yield* client.session.revoke({ params: { id: devices[1].id } })
yield* client.session.revokeOthers()
yield* client.session.signOut()
```

The same operations are available in-process, for server-side code that
needs to issue or revoke a session directly rather than through the HTTP
client — for instance, forcing every other session to sign out immediately
after a password change:

```ts
const sessions = yield* Sessions
const { session, token } = yield* sessions.issue({ userId, request: { ip, userAgent } })
// token: Redacted<"<id>.<secret>">  — the secret exists only here and in the cookie

yield* sessions.revokeOthers(userId, session.id)     // after a password change
```

None of this needs to be configured to get a secure baseline: only
`SHA-256(secret)` is ever stored, so a leaked session table cannot itself
authenticate anyone; idle-session refresh writes to storage at most once per
`touchEvery` (an hour by default) rather than on every request; a new
session is issued at every sign-in and after a password or email change,
with the old row deleted outright; and the cookie itself is
`__Host-session; Secure; HttpOnly; SameSite=Strict; Path=/` with no `Domain`
attribute, which is what makes the `__Host-` prefix legal and meaningful.

## 4. Closing the loop: reset and verification

*(Exercises [BEH-EA-057](../behaviors/08-verification-tokens.md#beh-ea-057-a-verification-token-is-scoped-to-one-purpose).)

The last piece of this walkthrough is what happens around the password
itself — a forgotten password, and a newly created account's email address.
Both flows use the same verification-token machinery under the hood, and
both are careful about what they reveal to a caller who does not yet own the
account in question.

```ts
yield* client.password.requestReset({ payload: { email } })     // always 202, even for unknown emails
// mail arrives with token
yield* client.password.confirmReset({ payload: { token: Redacted.make(tokenFromMail), password: Redacted.make(newPassword) } })
// → other sessions revoked, token consumed in the same transaction
```

Requesting a reset always answers `202`, whether or not the email address
belongs to an account — an attacker probing for valid emails learns nothing
from the response. Confirming a reset revokes every other session for that
user and consumes the token in the same transaction, so a token cannot be
replayed even by a caller racing two concurrent confirmations.

Email verification follows sign-up automatically:

```ts
yield* client.password.signUp({ payload: { email, password } })          // sends verification mail
yield* client.verification.confirm({ params: { token: Redacted.make(t) } })
// replaying the same token: 410 TokenConsumed, and event "auth.token.replay" is published
```

A replayed verification token is not silently ignored — it fails with `410
TokenConsumed` and publishes an `auth.token.replay` event, which is the kind
of signal an application can wire an alert to.

Finally, the password policy itself is configured at plugin construction,
not scattered across call sites:

```ts
password({ breachCheck: true, minLength: 12 })
// signUp with a pwned password → 422 WeakPassword { hints: ["appears in known breaches"] }
// HIBP unreachable → fail-open by default; password({ breachCheck: { onUnavailable: "reject" } }) to fail closed
```

By default, a breach-check provider being unreachable fails open — sign-up
is not blocked by a third-party outage — but an application with a stricter
posture can flip that with `onUnavailable: "reject"`.

That is the whole loop this appendix set out to walk: a server that runs
with no authorization concepts installed at all, an endpoint protected the
same way effect-auth protects its own, a session a user can see and revoke,
and the two flows — reset and verification — that keep a password account
recoverable without leaking who has an account at all.
