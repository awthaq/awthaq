// @awthaq/web — UserAgent
//
// spec/behaviors/24-nextjs-ssr.md, BEH-EA-344. One in-process user agent against an awthaq handler
// (`(Request) => Promise<Response>`): the cookie state (`CookieStore`), the CSRF echo, the bearer token
// and the request recipe (delivery header, forwarded client metadata, a cross-site request's
// `Sec-Fetch-Site`/`Origin`). The server-action client (`InProcessClient`, under the `trusted` policy),
// `@awthaq/test`'s `TestAuth.app` agents, the BDD worlds and the React world are all this one module.
//
// - `request` is a page script: it echoes `__Host-csrf` as `x-csrf-token` on an unsafe method. `fetch` and
//   `httpClient` are the network: no echo (the application's own CSRF client half does it, as in a browser;
//   `client` below provides it).
// - A fresh agent's first unsafe request carries no `Cookie` header, so `CsrfProtection`'s cookie-less
//   exemption (BEH-EA-077) passes it and the response's `__Host-csrf` lands in the store. There is no
//   bootstrap retry here; `AuthClient.csrfClientLayer` keeps it for typed clients.
// - Bearer delivery (`delivery: "bearer"`) sends no cookies: `X-Awthaq-Token-Delivery: bearer` and
//   `Authorization`, and it follows the headers every declared response carries (ADR-EA-045):
//   `set-auth-token` replaces the token, `x-awthaq-session-ended` clears it (and wins).
// - Under the `browser` policy a `Set-Cookie` a conforming browser would refuse rejects the request by
//   default (`onRefused: "throw"`): the CSS-001 class of bug (a `__Host-` cookie with a narrowed `Path`)
//   fails a test instead of working silently.
import { Api } from "@awthaq/api";
import { AuthClient } from "@awthaq/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import type { HeadersLike } from "./CookieHeader.ts";
import { applyResponseCookies, decodeCookieValue, type CookieJarLike } from "./CookieJar.ts";
import { makeCookieStore, type Policy, type Received, type Site } from "./CookieStore.ts";

/** The `init` of the platform `fetch`, named before this module's own `RequestInit` shadows it. */
type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;

export interface UserAgentOptions {
  /** The application's web handler; `fetch` itself for a server over the network. */
  readonly handler: (request: Request) => Promise<Response>;
  /** Default `http://localhost` (a secure context). Relative targets resolve against it. */
  readonly origin?: string | undefined;
  /** Default `browser`. */
  readonly policy?: Policy | undefined;
  /** Default `Date.now`; `TestAuth.app({ testClock: true })` passes the composition's clock. */
  readonly now?: (() => number) | undefined;
  /** A `Cookie` header to start from (a server action's incoming cookies). */
  readonly cookies?: string | undefined;
  /** Every `Set-Cookie` also lands here (BEH-EA-189), e.g. Next's `cookies()`. */
  readonly mirror?: CookieJarLike | undefined;
  /** Headers copied from an incoming request when the outgoing one lacks them (`user-agent`, `x-forwarded-for`). */
  readonly forward?:
    | { readonly from: HeadersLike; readonly names: ReadonlyArray<string> }
    | undefined;
  /** `bearer`: no cookies; `X-Awthaq-Token-Delivery: bearer` and `Authorization` instead. Default `cookie`. */
  readonly delivery?: "cookie" | "bearer" | undefined;
  /** `throw` (the default under `browser`): a refused `Set-Cookie` rejects the request. `record`: kept in `refused`. */
  readonly onRefused?: "throw" | "record" | undefined;
  /** Requests to these URLs never complete (a fetch still in flight); they are still logged in `sent`. */
  readonly hold?: ((url: URL) => boolean) | undefined;
}

/** What one `request` carries. */
export interface RequestInit {
  /** A JSON body (sets `content-type: application/json`). */
  readonly json?: unknown;
  /** A form body (sets `content-type: application/x-www-form-urlencoded`). */
  readonly form?: Readonly<Record<string, string>>;
  readonly body?: BodyInit;
  /** Win over everything the agent sets. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Default `same-origin` (no `Sec-Fetch-Site`/`Origin` sent). */
  readonly site?: Site;
  /** A top-level navigation (a `Lax` cookie travels on a cross-site GET only then). */
  readonly navigation?: boolean;
  /** Forged or legacy cookies for this request only, appended after the store's; never stored. */
  readonly extraCookies?: Readonly<Record<string, string>>;
}

