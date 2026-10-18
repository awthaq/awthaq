# Plan 21: The session lifecycle is declared on the `HttpApi` contract

| Property | Value |
|---|---|
| Strength | Worth exploring (README index). This plan finds it stronger: it fixes a live bearer-client bug that ends in a family revocation, and it turns a regex guard into a compile-time one |
| Dependency category | in-process (one contract module in `@awthaq/api`, read by four adapters: the server delivery middleware, the bearer client, the React client, the OpenAPI document) |
| Wave / order | After plans 01–10 (done). Before **20** (in-process user agent), whose bearer capture becomes "follow the headers" once this lands (§8). Coordinate with **11** (rotation delivery) and **15** (host composition derives the middleware) |
| Fixes live bugs | **A bearer client that changes its password is logged out everywhere.** `changePassword` returns the new token only in the body and sends no `set-auth-token`, so `bearerTransformClient` keeps the superseded token; presenting it again is refresh-token reuse, and `Sessions.verify` revokes the whole family, the new session included (reproduced, §2.6). Also: a bearer sign-out/revoke-all/delete-user leaves the dead token in `BearerTokenStore`; React session-changing mutations refetch nothing unless every call site remembers `reactivityKeys: [SESSION_KEY]`; the MNA-001 seam test does not see the four handlers that write the session cookie themselves |
| Execution tickets | `.scratch/session-minting-annotation/issues/NN-*.md`, one per phase below (`docs/agents/issue-tracker.md`) |
| New ADR | ADR-EA-045 (reserved for this plan in the brief) |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Re-check the line numbers before editing: plans 11–19 may land first and move code.

---

## 1. Summary, goals, non-goals

### Summary

"This endpoint mints (or rotates, ends, swaps) the caller's session" is a fact about the **contract**, but today only handler bodies know it:

- The server knows it at nine `SessionDelivery` call sites (`server/src/SessionDelivery.ts:39-91`): seven `respond`, one `mode` (the concealed sign-up), one `deliver` (the device grant). Four more handlers mint or swap without `SessionDelivery` at all (OAuth callback, OAuth native exchange, SAML ACS, admin impersonation), and eight end a session through a cookie expiry. A regex test (`server/test/SessionDelivery.seam.test.ts:39-52`) pins only the counts of `mode(` and `deliver(` calls.
- The bearer client rediscovers it by duck typing: `captureSessionToken` reads `Reflect.get(session, "token")` (`client/src/AuthClient.ts:268-276`), and every caller has to remember to wrap each minting call in it.
- The React client rediscovers it at every call site: a mutation that changes the session has to pass `reactivityKeys: [SESSION_KEY]` (`react/src/ReactClient.ts:31-37`), or `sessionAtom` never refetches.
- The OpenAPI document does not know it at all: no operation documents `Cache-Control: no-store`, `set-auth-token` or the session effect.

The module is **shallow**: each of the four readers re-derives the same fact, and the server's guard is a text search that misses the bypasses.

This plan makes the session lifecycle part of the contract. An endpoint declares it with one of five `HttpApiMiddleware` markers in `@awthaq/api`: `SessionLifecycle.Mints`, `.Rotates`, `.Ends`, `.Swaps`, `.Refreshes`. A middleware, not a `Context` annotation, because a middleware is both **typed** (it is in the endpoint's type, and what it `provides` is removed from the handler's requirements) and **reflectable** (`HttpApi.reflect` hands it to `middlewareFor`, the client and the OpenAPI generator). A `Context` annotation is only the second: `HttpApiEndpoint.annotations` is `Context.Context<never>` (`effect` rc.116 `HttpApiEndpoint.ts:189`), so no compile-time check can read it.

Four adapters then read the one declaration:

1. **Server.** The marker's server half resolves `X-Awthaq-Token-Delivery` before the handler runs, provides a **grant** (`MintGrant`, `EndGrant` or `SwapGrant`), sets `Cache-Control: no-store`, and dies if a successful response neither delivered nor explicitly declined. Every `SessionDelivery` function requires its grant, so a handler of an undeclared endpoint that calls `SessionDelivery.respond` does not type-check as a servable layer (verified, §2.7). The regex seam test is deleted.
2. **Bearer client.** The server now says what happened in headers on every declared response: `set-auth-token` on every bearer delivery (not only on throttled rotation), and the new `x-awthaq-session-ended` when the caller's own session ended. `bearerTransformClient` follows both; `captureSessionToken` is deleted.
3. **React client.** `makeReactClient` always installs the client half of the five markers, which invalidates `SESSION_KEY` after a successful declared mutation. Call sites stop passing the key.
4. **OpenAPI.** `Auth.make` annotates the composed api with one `OpenApi.Transform` that documents `no-store`, `set-auth-token`, `x-awthaq-session-ended` and an `x-awthaq-session` operation extension, for exactly the declared operations.

### Goals

1. One declaration per session-changing endpoint, on the contract, visible in its type.
2. A handler can call `SessionDelivery` only inside a declared endpoint (compile time), and a declared endpoint cannot answer successfully without settling the declaration (run time, fail closed).
3. The delivery header is validated by the middleware before the handler runs, so "an unknown value mints nothing" is structural, and `InvalidTokenDelivery` is declared once (on the marker) instead of on eight endpoints by hand.
4. Every session-minting, -swapping and -ending write goes through `SessionDelivery`; core no longer exports a function that writes the session cookie onto a response.
5. A bearer client stays signed in through every declared endpoint without wrapping calls by hand, and forgets a token whose session ended.
6. React refetches the session after any declared mutation, with no `reactivityKeys` at the call site.
7. The OpenAPI document states the lifecycle and its headers for exactly the declared operations.

### Non-goals

- Changing *how* a session is issued, verified or rotated (`Sessions`, plan 19's verdict, plan 11's credential resolution).
- Bearer impersonation. Swaps stay cookie-only (§3.5, Q2).
- The JWT session-mirror cookie on a sign-out response (`jwt/src/Jwt.ts:367-372` documents the bounded lag). It could read the declaration; that is a follow-up (Q6).
- Annotating the IdP-initiated SAML SLO (`saml/src/Saml.ts:490-559`): it revokes rows the IdP names, not the caller's presented credential.
- Retiring the body `token` field of `SessionDto` (Q1).

---

## 2. Verified current state

### 2.1 `SessionDelivery` today

`packages/server/src/SessionDelivery.ts`:

- `mode(request)` (`:39-45`) reads `X-Awthaq-Token-Delivery`: absent → `"cookie"`, `bearer` → `"bearer"`, anything else → `Api.InvalidTokenDelivery`.
- `deliver(mode, issued)` (`:52-68`): `cookie` calls core's `SessionCookie.set` (`:61`); `bearer` appends `cache-control: no-store` (`:64-66`) and returns the DTO with `token`. It never sets `set-auth-token`.
- `respond(request, mint)` (`:76-91`) is `mode` → `mint` → `deliver`.

The header comment (`:3-8`) says "every issuing handler (password sign-up/sign-in/change-password, passkey authenticate, the OAuth native exchange) routes through `mode` + `deliver`, so a plugin never calls `SessionCookie.set` (or writes a body token) on its own". The OAuth native exchange does not (§2.3), and neither do three other handlers.

### 2.2 Every `SessionDelivery` call site (9; the candidate's "~9" is right)

| # | Endpoint | Contract | Handler | Call |
|---|---|---|---|---|
| 1 | `password.signUp` | `password/src/PasswordApi.ts:225` | `password/src/Password.ts:661-690` | `mode` at `:680` (concealed, ADR-EA-026), `respond` at `:685` |
| 2 | `password.signIn` | `PasswordApi.ts:255` | `Password.ts:692-713` | `respond` at `:700` |
| 3 | `password.account.changePassword` | `PasswordApi.ts:359` | `Password.ts:798-830` | `respond` at `:817` |
| 4 | `passkey.authenticateVerify` | `passkey/src/PasskeyApi.ts:433` | `passkey/src/Passkey.ts:688-710` | `respond` at `:698` |
| 5 | `magicLink.verify` | `magic-link/src/MagicLinkApi.ts:50` | `magic-link/src/MagicLink.ts:194-209` | `respond` at `:202` |
| 6 | `emailOtp.verify` | `magic-link/src/EmailOtpApi.ts:43` | `magic-link/src/EmailOtp.ts:197-212` | `respond` at `:205` |
| 7 | `two_factor.verify`, `two_factor.verifyRecovery` | `two-factor/src/TwoFactorApi.ts:117`, `:131` | `two-factor/src/TwoFactor.ts:313-333` (`complete`, shared by `:337` and `:355`) | `respond` at `:322` |
| 8 | `deviceAuthorization.token` | `device-authorization/src/DeviceAuthorizationApi.ts:211` | `device-authorization/src/DeviceAuthorization.ts:548-580` | `deliver("bearer", …)` at `:571` |

So: password ×4 (three `respond`, one `mode`), magic-link ×2, passkey ×1, two-factor ×1 (one `respond` serving two endpoints), device-authorization ×1. Eight endpoints hand-declare `Api.InvalidTokenDelivery` in their error list: `PasswordApi.ts:250`, `:272`, `:367`, `PasskeyApi.ts:451`, `MagicLinkApi.ts:64`, `EmailOtpApi.ts:52`, `TwoFactorApi.ts:126`, `:139`.

### 2.3 Handlers that mint, swap or end a session without `SessionDelivery`

