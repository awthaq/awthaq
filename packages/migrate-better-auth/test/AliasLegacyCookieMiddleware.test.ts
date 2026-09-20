// BAM-003 (.issues/high): proves the middleware rewrites the ambient
// request's cookie header only when `__Host-session` is absent and the
// configured legacy cookie is present — never overwriting an already-live
// awthaq session, never inventing a cookie that wasn't there.
import { Sessions } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as AliasLegacyCookieMiddleware from "../src/AliasLegacyCookieMiddleware.ts";

const requestWithCookie = (cookie: string | undefined): HttpServerRequest.HttpServerRequest =>
  HttpServerRequest.fromWeb(
    new Request("http://localhost/", cookie === undefined ? {} : { headers: { cookie } }),
  );

const seenThroughMiddleware = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<HttpServerRequest.HttpServerRequest | undefined>(undefined);
    const app = Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      yield* Ref.set(seen, req);
      return HttpServerResponse.empty();
    }).pipe(
      AliasLegacyCookieMiddleware.make({ legacyCookieName: "better-auth.session_token" }),
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    yield* app;
    return yield* Ref.get(seen);
  });

describe("AliasLegacyCookieMiddleware", () => {
  it.effect("aliases the legacy cookie to __Host-session when the primary cookie is absent", () =>
    Effect.gen(function* () {
      const seen = yield* seenThroughMiddleware(
        requestWithCookie("better-auth.session_token=legacy-value"),
      );
      assert.strictEqual(seen?.cookies[Sessions.SESSION_COOKIE_NAME], "legacy-value");
    }),
  );

  it.effect(
    "leaves the request's cookie header byte-for-byte untouched when the primary cookie is already present",
    () =>
      Effect.gen(function* () {
        const original = requestWithCookie(
          `${Sessions.SESSION_COOKIE_NAME}=real-value; better-auth.session_token=legacy-value`,
        );
        const seen = yield* seenThroughMiddleware(original);
        assert.strictEqual(seen?.headers.cookie, original.headers.cookie);
        assert.strictEqual(seen?.cookies[Sessions.SESSION_COOKIE_NAME], "real-value");
      }),
  );

  it.effect(
    "leaves the request's cookie header byte-for-byte untouched when neither cookie is present",
    () =>
      Effect.gen(function* () {
        const original = requestWithCookie(undefined);
        const seen = yield* seenThroughMiddleware(original);
        assert.strictEqual(seen?.headers.cookie, original.headers.cookie);
        assert.isUndefined(seen?.cookies[Sessions.SESSION_COOKIE_NAME]);
      }),
  );
});
