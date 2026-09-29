// @awthaq/server — SessionDelivery
//
// MNA-001 (wayfinder ticket 17) / WPS-004: the one place a session-minting
// response chooses how the fresh credential reaches the client. Every
// issuing handler (password sign-up/sign-in/change-password, passkey
// authenticate, the OAuth native exchange) routes through `mode` + `deliver`,
// so a plugin never calls `SessionCookie.set` (or writes a body token) on its
// own and the two channels stay mutually exclusive per request.
//
// - `cookie` (the default, header absent): the `Set-Cookie` write every
//   browser client relies on — byte-for-byte what handlers did before.
// - `bearer` (`X-Awthaq-Token-Delivery: bearer`): no cookie; the raw token is
//   the response DTO's optional `token` field. A native app has no cookie jar
//   it can read, and putting a live token in a JS-readable body for a *browser*
//   would defeat `HttpOnly`, which is why bearer delivery is opt-in per
//   request and never the default. The response carries `Cache-Control:
//   no-store` (it holds a long-lived secret, MAPS-008).
//
// `mode` is its own step, run before the session is issued, so an unknown
// header value is a 400 that mints nothing.

import { Api, SessionContract } from "@awthaq/api";
import { SessionCookie, Sessions } from "@awthaq/core";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { toSessionDto } from "./Session.ts";

export type Mode = "cookie" | "bearer";

/** The delivery a request asked for. An unrecognised `X-Awthaq-Token-Delivery` value fails `InvalidTokenDelivery`. */
export const mode = (request: HttpServerRequest.HttpServerRequest) => {
  const header = Headers.get(request.headers, Api.TOKEN_DELIVERY_HEADER);
  if (Option.isNone(header)) return Effect.succeed<Mode>("cookie");
  return header.value.trim().toLowerCase() === "bearer"
    ? Effect.succeed<Mode>("bearer")
    : Effect.fail(new Api.InvalidTokenDelivery());
};

/**
 * Delivers an issued session the way `mode` chose and returns the response
 * DTO: `cookie` sets the session cookie and omits `token`; `bearer` sets no
 * cookie and carries the token in the body.
 */
export const deliver = Effect.fnUntraced(function* (
  deliveryMode: Mode,
  issued: {
    readonly session: Sessions.SessionView;
    readonly token: Redacted.Redacted<string>;
  },
) {
  const dto = toSessionDto(issued.session);
  if (deliveryMode === "cookie") {
    yield* SessionCookie.set(issued.session, issued.token);
    return dto;
  }
  yield* HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
  );
  return new SessionContract.SessionDto({ ...dto, token: Redacted.value(issued.token) });
});