| # | Endpoint | Contract | Handler | What it writes |
|---|---|---|---|---|
| 9 | `oauth.callback` (browser) | `oauth/src/OAuthApi.ts:187` | `oauth/src/OAuth.ts:526-584` | `SessionCookie.render` + `HttpServerResponse.setCookie` on the redirect/interstitial (`:569-582`); no session on the link flow (`outcome.session === undefined`) |
| 10 | `oauth.exchange.token` (native) | `OAuthApi.ts:234` | `OAuth.ts:596-622` | its own `cache-control: no-store` (`:611-614`); the body token comes from `oauth.exchange` |
| 11 | `saml.acs` | `saml/src/SamlApi.ts:118` | `saml/src/Saml.ts:462-489` | `SessionCookie.render` + `setCookie` on the redirect (`:482-488`) |
| 12 | `admin.impersonate` | `admin/src/AdminApi.ts:258` | `admin/src/Admin.ts:451-468` | `SessionCookie.set(…, "impersonation")` (`:466`); ignores `X-Awthaq-Token-Delivery` |
| 13 | `admin.stopImpersonating` | `AdminApi.ts:271` | `Admin.ts:469-473` | `SessionCookie.expireImpersonation` (`:443`, `:472`) |
| 14 | `admin.forceStop` | `AdminApi.ts:277` | `Admin.ts:474-479` | expiry only when the episode is the caller's own (`:478`) |
| 15 | `session.signOut` | `api/src/Session.ts:76` | `server/src/Session.ts:93-99` | `expireSessionCookie` (`:98`) |
| 16 | `session.revoke` | `api/src/Session.ts:78` | `server/src/Session.ts:104-122` | expiry only when the target is the caller's own session (`:121`) |
| 17 | `session.revokeAll` | `api/src/Session.ts:89` | `server/src/Session.ts:132-136` | expiry (`:135`) |
| 18 | `account.deleteUser` | `api/src/Account.ts:149` | `server/src/Account.ts:129-148` | expiry (`:147`) |
| 19 | `saml.logout` (SP-initiated) | `SamlApi.ts:163` | `Saml.ts:572-604` | `SessionCookie.expire` (`:593`) |
| — | `session.current` | `api/src/Session.ts:74` | `server/src/Session.ts:64-79` | EHA-009 hygiene: expiry when the session vanished between verify and read (`:75`). Not a lifecycle event: the credential was already dead |

`server/src/internal/SessionCookie.ts:16` is `export const expireSessionCookie = SessionCookie.expire`. Core's writers are `SessionCookie.set` (`core/src/SessionCookie.ts:185-198`), `expire` (`:207-217`) and `expireImpersonation` (`:220`); `render`/`renderAt` (`:148-177`) are pure.

**Spec drift.** `spec/behaviors/09-authentication-middleware.md:65` says `SessionDelivery` is "the one implementation every issuing handler routes through … a plugin never sets the session cookie itself", and `docs/plugin-authoring.md:191` says "Never call `SessionCookie.set` … `server/test/SessionDelivery.seam.test.ts` fails on any other direct call". Rows 9, 11 and 12 contradict the first; the seam test cannot see them (it counts `SessionDelivery.mode(` and `SessionDelivery.deliver(` only), so the second is not true either.

### 2.4 Session effects with no `SessionDelivery` involvement (React-only)

Endpoints whose success changes what `GET /session` or `GET /subject` returns for the caller, without a credential change: `password.account.reauthenticate` (`PasswordApi.ts:393`; `Password.ts:853-869`, `amr`/`authenticatedAt`), `passkey.reauthenticateVerify` (`PasskeyApi.ts:513`; `Passkey.ts:786-797`), `organization.setActive` (`organization/src/OrganizationApi.ts:346`; `OrganizationHandlers.ts:152`), `organization.setActiveTeam` (`:358`; `:166`), `organization.leave` (`:455`; `:274`, clears the active context, `OrganizationMembers.ts:332`), `organization.acceptInvitation` (`:517`; `:328`, new membership and roles). BEH-EA-178 names "role assignment, accepting an invite" among the session-changing mutations (`spec/behaviors/23-react.md:44-50`).

### 2.5 The client readers

- `captureSessionToken` (`client/src/AuthClient.ts:268-276`): `Reflect.get(session, "token")`, stored when a non-empty string. Used only by `client/README.md:110` and its three tests (`client/test/AuthClient.test.ts:314`, `:329`, `:339`); no source caller.
- `bearerTransformClient` (`AuthClient.ts:233-258`): sends `X-Awthaq-Token-Delivery: bearer` on every request, `Authorization: Bearer` when the store holds a token, and stores a non-empty `set-auth-token` from any response (`:252-257`). Nothing clears the store.
- `packages/cli/src/Session.ts:59-71`, `:162-186`: the CLI clears its credential by hand after `signOut`; it never calls a minting endpoint through the client.
- React: `SESSION_KEY` is defined at `react/src/ReactClient.ts:37`. In library source it is used only by the two queries that *listen* for it (`react/src/AuthClientAtom.ts:67-69` `sessionAtom`, `:120-122` `subjectDtoAtom`). **No library mutation passes it**: the tag is the application's job at every call site. Call sites that pass it today: `features/step-definitions/ReactSteps.ts:84`, `:205-221` (two mutations), `:260`, `:349`; `react/test/Providers.test.tsx:108`; `react/README.md:102`; `spec/behaviors/23-react.md:42`, `:102` (examples). `react/test/ReactClient.test.ts:45`, `:86` pass `[]`.
- `makeReactClient` (`ReactClient.ts:53-77`) passes its `httpClient` straight to `AtomHttpApi.Service`, which casts the layer's requirements away (`effect` rc.116 `unstable/reactivity/AtomHttpApi.ts:202-212`) and wraps a mutation in `Reactivity.mutation(effect, keys)` only when keys are given (`:236-238`).

### 2.6 Live bug: bearer `changePassword` ends in a family revocation (reproduced)

Throwaway test in the scratchpad (`probe21b/bearer-change-password.test.ts`, run with `npx vitest run --root <scratchpad>/probe21b`, importing `packages/{core,password,test}/src` by absolute path):

1. `Password.signUp` + `Users.verifyEmail` through `app.run`.
2. `POST /password/sign-in` with `X-Awthaq-Token-Delivery: bearer` → body `token` = `old`.
3. `POST /change-password` with `Authorization: Bearer old` and the bearer header → `200`, body `token` = `new`, **no `set-auth-token` header**.
4. `GET /session` with `new` → `200` (control).
5. `GET /session` with `old` → `401`. `old` names the row `changePassword` superseded (`Password.ts:1716-1721`, `supersedes`), so this is refresh-token reuse (RRS-003, `core/src/Sessions.ts:399-405`): every live session of the family is revoked and `auth.session.reuse` is published.
6. `GET /session` with `new` → **`401`**.

A client built as the README says (`make(api, { transformClient: bearerTransformClient(store) })`) does exactly steps 3 and 5 unless the caller remembers `captureSessionToken` for this endpoint too: the transport's tap sees no `set-auth-token` and keeps `old`. The user is logged out on every device and a security event fires.

Other gaps (not reproduced here, read from the code):

- A bearer `signOut`, `revokeAll`, or `deleteUser` leaves the dead token in the store; the next request is a `401` the client must interpret.
- A bearer request whose `verify` rotated (throttled touch) and which then ends the session (sign-out) carries a `set-auth-token` for the session it just revoked: the rotation pre-response handler (`server/src/Authentication.ts:410-421`, registered at `:529`) still writes the header, and `bearerTransformClient` stores the dead secret.
- A React app that forgets the key on any session-changing mutation shows a stale session and stale `Can` gates (BEH-EA-179/180).

### 2.7 Facts the design rests on (verified against `node_modules/effect` 4.0.0-rc.116)

- **Endpoint annotations are type-erased.** `HttpApiEndpoint.annotations: Context.Context<never>` (`unstable/httpapi/HttpApiEndpoint.ts:189`); `annotate(key, value)` (`:232`) and `annotateMerge` (`:252`) return the same endpoint type. There is no `annotateContext` in rc.116 (the candidate named one). Group-level: `annotateEndpoints` (`HttpApiGroup.ts:125`). qadi's `RequiredPermission` uses this mechanism and says so: it is "a key used purely as a typed annotation carrier, never injected as a dependency" (`../qadi/packages/http/src/RequirePermission.ts:1-10`).
- **Middleware is typed and reflectable.** `HttpApiEndpoint.middleware(m)` adds `m` to the endpoint type (`HttpApiEndpoint.ts:213-227`). A handler's requirements exclude `HttpApiMiddleware.Provides<Middleware<Endpoint>>` (`HttpApiEndpoint.ts:730-734`), and whatever is left becomes `HttpRouter.Request.From<"Requires", R>` in the group layer (`HttpApiBuilder.ts:214-225`). `HttpApi.reflect` hands each endpoint's `middleware` set to its callback (`HttpApi.ts:259-289`); `AuthHttp.middlewareFor` already derives host middleware this way (`server/src/AuthHttp.ts:167-173`).
- **Type probe (scratchpad `probe21/probe.ts`, `tsc` against rc.116 sources).** A group with `signIn` declaring a middleware that `provides: MintGrant` and `other` declaring nothing; both handlers call a `respond` that `yield*`s `MintGrant`. The `signIn`-only layer has no `HttpRouter.Request<"Requires", …>` left; the layer whose `other` handler also calls `respond` has `HttpRouter.Request<"Requires", MintGrant>` in its requirements, and `HttpRouter.toWebHandler(...).handler(request)` then fails with TS2554 ("Expected 2 arguments"), because the handler needs a context for the leftover. An inverted assertion errors, so the probe's assertions are real.
- **Server middleware sees the endpoint and the handler's effect.** `HttpApiMiddleware<Provides, E, Requires>` is `(httpEffect, { endpoint, group }) => Effect<HttpServerResponse, …>` (`HttpApiMiddleware.ts:64-70`). A typed handler error fails `httpEffect` (the route encodes it later), so code after `yield* httpEffect` runs only on a successful response.
- **Client middleware sees the endpoint and the response, and is optional.** `HttpApiMiddlewareClient` gets `{ endpoint, group, request, next }` (`HttpApiMiddleware.ts:113-123`). `HttpApiClient` looks a client half up by key and skips it when absent (`HttpApiClient.ts:311-316`), so a middleware without `requiredForClient` adds nothing to a client's requirements. `layerClient` captures its own requirements at layer build (`HttpApiMiddleware.ts:506-531`).
- **The atom runtime shares one `Reactivity` per registry.** `Atom.context` builds every runtime layer as `Layer.provideMerge(create, Reactivity.layer)` with the registry's memo map (`unstable/reactivity/Atom.ts:851-874`), and `withReactivity` builds `Reactivity.layer` into the same memo map (`:882-899`). A client-middleware layer built with `Layer.provide(…, Reactivity.layer)` inside that runtime resolves to the same instance by reference. Phase 0 pins this with a test before anything depends on it (§4, spike S2).
- **Pre-response handlers run in registration order; a later one wins.** `server/src/internal/SessionCookie.ts:11-12` relies on it (the expiry registered in the handler overrides the rotation registered at verify), and `Authentication.ts:431-434` skips the rotated cookie when the handler already wrote one.
- **OpenAPI.** `OpenApi.Transform` is a `(spec) => spec` annotation honoured at the api, group and endpoint level (`OpenApi.ts:155-158`, `:651-653`, `:734`); the default `operationId` is `group.endpoint` (`:386-390`). No package source sets `OpenApi.Transform` or `OpenApi.Override` today, and no endpoint documents a response header, so nothing ties `no-store` (or `set-auth-token`) to these operations in the document (verified: `grep -rn "OpenApi\." packages/*/src` finds only `cli/src/Openapi.ts:25`).