export interface SentRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
}

export type Refused = Extract<Received, { readonly _tag: "Refused" }>;

/** The methods `CsrfProtection` guards (`server/src/Csrf.ts`). */
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** An origin on another site, for a simulated cross-site request. */
const CROSS_SITE_ORIGIN = "https://elsewhere.example";

/** A sibling host under the same registrable domain (`app.example.com` -> `sibling.example.com`). */
const sameSiteOrigin = (url: URL): string => {
  const labels = url.hostname.split(".");
  const host =
    labels.length > 2 ? ["sibling", ...labels.slice(1)].join(".") : `sibling.${url.hostname}`;
  return `${url.protocol}//${host}`;
};

/** `same-origin` sends nothing (today's posture); a simulated other site sends `Sec-Fetch-Site` and `Origin`. */
const siteHeaders = (headers: Headers, url: URL, site: Site | undefined): void => {
  if (site === undefined || site === "same-origin") return;
  if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", site);
  if (!headers.has("origin")) {
    headers.set("origin", site === "cross-site" ? CROSS_SITE_ORIGIN : sameSiteOrigin(url));
  }
};

/** The subset of request bodies an auth client produces (JSON/text/bytes/forms); streams are not sent in process. */
const toBodyInit = (body: HttpClientRequest.HttpClientRequest["body"]): BodyInit | undefined => {
  switch (body._tag) {
    case "Empty":
      return undefined;
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
      throw new Error("@awthaq/web: unsupported raw request body in an in-process user agent");
    }
    case "Stream":
      throw new Error(
        "@awthaq/web: streaming request bodies are not supported in an in-process user agent",
      );
  }
};

interface Outgoing {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: BodyInit | undefined;
  readonly site: Site | undefined;
  readonly navigation: boolean;
  readonly extraCookies: Readonly<Record<string, string>> | undefined;
}

/**
 * BEH-EA-344: one in-process user agent. See the module comment for what `request`, `fetch` and
 * `httpClient` each add.
 */
