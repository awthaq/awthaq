# Effect Auth — Usage Examples

Version 0.2 — 2026-09-12. The public API of `design/api-design-v4.md`, shown only through usage. Every snippet is complete for its purpose and uses Effect v4 idioms verified against `../effect` and qadi 0.4 against `../qadi`. Package names use the `@effect-auth/*` placeholder.

Reading order is the order a team meets these needs: run it, serve it, protect things, add methods, authorize, build the UI, extend, test, operate.

---

## 1. First run

### 1.1 The smallest server

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

Defaults in effect: argon2id hasher, memory rate limiter, console mailer, 30-day absolute / 7-day idle sessions, `__Host-session` cookie, CSRF on every unsafe method, `AUTH_SECRET` read from the environment.

```
POST /auth/password/sign-up    POST /auth/password/sign-in
GET  /auth/session             POST /auth/session/sign-out
GET  /auth/openapi.json        GET  /auth/docs
```

### 1.2 On the wire

```bash
curl -c jar -b jar -X POST localhost:3000/auth/password/sign-up \
  -H 'content-type: application/json' -H 'x-csrf-token: <from __Host-csrf cookie>' \
  -d '{"email":"ada@example.com","password":"correct horse battery staple"}'
# 200 {"principal":{"_tag":"User",...},"user":{...},"session":{...},"subject":{"id":"user:…","roles":[],"permissions":[],"attributes":{}}}

curl -b jar localhost:3000/auth/session
# 200 same shape

curl -b jar -X POST localhost:3000/auth/password/sign-in -d '{"email":"ada@example.com","password":"wrong"}'
# 401 {"_tag":"InvalidCredentials"}
```

---

## 2. Configuration

### 2.1 Production wiring

```ts
import { password } from "@effect-auth/password"
import { oauth, google, github } from "@effect-auth/oauth"
import { passkey } from "@effect-auth/passkey"
import { organization } from "@effect-auth/organization"
import { roles } from "@effect-auth/roles"
import { SessionConfig } from "@effect-auth/core"
import { PasswordHasher, Mailer } from "@effect-auth/ports"
import { PgClient, PgMigrator } from "@effect/sql-pg"
import { RateLimiter, KeyValueStore } from "effect/unstable/persistence"

const plugins = [
  password({ breachCheck: true }),
  oauth({ providers: [google(), github()], linking: "explicit" }),
  passkey({ rpId: "example.com", origins: ["https://example.com"] }),
  organization(),
  roles({ graph: [member, admin] })
] as const

export const AuthApi = Auth.api(plugins.map((p) => p.contract), { prefix: "/auth" })

export const AuthLive = Auth.layer(plugins).pipe(
  Layer.provide(Layer.succeed(SessionConfig, {
    ...SessionConfig.defaultValue(),
    absolute: Duration.days(7),
    idle: Duration.days(1)
  })),
  Layer.provide(PasswordHasher.layerArgon2id),
  Layer.provide(Mailer.layerSes),
  Layer.provide(RateLimiter.layer.pipe(
    Layer.provide(RateLimiter.layerStoreRedisConfig({ url: Config.Redacted("REDIS_URL") })))),
  Layer.provide(KeyValueStore.layerMemory),
  Layer.provide(Migrations.pipe(Layer.provideMerge(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })))),
  Layer.provide(NodeServices.layer)
)
```

Secrets are environment only. `google()` reads `AUTH_OAUTH_GOOGLE_CLIENT_ID` and `AUTH_OAUTH_GOOGLE_CLIENT_SECRET` inside its layer with `Config.Redacted`; nothing secret appears in this file.

### 2.2 What fails at boot, not at first request

```ts
const plugins = [twoFactor()] as const          // requires plugin "password"
Auth.layer(plugins)
// LinkError { code: "E_PLUGIN_MISSING_DEP", plugins: ["two-factor"], message: 'two-factor requires plugin "password"' }
```

```ts
const plugins = [password(), acmeLegacyLogin()] as const   // both contribute group "password"
Auth.api(plugins.map((p) => p.contract))
// throws at module evaluation: E_GROUP_CONFLICT "password" contributed by password@1.0.0 and acme.legacy-login@0.3.0
```

---

## 3. Serving

### 3.1 Effect Node server with your own API

