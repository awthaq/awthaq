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
import { Api } from "@awthaq/api";
import { AuthClient } from "@awthaq/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import type * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import type { HeadersLike } from "./CookieHeader.ts";
import type { CookieJarLike } from "./CookieJar.ts";
import { applyResponseCookies, parseSetCookie } from "./CookieJar.ts";

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

/** Raw (still percent-encoded) name -> value pairs of a `Cookie` request header. */
const parseCookieHeader = (header: string | null): Map<string, string> => {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator > 0) cookies.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return cookies;
};

const decodeCookie = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** The subset of request bodies an auth client produces (JSON/text/bytes/forms); streams are not sent through a server action. */
const toBodyInit = (body: HttpClientRequest.HttpClientRequest["body"]): BodyInit | null => {
  switch (body._tag) {
    case "Empty":
      return null;
    case "Uint8Array":
      // A copy: `BodyInit` wants an `ArrayBuffer`-backed view, the body's is `ArrayBufferLike`.
      return new Uint8Array(body.body);
    case "FormData":
      return body.formData;
    case "Raw": {
      const raw = body.body;
      if (typeof raw === "string" || raw instanceof Blob) return raw;
      if (raw instanceof Uint8Array) return new Uint8Array(raw);
      if (raw instanceof ArrayBuffer || raw instanceof FormData || raw instanceof URLSearchParams) {
        return raw;
      }
      throw new Error("@awthaq/web: unsupported raw request body in a server action client");
    }
    case "Stream":
      throw new Error(
        "@awthaq/web: streaming request bodies are not supported in a server action client",
      );
  }
};

/**
 * The in-process transport plus the CSRF client half over one shared cookie
 * state: the action's incoming cookies, updated by every response's `Set-Cookie`.
 */
const makeLayers = (options: InProcessClientOptions) => {
  const cookies = parseCookieHeader(options.headers.get("cookie"));

  const transport = HttpClient.make((request, url) =>
    Effect.tryPromise({
      try: async () => {
        const headers = new Headers(request.headers);
        headers.set(
          "cookie",
          Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; "),
        );
        for (const name of ["user-agent", "x-forwarded-for"]) {
          const forwarded = options.headers.get(name);
          if (forwarded !== null && !headers.has(name)) headers.set(name, forwarded);
        }
        const response = await options.handler(
          new Request(url, { method: request.method, headers, body: toBodyInit(request.body) }),
        );
        // Record cookies for this action's later calls, and hand them to the framework's jar.
        for (const header of response.headers.getSetCookie()) {
          const { name, options: attributes } = parseSetCookie(header);
          // Forwarded raw (still percent-encoded), exactly as a browser would send it back.
          const raw = (header.split(";")[0] ?? "").slice(name.length + 1);
          if (attributes.maxAge !== undefined && attributes.maxAge <= 0) cookies.delete(name);
          else cookies.set(name, raw);
        }
        applyResponseCookies(response, options.jar);
        return HttpClientResponse.fromWeb(request, response);
      },
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    }),
  );

  const csrf = AuthClient.csrfClientLayer({
    readCookie: (name) => {
      const raw = cookies.get(name);
      return raw === undefined ? undefined : decodeCookie(raw);
    },
  });

  return Layer.merge(Layer.succeed(HttpClient.HttpClient, transport), csrf);
};

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
) =>
  HttpApiClient.make(api, { baseUrl: options.origin ?? "http://internal" }).pipe(
    Effect.provide(makeLayers(options)),
  );

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
