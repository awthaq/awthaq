# The Contract Stratum

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-04 |
> | Revision | 1.1 |
> | Effective Date | 2026-09-29 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) <br> 1.1 (2026-09-29): Replaced the pre-implementation banner with implementation pointers (DTWS-001, CCR-EA-006) |

---

> Implemented in `@awthaq/api` (`packages/api/src`; tests `packages/api/test`); the tests behind each behavior are mapped in [`spec/traceability.md`](../traceability.md) §5, and a behavior whose text differs from the shipped code carries an *Implementation* or *Deviation* note. The design was drawn from `archive/PRD.md` §10.

## BEH-EA-025: A Principal is a tagged union carrying a Zanzibar-shaped reference

> **See:** [ADR-EA-003](../decisions/003-httpapi-as-contract.md)

```ts
type PrincipalRef = { readonly type: string; readonly id: string }

type Principal =
  | UserPrincipal    // { sessionId, actingAs?: PrincipalRef }
  | ApiKeyPrincipal
  | ServicePrincipal
  | AnonymousPrincipal
```

```text
REQUIREMENT: `Principal` MUST be a `Schema.Union` of `Schema.TaggedClass`es,
             each carrying a `PrincipalRef { type, id }`, so that "who is
             asking" is decodable and encodable the same way any other
             contract value is, with no principal kind reachable except
             through one of the declared tags.
```

`archive/PRD.md` §7 fixes `Principal` as the answer to "who is asking," strictly upstream of qadi's `AuthSubject`, which answers "what may they do." Modeling it as a tagged union means a handler that pattern-matches on `principal._tag` is exhaustive-checked by the compiler, and an `actingAs` reference on `UserPrincipal` gives impersonation (`archive/PRD.md` §17) a place to carry a second identity without inventing a fifth principal kind for it.

## BEH-EA-026: `SessionView` and `SubjectDto` are the wire shapes of "who is signed in and what they may do"

```ts
type SessionView = { principal: Principal; user: User; session: Session; subject: SubjectDto }
type SubjectDto = { id: string; roles: ReadonlyArray<string>; permissions: ReadonlyArray<string>; attributes: Record<string, unknown> }
```

```text
REQUIREMENT: `SessionView` MUST include `principal`, `user`, `session`, and
             `subject` as one struct; `SubjectDto` MUST represent qadi's
             `AuthSubject` with its roles and permissions flattened to
             arrays, suitable for serialization over the wire.
```

`archive/PRD.md` §7 and §16 describe `SessionView` as the single response shape returned by sign-in, sign-up, and `GET /auth/session` alike (`archive/design/usage-examples-v4.md` §1.2), and `SubjectDto` as the array-shaped counterpart of qadi's `AuthSubject` the React and Next.js bindings reconstitute client-side (`archive/design/usage-examples-v4.md` §12.2, `makeSubject`). One shape answering "what does the client now know" is designed to remove the need for a second, ad hoc session-serialization format per plugin.

## BEH-EA-027: Every contract error is a `Schema.TaggedError` carrying its own `httpApiStatus`, and credential errors are enumeration-safe

```ts
class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()("InvalidCredentials", {}, {
  httpApiStatus: 401
}) {}
```

```text
REQUIREMENT: Every error a contract endpoint may return MUST be a
             `Schema.TaggedError` annotated with its own `httpApiStatus`;
             `InvalidCredentials` MUST be the identical error and status
             whether the submitted email exists or not, so that no
             observable difference discloses account existence.
```

`archive/PRD.md` §6 (Design principle 6) requires "typed failures with reasons," and §18 requires "uniform enumeration-safe errors" as part of the security model — a login form that returns a distinguishable error for "no such email" versus "wrong password" is a well-known account-enumeration oracle, and the plan is to make the error type itself incapable of expressing that distinction rather than rely on every handler author remembering not to leak it.

## BEH-EA-028: `Authentication` is a single multi-scheme middleware tried in declaration order

