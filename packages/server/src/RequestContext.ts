// @awthaq/server — RequestContext
//
// ALF-006 (.issues/medium): populates `@awthaq/core`'s `AuthRequestContext` once
// per request, so every `AuthEvents.publish` a request causes — and every
// `AuditLog` row it lands in — carries the same `correlationId`, the client
// address and the user agent. A global `HttpRouter` middleware, like
// `BodyLimit.layer`: merge it into the same layer list as `AuthHttp.routes(...)`.
//
// The correlation id is the caller's `x-request-id` when it is a sane token
// (<= 128 characters of `[A-Za-z0-9._:-]`: it lands in log lines and a database
// column, so it is validated, never trusted), else the trace id of an incoming
// W3C `traceparent`, else a fresh uuidv7. The address is what the `ClientAddress`
// port resolves (so a trusted-proxy deployment records the real client, not the
// load balancer); without that port it is the socket peer. Nothing else about the
// request — no header, cookie or body — is captured.

import { AuthRequestContext, Observability } from "@awthaq/core";
import { ClientAddress } from "@awthaq/ports";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

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

/** ALF-006: the global request-context middleware. */
export const layer = HttpRouter.middleware(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const address = yield* Effect.serviceOption(ClientAddress.ClientAddress);
    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const header = (name: string) => Option.getOrUndefined(Headers.get(request.headers, name));
        const correlationId = yield* Option.match(correlationIdFrom(header), {
          onSome: Effect.succeed,
          onNone: () => Effect.orDie(crypto.randomUUIDv7),
        });
        const ip = yield* Option.match(address, {
          onNone: () => Effect.succeed(request.remoteAddress),
          onSome: (port) => port.resolve(request),
        });
        return yield* app.pipe(
          Effect.provideService(AuthRequestContext.AuthRequestContext, {
            correlationId: Option.some(correlationId),
            ip,
            userAgent: Option.fromNullishOr(header("user-agent")),
          }),
          Effect.annotateLogs(Observability.Field.correlationId, correlationId),
        );
      });
  }),
  { global: true },
);