---

## 3. Target design

### 3.1 The contract module (`packages/api/src/SessionLifecycle.ts`, new)

```ts
// @awthaq/api — SessionLifecycle (ADR-EA-045)
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { InvalidTokenDelivery } from "./Api.ts";

/** What a successful response of the endpoint does to the caller's own session. */
export type Kind = "mints" | "rotates" | "ends" | "swaps" | "refreshes";

/** How the request asked for a fresh credential (`X-Awthaq-Token-Delivery`), resolved before the handler runs. */
export type Delivery = "cookie" | "bearer";

/**
 * The capability a declared endpoint's handler receives. `settle` is called by `@awthaq/server`'s
 * `SessionDelivery` only: "delivered" when it wrote the credential change, "declined" when this
 * response deliberately changes nothing (a concealed sign-up, an OAuth account link, revoking
 * another device).
 */
export interface GrantShape {
  readonly kind: Kind;
  readonly delivery: Delivery;
  readonly settle: (outcome: "delivered" | "declined") => Effect.Effect<void>;
}

export class MintGrant extends Context.Service<MintGrant, GrantShape>()(
  "awthaq/api/SessionLifecycle/MintGrant",
) {}
export class EndGrant extends Context.Service<EndGrant, GrantShape>()(
  "awthaq/api/SessionLifecycle/EndGrant",
) {}
export class SwapGrant extends Context.Service<SwapGrant, GrantShape>()(
  "awthaq/api/SessionLifecycle/SwapGrant",
) {}

/** Sign-up, sign-in, a second factor, a federated callback, a device or native exchange. */
export class Mints extends HttpApiMiddleware.Service<Mints, { provides: MintGrant }>()(
  "awthaq/SessionLifecycle/Mints",
  { error: InvalidTokenDelivery },
) {}
/** The caller's credential is replaced by a fresh one (`changePassword`, BEH-EA-053). */
export class Rotates extends HttpApiMiddleware.Service<Rotates, { provides: MintGrant }>()(
  "awthaq/SessionLifecycle/Rotates",
  { error: InvalidTokenDelivery },
) {}
/** The caller's own session ends (sign-out, revoke-all, account deletion, SP-initiated SAML logout). */
export class Ends extends HttpApiMiddleware.Service<Ends, { provides: EndGrant }>()(
  "awthaq/SessionLifecycle/Ends",
) {}
/** The presented credential changes to another session and back (impersonation, APS-006). Cookie only. */
export class Swaps extends HttpApiMiddleware.Service<Swaps, { provides: SwapGrant }>()(
  "awthaq/SessionLifecycle/Swaps",
  { error: InvalidTokenDelivery },
) {}
/** The session's view or subject changes, the credential does not (re-authentication, active organization, a new membership). */
export class Refreshes extends HttpApiMiddleware.Service<Refreshes>()(
  "awthaq/SessionLifecycle/Refreshes",
) {}

const byKey = new Map<string, Kind>([
  [Mints.key, "mints"],
  [Rotates.key, "rotates"],
  [Ends.key, "ends"],
  [Swaps.key, "swaps"],
  [Refreshes.key, "refreshes"],
]);

/** The declared kind among an endpoint's middleware, if any. */
export const kindOf = (middleware: Iterable<{ readonly key: string }>) => {
  for (const service of middleware) {
    const kind = byKey.get(service.key);
    if (kind !== undefined) return kind;
  }
  return undefined;
};

/**
 * BEH-EA-<new>: every declared endpoint of `api`, keyed by its OpenAPI `operationId` (`group.endpoint`).
 * Throws, at composition time, on an endpoint declaring two kinds.
 */
export const inventory = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
) => {
  const declared = new Map<string, Kind>();
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint, middleware }) => {
      const kinds = [...middleware].flatMap((service) => {
        const kind = byKey.get(service.key);
        return kind === undefined ? [] : [kind];
      });
      const id = group.topLevel ? endpoint.identifier : `${group.identifier}.${endpoint.identifier}`;
      if (kinds.length > 1) {
        throw new Error(`awthaq: ${id} declares more than one session lifecycle (${kinds.join(", ")})`);
      }
      if (kinds[0] !== undefined) declared.set(id, kinds[0]);
    },
  });
  return declared;
};

/** The headers a declared response may carry (also in `Api.ts`). */
export const SESSION_ENDED_HEADER = "x-awthaq-session-ended";
```

- `Api.ts` re-exports `SESSION_ENDED_HEADER` beside `ROTATED_TOKEN_HEADER` (`api/src/Api.ts:169`). `api/src/index.ts` exports the module as `SessionLifecycle`.
- `Mints`, `Rotates` and `Swaps` declare `InvalidTokenDelivery`, so the eight hand-written declarations in §2.2 are deleted: an endpoint cannot be declared minting and forget the 400.
- None of the five sets `requiredForClient`: a client that does not care (a cookie browser client, the CLI) needs nothing new (§2.7). React and the in-process agent (plan 20) provide a client half.
- `Refreshes` provides nothing and has no server behaviour beyond passing through. It exists so the declaration is one mechanism for all five kinds, and React needs no second list.
- Authoring is one line on the contract: `HttpApiEndpoint.post("signIn", "/password/sign-in", { … }).middleware(SessionLifecycle.Mints)`.

**Why middleware markers and not a `Context` annotation.** A `Context` annotation is reflectable but invisible to the type checker (§2.7), so it could drive the client and the OpenAPI document but never stop an undeclared handler from minting. A marker is both. The cost is five server implementations, which `middlewareFor` derives like the other host middleware (§3.2).

### 3.2 Server half (`packages/server/src/SessionLifecycle.ts`, new)

```ts
// @awthaq/server — SessionLifecycle (ADR-EA-045): the server half of the five markers.
import { Api, SessionLifecycle } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Context from "effect/Context";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import { HandlerInvariantViolation } from "./internal/Defects.ts";

type DeliveryRule = "either" | "cookieOnly" | "none";

/** MNA-001: resolved before the handler runs, so an unknown value mints nothing (structurally). */
const deliveryOf = (request: HttpServerRequest.HttpServerRequest, rule: DeliveryRule) => {
  if (rule === "none") return Effect.succeed<SessionLifecycle.Delivery>("cookie");
  const header = Headers.get(request.headers, Api.TOKEN_DELIVERY_HEADER);
  if (Option.isNone(header)) return Effect.succeed<SessionLifecycle.Delivery>("cookie");
  const bearer = header.value.trim().toLowerCase() === "bearer";
  return bearer && rule === "either"
    ? Effect.succeed<SessionLifecycle.Delivery>("bearer")
    : Effect.fail(new Api.InvalidTokenDelivery());
};

/** MAPS-008: a declared response may carry a live secret or end one; never cacheable. */
const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
);

const declared = <I, A, E, R>(
  grant: Context.Key<I, SessionLifecycle.GrantShape>,
  kind: SessionLifecycle.Kind,
  rule: DeliveryRule,
  httpEffect: Effect.Effect<A, E, R>,
  endpoint: HttpApiEndpoint.Top,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const delivery = yield* deliveryOf(request, rule);
    const settled = yield* Ref.make<"open" | "delivered" | "declined">("open");
    yield* noStore;
    const response = yield* Effect.provideService(httpEffect, grant, {
      kind,
      delivery,
      settle: (outcome) => Ref.set(settled, outcome),
    });
    // A typed handler error fails `httpEffect` and never reaches this line: only a success must settle.
    if ((yield* Ref.get(settled)) === "open") {
      return yield* Effect.die(
        new HandlerInvariantViolation({
          invariant: "SessionLifecycleUnsettled",
          message: `awthaq: ${endpoint.identifier} is declared "${kind}" but answered without SessionDelivery`,
        }),
      );
    }
    return response;
  });

export const MintsLive = Layer.succeed(SessionLifecycle.Mints, (httpEffect, { endpoint }) =>
  declared(SessionLifecycle.MintGrant, "mints", "either", httpEffect, endpoint),
);
export const RotatesLive = Layer.succeed(SessionLifecycle.Rotates, (httpEffect, { endpoint }) =>
  declared(SessionLifecycle.MintGrant, "rotates", "either", httpEffect, endpoint),
);
export const EndsLive = Layer.succeed(SessionLifecycle.Ends, (httpEffect, { endpoint }) =>
  declared(SessionLifecycle.EndGrant, "ends", "none", httpEffect, endpoint),
);
export const SwapsLive = Layer.succeed(SessionLifecycle.Swaps, (httpEffect, { endpoint }) =>
  declared(SessionLifecycle.SwapGrant, "swaps", "cookieOnly", httpEffect, endpoint),
);
export const RefreshesLive = Layer.succeed(SessionLifecycle.Refreshes, (httpEffect) => httpEffect);

/** All five, for a composition that wires middleware by hand instead of `middlewareFor`. */
export const layer = Layer.mergeAll(MintsLive, RotatesLive, EndsLive, SwapsLive, RefreshesLive);
```

