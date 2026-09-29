// @awthaq/migrate-better-auth — AliasLegacyCookieMiddleware
//
// BAM-003 (.issues/high): better-auth's session cookie has a different
// name than `__Host-session` (`Sessions.SESSION_COOKIE_NAME`), and
// `@awthaq/api`'s `Api.SessionCookie` extraction point (built on
// `effect/unstable/httpapi`'s own `HttpApiSecurity.apiKey`) only knows the
// latter. Rather than teach the typed contract or `@awthaq/server`'s
// `Authentication.ts` about a second cookie name — a concern that has
// nothing to do with either's own job — this is a thin, generic
// `HttpMiddleware` a deployment installs ahead of its composed app: when
// the primary `__Host-session` cookie is absent and the configured legacy
// cookie is present, it rewrites the *ambient* `HttpServerRequest`'s
// `cookie` header so existing extraction picks it up completely
// unmodified. `Sessions`/`Authentication`'s public types stay untouched by
// what is really transport-layer plumbing (`ADR-EA-003`'s contract/HTTP
// separation).
//
// The synthesized `__Host-session=<value>` entry never round-trips to a
// real browser under that name — no `Set-Cookie` is ever issued for it by
// this middleware — so RFC 6265bis's `__Host-` prefix storage rules (which
// only constrain what a *client* may store, not what a server may read
// off an incoming `Cookie` header) are not a concern here.

import { SessionCookie } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

export const make = (options: {
  readonly legacyCookieName: string;
}): HttpMiddleware.HttpMiddleware =>
  HttpMiddleware.make((httpApp) =>
    Effect.flatMap(SessionCookie.SessionCookieConfig, (cfg) => {
      // IC-007: alias to the configured session-cookie name (default `__Host-session`).
      const name = SessionCookie.cookieName(cfg);
      return Effect.updateService(httpApp, HttpServerRequest.HttpServerRequest, (request) => {
        if (request.cookies[name] !== undefined) return request;
        const legacyValue = request.cookies[options.legacyCookieName];
        if (legacyValue === undefined) return request;
        const existing = request.headers["cookie"] ?? "";
        const rewritten =
          existing.length > 0 ? `${existing}; ${name}=${legacyValue}` : `${name}=${legacyValue}`;
        return request.modify({ headers: Headers.set(request.headers, "cookie", rewritten) });
      });
    }),
  );
