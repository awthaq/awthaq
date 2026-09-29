# The Effect Client
> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-BEH-22 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-12 |
> | Status | Effective |
> | Author | awthaq Engineering |
> | Classification | Functional Specification |
> | Change History | 1.0 (2026-09-12): Initial release (CCR-EA-001) |
---

> Implemented in `@awthaq/client` — the code and tests behind each BEH id are mapped in [`spec/traceability.md`](../traceability.md). Some of its BDD scenarios are still `@skip @unwired`.

## BEH-EA-169: The client derives from the merged contract

> **See:** [ADR-EA-003](../decisions/003-httpapi-as-contract.md)

```ts
const client = yield* HttpApiClient.make(AuthApi, { baseUrl })
```

```text
REQUIREMENT: `@awthaq/client` MUST derive every endpoint method from
             `HttpApiClient.make` (or `AtomHttpApi.Service` for the reactive
             binding) against the application's merged `AuthApi`; it MUST NOT
             hand-write a method for any endpoint the contract already
             declares.
```

research/11-client-frontend.md's Q39 finding is the basis for this: `HttpApiClient.make` already gives "endpoint methods named per group/endpoint; payload/query/param encoding from `Schema`; success decoding; declared-error decoding into the typed union... `group`/`endpoint`-scoped sub-clients; `urlBuilder`" for free. Hand-writing any of that would create a second source of truth the contract and the client could drift apart from — exactly the drift ADR-EA-003 exists to prevent by making `HttpApi` the one contract every side derives from.

