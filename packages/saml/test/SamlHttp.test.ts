// BEH-EA-238 through 245 over real HTTP, through `HttpRouter.toWebHandler`: the login redirect and its
// `__Host-saml-request` cookie (SameSite=None: the IdP's POST is cross-site), the ACS form post that answers 302 with
// a session cookie, the metadata document, and the uniform 400 for everything the chain refuses.
import { AuthHttp } from "@awthaq/server";
import { Auth } from "@awthaq/core";
import { Organization } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { inflateRawSync } from "node:zlib";
import * as Saml from "../src/Saml.ts";
import * as SamlApi from "../src/SamlApi.ts";
import * as SamlConnections from "../src/SamlConnections.ts";
import { ACS_URL, ALGORITHM, attacker, responseXml, signedResponse, SP_ENTITY_ID_PREFIX } from "./samlFixtures.ts";
import { BASE_URL, IDP_ENTITY_ID, SamlLive, seedConnection } from "./support.ts";

/** A web handler runs on the real clock, so assertion times bracket the real "now" instead of the fixtures' fixed one. */
const around = () => ({
  notBefore: new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z"),
  notOnOrAfter: new Date(Date.now() + 300_000).toISOString().replace(/\.\d+Z$/, "Z"),
});

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const buildApp = () => {
  const Live = SamlLive();
  const AppLayer = AuthHttp.routes(SamlApi.SamlApi).pipe(
    Layer.provide(Live),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });
  /** Runs `effect` against the very same service instances the web handler uses. */
  const inside = <A, E>(
    effect: Effect.Effect<A, E, Saml.Saml | SamlConnections.SamlConnectionStore | Organization.Organization>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(Live, memoMap, scope);
          return yield* effect.pipe(Effect.provide(context));
        }),
      ),
    );
  return { handler, inside };
};

const acsForm = (response: string, cookie?: string) =>
  new Request(ACS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams({ SAMLResponse: response, RelayState: "ignored" }).toString(),
  });

const cookieHeaderOf = (response: Response, name: string): string | undefined =>
  response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));

