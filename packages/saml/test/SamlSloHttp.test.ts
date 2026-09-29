// BEH-EA-306 over real HTTP: the logout endpoint (`GET`/`POST /auth/saml/slo/:connection`) reads the RAW query the IdP sent and
// answers with a redirect or a form; the signed-in user's own logout (`POST /auth/saml/logout`, authenticated and CSRF-protected)
// expires the session cookie and sends the browser to the IdP with a `__Host-saml-logout` cookie (`SameSite=None`); and the admin
// group is 401 unauthenticated, 403 while the gate is unconfigured, and typed errors past it.
import { Api } from "@awthaq/api";
import { Sessions, Users } from "@awthaq/core";
import { AuthHttp } from "@awthaq/server";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { inflateRawSync } from "node:zlib";
import * as Saml from "../src/Saml.ts";
import * as SamlApi from "../src/SamlApi.ts";
import * as SamlConnections from "../src/SamlConnections.ts";
import * as SamlKeys from "../src/SamlKeys.ts";
import * as SamlProtocol from "../src/SamlProtocol.ts";
import { idp, NS, responseXml, signedResponse, SP_ENTITY_ID_PREFIX } from "./samlFixtures.ts";
import { redirectParts } from "./samlMetadata.ts";
import { BASE_URL, IDP_ENTITY_ID, SamlLive, seedConnection } from "./support.ts";
import { Organization } from "@awthaq/organization";

const CSRF_SECRET = "saml-test-csrf-secret-padded-to-thirty-two-bytes-long";
const CSRF_VALUE: string = (() => {
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", CSRF_SECRET).update(signed).digest("hex")}`;
})();

const IDP_SLO = "https://idp.example.com/slo";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const around = () => ({
  notBefore: new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z"),
  notOnOrAfter: new Date(Date.now() + 300_000).toISOString().replace(/\.\d+Z$/, "Z"),
});

const buildApp = (config: Parameters<typeof SamlLive>[0] = {}) => {
  const Live = SamlLive(config);
  const AppLayer = AuthHttp.routes(SamlApi.SamlApi).pipe(
    Layer.provide(Live),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });
  const inside = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | Saml.Saml
      | SamlConnections.SamlConnectionStore
      | Organization.Organization
      | Sessions.Sessions
      | Users.Users
    >,
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

const cookieHeaderOf = (response: Response, name: string): string | undefined =>
  response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));