Notes for the executor:

- `Layer.succeed(tag, fn)` gives `fn` its parameter types from the tag's shape: no annotation on the consts. If inference of `declared`'s `E`/`R` against `HttpApiMiddleware`'s `unhandled` marker does not line up, type `declared`'s `httpEffect` parameter from `Parameters<HttpApiMiddleware.HttpApiMiddleware<SessionLifecycle.MintGrant, typeof Api.InvalidTokenDelivery, never>>[0]` for each kind; that is a parameter type, not an assertion.
- `server/src/AuthHttp.ts`: `HostMiddleware` (`:124-129`) gains the five markers; `middlewareFor`'s table (`:182-200`) gains five `entry(SessionLifecycle.X.key, XLive)` rows. Only declared ones are built, as today. `AuthHttp.sessionLifecycle` re-exports `SessionLifecycle.layer` for hand-wired BDD worlds.
- `AuthHttp.cors` (`:267`) exposes `SessionLifecycle.SESSION_ENDED_HEADER` beside `ROTATED_TOKEN_HEADER`.
- The "unsettled" check is a defect (`500`) in every environment (Q4). It catches a declared endpoint whose handler forgot `SessionDelivery`; every existing success-path test of every declared endpoint exercises it.

### 3.3 `SessionDelivery`, rewritten over the grants (`packages/server/src/SessionDelivery.ts`)

```ts
import { Api, SessionContract, SessionLifecycle } from "@awthaq/api";
import type { Sessions } from "@awthaq/core";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as SessionCookie from "./internal/SessionCookie.ts"; // set/expire moved here (§3.6)
import { toSessionDto } from "./Session.ts";

/** Plan 11's `Sessions.IssuedSession` once it lands; inline until then. */
interface Issued {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

/** A bearer delivery always names the token in `set-auth-token` too, so a client's store follows every mint without reading the body. */
const bearerHeaders = (token: Redacted.Redacted<string>) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, Api.ROTATED_TOKEN_HEADER, Redacted.value(token))),
  );

const deliverWith = Effect.fnUntraced(function* (grant: SessionLifecycle.GrantShape, issued: Issued) {
  const dto = toSessionDto(issued.session);
  if (grant.delivery === "cookie") {
    yield* SessionCookie.set(issued.session, issued.token);
    yield* grant.settle("delivered");
    return dto;
  }
  yield* bearerHeaders(issued.token);
  yield* grant.settle("delivered");
  return new SessionContract.SessionDto({ ...dto, token: Redacted.value(issued.token) });
});

/** `Mints`/`Rotates`: runs `mint` and delivers what it issued the way the request asked. */
export const respond = <E, R>(mint: Effect.Effect<Issued, E, R>) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.MintGrant;
    const issued = yield* mint;
    return yield* deliverWith(grant, issued);
  });

/** RFC 8628 / MNA-003: a device or a native exchange has no cookie jar, whatever the header said. */
export const deliverBearer = (issued: Issued) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.MintGrant;
    return yield* deliverWith({ ...grant, delivery: "bearer" }, issued);
  });

/** MNA-003: the native exchange hands back a DTO it decrypted, token included. */
export const deliverExchanged = (dto: SessionContract.SessionDto) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.MintGrant;
    if (dto.token !== undefined) yield* bearerHeaders(Redacted.make(dto.token));
    yield* grant.settle("delivered");
    return dto;
  });

/** A browser navigation (OAuth callback, SAML ACS): the session cookie rides the redirect or the interstitial. */
export const redirect = (response: HttpServerResponse.HttpServerResponse, issued: Issued) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.MintGrant;
    const cookie = yield* SessionCookie.render(issued.session, issued.token);
    const withCookie = yield* HttpServerResponse.setCookie(response, cookie.name, cookie.value, cookie.options).pipe(
      Effect.orDie,
    );
    yield* grant.settle("delivered");
    return withCookie;
  });

/**
 * `Ends`: the caller's own session ended. Expires the cookie (a browser), says so in
 * `x-awthaq-session-ended` (a bearer client clears its store), and drops a `set-auth-token` the
 * verify-time rotation registered for the session that just ended (registered later, so it wins).
 */
export const end = Effect.gen(function* () {
  const grant = yield* SessionLifecycle.EndGrant;
  yield* SessionCookie.expire;
  yield* HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeader(
        HttpServerResponse.removeHeader(response, Api.ROTATED_TOKEN_HEADER),
        SessionLifecycle.SESSION_ENDED_HEADER,
        "1",
      ),
    ),
  );
  yield* grant.settle("delivered");
});

/** `Swaps` (APS-006): the impersonation cookie shadows the admin's own; `swapOut` hands the browser back. */
export const swapIn = (issued: Issued) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.SwapGrant;
    yield* SessionCookie.set(issued.session, issued.token, "impersonation");
    yield* grant.settle("delivered");
  });
export const swapOut = Effect.gen(function* () {
  const grant = yield* SessionLifecycle.SwapGrant;
  yield* SessionCookie.expireImpersonation;
  yield* grant.settle("delivered");
});

/** This response deliberately changes nothing: a concealed sign-up, an OAuth link, another device's revoke. */
export const decline = <I>(grant: Context.Key<I, SessionLifecycle.GrantShape>) =>
  Effect.flatMap(grant, (granted) => granted.settle("declined"));
```

- `mode` and the old two-argument `respond(request, mint)` leave the module (removed in Phase 4). `deliver` becomes module-private `deliverWith`.
- Requirements are the type-level gate: `respond`, `deliverBearer`, `deliverExchanged` and `redirect` need `MintGrant`; `end` needs `EndGrant`; `swapIn`/`swapOut` need `SwapGrant`. An `Ends` handler calling `respond` leaves `MintGrant` unprovided, which is the same compile error as an undeclared one.
- `HttpServerResponse.removeHeader` exists in rc.116 (`unstable/http/HttpServerResponse.ts:574`), as does `setHeader` (`:547`).
- `deliverBearer` builds the grant view with `delivery: "bearer"` by spread; `settle` is carried over.

### 3.4 Each endpoint's declaration (Phase 3–4)

| Endpoint | Kind | Handler change |
|---|---|---|
| `password.signUp` | `Mints` | `respond(…)`; concealed branch: `decline(SessionLifecycle.MintGrant)` replaces `mode(request)` (`Password.ts:680`) |
| `password.signIn` | `Mints` | `respond(…)` |
| `password.account.changePassword` | `Rotates` | `respond(…)` |
| `password.account.reauthenticate` | `Refreshes` | none |
| `passkey.authenticateVerify` | `Mints` | `respond(…)` |
| `passkey.reauthenticateVerify` | `Refreshes` | none |
| `magicLink.verify`, `emailOtp.verify` | `Mints` | `respond(…)` |
| `two_factor.verify`, `two_factor.verifyRecovery` | `Mints` | `respond(…)` in the shared `complete` |
| `deviceAuthorization.token` | `Mints` | `deliverBearer(redeemed)` |
| `oauth.callback` | `Mints` | `redirect(response, outcome.session)`; the link flow (`outcome.session === undefined`) `decline(MintGrant)` |
| `oauth.exchange.token` | `Mints` | `deliverExchanged(session)`; delete its own `no-store` (`OAuth.ts:611-614`) |
| `saml.acs` | `Mints` | `redirect(HttpServerResponse.redirect(outcome.callbackURL), outcome.session)` |
| `saml.logout` | `Ends` | `end` replaces `SessionCookie.expire` (`Saml.ts:593`) |
| `session.signOut`, `session.revokeAll` | `Ends` | `end` |
| `session.revoke` | `Ends` | own session: `end`; another device: `decline(EndGrant)` |
| `account.deleteUser` | `Ends` | `end` |
| `admin.impersonate` | `Swaps` | `swapIn(issued)` |
| `admin.stopImpersonating` | `Swaps` | `swapOut` |
| `admin.forceStop` | `Swaps` | own episode: `swapOut`; another: `decline(SwapGrant)` |
| `organization.setActive`, `.setActiveTeam`, `.leave`, `.acceptInvitation` | `Refreshes` | none |

