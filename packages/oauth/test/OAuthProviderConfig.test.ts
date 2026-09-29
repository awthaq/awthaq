// ESS-009: the BDD suite pruned REQ-EA-346 after a `Config.Redacted` "Encoding" schema
// failure "building a provider Layer from a `process.env`-set var". This reproduces the
// scenario at the unit level — a provider's `clientSecret` read via `Config.Redacted` from
// an environment `ConfigProvider` — so the root cause (or its absence) is on record.
import { assert, describe, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as OAuthProvider from "../src/OAuthProvider.ts";
import { fakeHttpClient } from "./FakeProvider.ts";

const okta = OAuthProvider.oidc({
  id: "okta",
  issuer: "https://okta.example.com/oauth2/default",
  clientId: "okta-client",
  clientSecret: Config.Redacted("AUTH_OAUTH_OKTA_CLIENT_SECRET"),
  scopes: ["openid", "email"],
  endpoints: {
    authorizationEndpoint: "https://okta.example.com/oauth2/default/v1/authorize",
    tokenEndpoint: "https://okta.example.com/oauth2/default/v1/token",
    jwksUri: "https://okta.example.com/oauth2/default/v1/keys",
  },
  mapProfile: (claims) => ({ subject: String(claims["sub"]) }),
});

const resolveOkta = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  return yield* OAuthProvider.resolve(client, okta, { discoveryTimeout: Duration.seconds(5) });
}).pipe(Effect.provide(fakeHttpClient({})));

describe("OAuthProvider config (ESS-009)", () => {
  it.effect(
    "BEH-EA-126: a provider clientSecret read via Config.Redacted from the environment builds the provider",
    () =>
      Effect.gen(function* () {
        const resolved = yield* resolveOkta.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { AUTH_OAUTH_OKTA_CLIENT_SECRET: "s3cret" } }),
            ),
          ),
        );
        assert.isTrue(Option.isSome(resolved.clientSecret));
        assert.strictEqual(
          Option.map(resolved.clientSecret, Redacted.value).pipe(Option.getOrUndefined),
          "s3cret",
        );
      }),
  );

  it.effect(
    "BEH-EA-126: a missing secret variable fails the provider at boot, never silently public",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          resolveOkta.pipe(
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          ),
        );
        assert.strictEqual(exit._tag, "Failure");
      }),
  );
});