/** Signs a user in through the ACS over HTTP and returns the session cookie the browser now holds. */
const signInOverHttp = (
  handler: (request: Request) => Promise<Response>,
  connectionId: string,
  assertionId: string,
) =>
  Effect.gen(function* () {
    const login = yield* Effect.promise(() =>
      handler(new Request(`${BASE_URL}/auth/saml/login?connection=${connectionId}`)),
    );
    const state =
      (cookieHeaderOf(login, Saml.REQUEST_COOKIE) ?? "")
        .split(";")[0]
        ?.slice(Saml.REQUEST_COOKIE.length + 1) ?? "";
    const location = new URL(login.headers.get("location") ?? "");
    const requestId = /ID="([^"]+)"/.exec(
      inflateRawSync(
        Buffer.from(location.searchParams.get("SAMLRequest") ?? "", "base64"),
      ).toString("utf8"),
    )?.[1];
    const samlResponse = Buffer.from(
      signedResponse(
        responseXml({
          inResponseTo: requestId ?? "",
          assertionId,
          audience: `${SP_ENTITY_ID_PREFIX}${connectionId}`,
          issuer: IDP_ENTITY_ID,
          ...around(),
        }),
        { assertionId },
      ),
    ).toString("base64");
    const response = yield* Effect.promise(() =>
      handler(
        new Request(`${BASE_URL}/auth/saml/acs`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${Saml.REQUEST_COOKIE}=${state}`,
          },
          body: new URLSearchParams({ SAMLResponse: samlResponse }).toString(),
        }),
      ),
    );
    const session = cookieHeaderOf(response, "__Host-session")?.split(";")[0] ?? "";
    return session;
  });

/** Is the session behind `cookie` (`__Host-session=<token>`) still valid, judged against the very services the handler uses? */
const sessionAlive = (inside: ReturnType<typeof buildApp>["inside"], cookie: string) =>
  inside(
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const token = decodeURIComponent(cookie.slice("__Host-session=".length));
      return yield* sessions.verify(Redacted.make(token)).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
    }),
  );

const logoutRequest = (connectionId: string, id: string) =>
  `<samlp:LogoutRequest xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${id}" Version="2.0" ` +
  `IssueInstant="${new Date().toISOString().replace(/\.\d+Z$/, "Z")}" Destination="${BASE_URL}/auth/saml/slo/${connectionId}">` +
  `<saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>` +
  `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">ada@acme.example</saml:NameID></samlp:LogoutRequest>`;

describe("the logout endpoint over HTTP", () => {
  it.effect(
    "GET with the IdP's signed redirect ends the session and answers 302 to the IdP with a signed LogoutResponse",
    () =>
      Effect.gen(function* () {
        const { handler, inside } = buildApp();
        const { connection } = yield* Effect.promise(() =>
          inside(seedConnection({ sloUrl: IDP_SLO, authnRequestsSigned: true })),
        );
        const session = yield* signInOverHttp(handler, connection.id, "_http-a1");
        assert.isTrue(session.startsWith("__Host-session="));
        const query = SamlKeys.signRedirect({
          kind: "SAMLRequest",
          message: SamlProtocol.deflateBase64(logoutRequest(connection.id, "_http-logout-1")),
          relayState: "state 1",
          privateKeyPem: idp.key,
        });
        const response = yield* Effect.promise(() =>
          handler(new Request(`${BASE_URL}/auth/saml/slo/${connection.id}?${query}`)),
        );
        assert.strictEqual(response.status, 302);
        assert.strictEqual(response.headers.get("referrer-policy"), "no-referrer");
        const location = response.headers.get("location") ?? "";
        assert.strictEqual(location.slice(0, location.indexOf("?")), IDP_SLO);
        assert.strictEqual(redirectParts(location).sigAlg, SamlKeys.SIG_ALG_RSA_SHA256);
        assert.strictEqual(decodeURIComponent(redirectParts(location).relay ?? ""), "state 1");
        // The logout state cookie is single-use: cleared on every response here.
        assert.include(cookieHeaderOf(response, Saml.LOGOUT_COOKIE) ?? "", "Max-Age=0");
        // The session is gone: the same cookie no longer authenticates.
        assert.isFalse(yield* Effect.promise(() => sessionAlive(inside, session)));
      }),
  );

  it.effect("GET with an unsigned or tampered message is the uniform 400, and ends nothing", () =>
    Effect.gen(function* () {
      const { handler, inside } = buildApp();
      const { connection } = yield* Effect.promise(() =>
        inside(seedConnection({ sloUrl: IDP_SLO })),
      );
      const session = yield* signInOverHttp(handler, connection.id, "_http-a2");
      const message = SamlProtocol.deflateBase64(logoutRequest(connection.id, "_http-logout-2"));
      const unsigned = SamlKeys.plainRedirect({ kind: "SAMLRequest", message });
      const signed = SamlKeys.signRedirect({
        kind: "SAMLRequest",
        message,
        privateKeyPem: idp.key,
      });
      const tampered = signed.replace(encodeURIComponent(message).slice(0, 6), "AAAAAA");
      const bodies: Array<string> = [];
      for (const query of [unsigned, tampered, ""]) {
        const response = yield* Effect.promise(() =>
          handler(new Request(`${BASE_URL}/auth/saml/slo/${connection.id}?${query}`)),
        );
        assert.strictEqual(response.status, 400);
        bodies.push(yield* Effect.promise(() => response.text()));
      }
      assert.strictEqual(new Set(bodies).size, 1);
      assert.deepStrictEqual(JSON.parse(bodies[0] ?? "{}"), { _tag: "SamlLogoutRejected" });
      assert.isTrue(yield* Effect.promise(() => sessionAlive(inside, session)));
    }),
  );

  it.effect(
    "POST with the IdP's XML-signed LogoutRequest ends the session and answers 200 with a self-submitting form (IdP takes POST)",
    () =>
      Effect.gen(function* () {
        const { handler, inside } = buildApp();
        const { connection } = yield* Effect.promise(() =>
          inside(seedConnection({ sloUrl: IDP_SLO, sloBinding: "post" })),
        );
        yield* signInOverHttp(handler, connection.id, "_http-a3");
        const signed = SamlKeys.signXml({
          xml: logoutRequest(connection.id, "_http-logout-3"),
          referenceId: "_http-logout-3",
          privateKeyPem: idp.key,
        });
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`${BASE_URL}/auth/saml/slo/${connection.id}`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                SAMLRequest: Buffer.from(signed).toString("base64"),
              }).toString(),
            }),
          ),
        );
        assert.strictEqual(response.status, 200);
        assert.include(response.headers.get("content-type") ?? "", "text/html");
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
        const html = yield* Effect.promise(() => response.text());
        assert.include(html, `action="${IDP_SLO}"`);
        assert.include(html, 'name="SAMLResponse"');
      }),
  );
});

