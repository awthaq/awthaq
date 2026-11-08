// @awthaq/server — RequestContext
//
// ADR-EA-047 (plan 26): the one capture of the facts of a request. `RequestContextLive` implements the endpoint
// middleware `Api.RequestContext`, which every awthaq group declares last (outermost); `AuthHttp.middlewareFor`
// derives it like the other host middleware, so a composition that serves awthaq's routes cannot leave it out: a
// handler or an authentication middleware that reads `Api.AuthRequestContext` without it does not compile.
//
// The correlation id is the caller's `x-request-id` when it is a sane token (<= 128 characters of
// `[A-Za-z0-9._:-]`: it lands in log lines and a database column, so it is validated, never trusted), else the trace
// id of an incoming W3C `traceparent`, else a fresh uuidv7. The address is what the `ClientAddress` port resolves (so a
// trusted-proxy deployment records the real client, not the load balancer); `ClientAddress.layerDirect` is the socket
// peer, which a web handler (`HttpRouter.toWebHandler`) never reports, so there every client shares the address
// `None`. The user agent is capped by `Api.toUserAgentHeader`. Nothing else about the request — no other header,
// cookie or body — is captured. This module is the only reader of `ClientAddress` and of `User-Agent` in awthaq.

import { Api } from "@awthaq/api";
import { Observability } from "@awthaq/core";
import { ClientAddress } from "@awthaq/ports";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Headers from "effect/http/Headers";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** The caller-supplied id, if any header carries a usable one. Pure, for testing. */
export const correlationIdFrom = (
  header: (name: string) => string | undefined,
): Option.Option<string> => {
  const requestId = header("x-request-id");
  if (requestId !== undefined && REQUEST_ID.test(requestId)) return Option.some(requestId);
  const traceId = header("traceparent")?.match(TRACEPARENT)?.[1];
  // An all-zero trace id is invalid per the W3C spec.
  return traceId === undefined || /^0+$/.test(traceId) ? Option.none() : Option.some(traceId);
};

const captureWith = (
  address: ClientAddress.ClientAddressShape,
  random: SecureRandom.SecureRandom["Service"],
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const header = (name: string) => Option.getOrUndefined(Headers.get(request.headers, name));
    const correlationId = yield* Option.match(correlationIdFrom(header), {
      onSome: Effect.succeed,
      onNone: () => Effect.orDie(random.uuidV7()),
    });
    const ip = yield* address.resolve(request);
    return Api.AuthRequestContext.request({
      correlationId,
      ip: Option.getOrUndefined(ip),
      userAgent: header("user-agent"),
    });
  });

/**
 * The facts of one request, for a host route outside awthaq's contracts that calls a plugin operation:
 * `Effect.provideService(Api.AuthRequestContext, yield* RequestContext.capture(request))`.
 */
export const capture = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const address = yield* ClientAddress.ClientAddress;
  const random = yield* SecureRandom.SecureRandom;
  return yield* captureWith(address, random, request);
});

/** ADR-EA-047: the implementation of `Api.RequestContext`. `AuthHttp.middlewareFor` derives it. */
export const RequestContextLive = Layer.effect(
  Api.RequestContext,
  Effect.gen(function* () {
    const address = yield* ClientAddress.ClientAddress;
    const random = yield* SecureRandom.SecureRandom;
    const middleware: HttpApiMiddleware.HttpApiMiddleware<Api.AuthRequestContext, never, never> = (
      httpEffect,
    ) =>
      Effect.gen(function* () {
        const facts = yield* captureWith(
          address,
          random,
          yield* HttpServerRequest.HttpServerRequest,
        );
        return yield* httpEffect.pipe(
          Effect.provideService(Api.AuthRequestContext, facts),
          Effect.annotateLogs(Observability.Field.correlationId, facts.correlationId),
        );
      });
    return middleware;
  }),
);