```ts
const Routes = Layer.mergeAll(
  AuthHttp.routes(AuthApi),
  HttpApiBuilder.layer(AppApi).pipe(Layer.provide(AppHandlers)),
  AuthHttp.docs(AuthApi)
).pipe(Layer.provide(AuthLive))

Layer.launch(HttpRouter.serve(Routes, { disableLogger: false }).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)).pipe(NodeRuntime.runMain)
```

### 3.2 Next.js route handler

```ts
// app/api/auth/[...all]/route.ts
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { Routes } from "../../../../server/routes"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const { handler } = HttpRouter.toWebHandler(Routes.pipe(Layer.provide(HttpServer.layerServices)))
export { handler as GET, handler as POST }
```

### 3.3 Hono, or anything with `Request → Response`

```ts
const { handler } = HttpRouter.toWebHandler(Routes.pipe(Layer.provide(HttpServer.layerServices)))
app.all("/auth/*", (c) => handler(c.req.raw))
```

### 3.4 ManagedRuntime for imperative code paths

```ts
export const runtime = ManagedRuntime.make(AuthLive)

app.get("/me", async (c) => {
  const view = await runtime.runPromise(
    Sessions.use((s) => s.resolve(Redacted.make(readCookie(c, "__Host-session")))).pipe(
      Effect.flatMap((session) => SessionViews.use((v) => v.forSession(session))),
      Effect.catchTag("Unauthenticated", () => Effect.succeed(null))
    )
  )
  return view ? c.json(view) : c.body(null, 401)
})
```

---

## 4. Protecting your own endpoints

### 4.1 Require a signed-in principal

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

### 4.2 Optional authentication

```ts
import { OptionalAuthentication } from "@effect-auth/api"

HttpApiGroup.make("feed")
  .add(HttpApiEndpoint.get("home", "/", { success: Feed }))
  .middleware(OptionalAuthentication)      // CurrentPrincipal is AnonymousPrincipal when no credential

// handler
home: () => CurrentPrincipal.use((p) => p._tag === "Anonymous" ? feed.public : feed.forUser(p))
```

### 4.3 Different strategies for different groups

```ts
import { ApiKeyAuthentication } from "@effect-auth/api-key/api"   // its own scheme: x-api-key header

HttpApiGroup.make("machine").add(/* … */).middleware(ApiKeyAuthentication)   // ServicePrincipal
HttpApiGroup.make("app").add(/* … */).middleware(Authentication)             // cookie → bearer
```

---

## 5. Sessions

### 5.1 List devices and revoke

```ts
const client = yield* HttpApiClient.make(AuthApi, { baseUrl })

const devices = yield* client.session.list()
// [{ id, createdAt, lastActiveAt, expiresAt, userAgent: "Mozilla/…", current: true }, …]

yield* client.session.revoke({ params: { id: devices[1].id } })
yield* client.session.revokeOthers()
yield* client.session.signOut()
```

### 5.2 In-process

```ts
const sessions = yield* Sessions
const { session, token } = yield* sessions.issue({ userId, request: { ip, userAgent } })
// token: Redacted<"<id>.<secret>">  — the secret exists only here and in the cookie

yield* sessions.revokeOthers(userId, session.id)     // after a password change
```

### 5.3 Session rules you get without configuring anything

- Only `SHA-256(secret)` is stored; a leaked table cannot authenticate.
- Sliding idle refresh writes at most once per `touchEvery` (default one hour).
- A new session is issued at every sign-in and after password or email change; the old row is deleted.
- Cookie: `__Host-session; Secure; HttpOnly; SameSite=Strict; Path=/`, no `Domain`.

---

## 6. Password flows

### 6.1 Reset

```ts
yield* client.password.requestReset({ payload: { email } })     // always 202, even for unknown emails
// mail arrives with token
yield* client.password.confirmReset({ payload: { token: Redacted.make(tokenFromMail), password: Redacted.make(newPassword) } })
// → other sessions revoked, token consumed in the same transaction
```

### 6.2 Email verification

```ts
yield* client.password.signUp({ payload: { email, password } })          // sends verification mail
yield* client.verification.confirm({ params: { token: Redacted.make(t) } })
// replaying the same token: 410 TokenConsumed, and event "auth.token.replay" is published
```

### 6.3 Breach check and policy

```ts
password({ breachCheck: true, minLength: 12 })
// signUp with a pwned password → 422 WeakPassword { hints: ["appears in known breaches"] }
// HIBP unreachable → fail-open by default; password({ breachCheck: { onUnavailable: "reject" } }) to fail closed
```

---

## 7. OAuth

### 7.1 Sign in with Google