```ts
export class Authentication extends HttpApiMiddleware.Service<Authentication>()("Authentication", {
  security: { cookie: SessionCookie, bearer: BearerToken }
}) {}
```

```text
REQUIREMENT: `Authentication` MUST be one `HttpApiMiddleware.Service` whose
             `security` record is tried in the order its keys are declared,
             stopping at the first scheme that succeeds; the record itself
             MUST be the entire strategy chain, with no separate ordering
             mechanism.
```

`archive/PRD.md` §10 states this is an Effect v4 capability the design leans on directly: "v4 tries schemes in declaration order and returns the first success; the record *is* the strategy chain." This replaces what other frameworks implement as an ordered list of named strategies (`research/03-auth-landscape.md`'s remix-auth `Strategy` interface is cited as the cleanest prior art for one-interface-many-credentials) with a data structure whose order is legible from the declaration itself.

## BEH-EA-029: `OptionalAuthentication` yields an `AnonymousPrincipal` instead of failing

```ts
HttpApiGroup.make("feed").add(HttpApiEndpoint.get("home", "/", { success: Feed })).middleware(OptionalAuthentication)

home: () => CurrentPrincipal.use((p) => p._tag === "Anonymous" ? feed.public : feed.forUser(p))
```

```text
REQUIREMENT: A group under `OptionalAuthentication` MUST still provide
             `CurrentPrincipal` to its handlers when no valid cookie or
             bearer credential is present, resolving to `AnonymousPrincipal`
             rather than failing the request with `Unauthenticated`.
```

`archive/design/usage-examples-v4.md` §4.2 is the source example: a public feed endpoint that personalizes for a signed-in user but still serves anonymous visitors reads `CurrentPrincipal` unconditionally and branches on its tag, rather than wrapping the call in `Effect.catchTag("Unauthenticated", ...)`. Making "no credential" a value (`AnonymousPrincipal`) instead of an error is designed to let a handler's success path express both cases without a parallel failure-handling path for the anonymous one.

## BEH-EA-030: `CsrfProtection` declares `requiredForClient: true`, gating client generation at the type level

```ts
export class CsrfProtection extends HttpApiMiddleware.Service<CsrfProtection>()("CsrfProtection", {
  requiredForClient: true
}) {}
```

```text
REQUIREMENT: An `HttpApi` group carrying `CsrfProtection` MUST fail to
             produce a usable `HttpApiClient` / `AtomHttpApi.Service` unless
             `HttpApiMiddleware.layerClient(CsrfProtection, ...)` is also
             supplied to the client build.
```

> **Invariant:** [INV-EA-011](../invariants.md#inv-ea-011-csrf-protection-is-required-by-the-generated-clients-type-not-merely-documented)

`archive/PRD.md` §10 states the intended effect directly: "a generated client does not type-check without the client half." `archive/design/usage-examples-v4.md` §11.1 shows the failure mode this closes off: removing the `CsrfClient` layer from a client program is designed to be a compile error naming `ForClient<CsrfProtection>` as still required, not a runtime 403 discovered by a user mid-session.

## BEH-EA-031: Core owns a `session` group at the API root, with `current`, `list`, `signOut`, `revoke`, `revokeOthers`, and `revokeAll`

```
GET  /auth/session
GET  /auth/session/list
POST /auth/session/sign-out
POST /auth/session/revoke
POST /auth/session/revoke-others
POST /auth/session/revoke-all
```

```text
REQUIREMENT: The core `session` group MUST mount at the root of the
             composed `HttpApi` (not under any plugin's namespace prefix)
             and MUST expose `current`, `list`, `signOut`, `revoke`,
             `revokeOthers`, and `revokeAll` as its endpoints.
```

MW-008: `SessionDto`'s `createdAt`, `lastActiveAt` and `expiresAt` are ISO-8601 date-time strings on the wire (`format: "date-time"` in the generated OpenAPI document) that decode to `DateTime.Utc`; a malformed timestamp neither decodes nor encodes, and constructing a `SessionDto` takes `DateTime.Utc` values, not strings.

`archive/design/plugins-as-layers.md` §6 states core's one privilege plainly: "its groups sit at the root of `/auth` and its ids are reserved." `archive/design/usage-examples-v4.md` §5.1 is the worked example of these endpoints in use (listing devices, revoking one, revoking the rest, signing out) through the same client the plugin groups are reached through — core's session surface is designed to need no plugin to exist at all. `revokeAll` (TIR-006) is the sixth endpoint: it kills every session for the caller *including the current one* and, like `signOut`, its response expires the `__Host-session` cookie, which is what a password reset relies on.

## BEH-EA-032: `Auth.api` merges contracts and refuses a duplicate group id

```ts
export const AuthApi = Auth.api(plugins.map((p) => p.contract), { prefix: "/auth" })
```

```text
REQUIREMENT: Merging two contracts that declare the same `HttpApiGroup` id
             through `Auth.make` (the composed `api`) MUST fail — at the type
             level via the `Validate<P>` machinery for plugin classes, and at
             composition for every group it merges (a plugin's, core's, a
             host's `extraGroups`) — never by one group silently replacing
             the other.
```

`archive/design/usage-examples-v4.md` §2.2 is the documented failure this behavior must reproduce: `password()` and a third-party `acmeLegacyLogin()` both contributing a group named `"password"` is designed to be caught as `E_GROUP_CONFLICT`, naming both contributing plugins by version, at the point the contracts are merged — never resolved by whichever plugin happened to be added to the array last.

**As shipped (PV-251):** the refusal is `Auth.make`'s (`composeApi`, `GroupIdConflict`, `E_GROUP_CONFLICT`). Effect's own `HttpApi.addHttpApi` copies groups with `assignProperty`, so a same-id group **replaces** the earlier one without an error; awthaq cannot change that, and a host that merges raw contracts by hand outside `Auth.make` gets that silent replacement. A host with a group no plugin owns therefore hands it to `Auth.make` as `extraGroups`, where a duplicate id is refused (REQ-EA-082, attributed to `core`/`host`); merging with `addHttpApi` directly is unsupported.

MW-002 (wayfinder ticket 26): the composed `api` is the one served document. `Auth.make` seeds it with core's own `session` and `account` groups (attributed to the pseudo-owner `core` in a conflict message, so a plugin reusing one of those ids, or one of their routes, is refused exactly as two plugins colliding are), then the optional `extraGroups` a host passes for groups no plugin owns (`@awthaq/qadi`'s `SubjectApi.SubjectGroup`), then every plugin group. `Built<P, Extra>["api"]` types all of them; `publicApi` keeps core's and the host's groups (none is admin-tier). Their handlers are `@awthaq/server`'s `AuthHttp.coreHandlers` (a composition that serves `built.api` without them fails at layer build); the standalone `AuthCore.AuthCoreApi` remains the typed input those handlers are built against, not a separately served document.

AVS-004: group ids are not the only thing two plugins can collide on. `Auth.make` also refuses two contributed endpoints, in the same or different groups, with the same method and path (`RouteConflict`, `E_ROUTE_CONFLICT`, naming both plugins, the method and the path); the router would otherwise serve whichever registered first and shadow the other. This is a composition-time check rather than a registry of reserved paths, so it covers a plugin's deliberate root-level routes too — currently informative: `@awthaq/password` owns `POST /verify-email`, `/resend-verification` and `/change-password` at the root, alongside its `/password/*` routes.

_Previous: [BEH-EA-024](03-ports-slots-hooks-registries.md#beh-ea-024-tapping-a-hook-point-nobody-defines-is-a-compile-error-and-registries-aggregate-through-layereffectdiscard-ordered-and-frozen-at-first-read)_
_Next: [BEH-EA-033](05-persistence-stratum.md#beh-ea-033-every-entity-is-a-modelclass-with-modeluuidv7insert-ids)_
