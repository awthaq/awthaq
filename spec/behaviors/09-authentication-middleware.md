# Authentication Middleware

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-09 |
> | Revision | 1.3 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): BEH-EA-066's native-client paragraph restated as shipped behaviour — opt-in bearer delivery (MNA-001), `set-auth-token` rotation, CSRF bootstrap (MNA-009) <br> 1.2 (2026-09-29): bearer/`x-api-key` credential-resolver registry (MAPS-001/MAPS-004/NAM-001), `MachineAuthentication` tier with the `apiKey` scheme (OCM-002) <br> 1.3 (2026-09-29): Replaced the pre-implementation banner with implementation pointers (DTWS-001, CCR-EA-006) |

---

> Implemented in `@awthaq/server` (`packages/server/src/Authentication.ts`; tests `packages/server/test/Authentication.test.ts`, `CredentialResolvers.test.ts`); the tests behind each behavior are mapped in [`spec/traceability.md`](../traceability.md) §5, and a behavior whose text differs from the shipped code carries an *Implementation* or *Deviation* note. The design was drawn from `archive/PRD.md` §10/§14 and `archive/design/usage-examples-v4.md` §4.

## BEH-EA-065: The `Authentication` middleware tries a cookie handler first, in its declared security record

> **See:** [ADR-EA-003](../decisions/003-httpapi-as-contract.md)

```ts
export class Authentication extends HttpApiMiddleware.Service<Authentication>()("Authentication", {
  security: { impersonation: ImpersonationCookie, cookie: SessionCookie, bearer: BearerToken }
}) {}
```

```text
REQUIREMENT: `Authentication`'s cookie handler MUST attempt to resolve
             `__Host-session` to a live, unexpired `Session` before the
             bearer scheme is attempted, per BEH-EA-028's
             declaration-order rule. The `impersonation` handler, declared
             ahead of it, MUST attempt `__Host-impersonation` first and MUST
             accept only a session carrying `actingAs` (BEH-EA-209) — an
             ordinary session presented in that cookie MUST NOT authenticate,
             and the chain falls through to `__Host-session`.
```

APS-006: `impersonation` exists so `@awthaq/admin`'s `impersonate` (BEH-EA-213) can deliver its session without overwriting the browser's single `__Host-session`; the admin's own cookie survives untouched and is restored the moment the impersonation cookie is cleared or its session hard-expires (a failed `impersonation` handler simply falls through). `OptionalAuthentication` declares the identical record. `@awthaq/qadi`'s Path B extractor and `@awthaq/next`'s `getSession` apply the same precedence so every entry point evaluates one identity per request.

OCM-002: `MachineAuthentication` is the same chain plus `apiKey` (the `x-api-key` request header, ADR-EA-022), declared between `cookie` and `bearer` so `bearer` remains the last scheme and owns the final `WWW-Authenticate` challenge. It is a separate middleware, not a scheme added to `Authentication`, because `Authentication` is the *user* tier — many handlers assume a session and treat any other principal as a wiring defect — so an API key or service token must never become a valid credential on a group that did not declare it. A group meant for CI, scripts or other services declares `MachineAuthentication`; `Authentication`, `OptionalAuthentication` and `AdminAuthentication` never see an `ApiKey`/`Service` principal and ignore `x-api-key`.

`archive/PRD.md` §10 places the cookie scheme first in the record shown throughout the design (`security: { cookie: SessionCookie, bearer }`), matching the browser-first cookie flow every worked example in `archive/design/usage-examples-v4.md` §1–§5 exercises. Because the record's own key order is the strategy chain (BEH-EA-028), moving bearer ahead of cookie is a one-line, explicit change to the middleware's definition, never an implicit precedence a caller has to infer.

## BEH-EA-066: The bearer handler is tried after the cookie handler fails, over the same session-resolution logic

```ts
const NativeApi = Auth.api(plugins.map((p) => p.contract), { csrf: false })
const client = yield* HttpApiClient.make(NativeApi, {
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(yield* Keychain.get("session")))
})
```

```text
REQUIREMENT: The bearer handler MUST resolve an `Authorization: Bearer
             <token>` header through the same `Sessions`/`PrincipalResolver`
             path the cookie handler uses, so that a native client
             presenting its session token as a bearer credential is
             recognized identically to a browser presenting the cookie.
```

