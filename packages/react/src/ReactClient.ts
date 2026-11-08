// @awthaq/react — ReactClient
//
// spec/behaviors/22-client-effect.md, BEH-EA-169/170; spec/behaviors/23-react.md,
// BEH-EA-178 (BE-004, NF-11-1).
//
// `makeReactClient` is `AtomHttpApi.Service` over an application's own
// composed `auth.api`, with the transport this package's audience always
// needs already wired: `FetchHttpClient` plus `AuthClient.CsrfClientLive`.
// `AtomHttpApi.Service` casts its `httpClient` requirement away internally
// (`Layer.provide(layer, options.httpClient) as Layer.Layer<Self>`), so a
// client built directly on it silently skips any client middleware nobody
// provided — for `CsrfProtection` that meant every mutation went out with no
// `x-csrf-token` header and 403'd (NF-11-1). Building through this factory
// makes the CSRF client middleware structurally present instead of something
// each application has to remember.
//
// An application with a non-cookie transport (bearer mode, a test double) or
// with client middleware beyond CSRF passes its own `httpClient`, which
// *replaces* the default — the parameter keeps `AtomHttpApi`'s own
// `ClientServices<Groups>` typing, so a missing middleware layer is a
// compile error there.
//
// BEH-EA-178/ADR-EA-045: whatever transport is used, the client half of the
// five `SessionLifecycle` markers is always installed beside it, so a
// successful mutation against an endpoint the contract declares refetches
// `SESSION_KEY` (the session and the subject) with no `reactivityKeys` at the
// call site.
import { SessionLifecycle } from "@awthaq/api";
import { AuthClient } from "@awthaq/client";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";
import type * as Atom from "effect/reactivity/Atom";
import * as Reactivity from "effect/reactivity/Reactivity";

/**
 * BEH-EA-178: the reactivity key the built-in session and subject queries
 * carry. A mutation against an endpoint the composed contract declares with a
 * `SessionLifecycle` marker invalidates it on its own (`sessionInvalidation`);
 * an application mutation outside the contract that changes the session
 * passes `reactivityKeys: [SESSION_KEY]`.
 */
export const SESSION_KEY = "session";

/** After a successful response of a declared endpoint, the session (and the subject) refetch. */
const invalidating = <Id extends HttpApiMiddleware.AnyId, S>(marker: Context.Key<Id, S>) =>
  HttpApiMiddleware.layerClient(marker, ({ next, request }) =>
    next(request).pipe(
      Effect.tap((response) =>
        response.status >= 200 && response.status < 300
          ? Reactivity.invalidate([SESSION_KEY])
          : Effect.void,
      ),
    ),
  );

/**
 * BEH-EA-178 (ADR-EA-045): the client half of the five `SessionLifecycle` markers. Built on
 * `Reactivity.layer`, which the atom runtime has already built into the registry's memo map, so the
 * invalidation reaches the registry's own `Reactivity` and every query listening on `SESSION_KEY`.
 */
export const sessionInvalidation = Layer.mergeAll(
  invalidating(SessionLifecycle.Mints),
  invalidating(SessionLifecycle.Rotates),
  invalidating(SessionLifecycle.Ends),
  invalidating(SessionLifecycle.Swaps),
  invalidating(SessionLifecycle.Refreshes),
).pipe(Layer.provide(Reactivity.layer));

/** The default transport: `fetch`, with the CSRF header attached to guarded mutations. */
const defaultHttpClient = Layer.merge(FetchHttpClient.layer, AuthClient.CsrfClientLive);

/**
 * Class-style, like `AtomHttpApi.Service` itself:
 *
 * ```ts
 * class AppClient extends makeReactClient<AppClient>()("app/Client", { api: auth.api }) {}
 * AppClient.query("organization", "active", { reactivityKeys: [SESSION_KEY] });
 * AppClient.mutation("password", "signIn"); // declared `Mints`: refetches the session itself
 * ```
 *
 * Every group of the composed api gets typed `query`/`mutation` atoms. The transport (the default or
 * a caller's `httpClient`) always carries `sessionInvalidation`.
 */
export const makeReactClient =
  <Self>() =>
  <const Id extends string, ApiId extends string, Groups extends HttpApiGroup.Constraint>(
    id: Id,
    options: {
      readonly api: HttpApi.HttpApi<ApiId, Groups>;
      /** Where the auth routes are mounted (e.g. `"/api/auth"` or another origin); default: same origin, root. */
      readonly baseUrl?: URL | string | undefined;
      /** Replaces the default `FetchHttpClient` + CSRF transport (`sessionInvalidation` is kept). */
      readonly httpClient?:
        | Layer.Layer<HttpApiGroup.ClientServices<Groups> | HttpClient.HttpClient>
        | undefined;
      readonly transformClient?:
        | ((client: HttpClient.HttpClient) => HttpClient.HttpClient)
        | undefined;
      readonly runtime?: Atom.RuntimeFactory | undefined;
    },
  ) =>
    AtomHttpApi.Service<Self>()(id, {
      api: options.api,
      baseUrl: options.baseUrl,
      httpClient: Layer.merge(options.httpClient ?? defaultHttpClient, sessionInvalidation),
      transformClient: options.transformClient,
      runtime: options.runtime,
    });