describe("SAML over HTTP", () => {
  it.effect("login redirects to the IdP with the AuthnRequest and sets the SameSite=None request cookie", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { connection } = yield* Effect.promise(() => inside(seedConnection()));
      const response = yield* Effect.promise(() =>
        handler(new Request(`${BASE_URL}/auth/saml/login?connection=${connection.id}&callbackURL=/dashboard`)),
      );
      assert.strictEqual(response.status, 302);
      assert.strictEqual(response.headers.get("referrer-policy"), "no-referrer");
      const location = new URL(response.headers.get("location") ?? "");
      assert.strictEqual(`${location.origin}${location.pathname}`, "https://idp.example.com/sso");
      const request = inflateRawSync(Buffer.from(location.searchParams.get("SAMLRequest") ?? "", "base64")).toString("utf8");
      assert.include(request, `AssertionConsumerServiceURL="${ACS_URL}"`);
      const cookie = cookieHeaderOf(response, Saml.REQUEST_COOKIE);
      assert.isDefined(cookie);
      assert.include(cookie ?? "", "HttpOnly");
      assert.include(cookie ?? "", "Secure");
      assert.include(cookie ?? "", "SameSite=None");
      assert.include(cookie ?? "", "Path=/");
      assert.notInclude(cookie ?? "", "Domain=");
    }),
  );

  it.effect("login for an unknown connection is 404, and the metadata document is served as SAML metadata", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { connection } = yield* Effect.promise(() => inside(seedConnection()));
      const missing = yield* Effect.promise(() => handler(new Request(`${BASE_URL}/auth/saml/login?connection=nope`)));
      assert.strictEqual(missing.status, 404);
      const metadata = yield* Effect.promise(() => handler(new Request(`${BASE_URL}/auth/saml/metadata?connection=${connection.id}`)));
      assert.strictEqual(metadata.status, 200);
      assert.include(metadata.headers.get("content-type") ?? "", "application/samlmetadata+xml");
      const xml = yield* Effect.promise(() => metadata.text());
      assert.include(xml, `entityID="${SP_ENTITY_ID_PREFIX}${connection.id}"`);
      assert.include(xml, ACS_URL);
    }),
  );

  it.effect("the ACS form post signs the browser in: 302 to the callback with a session cookie and the request cookie cleared", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { connection } = yield* Effect.promise(() => inside(seedConnection()));
      const login = yield* Effect.promise(() =>
        handler(new Request(`${BASE_URL}/auth/saml/login?connection=${connection.id}&callbackURL=/dashboard`)),
      );
      const state = (cookieHeaderOf(login, Saml.REQUEST_COOKIE) ?? "").split(";")[0]?.slice(Saml.REQUEST_COOKIE.length + 1) ?? "";
      const location = new URL(login.headers.get("location") ?? "");
      const requestId = /ID="([^"]+)"/.exec(
        inflateRawSync(Buffer.from(location.searchParams.get("SAMLRequest") ?? "", "base64")).toString("utf8"),
      )?.[1];
      const samlResponse = Buffer.from(
        signedResponse(
          responseXml({
            inResponseTo: requestId ?? "",
            audience: `${SP_ENTITY_ID_PREFIX}${connection.id}`,
            issuer: IDP_ENTITY_ID,
            ...around(),
          }),
        ),
      ).toString("base64");
      const response = yield* Effect.promise(() => handler(acsForm(samlResponse, `${Saml.REQUEST_COOKIE}=${state}`)));
      assert.strictEqual(response.status, 302);
      assert.strictEqual(response.headers.get("location"), "/dashboard");
      assert.isDefined(cookieHeaderOf(response, "__Host-session"));
      // Single-use: the request cookie is cleared on the way out.
      assert.include(cookieHeaderOf(response, Saml.REQUEST_COOKIE) ?? "", "Max-Age=0");
    }),
  );

  it.effect("every refusal is the same 400 SamlAssertionRejected with no detail, and sets no session cookie", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { connection } = yield* Effect.promise(() => inside(seedConnection()));
      const login = yield* Effect.promise(() =>
        handler(new Request(`${BASE_URL}/auth/saml/login?connection=${connection.id}`)),
      );
      const state = (cookieHeaderOf(login, Saml.REQUEST_COOKIE) ?? "").split(";")[0]?.slice(Saml.REQUEST_COOKIE.length + 1) ?? "";
      const bodies: Array<string> = [];
      const attempts: ReadonlyArray<{ readonly response: string; readonly cookie: string | undefined }> = [
        { response: "AAAA", cookie: undefined }, // unsolicited
        { response: "AAAA", cookie: `${Saml.REQUEST_COOKIE}=${state}` }, // garbage under a real state (consumes it)
        {
          response: Buffer.from(
            signedResponse(responseXml({ audience: `${SP_ENTITY_ID_PREFIX}${connection.id}`, issuer: IDP_ENTITY_ID, ...around() }), {
              who: attacker,
              signatureAlgorithm: ALGORITHM.rsaSha1,
              digestAlgorithm: ALGORITHM.sha1,
            }),
          ).toString("base64"),
          cookie: `${Saml.REQUEST_COOKIE}=saml-request:x.y`,
        },
      ];
      for (const attempt of attempts) {
        const response = yield* Effect.promise(() => handler(acsForm(attempt.response, attempt.cookie)));
        assert.strictEqual(response.status, 400);
        assert.isUndefined(cookieHeaderOf(response, "__Host-session"));
        bodies.push(yield* Effect.promise(() => response.text()));
      }
      // Indistinguishable: one body, naming the error and nothing else.
      assert.strictEqual(new Set(bodies).size, 1);
      assert.deepStrictEqual(JSON.parse(bodies[0] ?? "{}"), { _tag: "SamlAssertionRejected" });
    }),
  );

  it.effect("a GET to the ACS is not a sign-in (the endpoint is POST only)", () =>
    Effect.gen(function* () {
      const { handler } = buildApp();
      const response = yield* Effect.promise(() => handler(new Request(ACS_URL)));
      assert.notStrictEqual(response.status, 200);
      assert.notStrictEqual(response.status, 302);
    }),
  );
});

describe("the plugin composes with the organization plugin", () => {
  const auth = Auth.make([Organization.Organization, Saml.Saml]);

  it("orders the organization plugin first and puts the saml group on the public API", () => {
    const ids = auth.manifest.plugins.map((plugin) => plugin.id);
    assert.isBelow(ids.indexOf("organization"), ids.indexOf("saml"));
    const saml = auth.manifest.plugins.find((plugin) => plugin.id === "saml");
    assert.deepStrictEqual(saml?.dependsOn, ["organization"]);
    assert.deepStrictEqual(saml?.tables, ["saml_connection", "saml_connection_domain"]);
    assert.include(Object.keys(auth.publicApi.groups), "saml");
  });

  it("the ACS is the one state-changing endpoint without CSRF (a cross-site POST from the IdP by design)", () => {
    // Documented, not accidental: the request cookie plus the single-consume request id bind the browser instead.
    const endpoints = Object.values(SamlApi.SamlGroup.endpoints).map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    assert.deepStrictEqual(endpoints.sort(), ["GET /auth/saml/login", "GET /auth/saml/metadata", "POST /auth/saml/acs"]);
  });
});