```
GET  /auth/oauth/google/authorize?redirect=/dashboard     → 302 to Google (PKCE S256, state stored server-side)
GET  /auth/oauth/google/callback?code=…&state=…           → sets session cookie, 302 to /dashboard
```

```ts
const url = yield* HttpApiClient.urlBuilder(AuthApi).oauth.authorize({ params: { provider: "google" }, query: { redirect: "/dashboard" } })
```

### 7.2 Linking is explicit by default

```ts
oauth({ providers: [google()], linking: "explicit" })
// signed-in user links a provider:
yield* client.oauth.link({ params: { provider: "github" } })     // 302 → callback attaches Account to the current user
// signing in with a provider whose email matches an existing account, unlinked → 409 AccountExists { provider: "password" }

oauth({ providers: [google()], linking: { trustedProviders: ["google"] } })   // opt in to verified-email auto-link
```

### 7.3 A custom provider

```ts
import { OAuthProvider } from "@effect-auth/oauth"

export const okta = OAuthProvider.oidc({
  id: "okta",
  issuer: Config.String("AUTH_OAUTH_OKTA_ISSUER"),
  clientId: Config.String("AUTH_OAUTH_OKTA_CLIENT_ID"),
  clientSecret: Config.Redacted("AUTH_OAUTH_OKTA_CLIENT_SECRET"),
  scopes: ["openid", "email", "profile"],
  profile: (claims) => ({ subject: claims.sub, email: claims.email, name: claims.name })
})
```

---

## 8. Passkeys

```ts
// browser
const options = yield* client.passkey.registerOptions()                       // WebAuthn PublicKeyCredentialCreationOptions
const credential = await navigator.credentials.create({ publicKey: options })
yield* client.passkey.registerVerify({ payload: { credential } })

const request = yield* client.passkey.authenticateOptions()
const assertion = await navigator.credentials.get({ publicKey: request })
const view = yield* client.passkey.authenticateVerify({ payload: { assertion } })   // SessionView

yield* client.passkey.list()
yield* client.passkey.remove({ params: { id } })      // refuses to remove the last credential when no other method exists
```

Challenges are single-use verification rows with a two-minute TTL; attestation defaults to `none`.

---

## 9. Two-factor

```ts
const plugins = [password(), twoFactor({ issuer: "Example" })] as const

// sign-in for a user with 2FA enabled: the password plugin is untouched; two-factor taps the divert point
yield* client.password.signIn({ payload }).pipe(
  Effect.catchTag("TwoFactorRequired", ({ challengeId }) =>
    client.twoFactor.verify({ payload: { challengeId, code: Redacted.make(totp) } }))   // SessionView
)

// enable
const { secret, otpauthUrl, recoveryCodes } = yield* client.twoFactor.enable({ payload: { password } })
yield* client.twoFactor.confirm({ payload: { code: Redacted.make(firstCode) } })
```

Recovery codes are hashed and single-use; `/two-factor/verify` is rate limited to three attempts per ten seconds by a rule the plugin ships.

---

## 10. Authorization with qadi

### 10.1 Define permissions, roles, policies once

```ts
// domain/authz.ts
import { allOf, anyOf, createPermissionGroup, eq, hasPermission, hasResourceAttribute, hasRole, role, subjectId } from "@qadi/core"

export const project = createPermissionGroup("project", ["read", "update", "delete", "invite"] as const)

export const member = role({ name: "member", permissions: [project.read] })
export const admin  = role({ name: "admin", permissions: [project.update, project.delete, project.invite], inherits: [member] })

export const canReadProject = allOf([
  hasPermission(project.read, { fields: ["id", "name", "summary", "visibility"] }),
  anyOf([hasRole("admin"), hasResourceAttribute("visibility", eq("public")), hasResourceAttribute("ownerId", subjectId())])
])
export const canDeleteProject = allOf([hasPermission(project.delete), hasResourceAttribute("ownerId", subjectId())])
```

### 10.2 Install the roles plugin so subjects carry roles

```ts
const plugins = [password(), roles({ graph: [member, admin] })] as const

// grant
yield* client.roles.assign({ params: { userId }, payload: { role: "admin" } })    // requires user:set-role
// GET /auth/session → subject.roles: ["admin", "member"], subject.permissions: ["project:read", …]
```

### 10.3 Path A: decide in the handler against the loaded resource

