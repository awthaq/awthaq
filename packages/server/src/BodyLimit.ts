// @awthaq/server — BodyLimit
//
// spec/behaviors/11-http-error-mapping.md (NHS-004). Effect v4's server reads
// request bodies with no cap unless `HttpIncomingMessage.MaxBodySize` is set,
// so an unauthenticated caller could make the process buffer an arbitrarily
// large JSON body before any handler, CSRF check or rate limit ran. This is a
// global `HttpRouter` middleware that bounds every request the router serves,
// on two independent lines:
//
// 1. It provides `MaxBodySize` to the handler fiber, which the Node server's
//    body reader honors while reading, chunked bodies included. Effect's
//    reader destroys the socket the moment the cap is crossed, so an oversize
//    chunked upload ends in a dropped connection, not a 413 response (there is
//    no socket left to write one to).
// 2. It refuses a request whose declared `content-length` already exceeds the
//    cap with a 413 `PayloadTooLarge`, before the handler runs and before a
//    byte of the body is read. This is what holds on `toWebHandler` (the
//    Fetch-native serving path, BEH-EA-085), where the runtime's own body
//    reader does not consult `MaxBodySize`; a chunked body with no
//    `content-length` on that path is bounded only by the host's own limits.
//
// The 413 body uses the same `{ _tag, message }` shape the typed API errors
// serialize to, so a client's error decoding treats it uniformly.

import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export interface BodyLimitConfigShape {
  /** The largest request body the server will read. */
  readonly maxBytes: ByteSize.ByteSize;
}

const defaultBodyLimitConfig: BodyLimitConfigShape = {
  maxBytes: ByteSize.kibibytes(256),
};

/** ADR-EA-011's `Context.Reference`-with-default config: 256 KiB unless a deployment overrides it with `config`. */
export const BodyLimitConfig = Context.Reference("awthaq/server/BodyLimitConfig", {
  defaultValue: () => defaultBodyLimitConfig,
});

export const config = (partial: Partial<BodyLimitConfigShape>) =>
  Layer.succeed(BodyLimitConfig, { ...defaultBodyLimitConfig, ...partial });

const payloadTooLarge = (maxBytes: number) =>
  HttpServerResponse.jsonUnsafe(
    { _tag: "PayloadTooLarge", message: `awthaq: request body exceeds ${maxBytes} bytes` },
    { status: 413 },
  );

/**
 * NHS-004: the global body-size middleware. Merge it into the same layer list
 * as `AuthHttp.routes(...)`; it needs only the ambient `HttpRouter`.
 */
export const layer = HttpRouter.middleware(
  Effect.gen(function* () {
    const { maxBytes } = yield* BodyLimitConfig;
    const limit = ByteSize.toNumberUnsafe(maxBytes);
    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const declared = Number(request.headers["content-length"]);
        if (declared > limit) return payloadTooLarge(limit);
        return yield* app;
      }).pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBytes));
  }),
  { global: true },
);
