// BCR-004/THS-002 (.issues/high, wayfinder ticket 03): proves
// `OAuth.callback`'s own sign-in-completing path (silent sign-up)
// genuinely consults `Hooks.BeforeSessionIssue` — a dedicated file, not
// folded into `OAuth.test.ts`, for the same reason
// `packages/password/test/PasswordHooksSignUp.test.ts`'s own header
// comment gives (a shared, module-level singleton `HookPoint` class that
// freezes at its own first `run()`, and `OAuth.test.ts`'s own untapped
// `callback` coverage would otherwise freeze it first).
import {
  AuditLog,
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

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  // BEH-EA-093: unconditionally diverts every sign-in this composition
  // ever issues — enough to prove the wiring is real; the mechanism
  // itself (continue-through, amend, etc.) is proven once, generically,
  // by `@awthaq/core`'s own `HookPoint.test.ts` and
  // `packages/password/test/PasswordHooksSignIn.test.ts`.
  Layer.provideMerge(
    Hooks.BeforeSessionIssue.tap((input) =>
      Effect.succeed(
        Option.some(new Hooks.TwoFactorRequired({ userId: input.userId, challengeId: "chal-1" })),
      ),
    ),
  ),
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

describe("OAuth callback hook (BEH-EA-093)", () => {
  it.effect(
    "a BeforeSessionIssue divert tap redirects a silent sign-up's own sign-in to TwoFactorRequired",
    () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });

        const diverted = yield* oauth
          .callback("acme", { code: "auth-code", state, iss: undefined, cookieState: state })
          .pipe(
            Effect.flip,
            Effect.flatMap((error) =>
              error._tag === "TwoFactorRequired" ? Effect.succeed(error) : Effect.die(error),
            ),
          );
        assert.strictEqual(diverted.challengeId, "chal-1");
      }).pipe(
        Effect.provide(
          buildLayer([acme()], {
            "/token": { access_token: "at-1" },
            "/userinfo": { id: "acme-user-1", email: "ada@example.com", email_verified: true },
          }),
        ),
      ),
  );
});