```ts
import { AuthorizedSubject } from "@effect-auth/qadi"
import { enforceProjected, filter, guard } from "@qadi/core"

export class ProjectsApi extends HttpApiGroup.make("projects")
  .add(
    HttpApiEndpoint.get("list", "/", { success: Schema.Array(ProjectView) }),
    HttpApiEndpoint.get("byId", "/:id", { params: { id: ProjectId }, success: ProjectView, error: ProjectNotFound }),
    HttpApiEndpoint.post("remove", "/:id/delete", { params: { id: ProjectId }, success: HttpApiSchema.NoContent, error: ProjectNotFound })
  )
  .middleware(Authentication)
  .middleware(AuthorizedSubject)        // provides qadi CurrentSubject from CurrentPrincipal
  .middleware(CsrfProtection)
  .prefix("/projects")
{}

export const ProjectsHandlers = HttpApiBuilder.group(AppApi, "projects", Effect.fn(function*(handlers) {
  const projects = yield* Projects
  return handlers.handleAll({
    list: () => projects.all.pipe(Effect.flatMap((all) => filter(canReadProject, all)), Effect.orDie),

    byId: ({ params }) => projects.byId(params.id).pipe(
      enforceProjected(canReadProject),                                     // response has only granted fields
      Effect.catchTag("AccessDenied", () => new ProjectNotFound({ id: params.id })),   // 404, not 403: no enumeration
      Effect.orDie
    ),

    remove: ({ params }) => projects.byId(params.id).pipe(
      Effect.flatMap((p) => guard(project.delete, canDeleteProject)(p, (_witness, resource) => projects.remove(resource.id))),
      Effect.catchTag("AccessDenied", () => new ProjectNotFound({ id: params.id })),
      Effect.orDie
    )
  })
}))
```

### 10.4 Path B: declare the permission on the endpoint

```ts
import { PublicEndpoint, publicEndpoint, RequiredPermission, RequirePermission, requiresPermission } from "@qadi/http"

export class AdminApi extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("stats", "/stats", { success: Stats }).pipe((e) =>
      e.annotate(RequiredPermission, requiresPermission(e, { permission: adminAccess, policy: hasRole("admin") }))),
    HttpApiEndpoint.get("health", "/health", { success: HttpApiSchema.NoContent }).pipe((e) =>
      e.annotate(PublicEndpoint, publicEndpoint("liveness probe")))
    // an endpoint with neither annotation → 500 and a log naming it; absence is refusal
  )
  .middleware(RequirePermission)
  .prefix("/admin")
{}
```

### 10.5 Wire qadi

```ts
import { EvaluationServicesNone, EvaluationIdLive, decisionCacheLayer } from "@qadi/core"
import { RequirePermissionLive, PermissionRegistryLive, registerApi, permissionRegistryRoute } from "@qadi/http"
import { AuthorizedSubjectLive, SubjectExtractorLive } from "@effect-auth/qadi"

const QadiLive = Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive, decisionCacheLayer({ capacity: 512 }))

const AuthzLive = Layer.mergeAll(
  AuthorizedSubjectLive,
  RequirePermissionLive.pipe(Layer.provide(SubjectExtractorLive))
).pipe(Layer.provide(AuthLive))

const Routes = Layer.mergeAll(
  AuthHttp.routes(AuthApi),
  HttpApiBuilder.layer(AppApi).pipe(Layer.provide([ProjectsHandlers, AdminHandlers])),
  registerApi(AppApi),
  permissionRegistryRoute(adminAccess, hasRole("admin"))       // GET /__permissions, guarded
).pipe(Layer.provide(AuthzLive), Layer.provide(QadiLive), Layer.provide(AuthLive), Layer.provideMerge(PermissionRegistryLive))
```

### 10.6 Attributes from your own store

```ts
import { attributeResolverFromRecord, AttributeResolver } from "@qadi/core"

const Attributes = Layer.effect(AttributeResolver, Effect.gen(function*() {
  const users = yield* Users
  return AttributeResolver.of({
    resolve: (subjectId, attribute) => attribute === "plan"
      ? users.byRef(subjectId).pipe(Effect.map((u) => u.plan))
      : Effect.succeed(undefined)
  })
}))
// policy: hasAttribute("plan", eq("pro"))
```

### 10.7 In-process, for a job

```ts
const subject = yield* SubjectResolver.use((s) => s.resolve(reportsService))   // ServicePrincipal
const visible = yield* filter(canReadProject, yield* Projects.all).pipe(Effect.provide(currentSubjectLayer(subject)))
```

