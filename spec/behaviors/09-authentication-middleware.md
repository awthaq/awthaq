# Authentication Middleware

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-09 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |

---

> awthaq is pre-implementation (see `spec/README.md`). Every signature, requirement, and behavior in this file specifies intended design — drawn from `archive/PRD.md` §10/§14 and `archive/design/usage-examples-v4.md` §4 — not code that has shipped.

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

`archive/design/usage-examples-v4.md` §11.3 documents the native-client path this handler serves: a mobile or CLI client with no cookie jar reaches the same contract via `Auth.api(..., { csrf: false })` and a bearer token pulled from a keychain, and is expected to be resolved to the same `Principal` shape a browser session would be.

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

_Previous: [BEH-EA-064](08-verification-tokens.md#beh-ea-064-purpose-scoped-flows-respond-uniformly-regardless-of-whether-their-target-exists)_
_Next: [BEH-EA-073](10-csrf.md#beh-ea-073-sec-fetch-site-is-the-primary-csrf-signal)_