**Bearer credential resolvers (MAPS-001/MAPS-004/NAM-001, wayfinder ticket 33).** A bearer (and, on the machine tier, `x-api-key`) credential is offered first to the resolvers plugins have contributed to `@awthaq/server`'s `CredentialResolvers` registry (ADR-EA-012: an aggregating registry, ordered by `order` then `id`, frozen at first read; `Authentication.contribute(carrier, { id, claims, resolve })`). `claims` is a cheap shape check (a JOSE `typ`, a key prefix) that never verifies; the first contribution whose `claims` matches resolves the credential straight to an `Api.Principal` and no other contribution is tried, so a claimed credential that fails is `Unauthenticated`. A bearer credential nobody claims falls through to the opaque session lookup above, unchanged; an unclaimed `x-api-key` is `Unauthenticated`. On the user tier (`Authentication`/`OptionalAuthentication`) a claimed credential is admitted only when it resolves to a `User` (a JWT re-entering); an `ApiKey`/`Service` principal there is `Unauthenticated` (anonymous under `OptionalAuthentication`), and only `MachineAuthentication` serves it. A stateless (non-session) principal delivers no rotated token, but `PostAuthResponseHook` still runs, told the scheme (`bearer` or `apiKey`). `@awthaq/jwt` contributes a `jwt` resolver for its own principal tokens when `JwtConfig.acceptAsBearer` is on (default off; bare `verify`, revocation lag bounded by `ttl`; a `signJWT({ audience })` token for another audience is rejected by the audience check), and `@awthaq/api-key` contributes the service-token and API-key resolvers. The registry is read per request through `Effect.serviceOption`, so `AuthenticationLive`'s requirements are unchanged and an app without one behaves as before. `@awthaq/qadi`'s Path B extractor resolves credentials through the same path.