---

## 11. Client

### 11.1 Effect client

```ts
import { HttpApiClient, HttpApiMiddleware } from "effect/unstable/httpapi"
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http"
import { CsrfProtection } from "@effect-auth/api"

export const CsrfClient = HttpApiMiddleware.layerClient(CsrfProtection, ({ next, request }) =>
  next(HttpClientRequest.setHeader(request, "x-csrf-token", readCookie("__Host-csrf") ?? "")))

const program = Effect.gen(function*() {
  const client = yield* HttpApiClient.make(AuthApi, { baseUrl: "https://app.example.com" })
  const view = yield* client.password.signIn({ payload: { email, password: Redacted.make(pw) } })
  return view.user
}).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, CsrfClient)))
//   remove CsrfClient → compile error: ForClient<CsrfProtection> is required
```

### 11.2 Typed errors in the UI

```ts
client.password.signIn({ payload }).pipe(
  Effect.catchTags({
    InvalidCredentials: () => Effect.succeed(t("auth.invalid")),
    RateLimited: ({ retryAfterMillis }) => Effect.succeed(t("auth.slowDown", { seconds: retryAfterMillis / 1000 })),
    TwoFactorRequired: ({ challengeId }) => navigate(`/2fa/${challengeId}`)
  })
)

type AuthErrorCode = AuthClient.ErrorCodes<typeof AuthApi>   // "InvalidCredentials" | "RateLimited" | … for i18n catalogs
```

### 11.3 Bearer mode for native clients

```ts
const NativeApi = Auth.api(plugins.map((p) => p.contract), { csrf: false })   // groups without CsrfProtection
const client = yield* HttpApiClient.make(NativeApi, {
  baseUrl,
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(yield* Keychain.get("session")))
})
```

---

## 12. React

### 12.1 Client and atoms

```ts
// client/auth.ts
import { AtomHttpApi } from "effect/unstable/reactivity"

export class AuthClient extends AtomHttpApi.Service<AuthClient>()("app/AuthClient", {
  api: AuthApi,
  httpClient: FetchHttpClient.layer.pipe(Layer.merge(CsrfClient)),
  baseUrl: "/"
}) {}

export const sessionAtom = AuthClient.query("session", "current", { reactivityKeys: ["session"], timeToLive: "5 minutes" })
export const signIn  = AuthClient.mutation("password", "signIn")     // pass reactivityKeys: ["session"] to invalidate
export const signOut = AuthClient.mutation("session", "signOut")
```

### 12.2 Providers: session feeds qadi

```tsx
// client/Providers.tsx
"use client"
import { RegistryProvider, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/unstable/reactivity"
import { QadiProvider, hydrateDecisions, makeQadiAtoms } from "@qadi/react"
import { EvaluationServicesNone, EvaluationIdLive, makeSubject } from "@qadi/core"

const qadiAtoms = makeQadiAtoms(Layer.mergeAll(EvaluationServicesNone, EvaluationIdLive))

const toSubject = (v: SessionView | undefined) =>
  v && makeSubject({ id: v.subject.id, roles: v.subject.roles, permissions: v.subject.permissions as never, attributes: v.subject.attributes })

export const Providers = ({ initialSession, decisions, children }: ProvidersProps) => (
  <RegistryProvider initialValues={[[sessionAtom, AsyncResult.success(initialSession)]]}>
    <Authz decisions={decisions}>{children}</Authz>
  </RegistryProvider>
)

const Authz = ({ decisions, children }: { decisions?: DehydratedDecisions; children: React.ReactNode }) => {
  const session = useAtomValue(sessionAtom)
  const subject = toSubject(AsyncResult.isSuccess(session) ? session.value : undefined)
  const [initialValues] = useState(() => decisions && subject ? Array.from(hydrateDecisions(qadiAtoms, decisions, subject)) : [])
  return <QadiProvider atoms={qadiAtoms} subject={subject} initialValues={initialValues}>{children}</QadiProvider>
}
```

### 12.3 A sign-in form

```tsx
import { useAtom, useAtomValue } from "@effect/atom-react"

export const SignIn = () => {
  const [result, run] = useAtom(signIn)
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    run({ payload: { email: String(data.get("email")), password: Redacted.make(String(data.get("password"))) }, reactivityKeys: ["session"] })
  }
  return (
    <form onSubmit={onSubmit}>
      <input id="email" name="email" type="email" required />
      <input id="password" name="password" type="password" required />
      <button disabled={AsyncResult.isWaiting(result)}>Sign in</button>
      {AsyncResult.isFailure(result) && result.cause._tag === "InvalidCredentials" && <p>Wrong email or password.</p>}
    </form>
  )
}
```

