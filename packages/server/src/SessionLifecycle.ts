// @awthaq/server — SessionLifecycle (ADR-EA-045, BEH-EA-343): the server half of the five markers.
//
// A declared endpoint's marker runs around its handler:
//
// 1. MNA-001: it resolves `X-Awthaq-Token-Delivery` before the handler runs, so an unknown value is a 400 that
//    mints nothing (structurally: the handler never starts). `Ends` reads no delivery; `Swaps` refuses `bearer`
//    (an impersonation session is a cookie that shadows the admin's own, APS-006).
// 2. It provides the grant (`MintGrant`, `EndGrant`, `SwapGrant`) every `SessionDelivery` function requires, so
//    a handler of an undeclared endpoint that calls `SessionDelivery` leaves the grant in its requirements and
//    the group layer does not type-check as servable.
// 3. MAPS-008: it marks the response `Cache-Control: no-store`; a declared response may carry a live secret or
//    end one.
// 4. Fail closed: a successful response that neither delivered nor declined dies `SessionLifecycleUnsettled`.
//    A typed handler error fails the handler's effect and never reaches the check: only a success must settle.

import { Api, SessionLifecycle } from "@awthaq/api";
import { Defects } from "@awthaq/core";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Headers from "effect/http/Headers";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";

/** Which deliveries a marker accepts: `either` (mints/rotates) or `cookieOnly` (swaps). */
type DeliveryRule = "either" | "cookieOnly";

/** MNA-001: resolved before the handler runs. Absent is `cookie`; `bearer` is the one other recognised value. */
const deliveryOf = (rule: DeliveryRule) => (request: HttpServerRequest.HttpServerRequest) => {
  const header = Headers.get(request.headers, Api.TOKEN_DELIVERY_HEADER);
  if (Option.isNone(header)) return Effect.succeed<SessionLifecycle.Delivery>("cookie");
  const bearer = header.value.trim().toLowerCase() === "bearer";
  return bearer && rule === "either"
    ? Effect.succeed<SessionLifecycle.Delivery>("bearer")
    : Effect.fail(new Api.InvalidTokenDelivery());
};

/** `Ends` delivers nothing, so it reads no header (and declares no 400). */
const noDelivery = () => Effect.succeed<SessionLifecycle.Delivery>("cookie");

/** MAPS-008: a declared response may carry a live secret or end one; never cacheable. */
const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
);

const declared = <I, A, E, R, DE>(
  grant: Context.Key<I, SessionLifecycle.GrantShape>,
  kind: SessionLifecycle.Kind,
  resolve: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<SessionLifecycle.Delivery, DE>,
  httpEffect: Effect.Effect<A, E, R>,
  endpoint: HttpApiEndpoint.Top,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const delivery = yield* resolve(request);
    const settled = yield* Ref.make<"open" | SessionLifecycle.Outcome>("open");
    yield* noStore;
    const response = yield* Effect.provideService(httpEffect, grant, {
      kind,
      delivery,
      settle: (outcome) => Ref.set(settled, outcome),
    });
    if ((yield* Ref.get(settled)) === "open") {
      return yield* Defects.invariantViolation(
        "SessionLifecycleUnsettled",
        `awthaq: ${endpoint.identifier} is declared "${kind}" but answered without SessionDelivery`,
      );
    }
    return response;
  });

export const MintsLive = Layer.succeed(SessionLifecycle.Mints, (httpEffect, { endpoint }) =>
  declared(SessionLifecycle.MintGrant, "mints", deliveryOf("either"), httpEffect, endpoint),
);
export const RotatesLive = Layer.succeed(SessionLifecycle.Rotates, (httpEffect, { endpoint }) =>
  declared(SessionLifecycle.MintGrant, "rotates", deliveryOf("either"), httpEffect, endpoint),
);
export const EndsLive = Layer.succeed(SessionLifecycle.Ends, (httpEffect, { endpoint }) =>
  declared(SessionLifecycle.EndGrant, "ends", noDelivery, httpEffect, endpoint),
);
export const SwapsLive = Layer.succeed(SessionLifecycle.Swaps, (httpEffect, { endpoint }) =>
  declared(SessionLifecycle.SwapGrant, "swaps", deliveryOf("cookieOnly"), httpEffect, endpoint),
);
/** `Refreshes` changes nothing on the wire: it exists so React reads one declaration for all five kinds. */
export const RefreshesLive = Layer.succeed(SessionLifecycle.Refreshes, (httpEffect) => httpEffect);

/** All five, for a composition that wires middleware by hand instead of `AuthHttp.middlewareFor`. */
export const layer = Layer.mergeAll(MintsLive, RotatesLive, EndsLive, SwapsLive, RefreshesLive);
