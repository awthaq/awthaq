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
import { Users, Accounts, Sessions, AuthEvents } from "@awthaq/core";
import { WebAuthn } from "@awthaq/ports";
import { Authentication, AuthHttp } from "@awthaq/server";
import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { ChallengeStore, Passkey, PasskeyApi, PasskeyCredentials } from "../src/index.ts";
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
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
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
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(webAuthn, ChallengeStore.layerMemory, PasskeyCredentials.layerMemory).pipe(
        Layer.provideMerge(NodeCrypto.layer),
      ),
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
      headers: { "content-type": "application/json", ...headers },
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
            new Request(`${ORIGIN}/passkey/credentials/cred-mock-1`, {
              method: "PATCH",
              headers: { "content-type": "application/json", cookie },
              body: JSON.stringify({ name: "My Renamed Passkey" }),
            }),
          ),
        );
        assert.strictEqual(renameResponse.status, 200);

        const removeResponse = yield* Effect.promise(() =>
          handler(
            new Request(`${ORIGIN}/passkey/credentials/cred-mock-1`, {
              method: "DELETE",
              headers: { cookie },
            }),
          ),
        );
        assert.strictEqual(removeResponse.status, 409);

        const unknownResponse = yield* Effect.promise(() =>
          handler(
            new Request(`${ORIGIN}/passkey/credentials/does-not-exist`, {
              method: "DELETE",
              headers: { cookie },
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
});
