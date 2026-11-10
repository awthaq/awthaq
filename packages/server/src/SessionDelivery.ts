// @awthaq/server — SessionDelivery (MNA-001, WPS-004, ADR-EA-045)
//
// The one way a handler changes the caller's credential. Every function requires the grant a
// `SessionLifecycle` marker on the endpoint provides (`MintGrant` for `Mints`/`Rotates`, `EndGrant` for
// `Ends`, `SwapGrant` for `Swaps`), so a handler of an endpoint that did not declare the right kind leaves the
// grant in its requirements and the group layer cannot be served. Each function settles the grant; the
// marker dies when a successful response settled nothing.
//
// The marker already resolved `X-Awthaq-Token-Delivery` before the handler ran (an unknown value is a 400
// that mints nothing):
//
// - `cookie` (the default, header absent): the `Set-Cookie` write every browser client relies on.
// - `bearer`: no cookie; the raw token is the response DTO's optional `token` field AND the
//   `set-auth-token` header, so a client follows every mint from headers alone. A native app has no cookie
//   jar it can read, and a live token in a JS-readable body for a *browser* would defeat `HttpOnly`, which is
//   why bearer delivery is opt-in per request. The marker makes every declared response `no-store`.
//
// `respond(mint)` runs `mint` and delivers; `deliverBearer` (RFC 8628 device grant) and `deliverExchanged`
// (the OAuth native exchange) always deliver bearer; `land` lands a browser navigation (OAuth callback, SAML ACS: the
// same-site interstitial under a Strict cookie, a 302 otherwise); `end` expires the caller's session and says so (`x-awthaq-session-ended`);
// `swapIn`/`swapOut` move the impersonation cookie; `decline` settles a response that changes nothing.

import { Api, SessionContract, SessionLifecycle } from "@awthaq/api";
import { SessionCookie as CoreSessionCookie, type Sessions } from "@awthaq/core";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as BrowserPage from "./internal/BrowserPage.ts";
import * as SessionCookie from "./internal/SessionCookie.ts";
import { toSessionDto } from "./internal/SessionDto.ts";

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

/**
 * `Mints`/`Rotates`: runs `mint` and delivers what it issued the way the request asked (resolved by the
 * marker before the handler ran). The result is the response DTO; a handler types its local as
 * `SessionContract.SessionDto` (TS2883) when it returns it.
 */
export const respond = <E, R>(mint: Effect.Effect<Sessions.IssuedSession, E, R>) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.MintGrant;
    const issued = yield* mint;
    return yield* deliverWith(grant, issued);
  });

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

/**
 * Lands a browser return trip (OAuth callback, SAML ACS): the same-site interstitial while the session cookie is
 * `Strict` (PV-016), a `302` otherwise; the session cookie rides it. It declines `Mints` when nothing was minted
 * (an account link, a native deep link, a refused callback). `bounce: false` keeps the `302` under `Strict`.
 */
export const land = (
  location: string,
  issued: Sessions.IssuedSession | undefined,
  options?: { readonly bounce?: boolean },
) =>
  Effect.gen(function* () {
    const grant = yield* SessionLifecycle.MintGrant;
    const config = yield* CoreSessionCookie.SessionCookieConfig;
    const response =
      options?.bounce !== false && CoreSessionCookie.isStrict(config)
        ? BrowserPage.bounce(location)
        : HttpServerResponse.redirect(location);
    if (issued === undefined) {
      yield* grant.settle("declined");
      return response;
    }
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