### 12.4 Reading the session and gating the UI

```tsx
import { Can, useCan, useProjected } from "@qadi/react"

export const Header = () => {
  const session = useAtomValue(sessionAtom)
  if (!AsyncResult.isSuccess(session) || !session.value) return <a href="/sign-in">Sign in</a>
  return <span>{session.value.user.name} <SignOutButton /></span>
}

export const ProjectCard = ({ resource }: { resource: ProjectResource }) => {
  const view = useProjected(canReadProject, resource)          // only granted fields
  return (
    <article>
      <h3>{view.name}</h3>
      <Can policy={canDeleteProject} resource={resource} pending={<Spinner />}>
        <DeleteButton id={resource.id} />
      </Can>
    </article>
  )
}
```

Sign-in invalidates `["session"]`; the session atom refetches; `subject` changes; every `Can` re-decides. One store.

---

## 13. Next.js with server rendering

```tsx
// app/projects/page.tsx — React Server Component
import { headers } from "next/headers"
import { decide, filter, currentSubjectLayer } from "@qadi/core"
import { dehydrateDecisions } from "@qadi/react"
import { getSession } from "@effect-auth/next"

export const dynamic = "force-dynamic"

export default async function Page() {
  const session = await getSession({ headers: await headers() })      // SessionView | undefined, from the cookie, database-verified
  if (!session) redirect("/sign-in")

  const { views, decisions } = await runtime.runPromise(
    Effect.gen(function*() {
      const subject = yield* SubjectResolver.use((s) => s.resolve(session.principal))
      const projects = yield* Projects.all
      const resources = projects.map(policyResource)                  // attributes only, never content
      const entries = yield* Effect.forEach(resources, (resource) =>
        Effect.map(decide(canDeleteProject, { resource }), (decision) => ({ policy: canDeleteProject, resource, decision })))
      return { views: yield* filter(canReadProject, projects), decisions: dehydrateDecisions(entries) }
    }).pipe(Effect.provide(currentSubjectLayer(subject)))
  )

  return (
    <Providers initialSession={session} decisions={decisions}>
      <ProjectList projects={views} />
    </Providers>
  )
}
```

```ts
// proxy.ts — optimistic redirect only, never the boundary
import { hasSessionCookie } from "@effect-auth/next"
export function proxy(request: NextRequest) {
  if (!hasSessionCookie(request) && request.nextUrl.pathname.startsWith("/app")) return NextResponse.redirect(new URL("/sign-in", request.url))
}
```

```ts
// server action
"use server"
import { withNextCookies } from "@effect-auth/next"
export async function changeName(form: FormData) {
  return runtime.runPromise(withNextCookies(Users.use((u) => u.rename(String(form.get("name"))))))   // Set-Cookie from Effect reaches Next's jar
}
```

---

## 14. Hooks

```ts
import { AuthHooks, Hooks, HookAbort } from "@effect-auth/core"

// veto: only company addresses may sign up
const CompanyEmail = AuthHooks.tap(Hooks.beforeSignUp, (input) =>
  input.email.endsWith("@acme.com") ? Effect.succeed(input)
    : HookAbort.fail({ code: "EMAIL_DOMAIN_NOT_ALLOWED", message: "Use your company address." }))

// amend: normalize before the password plugin sees it
const Normalize = AuthHooks.tap(Hooks.beforeSignUp, (input) => Effect.succeed({ ...input, email: input.email.toLowerCase() }), { order: "pre" })

// observe: cannot fail sign-in even if it throws
const Welcome = AuthHooks.tap(Hooks.afterSignUp, (user) => Mailer.use((m) => m.send({ to: user.email, template: "welcome" })))

export const AuthLive = Auth.layer(plugins).pipe(Layer.provide(Layer.mergeAll(CompanyEmail, Normalize, Welcome)), /* … */)
```

Resolved order is printable: `effect-auth plugin list --hooks`.

---

## 15. Events

```ts
import { AuthEvents } from "@effect-auth/core"

const Audit = AuthEvents.on("auth.user.signedIn", (e) => AuditLog.use((a) => a.write({ kind: "sign-in", userId: e.userId, strategy: e.strategy })))
const Analytics = AuthEvents.on("auth.user.created", (e) => Segment.use((s) => s.track("signup", { userId: e.userId })))

// or the stream directly
yield* AuthEvents.use((ev) => ev.stream.pipe(Stream.filter((e) => e._tag === "auth.token.replay"), Stream.runForEach(alertSecurity), Effect.forkScoped))
```

