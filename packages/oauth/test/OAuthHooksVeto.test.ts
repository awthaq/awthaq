// NAM-002 (.issues/high): `OAuth.callback` consults `BeforeSignUp` before
// creating a first-login user (strategy = the provider id) and `BeforeSignIn`
// before issuing a session for a returning one, and fires `AfterSignUp` once
// the new user has committed. A veto surfaces as the typed `HookAborted`.
import {
  AuditLog,
  HookPoint,
  Hooks,
  AuthEvents,
  Accounts,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { ClientAddress, Encryption, KeyProvider, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as OAuth from "../src/OAuth.ts";
import * as OAuthProvider from "../src/OAuthProvider.ts";

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

interface FakeRoutes {
  readonly [urlFragment: string]: unknown;
}

const fakeHttpClient = (routes: FakeRoutes): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const match = Object.entries(routes).find(([fragment]) => request.url.includes(fragment));
      const body = match === undefined ? {} : match[1];
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), { status: match === undefined ? 404 : 200 }),
        ),
      );
    }),
  );

const signedUp = Ref.makeUnsafe<
  ReadonlyArray<{
    readonly userId: string;
    readonly email?: string | undefined;
    readonly strategy: string;
  }>
>([]);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  // First-login creation of the "blocked.example.com" domain is vetoed;
  // returning sign-in of "banned@example.com" is vetoed.
  Layer.provideMerge(
    Layer.mergeAll(
      Hooks.BeforeSignUp.tap((input) =>
        (input.email ?? "").endsWith("@blocked.example.com")
          ? Effect.fail(new HookPoint.HookAbort({ code: "DOMAIN_BLOCKED" }))
          : Effect.succeed(input),
      ),
      Hooks.BeforeSignIn.tap((input) =>
        input.email === "banned@example.com"
          ? Effect.fail(new HookPoint.HookAbort({ code: "USER_BANNED" }))
          : Effect.succeed(input),
      ),
      Hooks.AfterSignUp.tap((input) => Ref.update(signedUp, (seen) => [...seen, input])),
    ),
  ),
  // The tap requires its point, so the point's layer feeds both this
  // composition and the tap (ELC-001).
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const baseUrl = "https://app.example.com";

const buildLayer = (
  providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>,
  httpRoutes: FakeRoutes,
) =>
  OAuth.OAuth.layer.pipe(
    Layer.provide(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(RateLimiter.layerPermissive),
    Layer.provideMerge(RateLimits.layer),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(ClientAddress.layerDirect),
    Layer.provideMerge(EncryptionLive),
    Layer.provide(fakeHttpClient(httpRoutes)),
    Layer.provide(OAuth.config({ providers, linking: "explicit", trustedOrigins: [], baseUrl })),
  );

const optionalField = <K extends string, V>(
  key: K,
  value: V | undefined,
): { readonly [P in K]: V } | {} =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]: V });

const acme = (): OAuthProvider.OAuthProviderConfig =>
  OAuthProvider.oauth2({
    id: "acme",
    clientId: Config.succeed("acme-client-id"),
    clientSecret: Config.succeed(Redacted.make("acme-secret")),
    scopes: ["read"],
    endpoints: {
      authorizationEndpoint: "https://acme.example.com/authorize",
      tokenEndpoint: "https://acme.example.com/token",
      userinfoEndpoint: "https://acme.example.com/userinfo",
    },
    mapProfile: (claims) => ({
      subject: claims["id"] as string,
      ...optionalField("email", claims["email"] as string | undefined),
      ...optionalField("emailVerified", claims["email_verified"] as boolean | undefined),
      ...optionalField("name", claims["name"] as string | undefined),
    }),
  });

const authorizeAndCallback = (oauth: OAuth.OAuthShape) =>
  Effect.gen(function* () {
    const { state } = yield* oauth.authorize("acme", { callbackURL: undefined, link: undefined });
    return yield* oauth.callback("acme", {
      code: "auth-code",
      state,
      iss: undefined,
      cookieState: state,
    });
  });

const asHookAborted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.flatMap((error) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "HookAborted" &&
      "point" in error &&
      typeof error.point === "string" &&
      "code" in error &&
      typeof error.code === "string"
        ? Effect.succeed({ point: error.point, code: error.code })
        : Effect.die(error),
    ),
  );

describe("OAuth callback sign-up/sign-in hooks (NAM-002)", () => {
  it.effect("a BeforeSignUp veto blocks first-login user creation via OAuth", () =>
    Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const users = yield* Users.Users;
      const aborted = yield* asHookAborted(authorizeAndCallback(oauth));
      assert.deepStrictEqual(aborted, { point: "auth.user.signUp", code: "DOMAIN_BLOCKED" });
      // Nothing was written: the veto ran before the create transaction.
      assert.isTrue(Option.isNone(yield* users.findByEmail("mallory@blocked.example.com")));
      assert.deepStrictEqual(yield* Ref.get(signedUp), []);
    }).pipe(
      Effect.provide(
        buildLayer([acme()], {
          "/token": { access_token: "at-1" },
          "/userinfo": {
            id: "acme-blocked-1",
            email: "mallory@blocked.example.com",
            email_verified: true,
          },
        }),
      ),
    ),
  );

  it.effect(
    "a BeforeSignIn veto blocks a returning OAuth user; a first login fires AfterSignUp with the provider id",
    () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        // First login creates the (banned) user: BeforeSignIn is consulted
        // for it too, so the very first callback is already denied — but the
        // user row was committed and AfterSignUp observed it.
        const aborted = yield* asHookAborted(authorizeAndCallback(oauth));
        assert.deepStrictEqual(aborted, { point: "auth.user.signIn", code: "USER_BANNED" });
        const seen = yield* Ref.get(signedUp);
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0]?.email, "banned@example.com");
        assert.strictEqual(seen[0]?.strategy, "acme");

        // A returning sign-in of the same (now linked) account is denied again.
        const again = yield* asHookAborted(authorizeAndCallback(oauth));
        assert.deepStrictEqual(again, { point: "auth.user.signIn", code: "USER_BANNED" });
        // ...and creates no second user (AfterSignUp did not fire again).
        assert.strictEqual((yield* Ref.get(signedUp)).length, 1);
      }).pipe(
        Effect.provide(
          buildLayer([acme()], {
            "/token": { access_token: "at-2" },
            "/userinfo": {
              id: "acme-banned-1",
              email: "banned@example.com",
              email_verified: true,
            },
          }),
        ),
      ),
  );

  // CSD-004: a rejected callback is the OAuth strategy's failure signal.
  it.effect(
    "a callback whose state does not match publishes auth.user.signInFailed (callbackRejected)",
    () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const auditLog = yield* AuditLog.AuditLog;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        const failure = yield* oauth
          .callback("acme", {
            code: "auth-code",
            state,
            iss: undefined,
            cookieState: "not-the-state",
            ip: "203.0.113.4",
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
        const [event] = yield* auditLog.list({ eventTag: "auth.user.signInFailed" });
        assert.deepStrictEqual(event?.payload, {
          _tag: "auth.user.signInFailed",
          strategy: "acme",
          reason: "callbackRejected",
          clientIp: "203.0.113.4",
        });
      }).pipe(Effect.provide(buildLayer([acme()], {}))),
  );
});
