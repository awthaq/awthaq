// BEH-EA-238 through 245 over real HTTP, through `HttpRouter.toWebHandler`: the login redirect and its
// `__Host-saml-request` cookie (SameSite=None: the IdP's POST is cross-site), the ACS form post that answers 302 with
// a session cookie, the metadata document, and the uniform 400 for everything the chain refuses.
import { Auth, Sessions } from "@awthaq/core";
import { RateLimiter } from "@awthaq/ports";
import { Organization } from "@awthaq/organization";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { inflateRawSync } from "node:zlib";
import { CookieAssertions, TestAuth, UserAgent } from "@awthaq/test";
import * as Saml from "../src/Saml.ts";
import * as SamlApi from "../src/SamlApi.ts";
import * as SamlConnections from "../src/SamlConnections.ts";
import {
  ACS_URL,
  ALGORITHM,
  attacker,
  responseXml,
  signedResponse,
  SP_ENTITY_ID_PREFIX,
} from "./samlFixtures.ts";
import { BASE_URL, IDP_ENTITY_ID, SamlLive, seedConnection } from "./support.ts";

/** A web handler runs on the real clock, so assertion times bracket the real "now" instead of the fixtures' fixed one. */
const around = () => ({
  notBefore: new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z"),
  notOnOrAfter: new Date(Date.now() + 300_000).toISOString().replace(/\.\d+Z$/, "Z"),
});

const buildApp = () => {
  const app = TestAuth.app(SamlLive(), { baseUrl: BASE_URL });
  /** Runs `effect` against the very same service instances the web handler uses. */
  const inside = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Saml.Saml | SamlConnections.SamlConnectionStore | Organization.Organization
    >,
  ) => app.run(effect);
  return { handler: app.handler, inside, agent: () => app.agent() };
};

const acsBody = (response: string) => ({ SAMLResponse: response, RelayState: "ignored" });

/** A hand-built ACS post: unsolicited, or carrying a forged request cookie. */
const acsForm = (response: string, cookie?: string) =>
  new Request(ACS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(acsBody(response)).toString(),
  });

/** The browser's leg back from the IdP: a cross-site form post to the ACS (the `SameSite=None` request cookie travels). */
const postToAcs = (browser: UserAgent.UserAgent, response: string) =>
  browser.request("POST", ACS_URL, {
    form: acsBody(response),
    site: "cross-site",
    navigation: true,
  });

/** The request id of the AuthnRequest a login redirect carries. */
const requestIdOf = (login: Response) =>
  /ID="([^"]+)"/.exec(
    inflateRawSync(
      Buffer.from(
        new URL(login.headers.get("location") ?? "").searchParams.get("SAMLRequest") ?? "",
        "base64",
      ),
    ).toString("utf8"),
  )?.[1];

const hasSetCookie = (response: Response, name: string) =>
  CookieAssertions.setCookiesOf(response).some((cookie) => cookie.name === name);

