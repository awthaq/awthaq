// spec/behaviors/17-passkey.md, BEH-EA-129 through BEH-EA-136 (ticket 10).
// spec/behaviors/11-http-error-mapping.md, BEH-EA-083 through BEH-EA-088.
//
// The full `passkey`/`passkey.authenticate`/`passkey.credentials` groups
// exercised over a real `HttpRouter`/`HttpRouter.toWebHandler` — the
// closing proof that registration, Conditional Create, both authentication
// paths, and credential management all work together as one coherent wire
// contract, mirroring `@awthaq/password`'s own `AuthHttp.test.ts`.
// `WebAuthn` is still mocked (`Layer.mock`, BEH-EA-195) — this proves the
// wire contract, not the cryptography (ticket 02's own job).
import { Api, SessionContract } from "@awthaq/api";
import { Auth, Sessions } from "@awthaq/core";
import type { WebAuthn } from "@awthaq/ports";
import { CookieAssertions, TestAuth, type UserAgent } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyApi from "../src/PasskeyApi.ts";
import {
  ORIGIN,
  RP_ID,
  buildClientDataJSON,
  extractChallenge,
  mockWebAuthn,
} from "./passkeyTestFixtures.ts";

const buildApp = (
  webAuthn: Layer.Layer<WebAuthn.WebAuthn>,
  configOverrides?: Partial<Passkey.PasskeyConfigShape>,
) =>
  TestAuth.app(
    TestAuth.layer(Auth.make([Passkey.Passkey]), {
      services: Layer.mergeAll(
        webAuthn,
        Passkey.config({ rpId: RP_ID, origins: [ORIGIN], ...configOverrides }),
      ),
      openapiPath: "/openapi.json",
      docsPath: "/docs",
    }),
    { baseUrl: ORIGIN },
  );

/** One running app for the file: a session issued directly against its `Sessions` authenticates a request through its `handler`. */
const app = buildApp(mockWebAuthn());
const { handler } = app;

/**
 * Every group here carries `.middleware(Api.CsrfProtection)`: each request comes from an agent of the app, which
 * holds a `__Host-csrf` minted against the harness's own `CsrfConfig` and echoes it on unsafe methods, as a
 * browser's script would. `as` is a signed-in browser (`app.signIn`, a session issued directly against
 * `Sessions`: passkey registration needs one and this plugin has no sign-up), or a fresh anonymous agent.
 */