Publishers never await subscribers. A failing subscriber is logged with `auth.event.observer.error` and does not fail the operation.

---

## 16. Rate limiting

```ts
import { RateLimiter } from "effect/unstable/persistence"

// per-endpoint rule contributed by a plugin (only on its own endpoints)
manifest: { id: "acme.invite", apiVersion: 1 },
layer: Layer.mergeAll(Invites.layerNoDeps, InviteHandlers,
  AuthRateLimits.rule({ group: "invite", endpoint: "create", key: "principal", limit: 10, window: "10 minutes" }))

// direct use inside a service
yield* limiter.consume({ key: `signin:${email}`, limit: 5, window: "15 minutes" }).pipe(
  Effect.mapError(({ resetAfter }) => new RateLimited({ retryAfterMillis: Duration.toMillis(resetAfter) })))
```

---

## 17. Swapping ports

```ts
// a different hasher
Layer.provide(PasswordHasher.layerScrypt)                  // WebCrypto-only runtimes

// your own mailer
const ResendMailer = Layer.effect(Mailer, Effect.gen(function*() {
  const key = yield* Config.Redacted("RESEND_API_KEY")
  const http = yield* HttpClient.HttpClient
  return Mailer.of({ send: (msg) => /* POST api.resend.com */ Effect.void })
}))

// Redis-backed cookie cache / challenges
Layer.provide(KeyValueStore.layerRedis)

// tests
Layer.provide(Mailer.layerMemory)          // records; Mailer.sent to assert
Layer.provide(Layer.mock(Mailer, { send: () => Effect.void }))
```

Providing two layers for one port is a compile-time shadow, never a merge; the linker refuses two *plugins* that declare the same port with `E_PORT_CONFLICT`.

---

## 18. Multi-tenant

```ts
export class TenantProviders extends LayerMap.Service<TenantProviders>()("app/TenantProviders", {
  lookup: (tenantId: string) => OAuthProviders.layerFromConfig(tenantId),
  idleTimeToLive: "10 minutes"
}) {}

// per request: the tenant comes from the host header
const WithTenant = HttpRouter.middleware<{ provides: OAuthProviders }>()(Effect.gen(function*() {
  const map = yield* TenantProviders
  return (httpEffect) => Effect.gen(function*() {
    const host = yield* HttpServerRequest.HttpServerRequest.pipe(Effect.map((r) => r.headers.host ?? ""))
    return yield* Effect.provide(httpEffect, map.get(tenantFromHost(host)))
  })
})).layer
```

A tenant can enable an installed provider; it cannot install one. Tenant settings are validated against `Auth.link` at boot.

---

## 19. Impersonation

```ts
const plugins = [password(), roles({ graph }), admin({ impersonation: { maxDuration: Duration.hours(1) } })] as const

yield* client.admin.impersonate({ params: { userId }, payload: { reason: "support ticket #4821" } })
// new session row: userId = target, actingAs = admin; hard 60-minute expiry, no sliding refresh
// CurrentPrincipal → UserPrincipal { userId: target, actingAs: { type: "user", id: admin } }
// events: auth.session.issued with actingAs; UI reads session.subject.attributes.actingAs to show a staff bar
yield* client.admin.stopImpersonating()
```

---

## 20. API keys and service principals

```ts
const plugins = [password(), apiKey({ prefix: "ak_" })] as const

const { key } = yield* client.apiKey.create({ payload: { name: "ci", scopes: ["project:read"], expiresIn: "90 days" } })
// key: Redacted<"ak_…"> shown once; only its hash is stored

// server-to-server call
curl -H "x-api-key: ak_…" https://app.example.com/machine/projects
// CurrentPrincipal → ApiKeyPrincipal { keyId, scopes: ["project:read"] } ; SubjectResolver maps scopes to qadi permissions
```

---

## 21. Writing a plugin