describe("SAML over HTTP", () => {
  it.effect(
    "login redirects to the IdP with the AuthnRequest and sets the SameSite=None request cookie",
    () =>
      Effect.gen(function* () {
        const { handler, inside } = buildApp();
        const { connection } = yield* Effect.promise(() => inside(seedConnection()));
        const response = yield* Effect.promise(() =>
          handler(
            new Request(
              `${BASE_URL}/auth/saml/login?connection=${connection.id}&callbackURL=/dashboard`,
            ),
          ),
        );
        assert.strictEqual(response.status, 302);
        assert.strictEqual(response.headers.get("referrer-policy"), "no-referrer");
        const location = new URL(response.headers.get("location") ?? "");
        assert.strictEqual(`${location.origin}${location.pathname}`, "https://idp.example.com/sso");
        const request = inflateRawSync(
          Buffer.from(location.searchParams.get("SAMLRequest") ?? "", "base64"),
        ).toString("utf8");
        assert.include(request, `AssertionConsumerServiceURL="${ACS_URL}"`);
        const cookie = CookieAssertions.findSetCookie(response, Saml.REQUEST_COOKIE);
        assert.isTrue(cookie.httpOnly);
        assert.isTrue(cookie.secure);
        assert.strictEqual(cookie.sameSite, "none");
        assert.strictEqual(cookie.path, "/");
        assert.isUndefined(cookie.domain);
      }),
  );

  it.effect(
    "login for an unknown connection is 404, and the metadata document is served as SAML metadata",
    () =>
      Effect.gen(function* () {
        const { handler, inside } = buildApp();
        const { connection } = yield* Effect.promise(() => inside(seedConnection()));
        const missing = yield* Effect.promise(() =>
          handler(new Request(`${BASE_URL}/auth/saml/login?connection=nope`)),
        );
        assert.strictEqual(missing.status, 404);
        const metadata = yield* Effect.promise(() =>
          handler(new Request(`${BASE_URL}/auth/saml/metadata?connection=${connection.id}`)),
        );
        assert.strictEqual(metadata.status, 200);
        assert.include(metadata.headers.get("content-type") ?? "", "application/samlmetadata+xml");
        const xml = yield* Effect.promise(() => metadata.text());
        assert.include(xml, `entityID="${SP_ENTITY_ID_PREFIX}${connection.id}"`);
        assert.include(xml, ACS_URL);
      }),
  );

  // ADR-EA-047 (plan 26 ticket 16): the wiring probe. SAML reads no address and no header; the ACS session records
  // the request context's facts, and the per-source login rule counts per request address.
  it.effect(
    "ADR-EA-047: the ACS session records the request's address and user agent; login counts per address",
    () =>
      Effect.gen(function* () {
        const appAt = (clientAddress: string) =>
          TestAuth.app(
            SamlLive(
              { rateLimits: { login: { limit: 2, window: Duration.minutes(1) } } },
              RateLimiter.layerMemory,
              undefined,
              undefined,
              Layer.empty,
              clientAddress,
            ),
            { baseUrl: BASE_URL },
          );
        const app = appAt("198.51.100.16");
        const { connection } = yield* Effect.promise(() => app.run(seedConnection()));
        const browser = yield* Effect.promise(() => app.agent());
        const login = yield* Effect.promise(() =>
          browser.request("GET", `/auth/saml/login?connection=${connection.id}`),
        );
        const samlResponse = Buffer.from(
          signedResponse(
            responseXml({
              inResponseTo: requestIdOf(login) ?? "",
              audience: `${SP_ENTITY_ID_PREFIX}${connection.id}`,
              issuer: IDP_ENTITY_ID,
              ...around(),
            }),
          ),
        ).toString("base64");
        const landed = yield* Effect.promise(() =>
          browser.request("POST", ACS_URL, {
            form: acsBody(samlResponse),
            site: "cross-site",
            navigation: true,
            headers: { "user-agent": "SamlProbe/1" },
          }),
        );
        assert.strictEqual(landed.status, 302);
        const token = browser.cookies.get("__Host-session")?.value ?? "";
        const verified = yield* Effect.promise(() =>
          app.run(
            Effect.flatMap(Effect.service(Sessions.Sessions), (sessions) =>
              sessions.verify(Redacted.make(token)),
            ),
          ),
        );
        assert.deepStrictEqual(verified.session.ipAddress, Option.some("198.51.100.16"));
        assert.deepStrictEqual(verified.session.userAgent, Option.some("SamlProbe/1"));
        // `login` tuned to 2 per minute: the flow spent one, the next is admitted, the third refused.
        const loginStatus = (target: typeof app) =>
          Effect.promise(() =>
            target.request("GET", `/auth/saml/login?connection=${connection.id}`),
          ).pipe(Effect.map((response) => response.status));
        assert.strictEqual(yield* loginStatus(app), 302);
        assert.strictEqual(yield* loginStatus(app), 429);
        yield* Effect.promise(() => app.dispose());
      }),
  );

  it.effect(
    "the ACS form post signs the browser in: 302 to the callback with a session cookie and the request cookie cleared",
    () =>
      Effect.gen(function* () {
        const { inside, agent } = buildApp();
        const { connection } = yield* Effect.promise(() => inside(seedConnection()));
        const browser = yield* Effect.promise(agent);
        const login = yield* Effect.promise(() =>
          browser.request(
            "GET",
            `/auth/saml/login?connection=${connection.id}&callbackURL=/dashboard`,
          ),
        );
        const requestId = requestIdOf(login);
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
        const response = yield* Effect.promise(() => postToAcs(browser, samlResponse));
        assert.strictEqual(response.status, 302);
        assert.strictEqual(response.headers.get("location"), "/dashboard");
        assert.isTrue(hasSetCookie(response, "__Host-session"));
        assert.isDefined(browser.cookies.get("__Host-session"));
        // Single-use: the request cookie is cleared on the way out.
        CookieAssertions.assertExpiredCookie(
          CookieAssertions.findSetCookie(response, Saml.REQUEST_COOKIE),
        );
        assert.isUndefined(browser.cookies.get(Saml.REQUEST_COOKIE));
      }),
  );

  it.effect(
    "every refusal is the same 400 SamlAssertionRejected with no detail, and sets no session cookie",
    () =>
      Effect.gen(function* () {
        const { handler, inside, agent } = buildApp();
        const { connection } = yield* Effect.promise(() => inside(seedConnection()));
        const browser = yield* Effect.promise(agent);
        yield* Effect.promise(() =>
          browser.request("GET", `/auth/saml/login?connection=${connection.id}`),
        );
        const bodies: Array<string> = [];
        const attempts: ReadonlyArray<() => Promise<Response>> = [
          () => handler(acsForm("AAAA")), // unsolicited
          () => postToAcs(browser, "AAAA"), // garbage under a real state (consumes it)
          () =>
            handler(
              acsForm(
                Buffer.from(
                  signedResponse(
                    responseXml({
                      audience: `${SP_ENTITY_ID_PREFIX}${connection.id}`,
                      issuer: IDP_ENTITY_ID,
                      ...around(),
                    }),
                    {
                      who: attacker,
                      signatureAlgorithm: ALGORITHM.rsaSha1,
                      digestAlgorithm: ALGORITHM.sha1,
                    },
                  ),
                ).toString("base64"),
                `${Saml.REQUEST_COOKIE}=saml-request:x.y`, // a forged request cookie
              ),
            ),
        ];
        for (const attempt of attempts) {
          const response = yield* Effect.promise(attempt);
          assert.strictEqual(response.status, 400);
          assert.isFalse(hasSetCookie(response, "__Host-session"));
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
    assert.deepStrictEqual(saml?.tables, [
      "saml_connection",
      "saml_connection_domain",
      "saml_sp_key",
      "saml_session",
    ]);
    assert.include(Object.keys(auth.publicApi.groups), "saml");
  });

  it("the ACS and the logout endpoint are the only state-changing endpoints without CSRF (cross-site POSTs from the IdP by design)", () => {
    // Documented, not accidental: the request cookie plus the single-consume request id bind the browser at the ACS; the logout
    // endpoint takes only signed messages (an unsigned one is refused), and the user's own logout is in the CSRF-protected group.
    const endpoints = Object.values(SamlApi.SamlGroup.endpoints).map(
      (endpoint) => `${endpoint.method} ${endpoint.path}`,
    );
    assert.deepStrictEqual(endpoints.sort(), [
      "GET /auth/saml/login",
      "GET /auth/saml/metadata",
      "GET /auth/saml/slo/:connection",
      "POST /auth/saml/acs",
      "POST /auth/saml/slo/:connection",
    ]);
    assert.include(Object.keys(auth.publicApi.groups), "saml.account");
    assert.include(Object.keys(auth.adminApi.groups), "saml.admin");
    assert.notInclude(Object.keys(auth.publicApi.groups), "saml.admin");
  });
});
