// The two scope adapters of ADR-EA-042 decision 2: `httpScope` and `collecting`. One of the internal modules
// behind `../Credentials.ts`.

import { SessionCookie } from "@awthaq/core";
import { Api } from "@awthaq/api";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { resolveClaimed } from "./CredentialResolvers.ts";
import type { Rotation, Scope } from "./Resolution.ts";

// ---- the two scopes -------------------------------------------------------------------------------------

/**
 * PIL-005/NHS-007: delivers a rotated secret on whatever response the
 * request ends up with — registered as a pre-response handler by the one
 * `verify` call that rotated, so it runs for every route style (Path A's
 * middleware, Path B's `RequirePermission`) and every handler outcome,
 * including a typed-error response (a `flatMap` on the handler's success, as
 * this used to be, never sees `HandlerError`, so the rotated secret was lost
 * and the client silently logged out once `SessionConfig.rotationGrace` passed,
 * upstream-hardening ticket 01, RRS-005).
 *
 * Delivery splits by how the request authenticated: `cookie` gets the
 * `Set-Cookie` write `OAuth.ts` already uses after `issue` (a browser's jar
 * is only updated by `Set-Cookie`); `bearer` gets `Api.ROTATED_TOKEN_HEADER`,
 * the only way a raw-secret bearer client can learn its token rotated. Both
 * carry `Cache-Control: no-store` (MAPS-008) — the response holds a
 * long-lived secret. A handler that already wrote the session cookie itself
 * (a fresh sign-in's `issue`, a sign-out's expiry) wins: the rotated secret
 * belongs to a session that handler replaced or ended. An encoding failure is
 * logged and the response returned undecorated, never defected — delivery
 * must not turn a successful response into a 500 (NHS-007).
 */
const rotationDelivery =
  (rotation: Rotation): HttpEffect.PreResponseHandler =>
  (_request, response) => {
    const noStore = HttpServerResponse.setHeader(response, "cache-control", "no-store");
    if (rotation.carrier === "bearer") {
      return Effect.succeed(
        HttpServerResponse.setHeader(
          noStore,
          Api.ROTATED_TOKEN_HEADER,
          Redacted.value(rotation.token),
        ),
      );
    }
    // IC-007/BO-005: rendered through the shared `SessionCookie` config, so a
    // rotation carries the configured attributes and a `Max-Age` recomputed
    // from the session's remaining absolute lifetime.
    return SessionCookie.render(
      rotation.session,
      rotation.token,
      rotation.carrier === "impersonation" ? "impersonation" : "session",
    ).pipe(
      Effect.flatMap((cookie) =>
        Option.isSome(Cookies.get(response.cookies, cookie.name))
          ? Effect.succeed(response)
          : HttpServerResponse.setCookie(noStore, cookie.name, cookie.value, cookie.options),
      ),
      Effect.catch((error) =>
        Effect.logWarning("awthaq: could not deliver the rotated session cookie", error).pipe(
          Effect.as(response),
        ),
      ),
    );
  };

/**
 * The HTTP scope: one per request (keyed on `source`, so `request.modify` re-wraps share it — NHS-006). A claim runs
 * with the request and its request context (ADR-EA-047), which the caller read from the context it runs in.
 */
export const httpScope = (
  request: HttpServerRequest.HttpServerRequest,
  context: Api.RequestFacts | Api.NoRequest,
) =>
  ({
    key: request.source,
    // effect 4.1 keeps pre-response handlers in the request state `HttpEffect.toHandled` puts
    // in the fiber context, so the handler is registered from inside the request's fiber.
    deliver: (rotation) =>
      HttpEffect.appendPreResponseHandler(rotationDelivery(rotation)).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      ),
    claim: (carrier, credential) =>
      resolveClaimed(carrier, credential).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(Api.AuthRequestContext, context),
      ),
  }) satisfies Scope;

/** A framework call (web `getSession`): its own memo identity; rotations are collected, never written here. */
export const collecting = Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<Rotation>>([]);
  const scope = {
    key: {},
    deliver: (rotation) => Ref.update(seen, (all) => [...all, rotation]),
    // A cookie-only call presents no claimable carrier; if one ever does, it is unclaimed.
    claim: () => Effect.succeedNone,
  } satisfies Scope;
  return { scope, rotations: Ref.get(seen) };
});