export const make = (options: UserAgentOptions) => {
  const baseUrl = options.origin ?? "http://localhost";
  const origin = new URL(baseUrl);
  const policy = options.policy ?? "browser";
  const onRefused = options.onRefused ?? (policy === "browser" ? "throw" : "record");
  const store = makeCookieStore({ policy, now: options.now ?? Date.now });
  if (options.cookies !== undefined) store.seed(origin, options.cookies);
  const sent: Array<SentRequest> = [];
  const refused: Array<Refused> = [];
  let bearerToken: string | undefined;

  const dispatch = async (outgoing: Outgoing): Promise<Response> => {
    const { url, headers } = outgoing;
    if (options.delivery === "bearer") {
      headers.set(Api.TOKEN_DELIVERY_HEADER, "bearer");
      if (bearerToken !== undefined && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${bearerToken}`);
      }
    } else if (!headers.has("cookie")) {
      const fromStore = store.header({
        url,
        method: outgoing.method,
        site: outgoing.site ?? "same-origin",
        navigation: outgoing.navigation,
      });
      const extra = Object.entries(outgoing.extraCookies ?? {}).map(
        ([name, value]) => `${name}=${value}`,
      );
      const cookie = [fromStore ?? "", ...extra].filter((part) => part !== "").join("; ");
      if (cookie !== "") headers.set("cookie", cookie);
    }
    siteHeaders(headers, url, outgoing.site);
    for (const name of options.forward?.names ?? []) {
      const value = options.forward?.from.get(name);
      if (value !== null && value !== undefined && !headers.has(name)) headers.set(name, value);
    }
    sent.push({ method: outgoing.method, url, headers });
    if (options.hold?.(url) === true) return new Promise<Response>(() => undefined);
    const response = await options.handler(
      new Request(url, {
        method: outgoing.method,
        headers,
        ...(outgoing.body === undefined ? {} : { body: outgoing.body }),
      }),
    );
    for (const line of response.headers.getSetCookie()) {
      const received = store.receive(url, line);
      if (received._tag === "Refused") {
        refused.push(received);
        if (onRefused === "throw") {
          throw new Error(
            `awthaq user agent: a browser refuses ${received.name} (${received.refusal}): ${line}`,
          );
        }
      }
    }
    if (options.mirror !== undefined) applyResponseCookies(response, options.mirror);
    // ADR-EA-045: the server says what a declared response did to the caller's session.
    if (response.headers.has(Api.SESSION_ENDED_HEADER)) {
      bearerToken = undefined;
    } else {
      const rotated = response.headers.get(Api.ROTATED_TOKEN_HEADER);
      if (rotated !== null && rotated !== "") bearerToken = rotated;
    }
    return response;
  };

  /** A page script's request: JSON/form body helpers and the CSRF echo on an unsafe method. */
  const request = (method: string, target: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(target, origin);
    const headers = new Headers();
    let body: BodyInit | undefined = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(init.form).toString();
    }
    const csrf = store.get(Api.CSRF_COOKIE_NAME);
    if (options.delivery !== "bearer" && csrf !== undefined && UNSAFE.has(method.toUpperCase())) {
      headers.set(Api.CSRF_HEADER_NAME, decodeCookieValue(csrf.value));
    }
    for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
    return dispatch({
      method: method.toUpperCase(),
      url,
      headers,
      body,
      site: init.site,
      navigation: init.navigation ?? false,
      extraCookies: init.extraCookies,
    });
  };

  /** The network, as `fetch`: the store's cookies go out and every `Set-Cookie` comes back in. No CSRF echo. */
  const fetch = async (input: RequestInfo | URL, init?: FetchInit): Promise<Response> => {
    const incoming =
      input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), origin), init);
    const body = incoming.body === null ? undefined : await incoming.arrayBuffer();
    return dispatch({
      method: incoming.method,
      url: new URL(incoming.url),
      headers: new Headers(incoming.headers),
      body,
      site: undefined,
      navigation: false,
      extraCookies: undefined,
    });
  };

  /** The same transport as an Effect `HttpClient`. */
  const httpClient = HttpClient.make((clientRequest, url) =>
    Effect.tryPromise({
      try: async () =>
        HttpClientResponse.fromWeb(
          clientRequest,
          await dispatch({
            method: clientRequest.method,
            url,
            headers: new Headers(clientRequest.headers),
            body: toBodyInit(clientRequest.body),
            site: undefined,
            navigation: false,
            extraCookies: undefined,
          }),
        ),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: clientRequest, cause }),
        }),
    }),
  );

  return {
    /** The base every relative target resolves against, as given. */
    baseUrl,
    origin,
    request,
    fetch,
    httpClient,
    cookies: {
      /** The most specific live cookie named `name`, attributes included. */
      get: store.get,
      all: store.all,
      /** The decoded value of the most specific live cookie (`csrfClientLayer`'s `readCookie`). */
      value: (name: string): string | undefined => {
        const found = store.get(name);
        return found === undefined ? undefined : decodeCookieValue(found.value);
      },
      /** `document.cookie` as a page script on `origin` sees it. */
      scriptVisible: () => store.scriptVisible(origin),
      /** Takes a `Set-Cookie` as if `origin` had answered it (a session `TestAuth` minted directly). */
      receive: (header: string) => store.receive(origin, header),
    },
    bearer: {
      current: () => bearerToken,
      set: (token: string) => {
        bearerToken = token;
      },
      clear: () => {
        bearerToken = undefined;
      },
    },
    sent,
    refused,
  };
};

export type UserAgent = ReturnType<typeof make>;

/**
 * The agent's transport and the CSRF client half reading its store, as one layer: what an
 * `HttpApiClient` over an awthaq api needs.
 */
export const layer = (agent: UserAgent) =>
  Layer.merge(
    Layer.succeed(HttpClient.HttpClient, agent.httpClient),
    AuthClient.csrfClientLayer({ readCookie: agent.cookies.value }),
  );

/** `HttpApiClient.make` over the agent's transport, with the CSRF client half reading its store. */
export const client = <ApiId extends string, Groups extends HttpApiGroup.Constraint>(
  agent: UserAgent,
  api: HttpApi.HttpApi<ApiId, Groups>,
  options?: { readonly baseUrl?: string | undefined },
) =>
  HttpApiClient.make(api, { baseUrl: options?.baseUrl ?? agent.baseUrl }).pipe(
    Effect.provide(layer(agent)),
  );
