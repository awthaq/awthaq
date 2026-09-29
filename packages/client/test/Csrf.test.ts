// spec/behaviors/22-client-effect.md, BEH-EA-170.
// spec/invariants.md, INV-EA-011.
//
// A type-level check, real against `Api.CsrfProtection` itself (declared in
// `@awthaq/api`) even though no real plugin group in this repository
// attaches it to an endpoint yet (see `AuthClient.ts`'s own header comment)
// — this small synthetic group is enough to prove the property BEH-EA-170
// actually requires: a client built over a `CsrfProtection`-middlewared
// group carries `HttpApiMiddleware.ForClient<Api.CsrfProtection>` in its own
// requirement type, and providing `CsrfClientLive` is what discharges it.
// Originally planned as `Csrf.test-d.ts`; this repository's tooling runs
// `test/**/*.test.ts` only, so the check lives here as an ordinary test
// whose real assertion is the two type aliases below, not the trivial
// runtime one.
import { Api } from "@awthaq/api";
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as AuthClient from "../src/AuthClient.ts";

const TestApi = HttpApi.make("test").add(
  HttpApiGroup.make("g").add(HttpApiEndpoint.get("x", "/x")).middleware(Api.CsrfProtection),
);

const clientEffect = AuthClient.make(TestApi, { baseUrl: "http://localhost" });
const withCsrf = clientEffect.pipe(Effect.provide(AuthClient.CsrfClientLive));

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

type CsrfMarker = HttpApiMiddleware.ForClient<Api.CsrfProtection>;

// BEH-EA-170: the client's own requirement really does carry the marker
// `Api.CsrfProtection`'s `requiredForClient: true` puts there.
type _RequiresCsrf = Expect<
  Equal<Extract<Effect.Services<typeof clientEffect>, CsrfMarker>, CsrfMarker>
>;

// Providing `CsrfClientLive` discharges exactly that requirement.
type _CsrfDischarged = Expect<Equal<Extract<Effect.Services<typeof withCsrf>, CsrfMarker>, never>>;

describe("CsrfClientLive (BEH-EA-170/INV-EA-011)", () => {
  it("a CsrfProtection-middlewared client requires the marker until CsrfClientLive is provided", () => {
    const requiresCsrf: _RequiresCsrf = true;
    const csrfDischarged: _CsrfDischarged = true;
    assert.isTrue(requiresCsrf);
    assert.isTrue(csrfDischarged);
  });
});

// ---------------------------------------------------------------------------
// CDS-007: a cold client bootstraps itself
// ---------------------------------------------------------------------------

const MutationApi = HttpApi.make("test").add(
  HttpApiGroup.make("g").add(HttpApiEndpoint.post("x", "/x")).middleware(Api.CsrfProtection),
);

const setDocumentCookie = (cookie: string | undefined): void => {
  if (cookie === undefined) Reflect.deleteProperty(globalThis, "document");
  else Reflect.set(globalThis, "document", { cookie });
};

const csrfRejected = () =>
  new Response(JSON.stringify({ _tag: "CsrfRejected" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

const noContent = () => new Response(null, { status: 204 });

/** Runs one mutation through `layer` against a scripted server; returns the exit and every request seen. */
const run = async (
  layer: Layer.Layer<HttpApiMiddleware.ForClient<Api.CsrfProtection>>,
  respond: (request: HttpClientRequest.HttpClientRequest, attempt: number) => Response,
) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request);
        return HttpClientResponse.fromWeb(request, respond(request, requests.length));
      }),
    ),
  );
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const client = yield* AuthClient.make(MutationApi, { baseUrl: "http://localhost" });
      return yield* client.g.x();
    }).pipe(Effect.provide(Layer.merge(layer, transport))),
  );
  return { exit, requests };
};

describe("CsrfClientLive cold-start bootstrap (CDS-007)", () => {
  afterEach(() => setDocumentCookie(undefined));

  it("sends no x-csrf-token header when no cookie is readable (never an empty string)", async () => {
    setDocumentCookie("other=1");
    const { exit, requests } = await run(AuthClient.CsrfClientLive, noContent);
    assert.isTrue(Exit.isSuccess(exit));
    assert.strictEqual(requests.length, 1);
    assert.isUndefined(requests[0]?.headers[Api.CSRF_HEADER_NAME]);
  });

  it("attaches the cookie value when one is present", async () => {
    setDocumentCookie(`${Api.CSRF_COOKIE_NAME}=token-1`);
    const { requests } = await run(AuthClient.CsrfClientLive, noContent);
    assert.strictEqual(requests[0]?.headers[Api.CSRF_HEADER_NAME], "token-1");
  });

  it("a cold first call 403s, the cookie lands, and it is retried once and succeeds", async () => {
    setDocumentCookie(undefined);
    const { exit, requests } = await run(AuthClient.CsrfClientLive, (_request, attempt) => {
      if (attempt === 1) {
        // The server's pre-response handler minted the cookie on the 403 itself.
        setDocumentCookie(`${Api.CSRF_COOKIE_NAME}=fresh`);
        return csrfRejected();
      }
      return noContent();
    });
    assert.isTrue(Exit.isSuccess(exit));
    assert.strictEqual(requests.length, 2);
    assert.isUndefined(requests[0]?.headers[Api.CSRF_HEADER_NAME]);
    assert.strictEqual(requests[1]?.headers[Api.CSRF_HEADER_NAME], "fresh");
  });

  it("a second 403 is surfaced as CsrfRejected, never retried again", async () => {
    setDocumentCookie(undefined);
    const { exit, requests } = await run(AuthClient.CsrfClientLive, (_request, attempt) => {
      if (attempt === 1) setDocumentCookie(`${Api.CSRF_COOKIE_NAME}=fresh`);
      return csrfRejected();
    });
    assert.isTrue(Exit.isFailure(exit));
    assert.strictEqual(requests.length, 2);
  });

  it("a 403 with the same cookie as was sent is a genuine rejection: no retry", async () => {
    setDocumentCookie(`${Api.CSRF_COOKIE_NAME}=stale`);
    const { exit, requests } = await run(AuthClient.CsrfClientLive, csrfRejected);
    assert.isTrue(Exit.isFailure(exit));
    assert.strictEqual(requests.length, 1);
  });

  it("bootstrapRetry: false disables the retry", async () => {
    setDocumentCookie(undefined);
    const { exit, requests } = await run(
      AuthClient.csrfClientLayer({ bootstrapRetry: false }),
      (_request, attempt) => {
        if (attempt === 1) setDocumentCookie(`${Api.CSRF_COOKIE_NAME}=fresh`);
        return csrfRejected();
      },
    );
    assert.isTrue(Exit.isFailure(exit));
    assert.strictEqual(requests.length, 1);
  });

  it("csrfClientLayer takes any cookie reader, so a server-side caller can read its request's Cookie header", async () => {
    const { requests } = await run(
      AuthClient.csrfClientLayer({ readCookie: () => "from-header" }),
      noContent,
    );
    assert.strictEqual(requests[0]?.headers[Api.CSRF_HEADER_NAME], "from-header");
  });
});