_Previous: [BEH-EA-168](21-qadi-resolvers-obligations.md#beh-ea-168-the-guarded-devtools-decision-stream) | Next: [BEH-EA-170](22-client-effect.md#beh-ea-170-csrfprotection-is-required-by-the-client-type)_

## BEH-EA-170: `CsrfProtection` is required by the client type

```ts
export const CsrfClient = HttpApiMiddleware.layerClient(CsrfProtection, ({ next, request }) =>
  next(HttpClientRequest.setHeader(request, "x-csrf-token", readCookie("__Host-csrf") ?? "")))
// remove CsrfClient → compile error: ForClient<CsrfProtection> is required
```

```text
REQUIREMENT: A cookie-mode client program MUST NOT type-check without
             providing a `CsrfProtection` client middleware Layer; the
             requirement MUST be enforced by the client's own Effect
             requirement type, not merely documented.
```

PRD §10 states this directly: "`CsrfProtection` declares `requiredForClient: true`, so a generated client does not type-check without the client half." `usage-examples-v4.md` §11.1 shows the consequence in practice: deleting the `CsrfClient` line from a program's provided Layers is a compile error, not a runtime 403 discovered later — the security requirement and the type system's requirement are the same requirement.

**Implementation (CDS-007).** The shipped `CsrfClientLive` (= `csrfClientLayer()`) is self-bootstrapping: it omits `x-csrf-token` when no cookie is readable (never the `?? ""` sketch above — an empty header is indistinguishable from a forged one), and on a `CsrfRejected` response, when a cookie the rejected request did not carry has since appeared (the server mints `__Host-csrf` on any response through a guarded group, including the 403), it re-issues the request exactly once with it. `csrfClientLayer({ readCookie, bootstrapRetry })` exposes the cookie reader (a server-side caller reads its request's `Cookie` header) and the retry opt-out.

_Previous: [BEH-EA-169](22-client-effect.md#beh-ea-169-the-client-derives-from-the-merged-contract) | Next: [BEH-EA-171](22-client-effect.md#beh-ea-171-bearer-mode-is-a-separate-contract-variant)_

## BEH-EA-171: Bearer mode is a separate contract variant

```ts
const NativeApi = Auth.api(plugins.map((p) => p.contract), { csrf: false })   // groups without CsrfProtection
const client = yield* HttpApiClient.make(NativeApi, {
  baseUrl, transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token))
})
```

```text
REQUIREMENT: A bearer-mode client MUST NOT need a cookie jar or a CSRF
             double-submit pair: a request carrying a non-empty `Authorization`
             header is exempt from CSRF minting and enforcement alike, because a
             bearer credential is never ambient browser trust.
```

**Superseded in part (PV-262, decision 24 / MNA-008).** The `{ csrf: false }` contract variant this behavior originally specified is not built and is retired: `Auth.make` has no CSRF opt-out. The requirement above is what shipped instead: the exemption is server-side (`CsrfProtectionLive` skips a request carrying `Authorization`, BEH-EA-079 as shipped, REQ-EA-689), and a bearer client is built against the ordinary cookie-mode contract with `transformClient` attaching the token (`packages/client/test/AuthClient.test.ts`). Because that contract still declares `CsrfProtection`, the client type still asks for a `CsrfProtection` client layer (BEH-EA-170); a bearer client supplies the ordinary one, which has nothing to do for it. REQ-EA-482..484 described the retired variant and were removed from the suite (their ids are not reused); the bearer transport is exercised by the "bearer token attached by transformClient" scenario of `22-client-effect.feature` and the exemption itself by REQ-EA-689.

`usage-examples-v4.md` §11.3 shows this is a genuinely different contract, not a configuration flag on the same one: bearer credentials carry no ambient browser trust for CSRF to defend against, so the type-level requirement that makes sense for cookie mode (BEH-EA-170) would be meaningless noise on a bearer client — `{ csrf: false }` removes the requirement from the contract itself rather than asking every native client to provide a middleware that does nothing.

_Previous: [BEH-EA-170](22-client-effect.md#beh-ea-170-csrfprotection-is-required-by-the-client-type) | Next: [BEH-EA-172](22-client-effect.md#beh-ea-172-error-codes-are-derived-from-the-contract)_

## BEH-EA-172: Error codes are derived from the contract

```ts
type AuthErrorCode = AuthClient.ErrorCodes<typeof AuthApi>   // "InvalidCredentials" | "RateLimited" | …
```

```text
REQUIREMENT: The set of error tags an i18n catalog must cover MUST be a type
             derived mechanically from the compiled `AuthApi`; adding a new
             typed error to any plugin's contract MUST be reflected in that
             type without a corresponding hand-maintained list to update.
```

`usage-examples-v4.md` §11.2 shows this consumed directly: a `messages` catalog `satisfies Record<AuthErrorCode, ...>` gets a compile error the moment a contract adds an error tag the catalog has not yet translated. (PV-262: it must be the total `Record`; `satisfies Partial<Record<...>>` accepts a missing key, so an untranslated tag would not fail to type-check.) This is the same idea as PRD §16's "error codes derive from the contract for i18n catalogs" — the catalog cannot silently fall behind the contract, because the type checker is the thing keeping them in sync, not a changelog entry a translator might miss.

_Previous: [BEH-EA-171](22-client-effect.md#beh-ea-171-bearer-mode-is-a-separate-contract-variant) | Next: [BEH-EA-173](22-client-effect.md#beh-ea-173-urlbuilder-for-typed-redirect-links)_

## BEH-EA-173: `urlBuilder` for typed redirect links

```ts
const url = yield* HttpApiClient.urlBuilder(AuthApi).oauth.authorize({ params: { provider: "google" }, query: { redirect: "/dashboard" } })
```

```text
REQUIREMENT: A link to an endpoint that is not itself invoked as a request
             (an OAuth authorize redirect, an unsubscribe link) MUST be built
             with `HttpApiClient.urlBuilder` against the same contract; it MUST
             NOT be assembled by string-concatenating a path and query
             parameters by hand.
```

`usage-examples-v4.md` §7.1 shows the direct use case: generating the `/auth/oauth/google/authorize` link a "Sign in with Google" button points at. (PV-262 as shipped: the authorize endpoint's query parameter is `callbackURL`, not `redirect`; an unknown query key is dropped by the encoder.) `urlBuilder` shares the same schema-encoding logic as the request-issuing client, so a parameter that would fail to encode correctly in a real request also fails the same way here, at the same compile-time and runtime checks, rather than silently producing a malformed URL a real request call would have caught.

_Previous: [BEH-EA-172](22-client-effect.md#beh-ea-172-error-codes-are-derived-from-the-contract) | Next: [BEH-EA-174](22-client-effect.md#beh-ea-174-session-helpers-are-the-hand-written-remainder)_

## BEH-EA-174: Session helpers are the hand-written remainder

```ts
authClient.session.get()                     // Session | null
authClient.session.hydrate(initialSession)   // SSR seeding, first non-null wins (a `Session`, never `null`: PV-262)
```

```text
REQUIREMENT: `@awthaq/client` MUST hand-write only what `HttpApiClient`
             cannot derive — a session store, CSRF header injection, and the
             credentials/bearer policy; it MUST NOT hand-write endpoint
             plumbing that duplicates what the generated client already
             provides.
```

research/11-client-frontend.md's Q39 names this gap precisely: "nothing in Effect tracks 'the current browser session'... that is the entire hand-written surface." Confining hand-written code to exactly this remainder is what keeps the client small and keeps its correctness tied to the contract rather than to a parallel implementation someone has to remember to update in step with it.

_Previous: [BEH-EA-173](22-client-effect.md#beh-ea-173-urlbuilder-for-typed-redirect-links) | Next: [BEH-EA-175](22-client-effect.md#beh-ea-175-transformclient-is-the-one-seam-for-custom-auth-policy)_

## BEH-EA-175: `transformClient` is the one seam for custom auth policy

```ts
transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(yield* Keychain.get("session")))
```

```text
REQUIREMENT: A client-side policy that needs to modify every outgoing request
             (attaching a token from a keychain, adding a tenant header) MUST
             be expressed through `transformClient`/`transformResponse`; it
             MUST NOT be implemented by wrapping or re-exporting individual
             generated methods.
```

`usage-examples-v4.md` §11.3 shows a native client reading a token from `Keychain` and attaching it via exactly this hook. Because `transformClient` composes with the CSRF middleware seam (BEH-EA-170) rather than replacing it, an application can add its own cross-cutting client behavior without touching, wrapping, or shadowing any of the generated per-endpoint methods.

**Bearer clients get the same seam, shipped (MNA-005).** Because `Sessions.verify` rotates the session secret on its throttled touch and the replaced secret survives only `SessionConfig.rotationGrace` ([BEH-EA-052](07-sessions.md#beh-ea-052-idle-window-refresh-is-throttled-to-at-most-one-write-per-touchevery)), a bearer client that never reads the `set-auth-token` response header (`Api.ROTATED_TOKEN_HEADER`) is silently logged out within the touch interval. `@awthaq/client` therefore ships the contract rather than leaving it to every application: a `BearerTokenStore` service (`get`/`set`/`clear`; `BearerTokenStoreMemory` is process-local, durable Keychain/Keystore storage is the application's own implementation of the service) and `bearerTransformClient(store)`, passed as `transformClient`, which attaches `Authorization: Bearer <token>` from the store and persists a rotated token from every response that carries the header. An idle-expired or revoked token surfaces as the typed `Unauthenticated`; the client contract is to re-authenticate and `set` a fresh token. Deployments MUST preserve the `set-auth-token` header through proxies and, cross-origin, expose it via CORS; the token is a long-lived secret and MUST NOT be logged (request loggers must redact `set-auth-token` and `authorization`).

_Previous: [BEH-EA-174](22-client-effect.md#beh-ea-174-session-helpers-are-the-hand-written-remainder) | Next: [BEH-EA-176](22-client-effect.md#beh-ea-176-a-promise-facade-is-opt-in-never-a-second-client)_

## BEH-EA-176: A Promise facade is opt-in, never a second client

```ts
const qadi = makeQadi(QadiLive)   // the same Layer as the server
if (await qadi.check(subject, canReadProject, { resource })) { /* … */ }
```

```text
REQUIREMENT: A Promise-returning convenience wrapper offered for non-Effect
             code MUST call the same underlying client and the same evaluator
             as the Effect-native client; it MUST NOT be a separately
             implemented client with its own request or decision logic.
```

(PV-262 as shipped: awthaq's facade is `AuthClient.toPromiseFacade`, not qadi's `makeQadi`.) `usage-qadi.md` §14 shows the qadi analog directly — `makeQadi` wraps "the same Layer as the server" rather than reimplementing evaluation for Promise callers. Applied to `@awthaq/client`, an optional Promise wrapper (research/11-client-frontend.md's Q39 "promise wrappers, if the user opts in") must be a thin `Effect.runPromise` shim over the one generated client, so a non-Effect caller and an Effect caller are guaranteed to see identical behavior — the same "one evaluation path" discipline `usage-qadi.md` §16 states for authorization applies here to the client transport itself.

**Implementation (EHA-005).** `toPromiseFacade(client)` rejects with the endpoint's tagged contract error (typed nowhere — a rejection is untyped in TypeScript); `toPromiseFacade(client, { mode: "result" })` is the error-honest variant: every method resolves a `Result<A, E>` with `E` the endpoint's contract error union (`Effect.result` over the same generated method, still just `Effect.runPromise`), so a non-Effect caller narrows `result.failure._tag` exhaustively. Defects (transport/decoding) reject in both modes.

_Previous: [BEH-EA-175](22-client-effect.md#beh-ea-175-transformclient-is-the-one-seam-for-custom-auth-policy) | Next: [BEH-EA-177](23-react.md#beh-ea-177-registryprovider-seeds-the-session-atom-for-ssr)_