**Native clients (MNA-001/MNA-009, wayfinder ticket 17).** A mobile or CLI client with no cookie jar reaches the same contract with a bearer token, and the whole path now exists. *Acquisition:* every session-minting response (password sign-up/sign-in/change-password, passkey authenticate, the OAuth native exchange — BEH-EA-128) honours the request header `X-Awthaq-Token-Delivery: bearer`; the session token is then the response DTO's optional `token` field, no `Set-Cookie` is written, and the response is `Cache-Control: no-store`. The header is opt-in per request — absent, the cookie-only behaviour is byte-for-byte unchanged, and a live token never appears in a body a browser's JS can read — and any other value is a `400 InvalidTokenDelivery` raised before a session is minted. `@awthaq/server`'s `SessionDelivery` (`mode` + `deliver`) is the one implementation every issuing handler routes through, so cookie and body token are mutually exclusive per request and a plugin never sets the session cookie itself. *Presentation:* `Authorization: Bearer <token>` resolves as above. *Rotation:* when `Sessions.verify` rotates a bearer-presented session's secret the new token is returned in the `set-auth-token` response header (`Api.ROTATED_TOKEN_HEADER`). Storing the token (Keychain/Keystore) is the application's responsibility. The `{ csrf: false }` contract variant (BEH-EA-171) is not built yet: a native client's *first* mutating request (sign-in has no `Authorization` header yet) still passes CSRF by obtaining the `__Host-csrf` cookie and echoing it in `x-csrf-token`; every later request carries `Authorization` and is exempt (MNA-008). Magic-link sign-in is unimplemented. For the CLI, the bearer token lives in the `CredentialStore` of [BEH-EA-228](26-cli.md#beh-ea-228-cli-credentials-live-in-a-credentialstore-never-a-plaintext-dotfile-by-default) (OS keychain first, never a plaintext dotfile by default); a mobile app's storage stays the application's job.

## BEH-EA-067: When no scheme succeeds under required authentication, the request fails `Unauthenticated`

```ts
export class ProjectsApi extends HttpApiGroup.make("projects").add(/* … */).middleware(Authentication) {}
```

```text
REQUIREMENT: A group under `Authentication` (not `OptionalAuthentication`)
             MUST fail the request with a typed `Unauthenticated` error when
             neither the cookie nor the bearer handler resolves a live
             session, before any handler code runs.
```

`archive/design/usage-examples-v4.md` §4.1 documents this as the group-level default: "401 Unauthenticated when no valid cookie or bearer token." Because this is middleware, not a check a handler author writes, an endpoint mounted under `Authentication` cannot forget to enforce it — the requirement is a property of the group's declared middleware, checked before `CurrentPrincipal` is even provided.

**The failure carries an RFC 6750/7235 challenge (JR-007).** The `401` response also carries `WWW-Authenticate`: `Bearer realm="awthaq"` when no bearer credential was presented (an absent credential carries no error code, RFC 6750 §3.1), and `Bearer realm="awthaq", error="invalid_token"` when one was and did not resolve, with the typed JSON body unchanged. A `401` a *handler* itself raises (for example a wrong password on a re-authentication endpoint) is not this middleware's failure and carries no challenge. `insufficient_scope` is reserved for when scope enforcement exists.

## BEH-EA-068: `OptionalAuthentication` resolves to `CurrentPrincipal = AnonymousPrincipal` rather than failing

```ts
HttpApiGroup.make("feed").add(/* … */).middleware(OptionalAuthentication)
home: () => CurrentPrincipal.use((p) => p._tag === "Anonymous" ? feed.public : feed.forUser(p))
```

```text
REQUIREMENT: A group under `OptionalAuthentication` MUST still provide
             `CurrentPrincipal` to its handlers when no credential is
             present or valid, with the value `AnonymousPrincipal`, and
             MUST NOT fail the request the way `Authentication` does.
```

This restates BEH-EA-029 from the middleware's own point of view: the difference between `Authentication` and `OptionalAuthentication` is entirely in what happens when no scheme succeeds — a typed failure in one case, a typed anonymous value in the other — while the resolution logic for a credential that *is* present is identical between them.

**It declares no error type (EHA-006).** `OptionalAuthentication` cannot fail with `Unauthenticated` — its implementation resolves the cookie, then the bearer credential, then defaults to `AnonymousPrincipal` itself — so it declares no `error`, and the generated OpenAPI document lists no `401` for endpoints under it (endpoints under `Authentication` still do). Its fallback does not depend on which scheme is declared last.

## BEH-EA-069: `PrincipalResolver` maps a verified session to a `Principal` value

```ts
type PrincipalResolver = { resolve: (session: Session) => Effect.Effect<Principal, never> }
```

```text
REQUIREMENT: `PrincipalResolver` MUST derive a `Principal` (BEH-EA-025)
             from a resolved `Session` (and, for the bearer/API-key case,
             from whatever principal-bearing credential resolved), without
             itself performing any authorization decision — that is
             qadi's `SubjectResolver`'s responsibility, downstream.
```

`archive/PRD.md` §7 separates these two resolution steps by design: `Principal` answers who is asking, and `AuthSubject` (via qadi's `SubjectResolver` slot) separately answers what they may do. `PrincipalResolver` is the middleware-internal service that performs the first step only, so that `Authentication`'s implementation has no dependency on qadi at all — the authorization stratum is a separate, later composition step (`archive/PRD.md` §15).

**Trust is gated on assurance, not on "has a session" (APS-007).** The resolved `UserPrincipal` carries the session's `amr` ([BEH-EA-049](07-sessions.md)). A fresh password sign-up holds a live session before its mailbox is verified, so a host that needs a verified email MUST also read `emailVerified`, which the default resolver leaves absent (it costs a lookup); the opt-in `PrincipalResolverWithUserFactsLive` loads the user once per request and sets it (a missing user resolves as unverified, never a defect).

## BEH-EA-070: `CurrentPrincipal` is provided by `Authentication`/`OptionalAuthentication` and consumed by handlers as an ordinary service

```ts
list: () => Effect.gen(function*() {
  const principal = yield* CurrentPrincipal
  return yield* projects.forOwner(principal.ref)
})
```

```text
REQUIREMENT: `CurrentPrincipal` MUST be available to a handler only as a
             consequence of that handler's group carrying `Authentication`
             or `OptionalAuthentication`; a handler MUST NOT be able to
             read `CurrentPrincipal` from a group that declares neither.
```

`archive/design/usage-examples-v4.md` §4.1 is the worked example: `CurrentPrincipal` is read with an ordinary `yield*` inside the handler body, exactly as any other service dependency would be, because the middleware's own Layer is what places it in scope. This is the HTTP-stratum instance of the same principle BEH-EA-001 states for plugins generally — no second mechanism for "is this value available here," just Effect's own context.

**Per-request resolution is memoized (PCS-006).** Session resolution is single-flight per (request, credential): `Sessions.verify` runs at most once per underlying request, and a second resolution (Path A and Path B on one route, or a prefix-mounted re-wrap of the request) awaits the first outcome. The consequence is a deliberate staleness budget: a session revoked mid-request keeps resolving for the remainder of *that* request (bounded by its lifetime; a streaming response or long upload inherits the window). Invalidating the memo on revoke-of-current is deliberately not done.

## BEH-EA-071: Different groups may select different authentication schemes

```ts
HttpApiGroup.make("machine").add(/* … */).middleware(ApiKeyAuthentication)   // ServicePrincipal
HttpApiGroup.make("app").add(/* … */).middleware(Authentication)             // cookie → bearer
```

```text
REQUIREMENT: An `HttpApi` group MUST be free to select a different
             authentication middleware than another group in the same
             composed contract, and the resulting `Principal` type MUST
             reflect the middleware chosen (`ServicePrincipal` for an
             API-key scheme, the ordinary union for `Authentication`).
```

`archive/design/usage-examples-v4.md` §4.3 documents machine-to-machine endpoints choosing `ApiKeyAuthentication` (an `x-api-key` header scheme resolving to `ServicePrincipal`) alongside ordinary application endpoints under `Authentication`, within one composed API — per-group middleware selection is designed to be independent groups making independent, explicit choices, not a single global authentication policy every endpoint shares.

**Admin tier (AR-003).** A group is *admin-tier* when any dot-separated segment of its identifier is `admin` (`admin`, `admin.tenants`, `billing.admin`; `AuthPlugin.isAdminTier`, mirrored at the type level by `AdminTierId`). Admin-tier groups select their own scheme, `AdminAuthentication` (same security record and `CurrentPrincipal` as `Authentication`; `@awthaq/server`'s default `AdminAuthenticationLive` delegates to it, so a co-hosted deployment is unchanged). `Auth.make` additionally returns `publicApi` (every group except the admin tier) and `adminApi` (only the admin tier), each typed to exactly its groups, beside the unchanged `api` (all groups): a host that wants the admin surface on its own listener/port, behind its own authentication (mTLS, a service principal), serves `adminApi` there with its own `AdminAuthentication` layer and `publicApi` on the public listener — handlers still come from the one composed `layer`, and no contract is forked. `@awthaq/admin`'s `admin` group is the first admin-tier group.

## BEH-EA-072: The security record's declaration order is the entire strategy chain — no separate ordering mechanism exists

```text
REQUIREMENT: There MUST be no configuration, priority number, or runtime
             flag that reorders which scheme `Authentication` tries first,
             independent of the order the `security` record's keys are
             declared; changing the order MUST mean changing the
             declaration itself.
```

This entry closes the loop opened by BEH-EA-028 and BEH-EA-065 (whose first entry, `impersonation`, is itself a declaration in the record — APS-006 needed no ordering knob to put it ahead of `cookie`): `archive/PRD.md` §10 states "the record *is* the strategy chain" as a design commitment, not merely a today's-default — there is deliberately no second, independent ordering knob to keep in sync with the declaration, which is exactly the kind of implicit, easy-to-desynchronize convention `research/09-plugin-architecture.md` Q27 documents Babel's plugin/preset ordering rules as a cautionary example of.

Only the *declaration's* key order matters (NHS-010): Effect iterates the declaration's `security` record and looks the Live handlers up by key, so the key order of the record an implementation returns is irrelevant, and no Live-side code depends on a scheme's position. A test pins the `security` keys of `Authentication`, `AdminAuthentication` and `OptionalAuthentication` to `["impersonation", "cookie", "bearer"]` and those of `MachineAuthentication` to `["impersonation", "cookie", "apiKey", "bearer"]` (APS-006 declares `impersonation` first; OCM-002 adds `apiKey` ahead of `bearer` on the machine tier only). Credential types a plugin adds through the `CredentialResolvers` registry are not schemes and never change this chain.

_Previous: [BEH-EA-064](08-verification-tokens.md#beh-ea-064-purpose-scoped-flows-respond-uniformly-regardless-of-whether-their-target-exists)_
_Next: [BEH-EA-073](10-csrf.md#beh-ea-073-sec-fetch-site-is-the-primary-csrf-signal)_
