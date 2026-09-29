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
import { Api } from "@awthaq/api";
import { Users, Accounts, Sessions, AuditLog, Hooks, AuthEvents, RateLimits } from "@awthaq/core";
import { ClientAddress, RateLimiter, WebAuthn } from "@awthaq/ports";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as ChallengeStore from "../src/ChallengeStore.ts";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyApi from "../src/PasskeyApi.ts";
import * as PasskeyCredentials from "../src/PasskeyCredentials.ts";
import * as PasskeyUserHandles from "../src/PasskeyUserHandles.ts";
import {
  ORIGIN,
  RP_ID,
  buildClientDataJSON,
  extractChallenge,
  mockWebAuthn,
} from "./passkeyTestFixtures.ts";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(Users.layerMemory, Accounts.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(RateLimits.layer),
  Layer.provideMerge(RateLimiter.layerPermissive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

/**
 * CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `PasskeyGroup`,
 * `PasskeyAuthenticateGroup` (public/anonymous, BEH-EA-131), and
 * `PasskeyCredentialsGroup` all now carry `.middleware(Api.CsrfProtection)`
 * (`PasskeyApi.ts`) — this file calls the composed app's real HTTP handler
 * directly, never through `@awthaq/client`'s generated `CsrfClientLive`, so
 * every unsafe-method request built below (including the anonymous
 * authenticate-ceremony ones) has to play the double-submit role a real
 * browser client would. A reference HMAC computed independently of
 * `Csrf.ts`'s own implementation (Node's `node:crypto`), mirroring
 * `packages/server/test/Csrf.test.ts`'s own `validCookieValue()`.
 *
 * Plain `Layer.provide`, not `Layer.provideMerge` — this file's composed
 * layer already carries the most services of any file in this migration;
 * `provideMerge` exposing `Api.CsrfProtection` in its own output type
 * triggers a real `TS2883` portability error under this repo's `tsc -b`
 * composite project-reference build (see `PasskeyWorld.ts`'s own comment
 * on the identical issue).
 */
const CSRF_TEST_SECRET = "passkey-authhttp-test-csrf-secret";
const CSRF_TEST_COOKIE_VALUE: string = (() => {
  // CDS-006: `<iat>.<random>.<hmac(iat.random)>`. The handler under test runs on the real clock here (a web handler).
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  const signature = createHmac("sha256", CSRF_TEST_SECRET).update(signed).digest("hex");
  return `${signed}.${signature}`;
})();

const withCsrfCookie = (cookie?: string): string =>
  cookie
    ? `${cookie}; ${Api.CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`
    : `${Api.CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`;

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_TEST_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const buildAppLayer = (webAuthn: Layer.Layer<WebAuthn.WebAuthn>) =>
  Layer.mergeAll(
    AuthHttp.routes(PasskeyApi.PasskeyApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Passkey.Passkey.layer),
      Layer.provide(Passkey.config({ rpId: RP_ID, origins: [ORIGIN] })),
      Layer.provide(AuthenticationLive),
    ),
    AuthHttp.docs(PasskeyApi.PasskeyApi),
  ).pipe(
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(
        webAuthn,
        ChallengeStore.layerMemory,
        PasskeyCredentials.layerMemory,
        PasskeyUserHandles.layerMemory,
        ClientAddress.layerDirect,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const AppLayer = buildAppLayer(mockWebAuthn());

/**
 * A shared `MemoMap` so a session issued directly against `Sessions` (below)
 * and the real HTTP `handler`'s own internal layer build resolve to the
 * *same* running `Users.layerMemory`/`Sessions.layerMemory` instances,
 * rather than each independently constructing its own, disjoint state —
 * `HttpRouter.toWebHandler`'s own layer build and `Layer.buildWithMemoMap`
 * below are two separate call sites into the identical `AppLayer` value.
 */
const memoMap = Layer.makeMemoMapUnsafe();
const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });

const post = (
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
        cookie: withCsrfCookie(headers?.["cookie"]),
        [Api.CSRF_HEADER_NAME]: CSRF_TEST_COOKIE_VALUE,
      },
      body: JSON.stringify(body),
    }),
  );

const cookieFrom = (response: Response): string => {
  const raw = response.headers.get("set-cookie");
  if (raw === null) throw new Error("expected a set-cookie header");
  return raw.split(";")[0] ?? raw;
};

/**
 * Passkey registration always requires an existing session (no
 * passkey-first sign-up — `spec.md`'s own Out of Scope), and this plugin
 * has no sign-up endpoint of its own to bootstrap one — so this issues a
 * real session directly against `Sessions` (reaching into the same running
 * services `handler` itself uses, via the shared `memoMap` above) and
 * formats it as the same `__Host-session` cookie header the browser would
 * carry, the same `Sessions.SESSION_COOKIE_NAME`-keyed pattern
 * `@awthaq/test`'s own `signInAs` documents using.
 */
