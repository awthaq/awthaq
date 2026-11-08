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
// header value is a 400 that mints nothing. `respond(request, mint)` is that
// ordering as one call (mode -> mint -> deliver): a plugin hands over the
// request and the effect that mints, and cannot get the order wrong. Only an
// endpoint that mints no session (a concealed sign-up) calls `mode` itself.

import { Api, SessionContract, SessionLifecycle } from "@awthaq/api";
import { SessionCookie, Sessions } from "@awthaq/core";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Headers from "effect/http/Headers";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { toSessionDto } from "./internal/SessionDto.ts";

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
  issued: Sessions.IssuedSession,
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

/**
 * MNA-001, one call: resolves the delivery mode, and only then runs `mint`, then delivers what it
 * issued. An unknown `X-Awthaq-Token-Delivery` value fails `InvalidTokenDelivery` before `mint` runs,
 * so nothing was minted for a request that is refused. Plan 21 phase 2 keeps this arity for the plugins
 * not yet declared; phase 4 removes it.
 */
const respondToRequest = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  mint: Effect.Effect<Sessions.IssuedSession, E, R>,
) =>
  Effect.gen(function* () {
    const deliveryMode = yield* mode(request);
    const issued = yield* mint;
    return yield* deliver(deliveryMode, issued);
  });

// ---- ADR-EA-045: delivery over the grant a declared endpoint's marker provides ---------------------------

/** A bearer delivery always names the token in `set-auth-token` too, so a client follows every mint from headers. */
const bearerHeader = (token: Redacted.Redacted<string>) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeader(response, Api.ROTATED_TOKEN_HEADER, Redacted.value(token)),
    ),
  );

const deliverWith = Effect.fnUntraced(function* (
  grant: SessionLifecycle.GrantShape,
  issued: Sessions.IssuedSession,
) {
  const dto = toSessionDto(issued.session);
  if (grant.delivery === "cookie") {
    yield* SessionCookie.set(issued.session, issued.token);
    yield* grant.settle("delivered");
    return dto;
  }
  yield* bearerHeader(issued.token);
  yield* grant.settle("delivered");
  return new SessionContract.SessionDto({ ...dto, token: Redacted.value(issued.token) });
});

/** `Mints`/`Rotates`: runs `mint` and delivers what it issued the way the request asked (resolved by the marker). */
const respondGranted = <E, R>(mint: Effect.Effect<Sessions.IssuedSession, E, R>) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.MintGrant;
    const issued = yield* mint;
    return yield* deliverWith(grant, issued);
  });

/**
 * The result is the response DTO; a handler types its local as `SessionContract.SessionDto` (TS2883) when it
 * returns it. `respond(mint)` needs the `MintGrant` of a `Mints`/`Rotates` endpoint.
 */
export function respond<E, R>(
  mint: Effect.Effect<Sessions.IssuedSession, E, R>,
): ReturnType<typeof respondGranted<E, R>>;
export function respond<E, R>(
  request: HttpServerRequest.HttpServerRequest,
  mint: Effect.Effect<Sessions.IssuedSession, E, R>,
): ReturnType<typeof respondToRequest<E, R>>;
export function respond(
  first:
    | HttpServerRequest.HttpServerRequest
    | Effect.Effect<Sessions.IssuedSession, unknown, unknown>,
  mint?: Effect.Effect<Sessions.IssuedSession, unknown, unknown>,
) {
  if (Effect.isEffect(first)) return respondGranted(first);
  return mint === undefined
    ? Effect.die("SessionDelivery.respond: no mint")
    : respondToRequest(first, mint);
}

/** RFC 8628 / MNA-003: a device or a native exchange has no cookie jar, whatever the header said. */
export const deliverBearer = (issued: Sessions.IssuedSession) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.MintGrant;
    return yield* deliverWith({ ...grant, delivery: "bearer" }, issued);
  });

/** MNA-003: the native exchange hands back a DTO it decrypted, token included. */
export const deliverExchanged = (dto: SessionContract.SessionDto) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.MintGrant;
    if (dto.token !== undefined) yield* bearerHeader(Redacted.make(dto.token));
    yield* grant.settle("delivered");
    return dto;
  });

/** A browser navigation (OAuth callback, SAML ACS): the session cookie rides the redirect or the interstitial. */
export const redirect = (
  response: HttpServerResponse.HttpServerResponse,
  issued: Sessions.IssuedSession,
) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.MintGrant;
    const cookie = yield* SessionCookie.render(issued.session, issued.token);
    const withCookie = yield* HttpServerResponse.setCookie(
      response,
      cookie.name,
      cookie.value,
      cookie.options,
    ).pipe(Effect.orDie);
    yield* grant.settle("delivered");
    return withCookie;
  });

/**
 * `Ends` (CSS-002): the caller's own session ended. Expires the cookie (a browser), says so in
 * `x-awthaq-session-ended` (a bearer client clears its store), and drops a `set-auth-token` the verify-time
 * rotation registered for the session that just ended (registered later, so it wins).
 */
export const end = Effect.gen(function* () {
  const grant = yield* SessionLifecycle.EndGrant;
  yield* SessionCookie.expire;
  yield* HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeader(
        HttpServerResponse.removeHeader(response, Api.ROTATED_TOKEN_HEADER),
        Api.SESSION_ENDED_HEADER,
        "1",
      ),
    ),
  );
  yield* grant.settle("delivered");
});

/** `Swaps` (APS-006): the impersonation cookie shadows the admin's own. */
export const swapIn = (issued: Sessions.IssuedSession) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.SwapGrant;
    yield* SessionCookie.set(issued.session, issued.token, "impersonation");
    yield* grant.settle("delivered");
  });

/** `Swaps` (APS-006): expiring the impersonation cookie hands the browser back to the admin's own session. */
export const swapOut = Effect.gen(function* () {
  const grant = yield* SessionLifecycle.SwapGrant;
  yield* SessionCookie.expireImpersonation;
  yield* grant.settle("delivered");
});

/** This response deliberately changes nothing: a concealed sign-up, an OAuth link, another device's revoke. */
export const decline = <I>(grant: Context.Key<I, SessionLifecycle.GrantShape>) =>
  Effect.flatMap(grant, (granted) => granted.settle("declined"));
