// @awthaq/server — internal SessionCookie
//
// CSS-002: a response that ends the caller's own session must also expire the
// `__Host-session` cookie — revoking the row server-side while the browser
// keeps presenting the dead credential leaves it forever `Unauthenticated`
// with no signal to clear it (and, for a Next.js adapter, no cookie for the
// bridge to clear).

import { Api } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Registers a pre-response handler that expires `__Host-session` on whatever
 * response the request ends with (success or a typed error). `__Host-`
 * requires `Secure` and `Path=/` on the expiring write too, or a browser
 * ignores it. An encoding failure leaves the response as it was — expiry is
 * best-effort hygiene and must never fail the request that triggered it.
 * Registered after the rotation-delivery handler (which runs at verify time),
 * so the expiry wins over a rotated secret for a session that just ended.
 */
export const expireSessionCookie = HttpEffect.appendPreResponseHandler((_request, response) =>
  HttpServerResponse.expireCookie(response, Api.SESSION_COOKIE_NAME, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "strict",
  }).pipe(Effect.catch(() => Effect.succeed(response))),
);