const issueSessionCookieHeader = (email: string): Promise<string> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
        return yield* Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const user = yield* users.create({ email, name: email });
          const issued = yield* sessions.issue({ userId: user.id });
          return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
        }).pipe(Effect.provide(context));
      }),
    ),
  );

describe("AuthHttp + Passkey (real HTTP)", () => {
  it.effect("BEH-EA-130: a full registration ceremony persists a credential and answers 200", () =>
    Effect.gen(function* () {
      const cookie = yield* Effect.promise(() => issueSessionCookieHeader("register@example.com"));

      const optionsResponse = yield* Effect.promise(() =>
        post(handler, "/passkey/register/options", {}, { cookie }),
      );
      assert.strictEqual(optionsResponse.status, 200);
      const options = yield* Effect.promise(() => optionsResponse.json());
      const challenge = extractChallenge(options);

      const verifyResponse = yield* Effect.promise(() =>
        post(
          handler,
          "/passkey/register/verify",
          {
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
          },
          { cookie },
        ),
      );
      assert.strictEqual(verifyResponse.status, 200);
      const body = (yield* Effect.promise(() => verifyResponse.json())) as {
        id: string;
        name: string;
      };
      assert.strictEqual(body.id, "cred-mock-1");
    }),
  );

  it.effect("register/options is unreachable without a session cookie", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => post(handler, "/passkey/register/options", {}));
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect(
    "ticket 07: register/options/conditional is reachable only with a session cookie present",
    () =>
      Effect.gen(function* () {
        const anonymous = yield* Effect.promise(() =>
          post(handler, "/passkey/register/options/conditional", {}),
        );
        assert.strictEqual(anonymous.status, 401);

        const cookie = yield* Effect.promise(() =>
          issueSessionCookieHeader("conditional@example.com"),
        );
        const authenticated = yield* Effect.promise(() =>
          post(handler, "/passkey/register/options/conditional", {}, { cookie }),
        );
        assert.strictEqual(authenticated.status, 200);
      }),
  );

  it.effect(
    "BEH-EA-131: a full authentication ceremony sets a real session cookie on success",
    () =>
      Effect.gen(function* () {
        const cookie = yield* Effect.promise(() =>
          issueSessionCookieHeader("authuser@example.com"),
        );

        const registerOptionsResponse = yield* Effect.promise(() =>
          post(handler, "/passkey/register/options", {}, { cookie }),
        );
        const registerChallenge = extractChallenge(
          yield* Effect.promise(() => registerOptionsResponse.json()),
        );
        yield* Effect.promise(() =>
          post(
            handler,
            "/passkey/register/verify",
            {
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
            },
            { cookie },
          ),
        );

        const authOptionsResponse = yield* Effect.promise(() =>
          post(handler, "/passkey/authenticate/options", {}),
        );
        assert.strictEqual(authOptionsResponse.status, 200);
        const { ceremonyId, options } = (yield* Effect.promise(() =>
          authOptionsResponse.json(),
        )) as {
          ceremonyId: string;
          options: unknown;
        };
        const authChallenge = extractChallenge(options);

        const verifyResponse = yield* Effect.promise(() =>
          post(handler, "/passkey/authenticate/verify", {
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
        assert.match(cookieFrom(verifyResponse), /^__Host-session=/);
      }),
  );

  // WPS-004/MNA-001: delivery goes through the shared `SessionDelivery`; with
  // the opt-in header the token rides the body and no cookie is set.
  it.effect(
    "WPS-004: authenticate/verify with X-Awthaq-Token-Delivery: bearer returns the token and sets no cookie",
    () =>
      Effect.gen(function* () {
        const cookie = yield* Effect.promise(() =>
          issueSessionCookieHeader("bearerpasskey@example.com"),
        );
        const registerOptionsResponse = yield* Effect.promise(() =>
          post(handler, "/passkey/register/options", {}, { cookie }),
        );
        const registerChallenge = extractChallenge(
          yield* Effect.promise(() => registerOptionsResponse.json()),
        );
        yield* Effect.promise(() =>
          post(
            handler,
            "/passkey/register/verify",
            {
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
            },
            { cookie },
          ),
        );
        const authOptionsResponse = yield* Effect.promise(() =>
          post(handler, "/passkey/authenticate/options", {}),
        );
        const { ceremonyId, options } = (yield* Effect.promise(() =>
          authOptionsResponse.json(),
        )) as { ceremonyId: string; options: unknown };
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
            handler,
            "/passkey/authenticate/verify",
            { ceremonyId, credential },
            { [Api.TOKEN_DELIVERY_HEADER]: "nope" },
          ),
        );
        assert.strictEqual(bad.status, 400);
        const verifyResponse = yield* Effect.promise(() =>
          post(
            handler,
            "/passkey/authenticate/verify",
            { ceremonyId, credential },
            { [Api.TOKEN_DELIVERY_HEADER]: "bearer" },
          ),
        );
        assert.strictEqual(verifyResponse.status, 200);
        assert.isNull(verifyResponse.headers.get("set-cookie"));
        const body = (yield* Effect.promise(() => verifyResponse.json())) as { token?: string };
        assert.isString(body.token);
      }),
  );

  it.effect(
    "BEH-EA-136: an unknown credential at authenticate/verify answers 401 InvalidCredentials",
    () =>
      Effect.gen(function* () {
        const optionsResponse = yield* Effect.promise(() =>
          post(handler, "/passkey/authenticate/options", {}),
        );
        const { ceremonyId, options } = (yield* Effect.promise(() => optionsResponse.json())) as {
          ceremonyId: string;
          options: unknown;
        };
        const response = yield* Effect.promise(() =>
          post(handler, "/passkey/authenticate/verify", {
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
        const cookie = yield* Effect.promise(() => issueSessionCookieHeader("manage@example.com"));

        // WPS-010: a credential id is globally unique, and the earlier tests in
        // this file share this app's stores — so this test registers its own id.
        const optionsResponse = yield* Effect.promise(() =>
          post(handler, "/passkey/register/options", {}, { cookie }),
        );
        const challenge = extractChallenge(yield* Effect.promise(() => optionsResponse.json()));
        yield* Effect.promise(() =>
          post(
            handler,
            "/passkey/register/verify",
            {
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
            },
            { cookie },
          ),
        );

        const listResponse = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/passkey/credentials`, { headers: { cookie } })),
        );
        assert.strictEqual(listResponse.status, 200);
        const listed = (yield* Effect.promise(() => listResponse.json())) as ReadonlyArray<{
          id: string;
        }>;
        assert.strictEqual(listed.length, 1);

        const renameResponse = yield* Effect.promise(() =>
          handler(
            new Request(`${ORIGIN}/passkey/credentials/cred-manage-1`, {
              method: "PATCH",
              headers: {
                "content-type": "application/json",
                cookie: withCsrfCookie(cookie),
                [Api.CSRF_HEADER_NAME]: CSRF_TEST_COOKIE_VALUE,
              },
              body: JSON.stringify({ name: "My Renamed Passkey" }),
            }),
          ),
        );
        assert.strictEqual(renameResponse.status, 200);

        const removeResponse = yield* Effect.promise(() =>
          handler(
            new Request(`${ORIGIN}/passkey/credentials/cred-manage-1`, {
              method: "DELETE",
              headers: {
                cookie: withCsrfCookie(cookie),
                [Api.CSRF_HEADER_NAME]: CSRF_TEST_COOKIE_VALUE,
              },
            }),
          ),
        );
        assert.strictEqual(removeResponse.status, 409);

        const unknownResponse = yield* Effect.promise(() =>
          handler(
            new Request(`${ORIGIN}/passkey/credentials/does-not-exist`, {
              method: "DELETE",
              headers: {
                cookie: withCsrfCookie(cookie),
                [Api.CSRF_HEADER_NAME]: CSRF_TEST_COOKIE_VALUE,
              },
            }),
          ),
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

        const cookie = yield* Effect.promise(() => issueSessionCookieHeader("signals@example.com"));
        const optionsResponse = yield* Effect.promise(() =>
          post(handler, "/passkey/register/options", {}, { cookie }),
        );
        const options = yield* Effect.promise(() => optionsResponse.json());
        yield* Effect.promise(() =>
          post(
            handler,
            "/passkey/register/verify",
            {
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
            },
            { cookie },
          ),
        );

        const response = yield* Effect.promise(() =>
          handler(new Request(`${ORIGIN}/passkey/signals`, { headers: { cookie } })),
        );
        assert.strictEqual(response.status, 200);
        const body = (yield* Effect.promise(() => response.json())) as {
          rpId: string;
          userId: string;
          allAcceptedCredentialIds: ReadonlyArray<string>;
        };
        assert.strictEqual(body.rpId, RP_ID);
        assert.deepStrictEqual(body.allAcceptedCredentialIds, ["cred-signals-1"]);
        assert.strictEqual(body.userId, (options as { user: { id: string } }).user.id);
      }),
  );

  it.effect("WPS-010: registering an id another account already owns answers 409", () =>
    Effect.gen(function* () {
      const register = (email: string, id: string) =>
        Effect.gen(function* () {
          const cookie = yield* Effect.promise(() => issueSessionCookieHeader(email));
          const optionsResponse = yield* Effect.promise(() =>
            post(handler, "/passkey/register/options", {}, { cookie }),
          );
          const options = yield* Effect.promise(() => optionsResponse.json());
          return yield* Effect.promise(() =>
            post(
              handler,
              "/passkey/register/verify",
              {
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
              },
              { cookie },
            ),
          );
        });
      assert.strictEqual((yield* register("dup-a@example.com", "cred-dup-http")).status, 200);
      assert.strictEqual((yield* register("dup-b@example.com", "cred-dup-http")).status, 409);
    }),
  );
});