describe("the signed-in user's own logout over HTTP", () => {
  it.effect(
    "requires authentication and the CSRF token, then expires the session cookie and sends the browser to the IdP",
    () =>
      Effect.gen(function* () {
        const { handler, inside } = buildApp();
        const { connection } = yield* Effect.promise(() =>
          inside(seedConnection({ sloUrl: IDP_SLO, authnRequestsSigned: true })),
        );
        const session = yield* signInOverHttp(handler, connection.id, "_http-a4");
        const call = (options: { readonly cookie?: string; readonly csrf?: boolean }) =>
          handler(
            new Request(`${BASE_URL}/auth/saml/logout`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                cookie: [
                  options.cookie,
                  options.csrf === false ? undefined : `${Api.CSRF_COOKIE_NAME}=${CSRF_VALUE}`,
                ]
                  .filter(Boolean)
                  .join("; "),
                ...(options.csrf === false ? {} : { "x-csrf-token": CSRF_VALUE }),
              },
              body: JSON.stringify({ callbackURL: "/bye" }),
            }),
          );
        // Unauthenticated: 401. Authenticated without the CSRF token: 403. Neither ends anything.
        assert.strictEqual((yield* Effect.promise(() => call({}))).status, 401);
        assert.strictEqual(
          (yield* Effect.promise(() => call({ cookie: session, csrf: false }))).status,
          403,
        );
        const response = yield* Effect.promise(() => call({ cookie: session }));
        assert.strictEqual(response.status, 302);
        const location = response.headers.get("location") ?? "";
        assert.strictEqual(location.slice(0, location.indexOf("?")), IDP_SLO);
        // The session cookie is expired, and the logout state cookie is set for the IdP's cross-site answer.
        assert.include(cookieHeaderOf(response, "__Host-session") ?? "", "Max-Age=0");
        const logoutCookie = cookieHeaderOf(response, Saml.LOGOUT_COOKIE) ?? "";
        assert.include(logoutCookie, "SameSite=None");
        assert.include(logoutCookie, "HttpOnly");
        assert.include(logoutCookie, "Secure");
        const message = inflateRawSync(
          Buffer.from(decodeURIComponent(redirectParts(location).message), "base64"),
        ).toString("utf8");
        assert.include(message, "<samlp:LogoutRequest");
        assert.include(message, ">ada@acme.example</saml:NameID>");
      }),
  );
});