Unchanged and undeclared: `session.current` keeps its EHA-009 hygiene expiry through the server-internal `expireSessionCookie`; `session.revokeOthers` (never the caller's own); `saml.slo`/`sloPost`; `password.confirmReset`/`confirmEmailChange` (Q7). The eight hand-written `Api.InvalidTokenDelivery` error entries (§2.2) are deleted; `Mints`/`Rotates` declare it.

### 3.5 Swaps stay cookie-only

The `Swaps` marker resolves delivery with `cookieOnly`: a request asking `bearer` is answered `400 InvalidTokenDelivery` before the handler runs. Today `admin.impersonate` silently sets an impersonation cookie a bearer admin cannot use (`Admin.ts:466`). Delivering an impersonation token to a bearer client would also need a way to hand the admin's own token back on `stopImpersonating`; no caller needs that (Q2).

### 3.6 Core stops writing the session cookie onto responses

`core/src/SessionCookie.ts` keeps the configuration (`Mode`, `SessionCookieConfig`, `config`, `cookieName`, `isStrict`, `csrfCookieOptions`) and the pure renderers (`renderAt`, `render`), which `Authentication`'s rotation delivery (`server/src/Authentication.ts:426`) and `web/src/Session.ts:196` use. It loses `set` (`:185-198`), `expire` (`:207-217`) and `expireImpersonation` (`:220`): they move into `server/src/internal/SessionCookie.ts`, which `SessionDelivery` and `Session.ts`'s EHA-009 path import. No plugin can then write the session cookie except through `SessionDelivery` without hand-rolling `render` + `setCookie`, which `docs/plugin-authoring.md` forbids and review catches (Q5).

Test callers of the removed writers move to `TestAuth.signInAs(...).cookieHeader` (plan 20 later turns these into agents): `qadi/test/SubjectApi.test.ts:48`, `qadi/test/AuthorizedSubject.test.ts:52`, `qadi/test/ReauthHttp.test.ts:73`, `web/test/CookieJar.test.ts:231` (the last needs a `Set-Cookie` on a real response: route it through a one-endpoint `HttpApi` declaring `Mints`).

### 3.7 Bearer client (`packages/client/src/AuthClient.ts`)

```ts
export const bearerTransformClient =
  (store: BearerTokenStoreShape) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequestEffect(/* unchanged (:237-251) */),
      HttpClient.tap((response) => {
        // ADR-EA-045: the server says what a declared response did to the session. Ended wins.
        if (Option.isSome(Headers.get(response.headers, SessionLifecycle.SESSION_ENDED_HEADER))) {
          return store.clear;
        }
        const token = Headers.get(response.headers, Api.ROTATED_TOKEN_HEADER);
        return Option.isSome(token) && token.value.length > 0
          ? store.set(Redacted.make(token.value))
          : Effect.void;
      }),
    );
```

- `captureSessionToken` (`:260-276`) is deleted. Every bearer mint now carries `set-auth-token` (§3.3), so the transport's tap already stores it, for `changePassword` too (the §2.6 bug).
- The doc comments at `:217-232` and the module header (`:25-33`) are rewritten: "the store follows `set-auth-token` and `x-awthaq-session-ended`".
- The CLI keeps its explicit `store.clear` on logout (`cli/src/Session.ts:182`): it also covers a server it cannot reach.

### 3.8 React client (`packages/react/src/ReactClient.ts`)

```ts
import { SessionLifecycle } from "@awthaq/api";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";

/** After a successful response of a declared endpoint, the session (and the subject) refetch. */
const invalidating = <Id extends HttpApiMiddleware.AnyId, S>(marker: Context.Key<Id, S>) =>
  HttpApiMiddleware.layerClient(marker, ({ next, request }) =>
    next(request).pipe(
      Effect.tap((response) =>
        response.status < 300 ? Reactivity.invalidate([SESSION_KEY]) : Effect.void,
      ),
    ),
  );

/**
 * BEH-EA-178 (ADR-EA-045): built on `Reactivity.layer`, which the atom runtime has already built
 * into the registry's memo map (`Atom.context`), so this is the registry's own instance.
 */
export const sessionInvalidation = Layer.mergeAll(
  invalidating(SessionLifecycle.Mints),
  invalidating(SessionLifecycle.Rotates),
  invalidating(SessionLifecycle.Ends),
  invalidating(SessionLifecycle.Swaps),
  invalidating(SessionLifecycle.Refreshes),
).pipe(Layer.provide(Reactivity.layer));
```

`makeReactClient` passes `httpClient: Layer.merge(options.httpClient ?? defaultHttpClient, sessionInvalidation)`. A caller-supplied `httpClient` keeps the invalidation: it is not a default it can drop by accident. `SESSION_KEY` stays exported (queries listen on it, and an application mutation outside the composed contract can still pass it). Every declared endpoint is a `POST`/`DELETE` except `oauth.callback`, which a browser navigates to and never reaches through an atom, so invalidating on every successful response cannot loop a query.

**Fallback if spike S2 fails** (the client half does not see the registry's `Reactivity`): `makeReactClient` overrides the returned class's `mutation` for declared endpoints, building it with the class's own `runtime.fn` and `Reactivity.mutation(effect, [SESSION_KEY])`, the way `AtomHttpApi.ts:217-245` builds it. That duplicates about twenty lines of `AtomHttpApi`; it is the second choice for that reason.

### 3.9 OpenAPI (`packages/api/src/SessionLifecycle.ts` + `packages/core/src/Auth.ts`)

```ts
/** ADR-EA-045: documents what each declared operation does to the session and the headers it carries. */
export const openApi = (declared: ReadonlyMap<string, Kind>) => (spec: Record<string, any>) => {
  for (const methods of Object.values(spec["paths"] ?? {})) {
    if (typeof methods !== "object" || methods === null) continue;
    for (const operation of Object.values(methods)) {
      if (typeof operation !== "object" || operation === null) continue;
      const kind = declared.get(Reflect.get(operation, "operationId"));
      if (kind === undefined) continue;
      Reflect.set(operation, "x-awthaq-session", kind);
      if (kind === "refreshes") continue;
      for (const [status, response] of Object.entries(Reflect.get(operation, "responses") ?? {})) {
        if (typeof response !== "object" || response === null) continue;
        const headers = { ...(Reflect.get(response, "headers") ?? {}) };
        headers["Cache-Control"] = { schema: { type: "string", enum: ["no-store"] } };
        if (status.startsWith("2") && (kind === "mints" || kind === "rotates")) {
          headers[Api.ROTATED_TOKEN_HEADER] = {
            description: "The session token, when the request asked for bearer delivery",
            schema: { type: "string" },
          };
        }
        if (status.startsWith("2") && kind === "ends") {
          headers[SESSION_ENDED_HEADER] = { schema: { type: "string", enum: ["1"] } };
        }
        Reflect.set(response, "headers", headers);
      }
    }
  }
  return spec;
};
```

`Auth.make` composes the api (`core/src/Auth.ts:957`, `:977-978`), then validates and documents it: `api.annotate(OpenApi.Transform, SessionLifecycle.openApi(SessionLifecycle.inventory(api)))`. `inventory` throws on a double declaration, so a contract mistake fails at `Auth.make`, like a duplicate route. An application that sets its own api-level `OpenApi.Transform` composes it with this one (documented in ADR-EA-045). The `spec` parameter is `Record<string, any>` because that is `OpenApi.Transform`'s own type (`OpenApi.ts:155-158`); the walk narrows with guards and `Reflect`, no assertion.

If the OpenAPI generator does not list middleware-declared errors per operation, check that `400 InvalidTokenDelivery` is still documented for the minting operations after the eight hand declarations are removed (§7); if it is not, `openApi` adds it for `mints`/`rotates`/`swaps`.

---

## 4. Phased migration

Every phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Plan gate: `pnpm check` (no SQL adapter changes, so no `pnpm test:pg`). One ticket per phase under `.scratch/session-minting-annotation/issues/`.

**Preconditions.** Re-run the §2.2/§2.3 greps (`grep -rn "SessionDelivery\.\|SessionCookie\.\(set\|expire\|render\)" packages/*/src`) and classify any new site with §3.4's table. If plan 11 has landed, use its `IssuedSession` instead of the local `Issued` and put the rotation-header rule (§3.3 `end`) where plan 11 moved rotation delivery.

### Phase 0: pin the bugs (failing tests) and run the spikes

1. **Bearer `changePassword`.** `features/features/07-client-integration/22-client-effect.feature`, a new scenario under BEH-EA-175 ("A bearer client that changes its password stays signed in"), steps in `ClientEffectSteps.ts` over a `TestAuth.app` with `Password`: sign in through `AuthClient.make(api, { transformClient: bearerTransformClient(store) })`, call `password.account.changePassword` **without** `captureSessionToken`, then `session.current` twice. Fails today (the second `current` is `Unauthenticated`, §2.6).
2. **Bearer sign-out.** `client/test/AuthClient.test.ts`, `describe("bearerTransformClient (MNA-005)")`: "a response carrying x-awthaq-session-ended clears the store", and "ended wins over a set-auth-token on the same response". Stubbed transport, as the existing cases at `:212-312`. Fail today.
3. **React.** `react/test/ReactClient.test.ts`: "a declared mutation refetches sessionAtom with no reactivityKeys" (stub `POST /session/sign-out` and count `GET /session`, the `installFetchStub` pattern of `:37-48`). Fails today. It also uses a one-group api whose endpoint declares `SessionLifecycle.Mints`, which does not exist yet, so commit it with Phase 1 if the phase-0 commit must compile; the failing state is recorded in the ticket either way.
4. **Spike S1, the type gate.** Reproduce `probe21/probe.ts` as `server/test/SessionLifecycle.types.test.ts` in Phase 2 (it needs the module). Phase 0 records the probe and its result in the ticket.
5. **Spike S2, `Reactivity` sharing.** A throwaway test in the scratchpad: `makeReactClient` with `httpClient: Layer.merge(stub, layerClient(marker, invalidate).pipe(Layer.provide(Reactivity.layer)))`, mount a query with `reactivityKeys: ["session"]`, run a mutation without keys, assert the query refetched. If it fails, take §3.8's fallback.

### Phase 1: the contract module (additive)

1. `packages/api/src/SessionLifecycle.ts` (§3.1, §3.9's `openApi`), `api/src/index.ts` export, `SESSION_ENDED_HEADER` in `api/src/Api.ts`.
2. `packages/api/test/SessionLifecycle.test.ts` (§5.1).
3. `.changeset/session-lifecycle-contract.md` (`@awthaq/api` minor, §6.4).

### Phase 2: the server half, beside today's `SessionDelivery`

1. `packages/server/src/SessionLifecycle.ts` (§3.2); `server/src/index.ts` exports it.
2. `server/src/AuthHttp.ts`: `HostMiddleware`, `middlewareFor` table, `sessionLifecycle` re-export, CORS exposed header.
3. `server/src/SessionDelivery.ts`: add the grant-based functions of §3.3. Keep the old `respond(request, mint)` as an overload of `respond` (arity 2) and `mode`/`deliver` **for this phase only**, so every plugin still compiles; the seam test still passes.
4. `server/test/SessionLifecycle.test.ts` and `SessionLifecycle.types.test.ts` (§5.1).
5. `features/step-definitions/CompileTimeGates.ts`: the type gates of §5.2.

### Phase 3: core contracts and the server's own handlers

1. `api/src/Session.ts:76`, `:78`, `:89`: `.middleware(SessionLifecycle.Ends)` on `signOut`, `revoke`, `revokeAll`. `api/src/Account.ts:149`: `Ends` on `deleteUser`.
2. `server/src/Session.ts:93-136`, `server/src/Account.ts:129-148`: `SessionDelivery.end` / `decline(EndGrant)` per §3.4. `current` (`:75`) keeps `expireSessionCookie`.
3. Update `spec/decisions/003-httpapi-as-contract.md`'s `surface:api` block only if `check-drift` reads endpoint lines that now carry `.middleware(...)` (it diffs names; verify).
4. Tests: `server/test/AuthHttp.test.ts` sign-out/revoke cases assert `x-awthaq-session-ended` and `no-store`; the rest stay.

### Phase 4: plugin contracts and handlers; remove the old delivery

1. Contracts, per §3.4: `PasswordApi.ts:225`, `:255`, `:359`, `:393`; `PasskeyApi.ts:433`, `:513`; `MagicLinkApi.ts:50`; `EmailOtpApi.ts:43`; `TwoFactorApi.ts:117`, `:131`; `DeviceAuthorizationApi.ts:211`; `OAuthApi.ts:187`, `:234`; `SamlApi.ts:118`, `:163`; `AdminApi.ts:258`, `:271`, `:277`; `OrganizationApi.ts:346`, `:358`, `:455`, `:517`. Delete the eight `Api.InvalidTokenDelivery` entries (§2.2).
2. Handlers, per §3.4: `Password.ts:680`, `:685`, `:700`, `:817`; `Passkey.ts:698`; `MagicLink.ts:202`; `EmailOtp.ts:205`; `TwoFactor.ts:322`; `DeviceAuthorization.ts:571` (the `delivered.token === undefined` invariant at `:572-577` stays); `OAuth.ts:569-582`, `:611-621`; `Saml.ts:482-488`, `:593`; `Admin.ts:443`, `:466`, `:472`, `:478`.
3. `server/src/SessionDelivery.ts`: delete the old `respond` overload, `mode` and `deliver`. Rewrite the header comment (`:1-23`).
4. §3.6: move `set`/`expire`/`expireImpersonation` from `core/src/SessionCookie.ts` into `server/src/internal/SessionCookie.ts`; migrate the four test callers.
5. Delete `server/test/SessionDelivery.seam.test.ts`. Rewrite `server/test/SessionDelivery.test.ts` over a one-group `HttpApi` (§5.1).
6. Each plugin's `test/Contract.test.ts` pins its inventory (§5.1).
7. Spec, README and docs edits of §6.1–§6.3 for the server side. Changesets §6.4 (server, core, every touched plugin).

### Phase 5: the bearer client follows the headers

1. `client/src/AuthClient.ts` per §3.7; delete `captureSessionToken`.
2. `client/test/AuthClient.test.ts`: delete the three `captureSessionToken` tests (`:314`, `:329`, `:339`); the Phase 0 cases pass.
3. `client/README.md:83-120`, `password/README.md:11`, `oauth` README's native section: drop `captureSessionToken`.
4. Phase 0 BDD scenario passes. Changeset.

### Phase 6: React invalidates on its own

1. `react/src/ReactClient.ts` per §3.8 (or the fallback). Doc comment at `:31-36` rewritten.
2. Drop `reactivityKeys: [SESSION_KEY]` from the mutations in `ReactSteps.ts:84`, `:205-221`, `:260`, `:349`; `react/README.md:102`; spec examples. `Providers.test.tsx:108` keeps its explicit key (it tests an application mutation outside the contract).
3. Rewrite REQ-EA-504 and REQ-EA-698 (§5.3). Changeset.

### Phase 7: OpenAPI and the final sweep

1. `core/src/Auth.ts`: annotate the composed api (§3.9).
2. `api/test/Contracts.test.ts` (or `server/test/AuthHttp.test.ts`, which serves `/openapi.json`): the composed document carries `x-awthaq-session` and the headers for declared operations only.
3. Final greps (§9). `pnpm check`.

---

## 5. Test plan

Replace, don't layer: the delivery rules are tested once, at the server half and `SessionDelivery`; each plugin keeps its wire tests and adds one inventory line.

### 5.1 New and rewritten tests

`packages/api/test/SessionLifecycle.test.ts`:

1. `inventory` keys a top-level and a grouped endpoint by `operationId` and returns each declared kind.
2. `inventory` throws naming the endpoint when it declares two kinds.
3. `kindOf` ignores unrelated middleware (`Authentication`, `CsrfProtection`).
4. `openApi` adds `x-awthaq-session` to declared operations only; `no-store` on every response of `mints`/`rotates`/`ends`/`swaps`; `set-auth-token` on 2xx of `mints`/`rotates`; `x-awthaq-session-ended` on 2xx of `ends`; nothing but the extension for `refreshes`.

`packages/server/test/SessionLifecycle.test.ts` (one-group `HttpApi`, served through `toWebHandler` with `SessionLifecycle.layer`):

5. `Mints`: an unknown `X-Awthaq-Token-Delivery` answers `400 InvalidTokenDelivery` and the handler never runs (a `Ref` counter).
6. `Mints`: a handler that answers successfully without `SessionDelivery` dies `SessionLifecycleUnsettled` (500).
7. `Mints`: a handler that fails typed (`401`) without settling is not a defect.
8. `Mints`: `decline` settles; the response carries `no-store` and no cookie.
9. `respond` in cookie mode sets the session cookie, omits `token`, no `set-auth-token`; in bearer mode sets no cookie and carries `token` **and** `set-auth-token` (replaces `SessionDelivery.test.ts:76-110`'s three cases).
10. `respond` over an endpoint whose verify rotated (bearer): the response's `set-auth-token` is the minted token, not the rotated one (the later handler wins).
11. `end` expires the session cookie, sets `x-awthaq-session-ended: 1`, and removes a rotation's `set-auth-token`.
12. `Swaps`: `bearer` answers `400` before the handler; `swapIn` sets `__Host-impersonation`; `swapOut` expires it.
13. `deliverBearer` ignores a cookie-mode request and delivers bearer; `deliverExchanged` sets `set-auth-token` from the DTO.

`packages/server/test/SessionLifecycle.types.test.ts` (type-level; vitest `expectTypeOf` or the `MiddlewareFor.types.test.ts` style):

14. An undeclared endpoint whose handler calls `SessionDelivery.respond` leaves `HttpRouter.Request<"Requires", SessionLifecycle.MintGrant>` in the group layer's requirements (the §2.7 probe).
15. An `Ends` handler calling `respond` leaves `MintGrant`; a `Mints` handler calling `end` leaves `EndGrant`.
16. A `Mints` handler calling `respond` leaves nothing.

Plugin contract pins (one `it` each, in the existing `test/Contract.test.ts` of `password`, `passkey`, `magic-link`, `two-factor`, `device-authorization`, `oauth`, `saml`, `admin`, `organization`; and `api/test/Contracts.test.ts` for `AuthCoreApi`): `assert.deepStrictEqual(Object.fromEntries(SessionLifecycle.inventory(HttpApi.make("auth").add(...groups))), { … })` with the kinds of §3.4. This is the locality the regex test lacked: each plugin states its own lifecycle where its contract lives.

`client/test/AuthClient.test.ts`: the two Phase 0 cases; "a bearer mint's set-auth-token is stored with no wrapping".

`react/test/ReactClient.test.ts`: the Phase 0 case; "a failed declared mutation (4xx) does not invalidate"; "a caller-supplied httpClient keeps the invalidation".

### 5.2 Compile-time gates (`features/step-definitions/CompileTimeGates.ts`)

Following the pattern at `:152-168` (`HttpApiGroup.MiddlewareServices` checks):

```ts
// ---- 04-contract-stratum.feature: BEH-EA-<new> (REQ-EA-<new>) ----

const lifecycleApi = HttpApi.make("auth").add(
  HttpApiGroup.make("gate")
    .add(HttpApiEndpoint.post("mint", "/gate/mint", { success: Schema.String }).middleware(SessionLifecycle.Mints))
    .add(HttpApiEndpoint.post("plain", "/gate/plain", { success: Schema.String })),
);

// type-gate: session-delivery-needs-a-declared-endpoint
export const undeclared = HttpApiBuilder.group(lifecycleApi, "gate", (handlers) =>
  handlers
    .handle("mint", () => Effect.as(SessionDelivery.decline(SessionLifecycle.MintGrant), "ok"))
    .handle("plain", () => Effect.as(SessionDelivery.decline(SessionLifecycle.MintGrant), "ok")),
);
export const undeclaredLeavesTheGrant: [
  Extract<Layer.Services<typeof undeclared>, HttpRouter.Request<"Requires", SessionLifecycle.MintGrant>>,
] extends [never]
  ? false
  : true = true;

// type-gate: a-declared-endpoint-gets-its-grant
export const declaredOnly = HttpApiBuilder.group(lifecycleApi, "gate", (handlers) =>
  handlers
    .handle("mint", () => Effect.as(SessionDelivery.decline(SessionLifecycle.MintGrant), "ok"))
    .handle("plain", () => Effect.succeed("ok")),
);
export const declaredLeavesNothing: [
  Extract<Layer.Services<typeof declaredOnly>, HttpRouter.Request<"Requires", unknown>>,
] extends [never]
  ? true
  : false = true;
```

Matching `@REQ-EA-<new>` scenarios in `features/features/01-contract-and-persistence/04-contract-stratum.feature` with the `assertTypeGate` step (`CompileTimeSteps.ts`). `CompileTimeGates.ts` gains the `@awthaq/server`, `HttpApi`, `HttpApiBuilder` and `HttpRouter` imports.

### 5.3 BDD

New REQ ids are the next free ones at execution time (above `REQ-EA-1306` today; plans 11–24 also allocate, so re-check `features/traceability.md`).

- `04-contract-stratum.feature`: the two type gates; "the composed contract states the session lifecycle of each endpoint" (inventory over `Auth.make([Password, Passkey, MagicLink, …]).api`).
- `22-client-effect.feature` (BEH-EA-175): the Phase 0 bearer `changePassword` scenario; "a bearer client forgets a token whose session ended" (sign-out, then the store is empty).
- `23-react.feature` (BEH-EA-178): REQ-EA-504 becomes "A mutation against a declared endpoint refetches the session with no reactivityKeys"; REQ-EA-698 becomes "A plugin mutation declared on the contract refetches the session". REQ-EA-505 (`sessionAtom` declares its keys) unchanged.
- `09-admin-and-impersonation/27-admin-impersonation.feature`: "a bearer request to impersonate is refused before anything is minted".
- Existing scenarios that must keep passing unchanged in meaning: every MNA-001 bearer scenario (REQ ids under BEH-EA-066 and BEH-EA-128), the CSS-002 expiry scenarios, the APS-006 jar scenario (`AdminSteps.ts:1105-1156`), the PV-016 OAuth landing tests.

### 5.4 Tests deleted, by name

- `server/test/SessionDelivery.seam.test.ts`: "only an endpoint that mints no session calls SessionDelivery.mode directly", "only the device grant, whose delivery is fixed by the RFC, calls SessionDelivery.deliver directly". Replaced by §5.1 items 14–16, §5.2 and the per-plugin inventory pins.
- `server/test/SessionDelivery.test.ts:76-110` (three `respond` cases over a bare `HttpRouter` route): replaced by §5.1 items 5 and 9.
- `client/test/AuthClient.test.ts:314`, `:329`, `:339` (`captureSessionToken`): the function is gone; replaced by the header cases.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour specs (each gets a Document Control revision and a change-history line)

- `spec/behaviors/04-contract-stratum.md` → rev 1.2. New **BEH-EA-<new>**: "An endpoint declares what it does to the caller's session on the contract", REQUIREMENT: an endpoint whose success mints, rotates, ends or swaps the caller's credential, or changes its session's view, MUST declare exactly one `SessionLifecycle` marker; a handler MUST NOT change the credential except through `SessionDelivery`, and a declared endpoint MUST settle its declaration on every successful response. Implementation note naming §3.1–§3.3 and the type gates.
- `spec/behaviors/09-authentication-middleware.md` → rev 1.5. BEH-EA-066 "Native clients" paragraph (`:65`): delivery is resolved by the endpoint's marker before the handler runs; every bearer delivery carries `set-auth-token`; an ended session answers `x-awthaq-session-ended`; the list of minting endpoints is the contract's inventory, not prose. Delete "only a concealed sign-up … calls `mode` itself".
- `spec/behaviors/22-client-effect.md` → rev 1.1. BEH-EA-175 (or the `MNA-005` paragraph at `:150`): the store follows `set-auth-token` and `x-awthaq-session-ended`; `captureSessionToken` is gone.
- `spec/behaviors/23-react.md` → rev 1.2. BEH-EA-178: REQUIREMENT reworded — "A mutation against an endpoint the contract declares with a session lifecycle MUST refetch `sessionAtom` without application code passing `reactivityKeys`; a mutation outside the composed contract that changes the session passes `["session"]`." Example at `:42` loses the key.
- `spec/behaviors/15-password.md:29` (MNA-001/WPS-004 paragraph): `signUp`/`signIn` declare `Mints`, `changePassword` `Rotates`, `reauthenticate` `Refreshes`; a bearer `changePassword` carries `set-auth-token`.
- `spec/behaviors/27-admin-impersonation.md`: impersonation endpoints declare `Swaps`; bearer delivery is refused.
- `spec/behaviors/16-oauth.md` (callback, native exchange), `29-saml-sp.md` (ACS, SP logout), `31-two-factor.md`, `32-magic-link.md`, `33-email-otp.md`, `37-device-authorization.md` (`set-auth-token` on the token response), `35-organization.md` (`Refreshes` on the four endpoints), `17-passkey.md`: one sentence each naming the declared kind.
- `spec/glossary.md`: new entry **Session lifecycle** (the five kinds, the grant).

### 6.2 Decisions

- **New ADR-EA-045** (`spec/decisions/045-session-lifecycle-on-the-contract.md`, `index.yaml` entry), "An Endpoint's Effect on the Caller's Session Is Declared on the HttpApi Contract":
  - Context: §1 summary, §2.3's bypasses, §2.6's bug, the regex guard.
  - Decision: five middleware markers (§3.1), grants and the type-level gate (§3.2–§3.3), delivery resolved in the marker, `settle`/`decline`, headers as the client signal, React invalidation, OpenAPI transform, core's writers moved to the server.
  - Alternatives considered: (a) a `Context` annotation read the way qadi reads `RequiredPermission` (ADR-EA-015) — rejected: type-erased (`HttpApiEndpoint.ts:189`), so no compile-time gate; (b) one marker with the kind in an annotation — rejected: an `Ends` handler could call `respond`; (c) the client reads the declaration and inspects bodies — rejected: conditional ends (`revoke`, `forceStop`) are known only to the server, and a non-Effect client reads headers anyway; (d) `requiredForClient: true` on the markers — rejected: every cookie client and the CLI would need a no-op layer for no benefit; (e) keep the regex test and extend its patterns — rejected: a text search cannot see a hand-rolled `render` + `setCookie`.
  - Consequences: §7.
- **ADR-EA-003 rev 1.2** (`003-httpapi-as-contract.md`): Consequences gains "the contract also carries each endpoint's session lifecycle (ADR-EA-045)".
- **ADR-EA-015**: no change; cite it in ADR-EA-045's alternative (a).
- **ADR-EA-026** (signup enumeration): the concealed sign-up `decline`s; one sentence.

### 6.3 Traceability and docs

- `spec/traceability.md:229` (the `SessionDelivery.test.ts`, `SessionDelivery.seam.test.ts` row): replaced by rows for `server/test/SessionLifecycle.test.ts`, `SessionLifecycle.types.test.ts`, `SessionDelivery.test.ts` (rewritten), `api/test/SessionLifecycle.test.ts`. `:266` (`AuthClient.test.ts`): header-driven store, no `captureSessionToken`. React row (`react/test/ReactClient.test.ts`): automatic invalidation. Each plugin's `Contract.test.ts` row: the inventory pin.
- `features/traceability.md`: new REQ rows; REQ-EA-504/698 text.
- `docs/plugin-authoring.md:191`: rewritten — declare the marker on the endpoint; call `SessionDelivery.respond(mint)` (or `redirect`, `deliverBearer`, `end`, `swapIn`/`swapOut`, `decline`); a handler of an undeclared endpoint cannot call it (compile error), and a declared one that answers without it dies.
- `packages/server/README.md:21`, `packages/client/README.md:83-120`, `packages/react/README.md:52`, `:102`, `packages/password/README.md:11`.

### 6.4 Changesets (ADR-EA-034: each has a `Migration:` section naming ADR and BEH ids)

- Phase 1, `.changeset/session-lifecycle-contract.md`, `"@awthaq/api": minor`: "`SessionLifecycle.Mints`/`Rotates`/`Ends`/`Swaps`/`Refreshes` declare an endpoint's effect on the caller's session (ADR-EA-045). Migration: none."
- Phase 2–4, `.changeset/session-delivery-grants.md`, `"@awthaq/server": minor`, `"@awthaq/core": minor`, and every plugin whose contract changed (`password`, `passkey`, `magic-link`, `two-factor`, `device-authorization`, `oauth`, `saml`, `admin`, `organization`): "`SessionDelivery.respond(mint)` takes no request: the endpoint's marker resolved the delivery. `mode`/`deliver` are gone; `redirect`, `deliverBearer`, `deliverExchanged`, `end`, `swapIn`, `swapOut`, `decline` cover the rest. A bearer delivery carries `set-auth-token`; an ended session answers `x-awthaq-session-ended`; declared responses are `no-store`. Core's `SessionCookie.set`/`expire`/`expireImpersonation` moved into `@awthaq/server`. A bearer request to impersonate answers `400`. Migration: add `.middleware(SessionLifecycle.<Kind>)` to your endpoint, drop `Api.InvalidTokenDelivery` from its errors, replace `SessionDelivery.respond(request, mint)` with `SessionDelivery.respond(mint)` and `SessionDelivery.mode(request)` (mint nothing) with `SessionDelivery.decline(SessionLifecycle.MintGrant)`; never write the session cookie yourself."
- Phase 5, `.changeset/bearer-client-follows-headers.md`, `"@awthaq/client": minor`: "`bearerTransformClient` stores `set-auth-token` from every response (every bearer sign-in, sign-up and password change now sends it) and clears the store on `x-awthaq-session-ended`. `captureSessionToken` is removed. Migration: unwrap `captureSessionToken(call)` to `call`."
- Phase 6, `.changeset/react-session-invalidation.md`, `"@awthaq/react": minor`: "A mutation against an endpoint declared with a session lifecycle refetches the session itself (BEH-EA-178). Migration: drop `reactivityKeys: [SESSION_KEY]` from such mutations (keeping it is harmless)."

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **The unsettled check dies in production** for a declared endpoint whose handler has a success path nobody tested | Every declared endpoint has success-path wire tests today; Phase 4 runs them all. The check names the endpoint and the kind. Q4 offers log-and-pass in production instead |
| **Middleware order.** The marker is endpoint-level; `CsrfProtection`/`Authentication` are group-level. A `400 InvalidTokenDelivery` could be answered before or after authentication | Either order refuses before anything is minted. §5.1 item 5 asserts the handler never runs; it does not assert which of 400/401 wins |
| **`set-auth-token` now appears on bearer mints**: a proxy, log or cache that did not expect it | It already appears on any authenticated bearer response (rotation, `Authentication.ts:419-421`). `AuthHttp.layerRedactedHeaders` (`AuthHttp.ts:223-226`) already redacts it; CORS already exposes it |
| **Declared errors move from endpoint to middleware**: the OpenAPI document or `AuthClient.ErrorCodes` could lose `InvalidTokenDelivery` | `ErrorCodes` reads middleware errors (`client/src/AuthClient.ts:299-301`), so the client union is unchanged; a `client/test/ErrorCodes.test.ts` case pins it. §3.9 adds the 400 to the document if the generator omits middleware errors |
| **Spike S2 fails** (the client half builds its own `Reactivity`) | §3.8's fallback; the Phase 0 spike decides before Phase 6 |
| **A hand-wired composition** (BDD worlds that build middleware themselves) lacks the marker implementations | `HttpApiBuilder` fails at layer build (missing middleware), loudly; `AuthHttp.sessionLifecycle` is the one layer to add |
| **Core loses `SessionCookie.set`/`expire`**: an out-of-tree plugin used them | Pre-1.0 (ADR-EA-034); the changeset says what replaces them |
| **Plan 11 moves rotation delivery** while this plan's `end` removes the rotation header | `end`'s handler is registered in the handler, after any verify-time handler, wherever plan 11 puts it; §5.1 item 11 pins the outcome, not the mechanism |

**Rollback.** Phase 1 is additive. Phase 2 is additive (old overloads kept). Phases 3 and 4 revert together with the seam test restored. Phase 5 (client), 6 (React) and 7 (OpenAPI) revert independently; reverting 5 leaves the server sending the new headers, which an old client ignores.

---

## 8. Interactions with other plans

- **01 (sign-in core, done)**: `SignIn.complete` still returns the issued session; handlers pass it to `respond`. No change.
- **07 (redeem, done)**: magic-link/OTP/two-factor `use` runs inside `redeem`; delivery happens after `redeem` returns, in the handler, as today.
- **08 (test composition, done)**: `middlewareFor` derives the markers, so `TestAuth.layer` needs nothing new.
- **10 (standalone fixes, done)**: none.
- **11 (credential resolution)**: owns rotation delivery and `IssuedSession`. This plan uses `IssuedSession` if 11 lands first, and its `end` must keep winning over the rotation's `set-auth-token` wherever 11 moves it (§7). 11's configured-cookie-name fix touches `SessionCookie.cookieName`, which stays in core.
- **12 (passkey ceremony)**: `authenticateVerify` (`Mints`) and `reauthenticateVerify` (`Refreshes`) declarations; whichever lands second rebases the handler change.
- **13 (admin gate)**: rewrites the admin handlers; the three `Swaps` declarations and `swapIn`/`swapOut`/`decline` go with it. Land 21 first or have 13 carry them.
- **14 (federated identity)**: OAuth callback and SAML ACS completion move into core; their delivery stays in the handler through `SessionDelivery.redirect`.
- **15 (host composition)**: derives the servable layer, including host middleware; the five markers join `HostMiddleware`, and the OpenAPI transform may move from `Auth.make` into 15's module.
- **18 (verification-link redeem)**: magic-link handlers; no conflict (delivery stays in the handler).
- **19 (session verdict)**: none.
- **20 (in-process user agent)**: runs **after** this plan. Its bearer mode then needs no endpoint knowledge: store `set-auth-token`, clear on `x-awthaq-session-ended`, exactly like `bearerTransformClient`. Its React-world migration relies on Phase 6 (no keys). If 20 runs first, it must duck-type the body token as `captureSessionToken` does today and rework it here.
- **16, 17, 22, 23, 24**: none.

---

## 9. Acceptance checklist

- [ ] `@awthaq/api` exports `SessionLifecycle` with the five markers, three grants, `Kind`, `kindOf`, `inventory`, `openApi`, `SESSION_ENDED_HEADER`.
- [ ] `middlewareFor` derives the markers; `AuthHttp.sessionLifecycle` exists; CORS exposes the ended header.
- [ ] `grep -rn "SessionDelivery\.mode\|SessionDelivery\.deliver(\|captureSessionToken" packages features docs` returns nothing.
- [ ] `grep -rn "SessionCookie\.\(set\|expire\|expireImpersonation\)\b" packages/*/src` lists only `server/src/internal/SessionCookie.ts` callers inside `@awthaq/server`.
- [ ] `grep -rn "Api.InvalidTokenDelivery" packages/*/src` lists only `api/src`, `server/src/SessionLifecycle.ts` and `server/src/SessionDelivery.ts`.
- [ ] Every endpoint of §3.4 declares its kind; each plugin's `Contract.test.ts` pins its inventory.
- [ ] `SessionDelivery.seam.test.ts` is deleted; the type tests and compile-time gates pass.
- [ ] The Phase 0 bearer `changePassword` scenario passes: the session survives.
- [ ] A bearer sign-out empties the store; React refetches the session after a declared mutation with no keys.
- [ ] The composed OpenAPI document carries `x-awthaq-session` and the headers for declared operations only.
- [ ] No `as` (other than `as const`), no return-type annotations on new Effect/Layer consts.
- [ ] Specs (04, 09, 15, 16, 17, 22, 23, 27, 29, 31, 32, 33, 35, 37, glossary) revised with Document Control rows; ADR-EA-045 added and indexed; ADR-EA-003 at rev 1.2; traceability updated; `pnpm spec:verify:strict` passes.
- [ ] A changeset with `Migration:` per package-visible phase.
- [ ] `pnpm check` is green on the final commit.

---

## 10. Open questions only the user can answer

1. **Body `token` field.** Every bearer mint now also sends `set-auth-token`. Keep `SessionDto.token` in the body (recommended: it is the typed result a caller like the device CLI reads directly, and the native-app docs show it), or remove it so the token travels in one place only?
2. **Bearer impersonation.** Refuse `X-Awthaq-Token-Delivery: bearer` on the `Swaps` endpoints with `400` (recommended; nothing supports a bearer swap today and the cookie it sets now is useless), or design a bearer swap (the impersonation token in `set-auth-token`, the admin's own handed back on stop)?
3. **The `Refreshes` set.** Recommended: `password.reauthenticate`, `passkey.reauthenticateVerify`, `organization.setActive`, `.setActiveTeam`, `.leave`, `.acceptInvitation`. Also `organization.create`/`delete`, role assignment to oneself, `updateMemberRole`? Each one adds a session refetch after the mutation.
4. **Unsettled declared endpoint in production.** Die with a `500` everywhere (recommended: a minting endpoint that delivered nothing is a defect, and every test exercises the check), or log and pass the response in production, dying only under `TestAuth`?
5. **Core's cookie writers.** Move `SessionCookie.set`/`expire`/`expireImpersonation` into `@awthaq/server` (recommended: no plugin can then write the session cookie except through `SessionDelivery`), or keep them in core and rely on review?
6. **JWT session-mirror cookie.** Should an `Ends` response also expire the JWT mirror cookie (today it is re-minted on sign-out and lives out its `ttl`, `jwt/src/Jwt.ts:367-372`)? Recommended: a follow-up ticket, not this plan.
7. **Password reset and email-change confirmation** revoke all of the user's sessions from a request that carries no session. Declare them `Ends` (the browser that opened the link may hold one of those sessions, and would then get its cookie expired), or leave them undeclared (recommended: the request presents no credential, so there is nothing of the caller's to end)?
8. **Delivery validation order.** Is it acceptable that a request with both an invalid delivery header and no session may answer `400` or `401` depending on middleware order (recommended: yes; both refuse before anything is minted)?
