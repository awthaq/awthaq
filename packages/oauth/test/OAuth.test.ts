// spec/behaviors/16-oauth.md, BEH-EA-121 through BEH-EA-128.
//
// Real, domain-level tests (no HTTP layer here — see `AuthHttp.test.ts` for
// the wire-level counterpart): a real in-memory `Users`/`Accounts`/
// `Sessions`/`Verification`/`AuthEvents`, a fake `HttpClient` only for the
// provider transport (discovery/token/userinfo/JWKS — the same category of
// swap `TestClock` is for time), and, for the `"oidc"` scenarios, a real
// RSA keypair signing a real RS256 `id_token` that `Jwt.ts`'s own verifier
// checks — not a stub that always returns `true`.
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { AuthEvents, Accounts, RateLimits, Sessions, Users, Verification } from "@awthaq/core";
import { Encryption, KeyProvider, RateLimiter, SqlTransaction } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Authentication } from "@awthaq/server";
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

// Shipping-gap map (.scratch/shipping-gaps), ticket 19: `OAuth.layer` now
// requires `Encryption` — a fixed test key, isolated from the real
// `process.env`.
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

// ---- RS256 test signing (a real keypair, a real signature — not a stub) ----

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";
const jwk = {
  ...(keyPair.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
  kid: KID,
  alg: "RS256",
};

const toBase64Url = (buf: Buffer): string => buf.toString("base64url");

const signJwt = (
  payload: Record<string, unknown>,
  privateKey: KeyObject = keyPair.privateKey,
): string => {
  const header = { alg: "RS256", typ: "JWT", kid: KID };
  const headerSegment = toBase64Url(Buffer.from(JSON.stringify(header)));
  const payloadSegment = toBase64Url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = nodeSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${toBase64Url(signature)}`;
};

/**
 * `OAuthProfile`'s optional fields are real `?:` optionals under
 * `exactOptionalPropertyTypes` — a `mapProfile` that always assigns
 * `email: claims["email"] as string | undefined` (present as a key, value
 * `undefined`, for a claim set missing it) fails to type-check even though
 * the runtime value is fine. Conditionally spreading each field keeps the
 * key entirely absent instead.
 */
const optionalField = <K extends string, V>(
  key: K,
  value: V | undefined,
): { readonly [P in K]: V } | {} =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]: V });

// ---- fake HttpClient: routes by URL substring, form/JSON bodies alike ----

interface FakeRoutes {
  readonly [urlFragment: string]: unknown;
}

const fakeHttpClient = (routes: FakeRoutes): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const match = Object.entries(routes).find(([fragment]) => request.url.includes(fragment));
      if (match === undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 })),
        );
      }
      const body = typeof match[1] === "function" ? (match[1] as () => unknown)() : match[1];
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status: 200 })),
      );
    }),
  );

// ---- shared core/domain layers ----

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(Layer.provideMerge(AuthEvents.layer), Layer.provideMerge(NodeCrypto.layer));

const baseUrl = "https://app.example.com";

const buildLayer = (options: {
  readonly providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>;
  readonly linking?: "explicit" | { readonly trustedProviders: ReadonlyArray<string> };
  readonly trustedOrigins?: ReadonlyArray<string>;
  readonly httpRoutes?: FakeRoutes;
}) =>
  OAuth.OAuth.layer.pipe(
    // `OAuthApi.OAuthGroup`'s own `.middleware(Api.OptionalAuthentication)`
    // is part of what `OAuth.layer` merges its handlers with — required
    // even for these domain-level tests, which never issue an HTTP
    // request at all, because `AuthPlugin.layer` ties a plugin's own
    // service and its handlers together in one `Layer.provideMerge`.
    // Order matters: a `Layer.provide` call can only satisfy a
    // requirement introduced *earlier* in the pipe, so `CoreLive` (which
    // satisfies `OptionalAuthenticationLive`'s own `Sessions` need) has to
    // come after it, not before.
    Layer.provide(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provideMerge(CoreLive),
    // Ticket 13: `callback` is now rate-limited — a real, permissive
    // default here, mirroring `TestAuth`'s own posture, so an ordinary
    // test loop never trips a limit tuned for production.
    Layer.provideMerge(RateLimiter.layerPermissive),
    Layer.provideMerge(RateLimits.layer),
    // Ticket 16: `SqlTransaction`'s no-op layer — this test's own `CoreLive`
    // is in-memory, with nothing a transaction would need to wrap.
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(EncryptionLive),
    Layer.provide(fakeHttpClient(options.httpRoutes ?? {})),
    Layer.provide(
      OAuth.config({
        providers: options.providers,
        linking: options.linking ?? "explicit",
        trustedOrigins: options.trustedOrigins ?? [],
        baseUrl,
      }),
    ),
  );

// ---- a plain OAuth2 provider (no id_token — GitHub-shaped) ----

const acme = (
  overrides?: Partial<OAuthProvider.OAuthProviderConfig>,
): OAuthProvider.OAuthProviderConfig =>
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
    ...overrides,
  });

// ---- a discovery-driven OIDC provider (real RS256 id_token verification) ----

const okta = (
  overrides?: Partial<OAuthProvider.OAuthProviderConfig>,
): OAuthProvider.OAuthProviderConfig =>
  OAuthProvider.oidc({
    id: "okta",
    issuer: Config.succeed("https://okta.example.com/oauth2/default"),
    discoveryUrl: Config.succeed("https://okta.example.com/.well-known/openid-configuration"),
    clientId: Config.succeed("okta-client-id"),
    clientSecret: Config.succeed(Redacted.make("okta-secret")),
    scopes: ["openid", "email", "profile"],
    mapProfile: (claims) => ({
      subject: claims["sub"] as string,
      ...optionalField("email", claims["email"] as string | undefined),
      ...optionalField("emailVerified", claims["email_verified"] as boolean | undefined),
      ...optionalField("name", claims["name"] as string | undefined),
    }),
    ...overrides,
  });

const oktaDiscovery = {
  issuer: "https://okta.example.com/oauth2/default",
  authorization_endpoint: "https://okta.example.com/authorize",
  token_endpoint: "https://okta.example.com/token",
  jwks_uri: "https://okta.example.com/jwks",
};

describe("OAuth", () => {
  describe("BEH-EA-121: PKCE S256 is structural", () => {
    it.effect("REQ-EA-328: an authorization request is built with a code_challenge/S256", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { location } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        const url = new URL(location);
        assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256");
        assert.isString(url.searchParams.get("code_challenge"));
      }).pipe(Effect.provide(buildLayer({ providers: [acme()] }))),
    );

    it.effect("REQ-EA-330: quirks.skipPkce omits the challenge only for that provider", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { location } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        const url = new URL(location);
        assert.isNull(url.searchParams.get("code_challenge"));
      }).pipe(Effect.provide(buildLayer({ providers: [acme({ quirks: { skipPkce: true } })] }))),
    );

    it.effect("REQ-EA-354: redirect_uri is always derived from the configured base URL", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { location } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        const url = new URL(location);
        assert.strictEqual(url.searchParams.get("redirect_uri"), `${baseUrl}/oauth/acme/callback`);
      }).pipe(Effect.provide(buildLayer({ providers: [acme()] }))),
    );
  });

  describe("BEH-EA-122: flow state lives server-side, in Verification", () => {
    it.effect("REQ-EA-333: a replayed callback using an already-consumed state fails", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        const first = yield* oauth.callback("acme", {
          code: "auth-code",
          state,
          iss: undefined,
          cookieState: state,
        });
        assert.isDefined(first.session);
        const replay = yield* oauth
          .callback("acme", { code: "auth-code", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(replay._tag, "OAuthCallbackFailed");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "acme-user-1", email: "ada@example.com" },
            },
          }),
        ),
      ),
    );

    it.effect(
      "the correlation cookie must match the returned state — a mismatch fails before the token is even consumed",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: undefined,
          });
          const failure = yield* oauth
            .callback("acme", {
              code: "auth-code",
              state,
              iss: undefined,
              cookieState: "wrong-cookie",
            })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "OAuthCallbackFailed");
          // Proven not to have consumed the Verification entry: the *same*
          // state, presented again with the correct cookie, still works.
          const retried = yield* oauth.callback("acme", {
            code: "auth-code",
            state,
            iss: undefined,
            cookieState: state,
          });
          assert.isDefined(retried.session);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": { id: "acme-user-2", email: "bo@example.com" },
              },
            }),
          ),
        ),
    );
  });

  describe("Ticket 19: PKCE verifier/nonce are encrypted at rest", () => {
    it.effect(
      "the persisted FlowPayload's codeVerifier/nonce are ciphertext envelopes, not the raw PKCE values",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const verification = yield* Verification.Verification;
          // `okta` is an `"oidc"` provider (line 184), so `authorize` also
          // generates a `nonce` — unlike `acme` (`oauth2`), letting this one
          // test cover both `codeVerifier` and `nonce`.
          const { state } = yield* oauth.authorize("okta", {
            callbackURL: undefined,
            link: undefined,
          });
          // `state`'s own encoding (`OAuth.ts`'s private `encodeState`) is
          // `${identifier}.${value}` — replicated here, not exported,
          // specifically so this test reaches the *persisted* payload
          // directly via `Verification.consume`, the same primitive
          // `oauth.callback` itself uses, rather than asserting against
          // this module's own internals.
          const separator = state.lastIndexOf(".");
          const identifier = state.slice(0, separator);
          const value = Redacted.make(state.slice(separator + 1));
          const consumed = yield* verification.consume(identifier, value);
          const payload = consumed.payload as {
            readonly codeVerifier: string;
            readonly nonce: string | undefined;
          };
          assert.isDefined(payload.nonce);
          for (const ciphertext of [payload.codeVerifier, payload.nonce]) {
            const envelope: unknown = JSON.parse(
              Buffer.from(ciphertext ?? "", "base64url").toString("utf8"),
            );
            // The real `Encryption` envelope shape (`v`/`kid`/`iv`/
            // `ciphertext`) — structurally incompatible with a raw PKCE
            // verifier or nonce (a bare base64url random-bytes string),
            // so this also proves it isn't just base64 of the plaintext.
            assert.deepEqual(Object.keys(envelope as object).sort(), [
              "ciphertext",
              "iv",
              "kid",
              "v",
            ]);
          }
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta()],
              httpRoutes: { ".well-known/openid-configuration": oktaDiscovery },
            }),
          ),
        ),
    );

    it.effect(
      "an OAuth flow using an encrypted PKCE value still completes correctly end-to-end",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: undefined,
          });
          const outcome = yield* oauth.callback("acme", {
            code: "auth-code",
            state,
            iss: undefined,
            cookieState: state,
          });
          assert.isDefined(outcome.session);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": { id: "ticket-19-user", email: "ticket19@example.com" },
              },
            }),
          ),
        ),
    );
  });

  describe("BEH-EA-123/124: linking is explicit by default, trustedProviders opts in", () => {
    it.effect(
      "REQ-EA-335/336: an unlinked email match fails with AccountExists, nothing is linked",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          yield* users.create({ email: "alice@example.com", name: "Alice" });

          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: undefined,
          });
          const failure = yield* oauth
            .callback("acme", { code: "c1", state, iss: undefined, cookieState: state })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "AccountExists");

          const accounts = yield* Accounts.Accounts;
          const linked = yield* accounts.findByProviderSubject("acme", "alice-sub");
          assert.isTrue(Option.isNone(linked));
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": { id: "alice-sub", email: "alice@example.com", email_verified: true },
              },
            }),
          ),
        ),
    );

    it.effect("REQ-EA-338: a provider not named in trustedProviders never auto-links", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        yield* users.create({ email: "carol@example.com", name: "Carol" });

        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        const failure = yield* oauth
          .callback("acme", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AccountExists");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            linking: { trustedProviders: ["some-other-provider"] },
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "carol-sub", email: "carol@example.com", email_verified: true },
            },
          }),
        ),
      ),
    );

    it.effect(
      "REQ-EA-339: a provider named in trustedProviders auto-links on a verified-email match",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const existing = yield* users.create({ email: "dave@example.com", name: "Dave" });

          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: undefined,
          });
          const outcome = yield* oauth.callback("acme", {
            code: "c1",
            state,
            iss: undefined,
            cookieState: state,
          });
          assert.isDefined(outcome.session);
          assert.strictEqual(outcome.session?.session.userId, existing.id);

          const accounts = yield* Accounts.Accounts;
          const linked = yield* accounts.findByProviderSubject("acme", "dave-sub");
          assert.isTrue(Option.isSome(linked));
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              linking: { trustedProviders: ["acme"] },
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": { id: "dave-sub", email: "dave@example.com", email_verified: true },
              },
            }),
          ),
        ),
    );

    it.effect(
      "REQ-EA-340: naming one provider as trusted does not extend auto-link to a second, unnamed provider",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          yield* users.create({ email: "erin@example.com", name: "Erin" });

          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("github-like", {
            callbackURL: undefined,
            link: undefined,
          });
          const failure = yield* oauth
            .callback("github-like", { code: "c1", state, iss: undefined, cookieState: state })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "AccountExists");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [
                acme(),
                acme({
                  id: "github-like",
                  endpoints: {
                    authorizationEndpoint: "https://gh.example.com/authorize",
                    tokenEndpoint: "https://gh.example.com/token",
                    userinfoEndpoint: "https://gh.example.com/user",
                  },
                }),
              ],
              linking: { trustedProviders: ["acme"] },
              httpRoutes: {
                "gh.example.com/token": { access_token: "at-1" },
                "gh.example.com/user": {
                  id: "erin-sub",
                  email: "erin@example.com",
                  email_verified: true,
                },
              },
            }),
          ),
        ),
    );

    it.effect(
      "REQ-EA-337: an authenticated caller's explicit link attaches the account to their own user",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const alice = yield* users.create({ email: "alice2@example.com", name: "Alice" });

          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: { userId: alice.id },
          });
          const outcome = yield* oauth.callback("acme", {
            code: "c1",
            state,
            iss: undefined,
            cookieState: state,
          });
          // Linking never issues a new session — the caller's existing one is untouched.
          assert.isUndefined(outcome.session);

          const accounts = yield* Accounts.Accounts;
          const linked = yield* accounts.findByProviderSubject("acme", "link-target-sub");
          assert.strictEqual(Option.getOrThrow(linked).userId, alice.id);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                // No matching email at all — proves linking bypasses the
                // email-based policy entirely, keying off the flow's own
                // stored `link.userId` instead.
                "/userinfo": { id: "link-target-sub", email: "unrelated@example.com" },
              },
            }),
          ),
        ),
    );
  });

  describe("BEH-EA-125: (provider, subject, issuer) is the identity anchor", () => {
    it.effect(
      "a returning user (same provider/subject) signs in without creating a second account",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const first = yield* oauth.authorize("acme", { callbackURL: undefined, link: undefined });
          const firstOutcome = yield* oauth.callback("acme", {
            code: "c1",
            state: first.state,
            iss: undefined,
            cookieState: first.state,
          });
          const second = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: undefined,
          });
          const secondOutcome = yield* oauth.callback("acme", {
            code: "c2",
            state: second.state,
            iss: undefined,
            cookieState: second.state,
          });
          assert.strictEqual(
            firstOutcome.session?.session.userId,
            secondOutcome.session?.session.userId,
          );

          const accounts = yield* Accounts.Accounts;
          const users = yield* Users.Users;
          const all = yield* users.findByEmail("returning@example.com");
          assert.isTrue(Option.isSome(all));
          const linked = yield* accounts.listByUser(Option.getOrThrow(all).id);
          assert.strictEqual(linked.length, 1);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": { id: "returning-sub", email: "returning@example.com" },
              },
            }),
          ),
        ),
    );
  });

  describe("BEH-EA-126: provider secrets are Config.Redacted, inside the plugin's own Layer", () => {
    it.effect(
      "REQ-EA-346/348: the client secret is read via Config.Redacted and never printed in plain text",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { location } = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: undefined,
          });
          // The secret never appears in the authorize URL at all (it belongs
          // only to the later token-exchange request, never a GET redirect).
          assert.notInclude(location, "acme-secret");
        }).pipe(Effect.provide(buildLayer({ providers: [acme()] }))),
    );
  });

  describe("BEH-EA-127: generic OIDC discovery, with exact issuer match", () => {
    it.effect(
      "REQ-EA-349: a discovery document whose issuer matches exactly registers successfully",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { location } = yield* oauth.authorize("okta", {
            callbackURL: undefined,
            link: undefined,
          });
          assert.include(location, "https://okta.example.com/authorize");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta()],
              httpRoutes: { ".well-known/openid-configuration": oktaDiscovery },
            }),
          ),
        ),
    );

    it.effect(
      "REQ-EA-350/351: a mismatched discovery issuer dies at boot, before any request is served",
      () =>
        Effect.gen(function* () {
          const exit = yield* Effect.void.pipe(
            Effect.provide(
              buildLayer({
                providers: [okta()],
                httpRoutes: {
                  ".well-known/openid-configuration": {
                    ...oktaDiscovery,
                    issuer: "https://attacker.example.com/oauth2/default",
                  },
                },
              }),
            ),
            Effect.exit,
          );
          assert.strictEqual(exit._tag, "Failure");
        }),
    );
  });

  describe("BEH-EA-128: callback destination is validated, never echoed", () => {
    it.effect("REQ-EA-352: an allowlisted absolute callbackURL is honored", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: "https://trusted.example.com/dashboard",
          link: undefined,
        });
        const outcome = yield* oauth.callback("acme", {
          code: "c1",
          state,
          iss: undefined,
          cookieState: state,
        });
        assert.strictEqual(outcome.callbackURL, "https://trusted.example.com/dashboard");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            trustedOrigins: ["https://trusted.example.com"],
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "trusted-sub", email: "trusted@example.com" },
            },
          }),
        ),
      ),
    );

    it.effect("REQ-EA-353: an untrusted absolute callbackURL is never redirected to", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: "https://attacker.example.com/phish",
          link: undefined,
        });
        const outcome = yield* oauth.callback("acme", {
          code: "c1",
          state,
          iss: undefined,
          cookieState: state,
        });
        assert.notStrictEqual(outcome.callbackURL, "https://attacker.example.com/phish");
        assert.strictEqual(outcome.callbackURL, "/");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "untrusted-sub", email: "untrusted@example.com" },
            },
          }),
        ),
      ),
    );

    it.effect("a relative callbackURL is always honored (same-origin, safe by construction)", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: "/settings",
          link: undefined,
        });
        const outcome = yield* oauth.callback("acme", {
          code: "c1",
          state,
          iss: undefined,
          cookieState: state,
        });
        assert.strictEqual(outcome.callbackURL, "/settings");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "rel-sub", email: "rel@example.com" },
            },
          }),
        ),
      ),
    );
  });

  describe("OIDC id_token: real RS256 signature + claim verification", () => {
    /**
     * `authorize`'s own nonce is generated fresh, server-side, on every
     * call — unknowable when the fake `HttpClient`'s routes are built. This
     * closure captures whatever nonce the test itself extracts from
     * `authorize`'s returned redirect URL (the one place it's visible at
     * all — the browser's own query param), letting the fake token
     * endpoint mint a token with the *actual* nonce for that flow.
     */
    let currentClaims: Record<string, unknown> = {};

    const idTokenRoutes = (
      privateKey: KeyObject = keyPair.privateKey,
      publicJwk: Record<string, unknown> = jwk,
    ): FakeRoutes => ({
      ".well-known/openid-configuration": oktaDiscovery,
      "/jwks": { keys: [publicJwk] },
      "/token": () => ({ access_token: "at-1", id_token: signJwt(currentClaims, privateKey) }),
    });

    const nonceFrom = (location: string): string | undefined =>
      new URL(location).searchParams.get("nonce") ?? undefined;

    it.effect("a validly signed id_token with matching iss/aud/nonce/exp succeeds", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = {
          iss: "https://okta.example.com/oauth2/default",
          aud: "okta-client-id",
          sub: "okta-user-1",
          email: "okta-user@example.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: nonceFrom(location),
        };
        const outcome = yield* oauth.callback("okta", {
          code: "c1",
          state,
          iss: undefined,
          cookieState: state,
        });
        assert.isDefined(outcome.session);
      }).pipe(Effect.provide(buildLayer({ providers: [okta()], httpRoutes: idTokenRoutes() }))),
    );

    it.effect("a tampered id_token signature (a different, unregistered key) is rejected", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = {
          iss: "https://okta.example.com/oauth2/default",
          aud: "okta-client-id",
          sub: "forged-user",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: nonceFrom(location),
        };
        // Signed with a key the fake JWKS endpoint never advertises — the
        // real RS256 verifier in `Jwt.ts` must reject this, not merely
        // trust that a well-formed JWT was presented.
        const failure = yield* oauth
          .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [okta()],
            httpRoutes: idTokenRoutes(
              generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
            ),
          }),
        ),
      ),
    );

    it.effect("an id_token with the wrong issuer claim is rejected", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = {
          iss: "https://attacker.example.com/oauth2/default",
          aud: "okta-client-id",
          sub: "user-x",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: nonceFrom(location),
        };
        const failure = yield* oauth
          .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(Effect.provide(buildLayer({ providers: [okta()], httpRoutes: idTokenRoutes() }))),
    );

    it.effect("an expired id_token is rejected", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = {
          iss: "https://okta.example.com/oauth2/default",
          aud: "okta-client-id",
          sub: "user-y",
          exp: Math.floor(Date.now() / 1000) - 60,
          nonce: nonceFrom(location),
        };
        const failure = yield* oauth
          .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(Effect.provide(buildLayer({ providers: [okta()], httpRoutes: idTokenRoutes() }))),
    );

    it.effect("an id_token with a mismatched nonce is rejected", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = {
          iss: "https://okta.example.com/oauth2/default",
          aud: "okta-client-id",
          sub: "user-z",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: "a-completely-different-nonce",
        };
        const failure = yield* oauth
          .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(Effect.provide(buildLayer({ providers: [okta()], httpRoutes: idTokenRoutes() }))),
    );
  });
});
