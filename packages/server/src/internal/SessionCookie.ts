// @awthaq/server — internal SessionCookie
//
// ADR-EA-045: the writers that put the session cookie onto a response. They used to be `@awthaq/core`'s
// `SessionCookie.set`/`expire`/`expireImpersonation`, callable by any plugin; they now live here, behind
// `SessionDelivery` (whose functions require the grant of a declared endpoint), so a plugin cannot write the
// session cookie except through a declared session lifecycle. Core keeps the configuration and the pure
// renderers (`render`, `renderAt`, `baseOptions`), which the rotation delivery and `@awthaq/web` use.
//
// CSS-002: a response that ends the caller's own session must also expire the session cookie, with the
// configured name/`Domain`/attributes so a mode other than the default still expires the cookie it wrote.
// Pre-response handlers run in registration order and a later one wins, so an expiry registered by a handler
// overrides the rotation registered at verify time for a session that just ended.

import { SessionCookie } from "@awthaq/core";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** The pure renderer (core's), for a navigation response that carries the cookie itself. */
export const render = SessionCookie.render;

/**
 * Registers the session cookie on whatever response this request ends with (success or typed error). An
 * unencodable cookie is a defect: the name, attributes and token are all this library's own.
 */
export const set = (
  session: { readonly absoluteExpiresAt: DateTime.Utc },
  token: Redacted.Redacted<string>,
  kind: SessionCookie.CookieKind = "session",
) =>
  SessionCookie.render(session, token, kind).pipe(
    Effect.flatMap((cookie) =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        HttpServerResponse.setCookie(response, cookie.name, cookie.value, cookie.options).pipe(
          Effect.orDie,
        ),
      ),
    ),
  );

/**
 * CSS-002: expires the cookie on the response — same name, `Path`, `Domain`, `Secure` and `SameSite` as the
 * write (a mismatch and the browser keeps the cookie). Best-effort: an encoding failure leaves the response
 * as it was, since expiry is hygiene and must never fail the request that triggered it.
 */
const expireKind = (kind: SessionCookie.CookieKind) =>
  Effect.gen(function* () {
    const cfg = yield* SessionCookie.SessionCookieConfig;
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      HttpServerResponse.expireCookie(
        response,
        SessionCookie.cookieName(cfg, kind),
        SessionCookie.baseOptions(cfg),
      ).pipe(Effect.catch(() => Effect.succeed(response))),
    );
  });

export const expire = expireKind("session");

/** APS-006: expires the impersonation cookie, handing the browser back to the admin's own session cookie. */
export const expireImpersonation = expireKind("impersonation");