describe("the admin group over HTTP", () => {
  const adminApp = (gate: boolean) => {
    const app = buildApp({ canManageSaml: () => Effect.succeed(gate) });
    const sessionCookie = () =>
      app.inside(
        Effect.gen(function* () {
          const sessions = yield* Sessions.Sessions;
          const issued = yield* sessions.issue({ userId: Users.UserId("admin-1"), request: {} });
          return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
        }),
      );
    const call = (
      method: string,
      path: string,
      options: { readonly cookie?: string; readonly body?: unknown; readonly csrf?: boolean } = {},
    ) =>
      app.handler(
        new Request(`${BASE_URL}${path}`, {
          method,
          headers: {
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
            cookie: [
              options.cookie,
              options.csrf === false ? undefined : `${Api.CSRF_COOKIE_NAME}=${CSRF_VALUE}`,
            ]
              .filter(Boolean)
              .join("; "),
            ...(options.csrf === false ? {} : { "x-csrf-token": CSRF_VALUE }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      );
    return { ...app, sessionCookie, call };
  };

  it.effect(
    "is 401 unauthenticated, 403 with the gate unconfigured, and 403 before the gate without the CSRF token",
    () =>
      Effect.gen(function* () {
        const closed = adminApp(false);
        const anonymous = yield* Effect.promise(() =>
          closed.call("GET", "/admin/saml/connections?organizationId=x"),
        );
        assert.strictEqual(anonymous.status, 401);
        const cookie = yield* Effect.promise(closed.sessionCookie);
        const denied = yield* Effect.promise(() =>
          closed.call("GET", "/admin/saml/connections?organizationId=x", { cookie }),
        );
        assert.strictEqual(denied.status, 403);
        assert.deepStrictEqual(JSON.parse(yield* Effect.promise(() => denied.text())), {
          _tag: "SamlActionDenied",
        });
        const noCsrf = yield* Effect.promise(() =>
          closed.call("DELETE", "/admin/saml/connections/x", { cookie, csrf: false }),
        );
        assert.strictEqual(noCsrf.status, 403);
      }),
  );

  it.effect(
    "past the gate: create returns the connection, a bad URL is a typed 422, an unknown id a 404, and delete a 204",
    () =>
      Effect.gen(function* () {
        const open = adminApp(true);
        const cookie = yield* Effect.promise(open.sessionCookie);
        const organizationId = yield* Effect.promise(() =>
          open.inside(
            Effect.gen(function* () {
              const { ownerPrincipal } = yield* Effect.promise(() => import("./support.ts"));
              const organization = yield* Organization.Organization;
              return (yield* organization.create({
                caller: ownerPrincipal,
                name: "Acme",
                slug: "acme",
              })).id;
            }),
          ),
        );
        const created = yield* Effect.promise(() =>
          open.call("POST", "/admin/saml/connections", {
            cookie,
            body: {
              organizationId,
              name: "Acme Okta",
              idp: {
                entityId: IDP_ENTITY_ID,
                ssoUrl: "https://idp.example.com/sso",
                certificates: [idp.cert],
              },
              emailDomains: ["acme.example"],
              roleMapping: {
                rules: [{ attribute: "groups", value: "admins", roles: ["admin"] }],
                ceiling: ["admin"],
              },
            },
          }),
        );
        assert.strictEqual(created.status, 200);
        const body: unknown = yield* Effect.promise(() => created.json());
        const id = typeof body === "object" && body !== null && "id" in body ? String(body.id) : "";
        assert.notStrictEqual(id, "");
        // Round trip through the read endpoints.
        const read = yield* Effect.promise(() =>
          open.call("GET", `/admin/saml/connections/${id}`, { cookie }),
        );
        assert.strictEqual(read.status, 200);
        const listed = yield* Effect.promise(() =>
          open.call("GET", `/admin/saml/connections?organizationId=${organizationId}`, { cookie }),
        );
        assert.strictEqual(listed.status, 200);
        const bad = yield* Effect.promise(() =>
          open.call("PATCH", `/admin/saml/connections/${id}`, {
            cookie,
            body: { ssoUrl: "http://insecure.example.com" },
          }),
        );
        assert.strictEqual(bad.status, 422);
        assert.strictEqual(
          JSON.parse(yield* Effect.promise(() => bad.text()))["_tag"],
          "InvalidSamlConnectionRequest",
        );
        const missing = yield* Effect.promise(() =>
          open.call("GET", "/admin/saml/connections/nope", { cookie }),
        );
        assert.strictEqual(missing.status, 404);
        const key = yield* Effect.promise(() =>
          open.call("POST", `/admin/saml/connections/${id}/signing-key`, { cookie, body: {} }),
        );
        assert.strictEqual(key.status, 200);
        const keyBody = yield* Effect.promise(() => key.text());
        assert.include(keyBody, "BEGIN CERTIFICATE");
        assert.notInclude(keyBody, "PRIVATE KEY");
        const removed = yield* Effect.promise(() =>
          open.call("DELETE", `/admin/saml/connections/${id}`, { cookie }),
        );
        assert.strictEqual(removed.status, 204);
      }),
  );
});
