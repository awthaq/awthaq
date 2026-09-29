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
import { AuthClient } from "@awthaq/client";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";
import type * as Atom from "effect/unstable/reactivity/Atom";

/**
 * The reactivity key every session-changing mutation (sign-in, sign-out,
 * switching the active organization, accepting an invitation) passes as
 * `reactivityKeys: [SESSION_KEY]`, and the key the built-in session and
 * subject queries carry — BEH-EA-178.
 */
export const SESSION_KEY = "session";

/** The default transport: `fetch`, with the CSRF header attached to guarded mutations. */
const defaultHttpClient = Layer.merge(FetchHttpClient.layer, AuthClient.CsrfClientLive);

/**
 * Class-style, like `AtomHttpApi.Service` itself:
 *
 * ```ts
 * class AppClient extends makeReactClient<AppClient>()("app/Client", { api: auth.api }) {}
 * AppClient.query("organization", "active", { reactivityKeys: [SESSION_KEY] });
 * AppClient.mutation("password", "signIn");
 * ```
 *
 * Every group of the composed api gets typed `query`/`mutation` atoms.
 */
export const makeReactClient =
  <Self>() =>
  <const Id extends string, ApiId extends string, Groups extends HttpApiGroup.Constraint>(
    id: Id,
    options: {
      readonly api: HttpApi.HttpApi<ApiId, Groups>;
      /** Where the auth routes are mounted (e.g. `"/api/auth"` or another origin); default: same origin, root. */
      readonly baseUrl?: URL | string | undefined;
      /** Replaces the default `FetchHttpClient` + CSRF transport. */
      readonly httpClient?:
        | Layer.Layer<HttpApiGroup.ClientServices<Groups> | HttpClient.HttpClient>
        | undefined;
      readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined;
      readonly runtime?: Atom.RuntimeFactory | undefined;
    },
  ) =>
    AtomHttpApi.Service<Self>()(id, {
      api: options.api,
      baseUrl: options.baseUrl,
      httpClient: options.httpClient ?? defaultHttpClient,
      transformClient: options.transformClient,
      runtime: options.runtime,
    });
