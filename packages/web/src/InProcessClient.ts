// @awthaq/web — InProcessClient
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-189/190. BO-002/NSA-008: a typed,
// in-process client for server actions; BO-004: framework-neutral (a SvelteKit
// form action, an Astro action). `@awthaq/next` exposes it under its
// `serverActionClient` names.
//
// A server action never sees the raw HTTP response an Effect handler writes
// `Set-Cookie` onto, and (since `CsrfProtection` guards every mutating group)
// a hand-built `Request` needs the double-submit echo, the caller's cookies
// and its client metadata forwarded as well. This module is the whole recipe:
// an `HttpApiClient` over the application's *own* composed `api` whose
// transport dispatches to the application's own web handler, so
// `client.password.signIn({ payload })` works for whichever plugin set the
// application composed — and comes back typed, error tags included.
//
// - The incoming action's `Cookie`, `User-Agent` and `X-Forwarded-For` are
//   forwarded to the handler. `Origin`/`Sec-Fetch-Site` are deliberately not:
//   with neither header present `CsrfProtection`'s site check has nothing to
//   reject on and the double-submit check still runs (Csrf.ts).
// - The `__Host-csrf` cookie's value is echoed as `x-csrf-token` (the client
//   half, `AuthClient.csrfClientLayer`, reading from this call's cookie state).
//   A cold action — no CSRF cookie yet — gets one `CsrfRejected` whose
//   `Set-Cookie` carries a fresh cookie; the transport records it, the layer's
//   bootstrap retry re-issues the call once with it, and the fresh cookie lands
//   in the framework's jar for the browser.
// - Every `Set-Cookie` a response carries goes into the `jar` through
//   `applyResponseCookies` (BEH-EA-189).
//
// No `ManagedRuntime` is constructed here (the `.scratch/next-package` design
// decision): the application passes its own web `handler`, typically
// `HttpRouter.toWebHandler` over its composed layer, built once next to its
// pinned runtime.
//
// The transport and the cookie state are `UserAgent`'s (BEH-EA-344) under the `trusted` policy: a cookie
// expired by `Expires` or scoped to another `Path` stays off the action's later calls.
import type { Api } from "@awthaq/api";
import { AuthClient } from "@awthaq/client";
import * as Effect from "effect/Effect";
import type * as HttpApiClient from "effect/http-api/HttpApiClient";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import type * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import type { HeadersLike } from "./CookieHeader.ts";
import type { CookieJarLike } from "./CookieJar.ts";
import * as UserAgent from "./UserAgent.ts";

export interface InProcessClientOptions {
  /** The application's own web handler (e.g. `HttpRouter.toWebHandler(...).handler`). */
  readonly handler: (request: Request) => Promise<Response>;
  /** The incoming action's headers — `await headers()` (Next), `request.headers` (SvelteKit/Astro). */
  readonly headers: HeadersLike;
  /** The framework's mutable cookie jar — `await cookies()` (Next), `event.cookies` (SvelteKit). */
  readonly jar: CookieJarLike;
  /** The base URL requests are addressed to; default `http://internal`. Only its path prefix matters to the handler. */
  readonly origin?: string | undefined;
}

/**
 * The action's user agent: the `trusted` policy (the handler is the application itself, addressed at
 * `http://internal`, so `Domain`/`Secure`/`SameSite` are not enforced; expiry and `Path` are), seeded with
 * the action's incoming cookies, mirroring every `Set-Cookie` into the framework's jar.
 */
const agentFor = (options: InProcessClientOptions) =>
  UserAgent.make({
    handler: options.handler,
    origin: options.origin ?? "http://internal",
    policy: "trusted",
    cookies: options.headers.get("cookie") ?? undefined,
    mirror: options.jar,
    forward: { from: options.headers, names: ["user-agent", "x-forwarded-for"] },
  });

/**
 * The client-middleware requirement this module discharges on the caller's
 * behalf — `CsrfProtection`'s — and the check that nothing else is left: an api
 * whose groups need *other* client middleware cannot use the Promise form (the
 * missing middleware would be skipped at runtime, not rejected); it provides
 * that layer to `makeInProcessClient`'s Effect itself instead.
 */
type UnsupportedClientMiddleware<Groups> = [
  Exclude<HttpApiGroup.ClientServices<Groups>, HttpApiMiddleware.ForClient<Api.CsrfProtection>>,
] extends [never]
  ? unknown
  : {
      readonly "@awthaq/web: this api needs client middleware beyond CsrfProtection; use makeInProcessClient and provide it": never;
    };

/**
 * An Effect-native client over `api` for use inside a server action:
 * `yield* makeInProcessClient(AppApi, { handler, headers: await headers(), jar: await cookies() })`.
 * Build one per action invocation — it carries that request's cookie state.
 * Any client middleware other than CSRF's stays in the Effect's requirements.
 */
export const makeInProcessClient = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options: InProcessClientOptions,
) => UserAgent.client(agentFor(options), api);

/**
 * The Promise form, for actions that are plain `async` functions:
 *
 * ```ts
 * const client = await inProcessClient(AppApi, { handler, headers: await headers(), jar: await cookies() });
 * const session = await client.password.signIn({ payload: { email, password } });
 * ```
 *
 * Default: methods reject with the endpoint's tagged contract error;
 * `{ mode: "result" }` resolves a `Result<A, E>` instead (`AuthClient.toPromiseFacade`).
 */
export function inProcessClient<ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options: InProcessClientOptions & UnsupportedClientMiddleware<Groups>,
): Promise<AuthClient.PromiseFacade<HttpApiClient.Client<Groups>>>;
export function inProcessClient<ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  options: InProcessClientOptions &
    UnsupportedClientMiddleware<Groups> & { readonly mode: "result" },
): Promise<AuthClient.ResultFacade<HttpApiClient.Client<Groups>>>;
// The implementation is typed at the group constraint; the gate above is what
// guarantees, for every real call, that no client requirement is left over.
export async function inProcessClient(
  api: HttpApi.HttpApi<string, HttpApiGroup.Constraint>,
  options: InProcessClientOptions & { readonly mode?: "promise" | "result" },
): Promise<unknown> {
  const client = await Effect.runPromise(makeInProcessClient(api, options));
  return options.mode === "result"
    ? AuthClient.toPromiseFacade(client, { mode: "result" })
    : AuthClient.toPromiseFacade(client);
}
