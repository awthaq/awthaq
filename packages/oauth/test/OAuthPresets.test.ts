// IC-003: each vendor preset is a complete provider — it resolves against a
// fake discovery document (or its explicit endpoints), and its default
// `mapProfile` maps a recorded sample of that vendor's real claims. The
// samples are trimmed from the vendors' documented responses; the discovery
// documents carry the issuer each vendor actually publishes, which is what
// BEH-EA-127's exact-issuer match checks the preset against.
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as OAuthProvider from "../src/OAuthProvider.ts";
import { discord } from "../src/presets/discord.ts";
import { github } from "../src/presets/github.ts";
import { gitlab } from "../src/presets/gitlab.ts";
import { google } from "../src/presets/google.ts";
import { microsoft } from "../src/presets/microsoft.ts";
import { fakeHttpClient, type FakeRoutes } from "./FakeProvider.ts";

const credentials = {
  clientId: "app-client-id",
  clientSecret: Config.succeed(Redacted.make("app-secret")),
};

const resolveWith = (routes: FakeRoutes, provider: OAuthProvider.OAuthProviderConfig) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* OAuthProvider.resolve(client, provider, { discoveryTimeout: Duration.seconds(5) });
  }).pipe(Effect.provide(fakeHttpClient(routes)));

describe("OAuthPresets (IC-003)", () => {
  it.effect("google resolves against Google's discovery document and maps a Google id_token's claims", () =>
    Effect.gen(function* () {
      const preset = google(credentials);
      const resolved = yield* resolveWith(
        {
          ".well-known/openid-configuration": {
            issuer: "https://accounts.google.com",
            authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
            token_endpoint: "https://oauth2.googleapis.com/token",
            userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
            jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
            token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
          },
        },
        preset,
      );
      assert.strictEqual(resolved.id, "google");
      assert.strictEqual(resolved.kind, "oidc");
      assert.deepStrictEqual(resolved.scopes, ["openid", "email", "profile"]);
      assert.isFalse(resolved.skipPkce);
      assert.deepStrictEqual(
        resolved.mapProfile({
          sub: "110169484474386276334",
          email: "ada@gmail.com",
          email_verified: true,
          name: "Ada Lovelace",
          picture: "https://lh3.googleusercontent.com/a/x",
        }),
        {
          subject: "110169484474386276334",
          email: "ada@gmail.com",
          emailVerified: true,
          name: "Ada Lovelace",
        },
      );
    }),
  );

  it.effect("a stale preset fails loudly at boot: a moved discovery issuer is a mismatch", () =>
    Effect.gen(function* () {
      const exit = yield* resolveWith(
        {
          ".well-known/openid-configuration": {
            issuer: "https://accounts.google.example",
            authorization_endpoint: "https://accounts.google.example/auth",
            token_endpoint: "https://accounts.google.example/token",
          },
        },
        google(credentials),
      ).pipe(Effect.exit);
      if (exit._tag === "Success") return assert.fail("expected the issuer mismatch to die");
      assert.include(Cause.pretty(exit.cause), "does not match configured issuer");
    }),
  );

  it.effect("github is a complete oauth2 provider and maps GitHub's numeric id to a string subject", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveWith({}, github(credentials));
      assert.strictEqual(resolved.id, "github");
      assert.strictEqual(resolved.kind, "oauth2");
      assert.strictEqual(resolved.tokenEndpoint, "https://github.com/login/oauth/access_token");
      assert.strictEqual(resolved.tokenEndpointAuthMethod, "client_secret_post");
      assert.deepStrictEqual(
        resolved.mapProfile({
          id: 583231,
          login: "octocat",
          name: "The Octocat",
          email: null,
          avatar_url: "https://avatars.githubusercontent.com/u/583231",
        }),
        { subject: "583231", name: "The Octocat" },
      );
      // No login/name falls back to the handle; GitHub never asserts the email verified.
      assert.deepStrictEqual(
        resolved.mapProfile({ id: 7, login: "hubot", name: null, email: "hubot@example.com" }),
        { subject: "7", email: "hubot@example.com", name: "hubot" },
      );
    }),
  );

  it.effect("microsoft builds its issuer from the tenant id and matches Entra's discovery document", () =>
    Effect.gen(function* () {
      const tenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
      const resolved = yield* resolveWith(
        {
          ".well-known/openid-configuration": {
            issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
            authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
            token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
            jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
            userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
          },
        },
        microsoft({ ...credentials, tenant }),
      );
      assert.strictEqual(resolved.id, "microsoft");
      assert.deepStrictEqual(Option.getOrThrow(resolved.issuer), `https://login.microsoftonline.com/${tenant}/v2.0`);
      assert.deepStrictEqual(
        resolved.mapProfile({ sub: "AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ", name: "Abe Lincoln", email: "abe@contoso.com" }),
        { subject: "AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ", email: "abe@contoso.com", name: "Abe Lincoln" },
      );
    }),
  );

  it.effect("microsoft with a multi-tenant alias dies at boot: its placeholder issuer never matches", () =>
    Effect.gen(function* () {
      const exit = yield* resolveWith(
        {
          ".well-known/openid-configuration": {
            issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
            authorization_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          },
        },
        microsoft({ ...credentials, tenant: "common" }),
      ).pipe(Effect.exit);
      assert.strictEqual(exit._tag, "Failure");
    }),
  );

  it.effect("gitlab defaults to gitlab.com and accepts a self-managed base URL", () =>
    Effect.gen(function* () {
      const saas = gitlab(credentials);
      assert.strictEqual(saas.id, "gitlab");
      const selfManaged = gitlab({ ...credentials, baseUrl: "https://git.acme.test" });
      const resolved = yield* resolveWith(
        {
          ".well-known/openid-configuration": {
            issuer: "https://git.acme.test",
            authorization_endpoint: "https://git.acme.test/oauth/authorize",
            token_endpoint: "https://git.acme.test/oauth/token",
            jwks_uri: "https://git.acme.test/oauth/discovery/keys",
            userinfo_endpoint: "https://git.acme.test/oauth/userinfo",
          },
        },
        selfManaged,
      );
      assert.deepStrictEqual(
        resolved.mapProfile({ sub: "42", name: "Grace", email: "grace@acme.test", email_verified: true }),
        { subject: "42", email: "grace@acme.test", emailVerified: true, name: "Grace" },
      );
    }),
  );

  it.effect("discord is a complete oauth2 provider; `verified` is its email assertion", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveWith({}, discord(credentials));
      assert.strictEqual(resolved.kind, "oauth2");
      assert.deepStrictEqual(resolved.scopes, ["identify", "email"]);
      assert.deepStrictEqual(
        resolved.mapProfile({
          id: "80351110224678912",
          username: "nelly",
          global_name: "Nelly",
          email: "nelly@discord.example",
          verified: true,
        }),
        {
          subject: "80351110224678912",
          email: "nelly@discord.example",
          emailVerified: true,
          name: "Nelly",
        },
      );
    }),
  );

  it("overrides: id, scopes and mapProfile replace the preset's defaults; the factories stay the escape hatch", () => {
    const preset = google({
      ...credentials,
      id: "google-staff",
      scopes: ["openid"],
      mapProfile: () => ({ subject: "fixed" }),
    });
    assert.strictEqual(preset.id, "google-staff");
    assert.deepStrictEqual(preset.scopes, ["openid"]);
    assert.strictEqual(preset.mapProfile({}).subject, "fixed");
    // Every preset is an ordinary provider config: PKCE stays structural.
    assert.isTrue(preset.pkce);
  });

  it("a claim set missing its identifier maps to an empty subject the callback refuses", () => {
    assert.strictEqual(github(credentials).mapProfile({ login: "ghost" }).subject, "");
    assert.strictEqual(google(credentials).mapProfile({ sub: 123 }).subject, "123");
  });
});