```ts
// index.ts — the whole plugin contract in one value
export const invite = (options?: { readonly ttl?: Duration.Input }) => Auth.plugin({
  manifest: {
    id: "acme.invite", apiVersion: 1, version: "1.0.0",
    requires: { plugins: ["password"], ports: ["effect-auth/ports/Mailer"] },
    tables: ["invite_invitation"]
  },
  contract: InviteContract,                                   // HttpApi.make("auth").add(InviteApi)  (api.ts, isomorphic)
  migrations,                                                 // Record<string, Effect<void, unknown, SqlClient>>
  layer: Layer.mergeAll(
    Invites.layerNoDeps,                                      // Context.Service, SqlModel repository, Crypto, Mailer, RateLimiter
    InviteHandlers,                                           // HttpApiBuilder.group(InviteContract, "invite", …)
    AuthHooks.tap(Hooks.beforeUserDelete, (u) => Invites.use((i) => i.purgeFor(u.id))),
    AuthEvents.on("auth.user.created", (e) => Invites.use((i) => i.markAccepted(e.userId)))
  )
})
```

The contract, migrations and manifest are static; options reach only Layers. `effect-auth plugin list` reads the static half without executing anything.

---

## 22. Testing

### 22.1 Whole pipeline, no server, no database, controlled clock

```ts
import { assert, layer } from "@effect/vitest"
import { HttpApiTest } from "effect/unstable/httpapi"
import { TestClock } from "effect/testing"
import { TestAuth } from "@effect-auth/test"

const TestLive = TestAuth.layer(plugins)              // *.layerMemory, Mailer.layerMemory, permissive RateLimiter, HttpServer.layerServices
const makeClient = HttpApiTest.groups(AuthApi, ["password", "session"])

layer(TestLive)("sessions", (it) => {
  it.effect("idle expiry signs the user out", () => Effect.gen(function*() {
    const client = yield* makeClient
    yield* client.password.signUp({ payload: { email: "a@b.c", password: Redacted.make("correct horse battery staple") } })
    yield* TestClock.adjust("8 days")
    const err = yield* client.session.current().pipe(Effect.flip)
    assert.strictEqual(err._tag, "Unauthenticated")
  }).pipe(Effect.provide(TestAuth.csrfClient)))

  it.effect("reset mail is sent and the token is single-use", () => Effect.gen(function*() {
    const client = yield* makeClient
    yield* client.password.requestReset({ payload: { email: "a@b.c" } })
    const [mail] = yield* Mailer.sent
    yield* client.password.confirmReset({ payload: { token: mail.data.token, password: Redacted.make("new-long-password-42") } })
    const err = yield* client.password.confirmReset({ payload: { token: mail.data.token, password: Redacted.make("again") } }).pipe(Effect.flip)
    assert.strictEqual(err._tag, "InvalidToken")
  }).pipe(Effect.provide(TestAuth.csrfClient)))
})
```

### 22.2 Authorization

```ts
import { qadiTestLayer, subjectWith } from "@qadi/testing"

it.effect("only the owner may delete", () => Effect.gen(function*() {
  const owner = subjectWith({ id: "user:u1", permissions: [project.delete] })
  const other = subjectWith({ id: "user:u2", permissions: [project.delete] })
  const resource = { ownerId: "user:u1" }
  assert.isTrue(yield* check(canDeleteProject, { resource }).pipe(Effect.provide(currentSubjectLayer(owner))))
  assert.isFalse(yield* check(canDeleteProject, { resource }).pipe(Effect.provide(currentSubjectLayer(other))))
}).pipe(Effect.provide(qadiTestLayer())))
```

### 22.3 Plugin contract tests

```ts
import { runPluginContractTests } from "@effect-auth/test"
runPluginContractTests(invite, { options: [{}, { ttl: "1 hour" }], host: [password()] })
// manifest legality · group id uniqueness · table prefixes · migration determinism · veto only in veto points ·
// observer isolation · no Redacted in spans · options do not change the contract hash · missing host dep → E_PLUGIN_MISSING_DEP
```

---

## 23. Operating

```bash
effect-auth doctor                     # link + config + insecure defaults (sameSite lax, csrf off, dev mailer in prod)
effect-auth plugin list --graph        # topo order, ports, hook chains
effect-auth routes                     # method, path, group, plugin, middleware
effect-auth migration status           # applied / pending against the Migrator ledger
effect-auth migration apply --yes
effect-auth openapi > openapi.json
```

```ts
// observability: spans auth.<op>, metrics auth.signin.total{outcome}, auth.denied.total{reason}; nothing sensitive in attributes
import { Otlp } from "effect/unstable/observability"
Layer.provide(Otlp.layer({ baseUrl: "http://otel-collector:4318", resource: { serviceName: "app" } }))
```