const post = async (
  as: UserAgent.UserAgent | undefined,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> =>
  (as ?? (await app.agent())).request("POST", path, {
    json: body,
    ...(headers === undefined ? {} : { headers }),
  });

describe("AuthHttp + Passkey (real HTTP)", () => {
  it.effect("BEH-EA-130: a full registration ceremony persists a credential and answers 200", () =>
    Effect.gen(function* () {
      const browser = yield* Effect.promise(() => app.signIn("register@example.com"));

      const optionsResponse = yield* Effect.promise(() =>
        post(browser, "/passkey/register/options", {}),
      );
      assert.strictEqual(optionsResponse.status, 200);
      const options = yield* Effect.promise(() => optionsResponse.json());
      const challenge = extractChallenge(options);

      const verifyResponse = yield* Effect.promise(() =>
        post(browser, "/passkey/register/verify", {
          credential: {
            id: "cred-mock-1",
            rawId: "cred-mock-1",
            type: "public-key",
            response: {
              clientDataJSON: buildClientDataJSON({
                type: "webauthn.create",
                challenge,
                origin: ORIGIN,
              }),
              attestationObject: "",
            },
          },
        }),
      );
      assert.strictEqual(verifyResponse.status, 200);
      const body = Schema.decodeUnknownSync(PasskeyApi.PasskeyCredentialDto)(
        yield* Effect.promise(() => verifyResponse.json()),
      );
      assert.strictEqual(body.id, "cred-mock-1");
    }),
  );

  it.effect("register/options is unreachable without a session cookie", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        post(undefined, "/passkey/register/options", {}),
      );
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect(
    "ticket 07: register/options/conditional is reachable only with a session cookie present",
    () =>
      Effect.gen(function* () {
        const anonymous = yield* Effect.promise(() =>
          post(undefined, "/passkey/register/options/conditional", {}),
        );
        assert.strictEqual(anonymous.status, 401);

        const browser = yield* Effect.promise(() => app.signIn("conditional@example.com"));
        const authenticated = yield* Effect.promise(() =>
          post(browser, "/passkey/register/options/conditional", {}),
        );
        assert.strictEqual(authenticated.status, 200);
      }),
  );

  it.effect(
    "BEH-EA-131: a full authentication ceremony sets a real session cookie on success",
    () =>
      Effect.gen(function* () {
        const browser = yield* Effect.promise(() => app.signIn("authuser@example.com"));

        const registerOptionsResponse = yield* Effect.promise(() =>
          post(browser, "/passkey/register/options", {}),
        );
        const registerChallenge = extractChallenge(
          yield* Effect.promise(() => registerOptionsResponse.json()),
        );
        yield* Effect.promise(() =>
          post(browser, "/passkey/register/verify", {
            credential: {
              id: "cred-mock-1",
              rawId: "cred-mock-1",
              type: "public-key",
              response: {
                clientDataJSON: buildClientDataJSON({
                  type: "webauthn.create",
                  challenge: registerChallenge,
                  origin: ORIGIN,
                }),
                attestationObject: "",
              },
            },
          }),
        );

        const authOptionsResponse = yield* Effect.promise(() =>
          post(undefined, "/passkey/authenticate/options", {}),
        );
        assert.strictEqual(authOptionsResponse.status, 200);
        const { ceremonyId, options } = Schema.decodeUnknownSync(
          PasskeyApi.AuthenticateOptionsResult,
        )(yield* Effect.promise(() => authOptionsResponse.json()));
        const authChallenge = extractChallenge(options);

        const verifyResponse = yield* Effect.promise(() =>
          post(undefined, "/passkey/authenticate/verify", {
            ceremonyId,
            credential: {
              id: "cred-mock-1",
              rawId: "cred-mock-1",
              type: "public-key",
              response: {
                clientDataJSON: buildClientDataJSON({
                  type: "webauthn.get",
                  challenge: authChallenge,
                  origin: ORIGIN,
                }),
                authenticatorData: "",
                signature: "",
              },
            },
          }),
        );
        assert.strictEqual(verifyResponse.status, 200);
        assert.strictEqual(
          CookieAssertions.findSetCookie(verifyResponse, Api.SESSION_COOKIE_NAME).name,
          Api.SESSION_COOKIE_NAME,
        );
      }),
  );

  // ADR-EA-047 (plan 26 ticket 14): the wiring probe. Passkey reads no address and no header; the session records the
  // request context's facts, and the per-source rule counts per request address.
  it.effect(
    "ADR-EA-047: a passkey sign-in records the request's address and user agent; authenticate/options counts per address",
    () =>
      Effect.gen(function* () {
        const appAt = (clientAddress: string) =>
          TestAuth.app(
            TestAuth.layer(Auth.make([Passkey.Passkey]), {
              services: Layer.mergeAll(
                mockWebAuthn(),
                Passkey.config({ rpId: RP_ID, origins: [ORIGIN] }),
              ),
              rateLimiter: "enforcing",
              clientAddress,
            }),
            { baseUrl: ORIGIN },
          );
        const probe = appAt("198.51.100.14");
        const as = async (
          agent: UserAgent.UserAgent | undefined,
          path: string,
          body: unknown,
          headers?: Record<string, string>,
        ) =>
          (agent ?? (await probe.agent())).request("POST", path, {
            json: body,
            ...(headers === undefined ? {} : { headers }),
          });
        const browser = yield* Effect.promise(() => probe.signIn("probe-passkey@example.com"));
        const registerChallenge = extractChallenge(
          yield* Effect.promise(() =>
            as(browser, "/passkey/register/options", {}).then((r) => r.json()),
          ),
        );
        yield* Effect.promise(() =>
          as(browser, "/passkey/register/verify", {
            credential: {
              id: "cred-probe",
              rawId: "cred-probe",
              type: "public-key",
              response: {
                clientDataJSON: buildClientDataJSON({
                  type: "webauthn.create",
                  challenge: registerChallenge,
                  origin: ORIGIN,
                }),
                attestationObject: "",
              },
            },
          }),
        );
        const { ceremonyId, options } = Schema.decodeUnknownSync(
          PasskeyApi.AuthenticateOptionsResult,
        )(
          yield* Effect.promise(() =>
            as(undefined, "/passkey/authenticate/options", {}).then((r) => r.json()),
          ),
        );
        const verified = yield* Effect.promise(() =>
          as(
            undefined,
            "/passkey/authenticate/verify",
            {
              ceremonyId,
              credential: {
                id: "cred-probe",
                rawId: "cred-probe",
                type: "public-key",
                response: {
                  clientDataJSON: buildClientDataJSON({
                    type: "webauthn.get",
                    challenge: extractChallenge(options),
                    origin: ORIGIN,
                  }),
                  authenticatorData: "",
                  signature: "",
                },
              },
            },
            { [Api.TOKEN_DELIVERY_HEADER]: "bearer", "user-agent": "PasskeyProbe/1" },
          ),
        );
        assert.strictEqual(verified.status, 200);
        const body = Schema.decodeUnknownSync(SessionContract.SessionDto)(
          yield* Effect.promise(() => verified.json()),
        );
        const session = yield* Effect.promise(() =>
          probe.run(
            Effect.flatMap(Effect.service(Sessions.Sessions), (sessions) =>
              sessions.verify(Redacted.make(body.token ?? "")),
            ),
          ),
        );
        assert.deepStrictEqual(session.session.ipAddress, Option.some("198.51.100.14"));
        assert.deepStrictEqual(session.session.userAgent, Option.some("PasskeyProbe/1"));

        // `authenticateOptionsByIp` is 60 per window: one options call above, 59 more, then refused; another
        // address is not.
        const options60 = () =>
          Effect.promise(() => as(undefined, "/passkey/authenticate/options", {})).pipe(
            Effect.map((response) => response.status),
          );
        for (let i = 0; i < 59; i++) assert.strictEqual(yield* options60(), 200);
        assert.strictEqual(yield* options60(), 429);
        const other = appAt("198.51.100.15");
        const elsewhere = yield* Effect.promise(() =>
          other.request("POST", "/passkey/authenticate/options", { json: {} }),
        );
        assert.strictEqual(elsewhere.status, 200);
        yield* Effect.promise(() => Promise.all([probe.dispose(), other.dispose()]));
      }),
  );

  // WPS-004/MNA-001: delivery goes through the shared `SessionDelivery`; with
  // the opt-in header the token rides the body and no cookie is set.
  it.effect(
    "WPS-004: authenticate/verify with X-Awthaq-Token-Delivery: bearer returns the token and sets no cookie",
    () =>
      Effect.gen(function* () {
        const browser = yield* Effect.promise(() => app.signIn("bearerpasskey@example.com"));
        const registerOptionsResponse = yield* Effect.promise(() =>
          post(browser, "/passkey/register/options", {}),
        );
        const registerChallenge = extractChallenge(
          yield* Effect.promise(() => registerOptionsResponse.json()),
        );
        yield* Effect.promise(() =>
          post(browser, "/passkey/register/verify", {
            credential: {
              id: "cred-mock-bearer",
              rawId: "cred-mock-bearer",
              type: "public-key",
              response: {
                clientDataJSON: buildClientDataJSON({
                  type: "webauthn.create",
                  challenge: registerChallenge,
                  origin: ORIGIN,
                }),
                attestationObject: "",
              },
            },
          }),
        );
        const authOptionsResponse = yield* Effect.promise(() =>
          post(undefined, "/passkey/authenticate/options", {}),
        );
        const { ceremonyId, options } = Schema.decodeUnknownSync(
          PasskeyApi.AuthenticateOptionsResult,
        )(yield* Effect.promise(() => authOptionsResponse.json()));
        const credential = {
          id: "cred-mock-bearer",
          rawId: "cred-mock-bearer",
          type: "public-key",
          response: {
            clientDataJSON: buildClientDataJSON({
              type: "webauthn.get",
              challenge: extractChallenge(options),
              origin: ORIGIN,
            }),
            authenticatorData: "",
            signature: "",
          },
        };
        const bad = yield* Effect.promise(() =>
          post(
            undefined,
            "/passkey/authenticate/verify",
            { ceremonyId, credential },
            { [Api.TOKEN_DELIVERY_HEADER]: "nope" },
          ),
        );
        assert.strictEqual(bad.status, 400);
        const verifyResponse = yield* Effect.promise(() =>
          post(
            undefined,
            "/passkey/authenticate/verify",
            { ceremonyId, credential },
            { [Api.TOKEN_DELIVERY_HEADER]: "bearer" },
          ),
        );
        assert.strictEqual(verifyResponse.status, 200);
        assert.isNull(verifyResponse.headers.get("set-cookie"));
        const body = Schema.decodeUnknownSync(SessionContract.SessionDto)(
          yield* Effect.promise(() => verifyResponse.json()),
        );
        assert.isString(body.token);
      }),
  );

  it.effect(
    "BEH-EA-136: an unknown credential at authenticate/verify answers 401 InvalidCredentials",
    () =>
      Effect.gen(function* () {
        const optionsResponse = yield* Effect.promise(() =>
          post(undefined, "/passkey/authenticate/options", {}),
        );
        const { ceremonyId, options } = Schema.decodeUnknownSync(
          PasskeyApi.AuthenticateOptionsResult,
        )(yield* Effect.promise(() => optionsResponse.json()));
        const response = yield* Effect.promise(() =>
          post(undefined, "/passkey/authenticate/verify", {
            ceremonyId,
            credential: {
              id: "no-such-credential",
              rawId: "no-such-credential",
              type: "public-key",
              response: {
                clientDataJSON: buildClientDataJSON({
                  type: "webauthn.get",
                  challenge: extractChallenge(options),
                  origin: ORIGIN,
                }),
                authenticatorData: "",
                signature: "",
              },
            },
          }),
        );
        assert.strictEqual(response.status, 401);
      }),
  );

  it.effect(
    "credentials list/rename/delete work over real HTTP, including last-credential refusal",
    () =>
      Effect.gen(function* () {
        const browser = yield* Effect.promise(() => app.signIn("manage@example.com"));

        // WPS-010: a credential id is globally unique, and the earlier tests in
        // this file share this app's stores — so this test registers its own id.
        const optionsResponse = yield* Effect.promise(() =>
          post(browser, "/passkey/register/options", {}),
        );
        const challenge = extractChallenge(yield* Effect.promise(() => optionsResponse.json()));
        yield* Effect.promise(() =>
          post(browser, "/passkey/register/verify", {
            credential: {
              id: "cred-manage-1",
              rawId: "cred-manage-1",
              type: "public-key",
              response: {
                clientDataJSON: buildClientDataJSON({
                  type: "webauthn.create",
                  challenge,
                  origin: ORIGIN,
                }),
                attestationObject: "",
              },
            },
          }),
        );

        const listResponse = yield* Effect.promise(() =>
          browser.request("GET", "/passkey/credentials"),
        );
        assert.strictEqual(listResponse.status, 200);
        const listed = Schema.decodeUnknownSync(Schema.Array(PasskeyApi.PasskeyCredentialDto))(
          yield* Effect.promise(() => listResponse.json()),
        );
        assert.strictEqual(listed.length, 1);

        const renameResponse = yield* Effect.promise(() =>
          browser.request("PATCH", "/passkey/credentials/cred-manage-1", {
            json: { name: "My Renamed Passkey" },
          }),
        );
        assert.strictEqual(renameResponse.status, 200);

        const removeResponse = yield* Effect.promise(() =>
          browser.request("DELETE", "/passkey/credentials/cred-manage-1"),
        );
        assert.strictEqual(removeResponse.status, 409);

        const unknownResponse = yield* Effect.promise(() =>
          browser.request("DELETE", "/passkey/credentials/does-not-exist"),
        );
        assert.strictEqual(unknownResponse.status, 404);
      }),
  );

  it.effect(
    "BEH-EA-084: serves generated OpenAPI JSON and Scalar docs from this plugin's own api",
    () =>
      Effect.gen(function* () {
        const openapi = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/openapi.json`)));
        assert.strictEqual(openapi.status, 200);
        const docs = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/docs`)));
        assert.strictEqual(docs.status, 200);
      }),
  );

  // AVS-003: a generated client (and the docs) see the real WebAuthn options
  // dictionary, not `{}`.
  it.effect(
    "AVS-003: the OpenAPI document declares a structured schema for the options endpoints",
    () =>
      Effect.gen(function* () {
        const openapi = yield* Effect.promise(() => handler(new Request(`${ORIGIN}/openapi.json`)));
        const document = JSON.stringify(yield* Effect.promise(() => openapi.json()));
        // `challenge`/`pubKeyCredParams`/`rp` only appear if the schema is modeled, never for `unknown`.
        assert.include(document, "pubKeyCredParams");
        assert.include(document, "excludeCredentials");
        assert.include(document, "allowCredentials");
        assert.include(document, "/passkey/signals");
      }),
  );

  // BPAS-006/TC-004: the Signals surface is authenticated and per-caller.
  it.effect(
    "the signals endpoint 401s without a session and answers only the caller's own ids with one",
    () =>
      Effect.gen(function* () {
        const anonymous = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/passkey/signals`)),
        );
        assert.strictEqual(anonymous.status, 401);

        const browser = yield* Effect.promise(() => app.signIn("signals@example.com"));
        const optionsResponse = yield* Effect.promise(() =>
          post(browser, "/passkey/register/options", {}),
        );
        const options = yield* Effect.promise(() => optionsResponse.json());
        yield* Effect.promise(() =>
          post(browser, "/passkey/register/verify", {
            credential: {
              id: "cred-signals-1",
              rawId: "cred-signals-1",
              type: "public-key",
              response: {
                clientDataJSON: buildClientDataJSON({
                  type: "webauthn.create",
                  challenge: extractChallenge(options),
                  origin: ORIGIN,
                }),
                attestationObject: "",
              },
            },
          }),
        );

        const response = yield* Effect.promise(() => browser.request("GET", "/passkey/signals"));
        assert.strictEqual(response.status, 200);
        const body = Schema.decodeUnknownSync(PasskeyApi.PasskeySignalsDto)(
          yield* Effect.promise(() => response.json()),
        );
        assert.strictEqual(body.rpId, RP_ID);
        assert.deepStrictEqual(body.allAcceptedCredentialIds, ["cred-signals-1"]);
        assert.strictEqual(
          body.userId,
          Schema.decodeUnknownSync(PasskeyApi.PublicKeyCredentialCreationOptionsSchema)(options)
            .user.id,
        );
      }),
  );

  it.effect("WPS-010: registering an id another account already owns answers 409", () =>
    Effect.gen(function* () {
      const register = (email: string, id: string) =>
        Effect.gen(function* () {
          const browser = yield* Effect.promise(() => app.signIn(email));
          const optionsResponse = yield* Effect.promise(() =>
            post(browser, "/passkey/register/options", {}),
          );
          const options = yield* Effect.promise(() => optionsResponse.json());
          return yield* Effect.promise(() =>
            post(browser, "/passkey/register/verify", {
              credential: {
                id,
                rawId: id,
                type: "public-key",
                response: {
                  clientDataJSON: buildClientDataJSON({
                    type: "webauthn.create",
                    challenge: extractChallenge(options),
                    origin: ORIGIN,
                  }),
                  attestationObject: "",
                },
              },
            }),
          );
        });
      assert.strictEqual((yield* register("dup-a@example.com", "cred-dup-http")).status, 200);
      assert.strictEqual((yield* register("dup-b@example.com", "cred-dup-http")).status, 409);
    }),
  );
});

// TC-008: WebAuthn Related Origin Requests — the well-known document a browser fetches from the rpId host.
describe("GET /.well-known/webauthn (TC-008)", () => {
  it.effect("is a 404 unless related origins are configured (off by default)", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        handler(new Request(`${ORIGIN}/.well-known/webauthn`)),
      );
      assert.strictEqual(response.status, 404);
    }),
  );

  it.effect("serves the configured related origins as JSON, anonymously", () =>
    Effect.gen(function* () {
      const related = buildApp(mockWebAuthn(), {
        relatedOrigins: ["https://example.co.uk", "https://example.de"],
      });
      const response = yield* Effect.promise(() =>
        related.handler(new Request(`${ORIGIN}/.well-known/webauthn`)),
      );
      assert.strictEqual(response.status, 200);
      assert.include(response.headers.get("content-type") ?? "", "application/json");
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        origins: ["https://example.co.uk", "https://example.de"],
      });
      yield* Effect.promise(() => related.dispose());
    }),
  );
});
