// spec/behaviors/16-oauth.md, BEH-EA-121 through BEH-EA-128.
//
// Real, domain-level tests (no HTTP layer here — see `AuthHttp.test.ts` for
// the wire-level counterpart): a real in-memory `Users`/`Accounts`/
// `Sessions`/`Verification`/`AuthEvents`, a fake `HttpClient` only for the
// provider transport (discovery/token/userinfo/JWKS — the same category of
// swap `TestClock` is for time), and, for the `"oidc"` scenarios, a real
// RSA keypair signing a real RS256 `id_token` that `Jwt.ts`'s own verifier
// checks — not a stub that always returns `true`.
import { createHmac, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
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
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { Authentication } from "@awthaq/server";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as OAuth from "../src/OAuth.ts";
import * as OAuthConnections from "../src/OAuthConnections.ts";
import * as OAuthProvider from "../src/OAuthProvider.ts";
import * as OAuthTokenAccess from "../src/OAuthTokenAccess.ts";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { FakeReply, fakeHttpClient, hangingRoute, type FakeRoutes } from "./FakeProvider.ts";

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
  kid: string = KID,
): string => {
  const header = { alg: "RS256", typ: "JWT", kid };
  const headerSegment = toBase64Url(Buffer.from(JSON.stringify(header)));
  const payloadSegment = toBase64Url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = nodeSign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${toBase64Url(signature)}`;
};

// AOMS-005: an ES256 signer/JWKS beside the RS256 one — same claims, a different algorithm.
const ecKeyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const EC_KID = "test-ec-key-1";
const ecJwk = {
  ...(ecKeyPair.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
  kid: EC_KID,
  alg: "ES256",
};
const signEs256 = (payload: Record<string, unknown>, kid: string = EC_KID): string => {
  const header = { alg: "ES256", typ: "JWT", kid };
  const headerSegment = toBase64Url(Buffer.from(JSON.stringify(header)));
  const payloadSegment = toBase64Url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const signature = nodeSign("sha256", Buffer.from(signingInput), {
    key: ecKeyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
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

// ---- shared core/domain layers ----

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const baseUrl = "https://app.example.com";

/** The claims the FAMS-006 test's fake token endpoint signs (the nonce is only known after `authorize`). */
let currentAnchorClaims: Record<string, unknown> = {};

const buildLayer = (options: {
  readonly providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>;
  readonly linking?: "explicit" | { readonly trustedProviders: ReadonlyArray<string> };
  readonly trustedOrigins?: ReadonlyArray<string>;
  readonly httpRoutes?: FakeRoutes;
  readonly baseUrl?: string;
  readonly httpTimeouts?: OAuth.OAuthConfigInput["httpTimeouts"];
  readonly retry?: OAuth.OAuthConfigInput["retry"];
  /** Extra `OAuth.config` fields (clock skew, id_token age, ...). */
  readonly config?: Partial<OAuth.OAuthConfigInput>;
  /** EP-004: per-organization connections, consulted after the static registry. */
  readonly connections?: OAuthConnections.OAuthConnectionResolverShape;
}) =>
  OAuth.OAuth.layer.pipe(
    Layer.provide(
      options.connections === undefined
        ? Layer.empty
        : OAuthConnections.layer(options.connections),
    ),
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
    // AGA-001/NHS-003: `OAuth`'s callback handler now resolves through
    // `ClientAddress` — the direct passthrough is byte-for-byte today's
    // `remoteAddress` behavior.
    Layer.provideMerge(ClientAddress.layerDirect),
    Layer.provideMerge(EncryptionLive),
    Layer.provide(fakeHttpClient(options.httpRoutes ?? {})),
    Layer.provide(
      OAuth.config({
        providers: options.providers,
        linking: options.linking ?? "explicit",
        trustedOrigins: options.trustedOrigins ?? [],
        baseUrl: options.baseUrl ?? baseUrl,
        // Zero backoff by default: a retry never sleeps on the TestClock.
        retry: { base: Duration.zero, ...options.retry },
        ...(options.httpTimeouts === undefined ? {} : { httpTimeouts: options.httpTimeouts }),
        ...options.config,
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

  describe("CSD-003: the callback's request context lands on the minted session", () => {
    it.effect("records the client ip and user agent the handler passed", () =>
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
          ip: "203.0.113.9",
          userAgent: "OAuthTest/1.0",
        });
        assert.isDefined(outcome.session);
        assert.deepStrictEqual(outcome.session?.session.ipAddress, Option.some("203.0.113.9"));
        assert.deepStrictEqual(outcome.session?.session.userAgent, Option.some("OAuthTest/1.0"));
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

  describe("CSD-003: the issued session records the callback request's context", () => {
    it.effect("callback passes ip and userAgent through to Sessions.issue", () =>
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
          ip: "203.0.113.20",
          userAgent: "OAuthBrowser/1.0",
        });
        assert.isDefined(outcome.session);
        assert.deepStrictEqual(outcome.session?.session.amr, ["fed"]);
        assert.deepStrictEqual(outcome.session?.session.ipAddress, Option.some("203.0.113.20"));
        assert.deepStrictEqual(outcome.session?.session.userAgent, Option.some("OAuthBrowser/1.0"));
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "csd003-user", email: "csd003@example.com" },
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
          yield* users.create({
            identity: { _tag: "Email", email: "alice@example.com" },
            name: "Alice",
          });

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
        yield* users.create({
          identity: { _tag: "Email", email: "carol@example.com" },
          name: "Carol",
        });

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
          const existing = yield* users.create({
            identity: { _tag: "Email", email: "dave@example.com" },
            name: "Dave",
          });
          // TMS-007: auto-link needs the local account's email proven too.
          yield* users.verifyEmail(existing.id);

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
          yield* users.create({
            identity: { _tag: "Email", email: "erin@example.com" },
            name: "Erin",
          });

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
          const alice = yield* users.create({
            identity: { _tag: "Email", email: "alice2@example.com" },
            name: "Alice",
          });

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

  describe("account-linking trust policy (TMS-007/AOMS-007/NAM-006)", () => {
    const trustedAcme = (routes: FakeRoutes) =>
      buildLayer({
        providers: [acme()],
        linking: { trustedProviders: ["acme"] },
        httpRoutes: routes,
      });

    const callbackAsAcme = Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const { state } = yield* oauth.authorize("acme", { callbackURL: undefined, link: undefined });
      return oauth.callback("acme", { code: "c1", state, iss: undefined, cookieState: state });
    });

    it.effect(
      "TMS-007: a trusted provider does not auto-link into an unverified local account",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          yield* users.create({
            identity: { _tag: "Email", email: "squat@example.com" },
            name: "Squatter",
          });
          const callback = yield* callbackAsAcme;
          const failure = yield* callback.pipe(Effect.flip);
          assert.strictEqual(failure._tag, "AccountExists");
          const accounts = yield* Accounts.Accounts;
          assert.isTrue(Option.isNone(yield* accounts.findByProviderSubject("acme", "squat-sub")));
        }).pipe(
          Effect.provide(
            trustedAcme({
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "squat-sub", email: "squat@example.com", email_verified: true },
            }),
          ),
        ),
    );

    it.effect("TMS-007: a trusted provider still auto-links into a verified local account", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const local = yield* users.create({
          identity: { _tag: "Email", email: "proven@example.com" },
          name: "Proven",
        });
        yield* users.verifyEmail(local.id);
        const callback = yield* callbackAsAcme;
        const outcome = yield* callback;
        assert.strictEqual(outcome.session?.session.userId, local.id);
      }).pipe(
        Effect.provide(
          trustedAcme({
            "/token": { access_token: "at-1" },
            "/userinfo": { id: "proven-sub", email: "proven@example.com", email_verified: true },
          }),
        ),
      ),
    );

    it.effect("AOMS-007: a trusted provider asserting email_verified creates a verified user", () =>
      Effect.gen(function* () {
        const callback = yield* callbackAsAcme;
        yield* callback;
        const users = yield* Users.Users;
        const created = Option.getOrThrow(yield* users.findByEmail("jit-trusted@example.com"));
        assert.isTrue(Users.isEmailVerified(created));
      }).pipe(
        Effect.provide(
          trustedAcme({
            "/token": { access_token: "at-1" },
            "/userinfo": {
              id: "jit-trusted-sub",
              email: "jit-trusted@example.com",
              email_verified: true,
            },
          }),
        ),
      ),
    );

    it.effect(
      "AOMS-007: an untrusted provider asserting email_verified creates an unverified user",
      () =>
        Effect.gen(function* () {
          const callback = yield* callbackAsAcme;
          yield* callback;
          const users = yield* Users.Users;
          const created = Option.getOrThrow(yield* users.findByEmail("jit-untrusted@example.com"));
          assert.isFalse(Users.isEmailVerified(created));
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": {
                  id: "jit-untrusted-sub",
                  email: "jit-untrusted@example.com",
                  email_verified: true,
                },
              },
            }),
          ),
        ),
    );

    it.effect(
      "AOMS-007: a trusted provider that does not assert email_verified creates an unverified user",
      () =>
        Effect.gen(function* () {
          const callback = yield* callbackAsAcme;
          yield* callback;
          const users = yield* Users.Users;
          const created = Option.getOrThrow(yield* users.findByEmail("jit-unasserted@example.com"));
          assert.isFalse(Users.isEmailVerified(created));
        }).pipe(
          Effect.provide(
            trustedAcme({
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "jit-unasserted-sub", email: "jit-unasserted@example.com" },
            }),
          ),
        ),
    );

    it.effect(
      "FAMS-002: a provider profile without an email creates an Anonymous user, never a synthetic email",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const accounts = yield* Accounts.Accounts;
          const first = yield* yield* callbackAsAcme;
          assert.isDefined(first.session);
          const linked = Option.getOrThrow(
            yield* accounts.findByProviderSubject("acme", "no-email-sub"),
          );
          const user = yield* users.findById(linked.userId);
          assert.deepStrictEqual(user.identity, { _tag: "Anonymous" });
          assert.strictEqual(user.name, "no-email-sub");
          // No row anywhere holds the old `${providerId}:${subject}` placeholder.
          assert.isTrue(Option.isNone(yield* users.findByEmail("acme:no-email-sub")));

          // The next sign-in resolves the same user through the linked account.
          const second = yield* yield* callbackAsAcme;
          assert.strictEqual(second.session?.session.userId, user.id);
          assert.strictEqual((yield* users.list()).items.length, 1);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": { id: "no-email-sub" },
              },
            }),
          ),
        ),
    );

    it.effect(
      "NAM-009: an http(s) avatar from the profile lands on the created user; anything else is dropped",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          yield* yield* callbackAsAcme;
          const good = Option.getOrThrow(yield* users.findByEmail("avatar@example.com"));
          assert.deepStrictEqual(good.image, Option.some("https://cdn.example.com/a.png"));
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [
                acme({
                  mapProfile: (claims) => ({
                    subject: claims["id"] as string,
                    email: claims["email"] as string,
                    image: claims["picture"] as string,
                  }),
                }),
              ],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": {
                  id: "avatar-sub",
                  email: "avatar@example.com",
                  picture: "https://cdn.example.com/a.png",
                },
              },
            }),
          ),
        ),
    );

    it.effect("NAM-009: a non-http(s) avatar claim (javascript:, data:) is never stored", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        yield* yield* callbackAsAcme;
        const created = Option.getOrThrow(yield* users.findByEmail("evil-avatar@example.com"));
        assert.isTrue(Option.isNone(created.image));
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [
              acme({
                mapProfile: (claims) => ({
                  subject: claims["id"] as string,
                  email: claims["email"] as string,
                  image: claims["picture"] as string,
                }),
              }),
            ],
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": {
                id: "evil-avatar-sub",
                email: "evil-avatar@example.com",
                picture: "javascript:alert(1)",
              },
            },
          }),
        ),
      ),
    );

    it.effect(
      "SCP-001: a suspended user's callback is refused with UserSuspended and issues no session",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const sessions = yield* Sessions.Sessions;
          const created = Option.getOrThrow(
            yield* Effect.gen(function* () {
              yield* yield* callbackAsAcme;
              return yield* users.findByEmail("suspendable@example.com");
            }),
          );
          yield* users.setStatus(created.id, "suspended", { reason: "abuse" });
          const before = (yield* sessions.list(created.id)).length;
          const refused = yield* (yield* callbackAsAcme).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "UserSuspended");
          assert.strictEqual((yield* sessions.list(created.id)).length, before);

          yield* users.setStatus(created.id, "active");
          const restored = yield* yield* callbackAsAcme;
          assert.strictEqual(restored.session?.session.userId, created.id);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": { id: "suspendable-sub", email: "suspendable@example.com" },
              },
            }),
          ),
        ),
    );

    const seedPasskeyOnlyUser = Effect.gen(function* () {
      const users = yield* Users.Users;
      const accounts = yield* Accounts.Accounts;
      const local = yield* users.create({
        identity: { _tag: "Email", email: "passkey-only@example.com" },
        name: "Passkey",
      });
      yield* accounts.link({ userId: local.id, providerId: "passkey", subject: "credential-1" });
    });

    it.effect(
      "NAM-006: AccountExists lists the providers the user actually has (a passkey-only user)",
      () =>
        Effect.gen(function* () {
          yield* seedPasskeyOnlyUser;
          const callback = yield* callbackAsAcme;
          const failure = yield* callback.pipe(Effect.flip);
          assert.strictEqual(failure._tag, "AccountExists");
          if (failure._tag === "AccountExists")
            assert.deepStrictEqual(failure.providers, ["passkey"]);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": {
                  id: "pk-sub",
                  email: "passkey-only@example.com",
                  email_verified: true,
                },
              },
            }),
          ),
        ),
    );

    it.effect("NAM-006: AccountExists lists nothing when the provider's email is unverified", () =>
      Effect.gen(function* () {
        yield* seedPasskeyOnlyUser;
        const callback = yield* callbackAsAcme;
        const failure = yield* callback.pipe(Effect.flip);
        assert.strictEqual(failure._tag, "AccountExists");
        if (failure._tag === "AccountExists") assert.deepStrictEqual(failure.providers, []);
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "pk-sub-2", email: "passkey-only@example.com" },
            },
          }),
        ),
      ),
    );
  });

  describe("BEH-EA-125: (provider, subject, issuer) is the identity anchor", () => {
    it.effect(
      "FAMS-006: accountAnchorFor is exactly the key callback looks an imported account up by",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const accounts = yield* Accounts.Accounts;
          const imported = yield* users.create({
            identity: { _tag: "Email", email: "imported@example.com" },
            name: "Imported",
          });
          // What an importer writes: the anchor, computed from the provider config.
          yield* accounts.link({
            userId: imported.id,
            ...(yield* OAuth.accountAnchorFor(okta(), "imported-sub")),
          });

          const oauth = yield* OAuth.OAuth;
          const { state, location } = yield* oauth.authorize("okta", {
            callbackURL: undefined,
            link: undefined,
          });
          currentAnchorClaims = {
            iss: "https://okta.example.com/oauth2/default",
            aud: "okta-client-id",
            sub: "imported-sub",
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: new URL(location).searchParams.get("nonce"),
          };
          const outcome = yield* oauth.callback("okta", {
            code: "c1",
            state,
            iss: undefined,
            cookieState: state,
          });
          // Signed in as the imported user; no second user or account appeared.
          assert.strictEqual(outcome.session?.session.userId, imported.id);
          assert.strictEqual((yield* accounts.listByUser(imported.id)).length, 1);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta()],
              httpRoutes: {
                ".well-known/openid-configuration": oktaDiscovery,
                "/jwks": { keys: [jwk] },
                "/token": () => ({ access_token: "at-1", id_token: signJwt(currentAnchorClaims) }),
              },
            }),
          ),
        ),
    );

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

  describe("non-secret provider fields accept plain strings (BO-009)", () => {
    it.effect("oidc({ issuer, discoveryUrl, clientId }) given plain strings resolves", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        assert.strictEqual(new URL(location).searchParams.get("client_id"), "plain-client-id");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [
              OAuthProvider.oidc({
                id: "okta",
                issuer: "https://okta.example.com/oauth2/default",
                discoveryUrl: "https://okta.example.com/.well-known/openid-configuration",
                clientId: "plain-client-id",
                clientSecret: Config.succeed(Redacted.make("okta-secret")),
                scopes: ["openid"],
                mapProfile: (claims) => ({ subject: String(claims["sub"]) }),
              }),
            ],
            httpRoutes: { ".well-known/openid-configuration": oktaDiscovery },
          }),
        ),
      ),
    );

    it("a plain-string clientSecret is rejected by the type (BEH-EA-126: secrets are Config.Redacted only)", () => {
      OAuthProvider.oauth2({
        id: "leaky",
        clientId: "abc",
        // @ts-expect-error a secret must be a Config<Redacted>, never a bare string.
        clientSecret: "hunter2",
        scopes: [],
        endpoints: {
          authorizationEndpoint: "https://x.example.com/a",
          tokenEndpoint: "https://x.example.com/t",
        },
        mapProfile: () => ({ subject: "x" }),
      });
    });
  });

  describe("boot-time provider configuration validation (ESS-002/OAP-005/JR-009)", () => {
    /** The rendered defect message of a boot that must die, or `undefined` if it booted. */
    const bootDefect = (
      options: Parameters<typeof buildLayer>[0],
    ): Effect.Effect<string | undefined> =>
      Effect.void.pipe(
        Effect.provide(buildLayer(options)),
        Effect.exit,
        Effect.map((exit) => (exit._tag === "Failure" ? Cause.pretty(exit.cause) : undefined)),
      );

    it.effect(
      "ESS-002: a discovery token_endpoint that is not a string dies at boot naming the field",
      () =>
        Effect.gen(function* () {
          const message = yield* bootDefect({
            providers: [okta()],
            httpRoutes: {
              ".well-known/openid-configuration": { ...oktaDiscovery, token_endpoint: 42 },
            },
          });
          assert.isDefined(message);
          assert.include(message, "okta");
          assert.include(message, "token_endpoint");
        }),
    );

    it.effect("AOMS-005: discovery advertising only unsupported id_token algorithms dies at boot", () =>
      Effect.gen(function* () {
        const message = yield* bootDefect({
          providers: [okta()],
          httpRoutes: {
            ".well-known/openid-configuration": {
              ...oktaDiscovery,
              id_token_signing_alg_values_supported: ["HS256", "none"],
            },
          },
        });
        assert.isDefined(message);
        assert.include(message, "okta");
        assert.include(message, "id_token");
      }),
    );

    it.effect("ESS-002: a JSON array discovery body dies at boot", () =>
      Effect.gen(function* () {
        const message = yield* bootDefect({
          providers: [okta()],
          httpRoutes: { ".well-known/openid-configuration": [] },
        });
        assert.isDefined(message);
        assert.include(message, "discovery document is invalid");
      }),
    );

    it.effect("ESS-002: a discovery endpoint that is not an absolute URL dies at boot", () =>
      Effect.gen(function* () {
        const message = yield* bootDefect({
          providers: [okta()],
          httpRoutes: {
            ".well-known/openid-configuration": { ...oktaDiscovery, token_endpoint: "not a url" },
          },
        });
        assert.isDefined(message);
        assert.include(message, "token_endpoint");
      }),
    );

    it.effect("OAP-005: quirks.skipPkce without a clientSecret dies at boot", () =>
      Effect.gen(function* () {
        const { clientSecret: _omitted, ...publicClient } = acme({ quirks: { skipPkce: true } });
        const message = yield* bootDefect({ providers: [publicClient] });
        assert.isDefined(message);
        assert.include(message, "skipPkce");
      }),
    );

    it.effect("OAP-005: quirks.skipPkce with a clientSecret still boots", () =>
      Effect.gen(function* () {
        const message = yield* bootDefect({ providers: [acme({ quirks: { skipPkce: true } })] });
        assert.isUndefined(message);
      }),
    );

    it.effect("JR-009: an oidc provider whose scopes omit openid dies at boot", () =>
      Effect.gen(function* () {
        const message = yield* bootDefect({
          providers: [okta({ scopes: ["email", "profile"] })],
          httpRoutes: { ".well-known/openid-configuration": oktaDiscovery },
        });
        assert.isDefined(message);
        assert.include(message, "openid");
      }),
    );
  });

  describe("outbound provider calls: deadlines, retries, 503 channel (ECF-001/EEM-004/ERS-003/NAM-004)", () => {
    /**
     * Forks `effect`, waits until its outbound call is pending on the hung
     * route, advances the TestClock by `by`, and joins — no real waiting.
     */
    const afterAdvancing = <A, E, R>(
      hang: ReturnType<typeof hangingRoute>,
      by: Duration.Duration,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(effect);
        yield* hang.reached;
        yield* TestClock.adjust(by);
        return yield* Fiber.join(fiber);
      });

    const acmeCallback = Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const { state } = yield* oauth.authorize("acme", { callbackURL: undefined, link: undefined });
      return yield* oauth
        .callback("acme", { code: "c1", state, iss: undefined, cookieState: state })
        .pipe(Effect.flip);
    });

    const acmeRoutes = {
      "/token": { access_token: "at-1" },
      "/userinfo": { id: "acme-user-1", email: "ada@example.com" },
    };

    it.effect(
      "ECF-001: a token endpoint that never answers fails ProviderUnavailable at its deadline",
      () => {
        const hang = hangingRoute();
        return Effect.gen(function* () {
          const failure = yield* afterAdvancing(hang, Duration.seconds(3), acmeCallback);
          assert.strictEqual(failure._tag, "ProviderUnavailable");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: { ...acmeRoutes, "/token": hang.route },
              httpTimeouts: { tokenExchange: Duration.seconds(3) },
            }),
          ),
        );
      },
    );

    it.effect(
      "ECF-001: a userinfo endpoint that never answers fails ProviderUnavailable at its deadline",
      () => {
        const hang = hangingRoute();
        return Effect.gen(function* () {
          const failure = yield* afterAdvancing(hang, Duration.seconds(3), acmeCallback);
          assert.strictEqual(failure._tag, "ProviderUnavailable");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: { ...acmeRoutes, "/userinfo": hang.route },
              httpTimeouts: { userinfo: Duration.seconds(3) },
              retry: { times: 0 },
            }),
          ),
        );
      },
    );

    it.effect(
      "ECF-001: a discovery endpoint that never answers dies at boot at its deadline",
      () => {
        const hang = hangingRoute();
        return Effect.gen(function* () {
          const exit = yield* afterAdvancing(
            hang,
            Duration.seconds(3),
            Effect.void.pipe(
              Effect.provide(
                buildLayer({
                  providers: [okta()],
                  httpRoutes: { ".well-known/openid-configuration": hang.route },
                  httpTimeouts: { discovery: Duration.seconds(3) },
                  retry: { times: 0 },
                }),
              ),
              Effect.exit,
            ),
          );
          if (exit._tag === "Success") return assert.fail("expected boot to die");
          assert.include(Cause.pretty(exit.cause), "unreachable");
        });
      },
    );

    it.effect(
      "EEM-004: a token endpoint answering 503 is ProviderUnavailable, not OAuthCallbackFailed",
      () =>
        Effect.gen(function* () {
          const failure = yield* acmeCallback;
          assert.strictEqual(failure._tag, "ProviderUnavailable");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: { ...acmeRoutes, "/token": new FakeReply(503) },
            }),
          ),
        ),
    );

    it.effect(
      "EEM-004: a token endpoint answering 400 invalid_grant is still OAuthCallbackFailed",
      () =>
        Effect.gen(function* () {
          const failure = yield* acmeCallback;
          assert.strictEqual(failure._tag, "OAuthCallbackFailed");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                ...acmeRoutes,
                "/token": new FakeReply(400, { error: "invalid_grant" }),
              },
            }),
          ),
        ),
    );

    it.effect("EEM-004: a userinfo 401 is a protocol failure, never mistaken for a claim set", () =>
      Effect.gen(function* () {
        const failure = yield* acmeCallback;
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              ...acmeRoutes,
              "/userinfo": new FakeReply(401, { error: "invalid_token" }),
            },
          }),
        ),
      ),
    );

    it.effect("ERS-003: a token endpoint that 503s is NOT retried (the code is single-use)", () => {
      let tokenCalls = 0;
      return Effect.gen(function* () {
        const failure = yield* acmeCallback;
        assert.strictEqual(failure._tag, "ProviderUnavailable");
        assert.strictEqual(tokenCalls, 1);
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              ...acmeRoutes,
              "/token": () => {
                tokenCalls += 1;
                return new FakeReply(503);
              },
            },
          }),
        ),
      );
    });

    it.effect(
      "ERS-003: a userinfo endpoint that 503s once then succeeds still completes the sign-in",
      () => {
        let userinfoCalls = 0;
        return Effect.gen(function* () {
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
          assert.strictEqual(userinfoCalls, 2);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                ...acmeRoutes,
                "/userinfo": () => {
                  userinfoCalls += 1;
                  return userinfoCalls === 1
                    ? new FakeReply(503)
                    : { id: "acme-user-1", email: "ada@example.com" };
                },
              },
            }),
          ),
        );
      },
    );

    it.effect(
      "ERS-003/NAM-004: a discovery endpoint that fails once at boot still registers the provider",
      () => {
        let discoveryCalls = 0;
        return Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { location } = yield* oauth.authorize("okta", {
            callbackURL: undefined,
            link: undefined,
          });
          assert.include(location, "https://okta.example.com/authorize");
          assert.strictEqual(discoveryCalls, 2);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta()],
              httpRoutes: {
                ".well-known/openid-configuration": () => {
                  discoveryCalls += 1;
                  return discoveryCalls === 1 ? new FakeReply(503) : oktaDiscovery;
                },
              },
            }),
          ),
        );
      },
    );

    it.effect(
      "NAM-004: a lazy provider whose discovery is down boots, answers 503, then recovers",
      () => {
        let discoveryUp = false;
        return Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          // The rest of the runtime is unaffected by the down provider.
          const other = yield* oauth.authorize("acme", { callbackURL: undefined, link: undefined });
          assert.include(other.location, "https://acme.example.com/authorize");
          const down = yield* oauth
            .authorize("okta", { callbackURL: undefined, link: undefined })
            .pipe(Effect.flip);
          assert.strictEqual(down._tag, "ProviderUnavailable");
          discoveryUp = true;
          const { location } = yield* oauth.authorize("okta", {
            callbackURL: undefined,
            link: undefined,
          });
          assert.include(location, "https://okta.example.com/authorize");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme(), okta({ discovery: { mode: "lazy" } })],
              retry: { times: 0 },
              httpRoutes: {
                ".well-known/openid-configuration": () =>
                  discoveryUp ? oktaDiscovery : new FakeReply(503),
              },
            }),
          ),
        );
      },
    );

    it.effect(
      "NAM-004: a lazy provider whose fetched issuer mismatches never serves a request",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const first = yield* oauth
            .authorize("okta", { callbackURL: undefined, link: undefined })
            .pipe(Effect.flip);
          assert.strictEqual(first._tag, "ProviderUnavailable");
          const second = yield* oauth
            .authorize("okta", { callbackURL: undefined, link: undefined })
            .pipe(Effect.flip);
          assert.strictEqual(second._tag, "ProviderUnavailable");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta({ discovery: { mode: "lazy" } })],
              httpRoutes: {
                ".well-known/openid-configuration": {
                  ...oktaDiscovery,
                  issuer: "https://attacker.example.com/oauth2/default",
                },
              },
            }),
          ),
        ),
    );

    it.effect(
      "NAM-004: OAuth and OAuthTokenAccess share one resolved registry (discovery fetched once)",
      () => {
        let discoveryCalls = 0;
        const both = Layer.merge(OAuth.OAuth.layer, OAuthTokenAccess.layer).pipe(
          Layer.provide(Authentication.OptionalAuthenticationLive),
          Layer.provide(Authentication.PrincipalResolverLive),
          Layer.provideMerge(CoreLive),
          Layer.provideMerge(RateLimiter.layerPermissive),
          Layer.provideMerge(RateLimits.layer),
          Layer.provideMerge(SqlTransaction.layerNoop),
          Layer.provideMerge(ClientAddress.layerDirect),
          Layer.provideMerge(EncryptionLive),
          Layer.provide(
            fakeHttpClient({
              ".well-known/openid-configuration": () => {
                discoveryCalls += 1;
                return oktaDiscovery;
              },
            }),
          ),
          Layer.provide(OAuth.config({ providers: [okta()], baseUrl })),
        );
        return Effect.gen(function* () {
          yield* OAuthTokenAccess.OAuthTokenAccess;
          assert.strictEqual(discoveryCalls, 1);
        }).pipe(Effect.provide(both));
      },
    );
  });

  describe("OAP-008: authorize has its own registered rate-limit rule", () => {
    it.effect("the RateLimits registry lists an authorize rule beside the callback rule", () =>
      Effect.gen(function* () {
        const registry = yield* RateLimits.RateLimitsRegistry;
        const rules = yield* registry.registered;
        const endpoints = rules
          .filter((rule) => rule.group === "oauth")
          .map((rule) => rule.endpoint);
        assert.sameMembers([...endpoints], ["authorize", "callback"]);
      }).pipe(Effect.provide(buildLayer({ providers: [acme()] }))),
    );
  });

  describe("baseUrl is required config, validated at boot (PDR-005/AGA-005)", () => {
    /** Boots `options` with a capturing logger and reports what it logged, or the defect it died with. */
    const boot = (options: Parameters<typeof buildLayer>[0]) =>
      Effect.gen(function* () {
        const logs: Array<{ readonly level: string; readonly message: string }> = [];
        const capture = Logger.make((entry) => {
          logs.push({ level: entry.logLevel, message: JSON.stringify(entry.message) });
        });
        const exit = yield* Effect.void.pipe(
          Effect.provide(Layer.provide(buildLayer(options), Logger.layer([capture]))),
          Effect.exit,
        );
        return { exit, logs };
      });

    it("OAuth.config cannot be called without a baseUrl", () => {
      // @ts-expect-error baseUrl is required: there is no default public origin.
      const layer = OAuth.config({});
      assert.isDefined(layer);
    });

    it.effect("a baseUrl with a path component fails at boot", () =>
      Effect.gen(function* () {
        const { exit } = yield* boot({
          providers: [acme()],
          baseUrl: "https://app.example.com/auth",
        });
        if (exit._tag === "Success") return assert.fail("expected boot to die");
        assert.include(Cause.pretty(exit.cause), "baseUrl");
      }),
    );

    it.effect("a baseUrl that does not parse fails at boot", () =>
      Effect.gen(function* () {
        const { exit } = yield* boot({ providers: [acme()], baseUrl: "not a url" });
        assert.strictEqual(exit._tag, "Failure");
      }),
    );

    it.effect("a plain-http non-localhost baseUrl boots but logs a warning", () =>
      Effect.gen(function* () {
        const { exit, logs } = yield* boot({
          providers: [acme()],
          baseUrl: "http://app.example.com",
        });
        assert.strictEqual(exit._tag, "Success");
        assert.isTrue(
          logs.some((entry) => entry.level === "Warn" && entry.message.includes("plain http")),
        );
      }),
    );

    it.effect("a plain-http localhost baseUrl does not warn", () =>
      Effect.gen(function* () {
        const { exit, logs } = yield* boot({
          providers: [acme()],
          baseUrl: "http://localhost:3000",
        });
        assert.strictEqual(exit._tag, "Success");
        assert.isFalse(logs.some((entry) => entry.level === "Warn"));
      }),
    );

    it.effect("AGA-005: boot logs the effective redirect_uri for each provider", () =>
      Effect.gen(function* () {
        const { logs } = yield* boot({ providers: [acme()], baseUrl: "https://app.example.com/" });
        // A trailing slash is normalized away, never doubled into the redirect_uri.
        assert.isTrue(
          logs.some((entry) =>
            entry.message.includes("https://app.example.com/oauth/acme/callback"),
          ),
        );
      }),
    );

    it.effect("a trailing slash on baseUrl does not double up in the authorize redirect_uri", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { location } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        assert.strictEqual(
          new URL(location).searchParams.get("redirect_uri"),
          "https://app.example.com/oauth/acme/callback",
        );
      }).pipe(
        Effect.provide(buildLayer({ providers: [acme()], baseUrl: "https://app.example.com/" })),
      ),
    );
  });

  describe("token endpoint client authentication (AP-006)", () => {
    /** What one token request looked like on the wire. */
    interface SeenRequest {
      readonly authorization: string | undefined;
      readonly accept: string | undefined;
      readonly form: URLSearchParams;
    }
    const recordingTokenRoute =
      (seen: Array<SeenRequest>) => (request: HttpClientRequest.HttpClientRequest) => {
        const body = request.body;
        seen.push({
          authorization: request.headers["authorization"],
          accept: request.headers["accept"],
          form: new URLSearchParams(
            body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "",
          ),
        });
        return { access_token: "at-1" };
      };

    const exchange = Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const { state } = yield* oauth.authorize("okta", { callbackURL: undefined, link: undefined });
      return yield* oauth
        .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
        .pipe(Effect.flip);
    });

    const boot = (
      providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>,
      discovery: Record<string, unknown>,
    ) =>
      Effect.void.pipe(
        Effect.provide(
          buildLayer({ providers, httpRoutes: { ".well-known/openid-configuration": discovery } }),
        ),
        Effect.exit,
      );

    const layerAdvertising = (
      advertised: ReadonlyArray<string> | undefined,
      seen: Array<SeenRequest>,
    ) =>
      buildLayer({
        providers: [okta({ mapProfile: (claims) => ({ subject: String(claims["sub"]) }) })],
        httpRoutes: {
          ".well-known/openid-configuration": {
            ...oktaDiscovery,
            ...(advertised === undefined
              ? {}
              : { token_endpoint_auth_methods_supported: advertised }),
          },
          "/jwks": { keys: [jwk] },
          "/token": recordingTokenRoute(seen),
        },
      });

    it.effect(
      "a provider advertising only client_secret_basic gets Authorization: Basic and no client_secret in the body",
      () => {
        const seen: Array<SeenRequest> = [];
        return Effect.gen(function* () {
          yield* exchange;
          assert.strictEqual(seen.length, 1);
          assert.strictEqual(seen[0]?.authorization, `Basic ${btoa("okta-client-id:okta-secret")}`);
          assert.isFalse(seen[0]?.form.has("client_secret"));
          assert.strictEqual(seen[0]?.form.get("client_id"), "okta-client-id");
          // Token requests ask for JSON (GitHub answers form-encoded otherwise).
          assert.strictEqual(seen[0]?.accept, "application/json");
        }).pipe(Effect.provide(layerAdvertising(["client_secret_basic"], seen)));
      },
    );

    it.effect(
      "a provider advertising only client_secret_post gets client_secret in the body and no Authorization",
      () => {
        const seen: Array<SeenRequest> = [];
        return Effect.gen(function* () {
          yield* exchange;
          assert.isUndefined(seen[0]?.authorization);
          assert.strictEqual(seen[0]?.form.get("client_secret"), "okta-secret");
        }).pipe(Effect.provide(layerAdvertising(["client_secret_post"], seen)));
      },
    );

    it.effect(
      "with no advertised list and no explicit method, the RFC 6749 default (basic) is used",
      () => {
        const seen: Array<SeenRequest> = [];
        return Effect.gen(function* () {
          yield* exchange;
          assert.strictEqual(seen[0]?.authorization, `Basic ${btoa("okta-client-id:okta-secret")}`);
        }).pipe(Effect.provide(layerAdvertising(undefined, seen)));
      },
    );

    it.effect(
      "when both are advertised, basic wins; an explicit method overrides discovery",
      () => {
        const seen: Array<SeenRequest> = [];
        return Effect.gen(function* () {
          yield* exchange;
          assert.isUndefined(seen[0]?.authorization);
          assert.strictEqual(seen[0]?.form.get("client_secret"), "okta-secret");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [
                okta({
                  tokenEndpointAuthMethod: "client_secret_post",
                  mapProfile: (claims) => ({ subject: String(claims["sub"]) }),
                }),
              ],
              httpRoutes: {
                ".well-known/openid-configuration": {
                  ...oktaDiscovery,
                  token_endpoint_auth_methods_supported: [
                    "client_secret_basic",
                    "client_secret_post",
                  ],
                },
                "/jwks": { keys: [jwk] },
                "/token": recordingTokenRoute(seen),
              },
            }),
          ),
        );
      },
    );

    it.effect(
      "client ids containing reserved characters are form-urlencoded before base64 (RFC 6749 2.3.1)",
      () => {
        const seen: Array<SeenRequest> = [];
        return Effect.gen(function* () {
          yield* exchange;
          assert.strictEqual(seen[0]?.authorization, `Basic ${btoa("my+app%3Aid:s%3Dcr%26t")}`);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [
                okta({
                  clientId: Config.succeed("my app:id"),
                  clientSecret: Config.succeed(Redacted.make("s=cr&t")),
                  tokenEndpointAuthMethod: "client_secret_basic",
                  mapProfile: (claims) => ({ subject: String(claims["sub"]) }),
                }),
              ],
              httpRoutes: {
                ".well-known/openid-configuration": oktaDiscovery,
                "/jwks": { keys: [jwk] },
                "/token": recordingTokenRoute(seen),
              },
            }),
          ),
        );
      },
    );

    it.effect("a configured method the discovery document does not advertise fails at boot", () =>
      Effect.gen(function* () {
        const exit = yield* boot([okta({ tokenEndpointAuthMethod: "client_secret_basic" })], {
          ...oktaDiscovery,
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
        if (exit._tag === "Success") return assert.fail("expected boot to die");
        assert.include(Cause.pretty(exit.cause), "client_secret_basic");
      }),
    );

    it.effect("a provider advertising only methods this plugin cannot use fails at boot", () =>
      Effect.gen(function* () {
        const exit = yield* boot([okta()], {
          ...oktaDiscovery,
          token_endpoint_auth_methods_supported: ["private_key_jwt"],
        });
        assert.strictEqual(exit._tag, "Failure");
      }),
    );

    it.effect(
      "a client-secret method with no clientSecret, or method none with one, fails at boot",
      () =>
        Effect.gen(function* () {
          const { clientSecret: _omitted, ...publicClient } = okta({
            tokenEndpointAuthMethod: "client_secret_post",
          });
          assert.strictEqual((yield* boot([publicClient], oktaDiscovery))._tag, "Failure");
          const withSecret = okta({ tokenEndpointAuthMethod: "none" });
          assert.strictEqual((yield* boot([withSecret], oktaDiscovery))._tag, "Failure");
        }),
    );

    it.effect("a public client (no clientSecret) authenticates with nothing but client_id", () => {
      const seen: Array<SeenRequest> = [];
      return Effect.gen(function* () {
        yield* exchange;
        assert.isUndefined(seen[0]?.authorization);
        assert.strictEqual(seen[0]?.form.get("client_id"), "okta-client-id");
        assert.isFalse(seen[0]?.form.has("client_secret"));
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [
              (() => {
                const { clientSecret: _omitted, ...publicClient } = okta({
                  mapProfile: (claims) => ({ subject: String(claims["sub"]) }),
                });
                return publicClient;
              })(),
            ],
            httpRoutes: {
              ".well-known/openid-configuration": oktaDiscovery,
              "/jwks": { keys: [jwk] },
              "/token": recordingTokenRoute(seen),
            },
          }),
        ),
      );
    });
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

    it.effect("OAP-001/AP-001: a scheme-relative //host callbackURL is never redirected to", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: "//evil.example.com/phish",
          link: undefined,
        });
        const outcome = yield* oauth.callback("acme", {
          code: "c1",
          state,
          iss: undefined,
          cookieState: state,
        });
        // A browser resolves `//evil.example.com/phish` against the
        // current scheme (e.g. `https://evil.example.com/phish`) despite
        // its leading `/` — this must fall back to the safe default,
        // exactly like an untrusted absolute URL does.
        assert.notInclude(outcome.callbackURL, "evil.example.com");
        assert.strictEqual(outcome.callbackURL, "/");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "np-sub", email: "np@example.com" },
            },
          }),
        ),
      ),
    );

    it.effect(
      "OAP-001/AP-001: a backslash-variant /\\host callbackURL is never redirected to",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: "/\\evil.example.com/phish",
            link: undefined,
          });
          const outcome = yield* oauth.callback("acme", {
            code: "c1",
            state,
            iss: undefined,
            cookieState: state,
          });
          assert.notInclude(outcome.callbackURL, "evil.example.com");
          assert.strictEqual(outcome.callbackURL, "/");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-1" },
                "/userinfo": { id: "bs-sub", email: "bs@example.com" },
              },
            }),
          ),
        ),
    );

    it.effect("a bare single slash is still honored as a same-origin relative path", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: "/",
          link: undefined,
        });
        const outcome = yield* oauth.callback("acme", {
          code: "c1",
          state,
          iss: undefined,
          cookieState: state,
        });
        assert.strictEqual(outcome.callbackURL, "/");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": { id: "root-sub", email: "root@example.com" },
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

    // OIT-001 (OIDC Core 5.3.2): the userinfo `sub` MUST equal the verified
    // id_token `sub`, and the signed id_token wins identity-bearing claims.
    const oktaWithUserinfo = (overrides?: Partial<OAuthProvider.OAuthProviderConfig>) =>
      okta({
        endpoints: {
          authorizationEndpoint: oktaDiscovery.authorization_endpoint,
          tokenEndpoint: oktaDiscovery.token_endpoint,
          userinfoEndpoint: "https://okta.example.com/userinfo",
        },
        ...overrides,
      });

    const oidcClaims = (location: string, extra: Record<string, unknown>) => ({
      iss: "https://okta.example.com/oauth2/default",
      aud: "okta-client-id",
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: nonceFrom(location),
      ...extra,
    });

    it.effect(
      "OIT-001: a userinfo response whose sub differs from the id_token sub is rejected",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state, location } = yield* oauth.authorize("okta", {
            callbackURL: undefined,
            link: undefined,
          });
          currentClaims = oidcClaims(location, { sub: "real-sub", email: "real@example.com" });
          const failure = yield* oauth
            .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "OAuthCallbackFailed");

          const accounts = yield* Accounts.Accounts;
          assert.isTrue(Option.isNone(yield* accounts.findByProviderSubject("okta", "victim-sub")));
          assert.isTrue(Option.isNone(yield* accounts.findByProviderSubject("okta", "real-sub")));
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [oktaWithUserinfo()],
              httpRoutes: { ...idTokenRoutes(), "/userinfo": { sub: "victim-sub" } },
            }),
          ),
        ),
    );

    it.effect(
      "OIT-001: the id_token's email_verified wins over userinfo for the trusted auto-link decision",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          yield* users.create({
            identity: { _tag: "Email", email: "mallory-target@example.com" },
            name: "Target",
          });

          const oauth = yield* OAuth.OAuth;
          const { state, location } = yield* oauth.authorize("okta", {
            callbackURL: undefined,
            link: undefined,
          });
          currentClaims = oidcClaims(location, {
            sub: "same-sub",
            email: "mallory-target@example.com",
            email_verified: false,
          });
          const failure = yield* oauth
            .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
            .pipe(Effect.flip);
          // The signed id_token says the email is NOT verified; userinfo's
          // contradicting `true` must not turn on auto-link.
          assert.strictEqual(failure._tag, "AccountExists");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [oktaWithUserinfo()],
              linking: { trustedProviders: ["okta"] },
              httpRoutes: {
                ...idTokenRoutes(),
                "/userinfo": {
                  sub: "same-sub",
                  email: "mallory-target@example.com",
                  email_verified: true,
                },
              },
            }),
          ),
        ),
    );

    it.effect("OIT-001: userinfo still enriches the profile (name) when the subs match", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = oidcClaims(location, { sub: "enrich-sub", email: "enrich@example.com" });
        const outcome = yield* oauth.callback("okta", {
          code: "c1",
          state,
          iss: undefined,
          cookieState: state,
        });
        assert.isDefined(outcome.session);
        const users = yield* Users.Users;
        const user = yield* users.findByEmail("enrich@example.com");
        assert.strictEqual(Option.getOrThrow(user).name, "Enriched Name");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [oktaWithUserinfo()],
            httpRoutes: {
              ...idTokenRoutes(),
              "/userinfo": { sub: "enrich-sub", name: "Enriched Name" },
            },
          }),
        ),
      ),
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

    it.effect(
      "ESS-001/GC-001/SFS-002/TTE-001: a malformed JWKS document fails typed, not as an unchecked cast",
      () =>
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
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: nonceFrom(location),
          };
          const failure = yield* oauth
            .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "OAuthCallbackFailed");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta()],
              // `keys` is a string, not an array — the shape `body as
              // unknown as Jwt.Jwks` would have laundered straight through
              // to `findKey` as a defect-shaped crash instead of this typed
              // `OAuthCallbackFailed`.
              httpRoutes: { ...idTokenRoutes(), "/jwks": { keys: "not-an-array" } },
            }),
          ),
        ),
    );

    it.effect(
      "JJS-001/JR-002/KRS-004/OIT-002: an id_token whose kid matches no JWKS entry is rejected, not verified against an unrelated key",
      () =>
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
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: nonceFrom(location),
          };
          // The `/token` route below signs with the *only* key the fake
          // JWKS endpoint serves — a real, otherwise-valid signature —
          // but the token's own header claims a `kid` that key was never
          // registered under. Before the fix, `findKey`'s
          // `?? candidates[0]` fallback would have resolved this to the
          // JWKS's one entry regardless, and `verifyRs256` would then
          // have succeeded, silently accepting a token whose declared
          // key selector was simply wrong.
          const failure = yield* oauth
            .callback("okta", {
              code: "c1",
              state,
              iss: undefined,
              cookieState: state,
            })
            .pipe(Effect.flip);
          assert.strictEqual(failure._tag, "OAuthCallbackFailed");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta()],
              httpRoutes: {
                ...idTokenRoutes(),
                "/token": () => ({
                  access_token: "at-1",
                  id_token: signJwt(currentClaims, keyPair.privateKey, "unregistered-kid"),
                }),
              },
            }),
          ),
        ),
    );

    // AOMS-005: the id_token algorithm is the provider's allowlist, not RS256-only.
    const es256Routes = (): FakeRoutes => ({
      ".well-known/openid-configuration": oktaDiscovery,
      "/jwks": { keys: [ecJwk] },
      "/token": () => ({ access_token: "at-1", id_token: signEs256(currentClaims) }),
    });

    it.effect("AOMS-005: an ES256-signed id_token verifies for a provider allowing ES256", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = {
          iss: "https://okta.example.com/oauth2/default",
          aud: "okta-client-id",
          sub: "okta-ec-user",
          email: "ec-user@example.com",
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
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [okta({ idTokenSigningAlgs: ["ES256"] })],
            httpRoutes: es256Routes(),
          }),
        ),
      ),
    );

    it.effect("AOMS-005: an RS256 id_token is rejected for a provider whose allowlist is [ES256]", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = {
          iss: "https://okta.example.com/oauth2/default",
          aud: "okta-client-id",
          sub: "okta-rs-user",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: nonceFrom(location),
        };
        const failure = yield* oauth
          .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [okta({ idTokenSigningAlgs: ["ES256"] })],
            // The token is a perfectly valid RS256 one against the RS256 key the JWKS serves.
            httpRoutes: idTokenRoutes(),
          }),
        ),
      ),
    );

    it.effect("AOMS-005: the allowlist defaults to what discovery advertises, intersected with what is verifiable", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = {
          iss: "https://okta.example.com/oauth2/default",
          aud: "okta-client-id",
          sub: "okta-adv-user",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: nonceFrom(location),
        };
        // `HS256` is advertised too but is not verifiable here, so it never enters the allowlist.
        const outcome = yield* oauth.callback("okta", {
          code: "c1",
          state,
          iss: undefined,
          cookieState: state,
        });
        assert.isDefined(outcome.session);
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [okta()],
            httpRoutes: {
              ...es256Routes(),
              ".well-known/openid-configuration": {
                ...oktaDiscovery,
                id_token_signing_alg_values_supported: ["HS256", "ES256"],
              },
            },
          }),
        ),
      ),
    );

    it.effect(
      "ECF-002: concurrent callbacks presenting an unknown kid cause one JWKS refetch, not one per request",
      () => {
        let jwksCalls = 0;
        return Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const flows = yield* Effect.forEach(Array.from({ length: 6 }), () =>
            oauth.authorize("okta", { callbackURL: undefined, link: undefined }),
          );
          currentClaims = {
            iss: "https://okta.example.com/oauth2/default",
            aud: "okta-client-id",
            sub: "okta-user-1",
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: "irrelevant: the kid is checked first",
          };
          const failures = yield* Effect.forEach(
            flows,
            ({ state }) =>
              oauth
                .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
                .pipe(Effect.flip),
            { concurrency: "unbounded" },
          );
          for (const failure of failures) assert.strictEqual(failure._tag, "OAuthCallbackFailed");
          // One cold load shared by every caller, plus at most one forced refetch for the miss.
          assert.isAtMost(jwksCalls, 2);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta()],
              httpRoutes: {
                ...idTokenRoutes(),
                "/token": () => ({
                  access_token: "at-1",
                  id_token: signJwt(currentClaims, keyPair.privateKey, "unregistered-kid"),
                }),
                "/jwks": () => {
                  jwksCalls += 1;
                  return { keys: [jwk] };
                },
              },
            }),
          ),
        );
      },
    );

    it.effect(
      "JJS-001/JR-002/KRS-004/OIT-002: a rotated signing key is picked up via the kid-miss refetch, not stuck on the stale cache",
      () => {
        const rotatedKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const ROTATED_KID = "test-key-2";
        const rotatedJwk = {
          ...(rotatedKeyPair.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
          kid: ROTATED_KID,
          alg: "RS256",
        };
        // The provider's JWKS starts with only the original key — mutated
        // to also serve the rotated key only *after* the first round trip
        // has already cached the original set, so the second round trip's
        // kid-miss is what has to force the refetch, not a fresh,
        // already-up-to-date fetch.
        let jwksKeys: ReadonlyArray<Record<string, unknown>> = [jwk];
        let activePrivateKey = keyPair.privateKey;
        let activeKid = KID;
        const httpRoutes: FakeRoutes = {
          ".well-known/openid-configuration": oktaDiscovery,
          "/jwks": () => ({ keys: jwksKeys }),
          "/token": () => ({
            access_token: "at-1",
            id_token: signJwt(currentClaims, activePrivateKey, activeKid),
          }),
        };

        const roundTrip = Effect.fnUntraced(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state, location } = yield* oauth.authorize("okta", {
            callbackURL: undefined,
            link: undefined,
          });
          currentClaims = {
            iss: "https://okta.example.com/oauth2/default",
            aud: "okta-client-id",
            sub: "okta-user-1",
            exp: Math.floor(Date.now() / 1000) + 3600,
            nonce: nonceFrom(location),
          };
          return yield* oauth.callback("okta", {
            code: "c1",
            state,
            iss: undefined,
            cookieState: state,
          });
        });

        // Both round trips share one `Effect.provide` — and therefore one
        // built `OAuth` service, one `jwksCache` — so the second call's
        // kid-miss genuinely hits the first call's stale cache rather
        // than a fresh one.
        return Effect.gen(function* () {
          const first = yield* roundTrip();
          assert.isDefined(first.session);

          // The provider rotates: the old key is retired, only the new
          // one remains — the cache built by the first round trip still
          // only knows the old kid.
          jwksKeys = [rotatedJwk];
          activePrivateKey = rotatedKeyPair.privateKey;
          activeKid = ROTATED_KID;

          const second = yield* roundTrip();
          assert.isDefined(second.session);
        }).pipe(Effect.provide(buildLayer({ providers: [okta()], httpRoutes })));
      },
    );

    // ESS-003 pins: a malformed provider body is a typed failure, never a defect.
    const malformedTokenBody = (body: unknown) =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        const failure = yield* oauth
          .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [okta()],
            httpRoutes: {
              ".well-known/openid-configuration": oktaDiscovery,
              "/jwks": { keys: [jwk] },
              "/token": body,
            },
          }),
        ),
      );

    it.effect("ESS-003: a token response whose id_token is a number fails typed", () =>
      malformedTokenBody({ access_token: "at-1", id_token: 12345 }),
    );

    it.effect("ESS-003: a token response that is a JSON array fails typed", () =>
      malformedTokenBody([{ access_token: "at-1" }]),
    );

    it.effect("ESS-003: a userinfo body that is a JSON array fails typed, not as a defect", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        const failure = yield* oauth
          .callback("acme", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: { "/token": { access_token: "at-1" }, "/userinfo": [{ id: "x" }] },
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
          // MA-002: expiry is judged by the Effect Clock (TestClock at 0
          // here), far enough back to be outside the default 60s skew.
          exp: -120,
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

    it.effect("BAM-008: an oidc sign-up persists the id_token alongside the access token", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = oidcClaims(location, { sub: "idt-sub", email: "idt@example.com" });
        yield* oauth.callback("okta", { code: "c1", state, iss: undefined, cookieState: state });
        const accounts = yield* Accounts.Accounts;
        const account = Option.getOrThrow(
          yield* accounts.findByProviderSubject(
            "okta",
            "idt-sub",
            "https://okta.example.com/oauth2/default",
          ),
        );
        const tokens = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
        assert.strictEqual(Redacted.value(tokens.accessToken), "at-1");
        // The stored id_token is the very JWT the provider returned.
        assert.strictEqual(
          Redacted.value(Option.getOrThrow(tokens.idToken)),
          signJwt(currentClaims),
        );
      }).pipe(Effect.provide(buildLayer({ providers: [okta()], httpRoutes: idTokenRoutes() }))),
    );

    it.effect(
      "ECF-001: a JWKS endpoint that never answers fails ProviderUnavailable at its deadline",
      () => {
        const hang = hangingRoute();
        return Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state, location } = yield* oauth.authorize("okta", {
            callbackURL: undefined,
            link: undefined,
          });
          currentClaims = oidcClaims(location, { sub: "hang-sub" });
          const fiber = yield* Effect.forkChild(
            oauth
              .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
              .pipe(Effect.flip),
          );
          yield* hang.reached;
          yield* TestClock.adjust(Duration.seconds(3));
          const failure = yield* Fiber.join(fiber);
          assert.strictEqual(failure._tag, "ProviderUnavailable");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta()],
              httpRoutes: { ...idTokenRoutes(), "/jwks": hang.route },
              httpTimeouts: { jwks: Duration.seconds(3) },
              retry: { times: 0 },
            }),
          ),
        );
      },
    );

    it.effect(
      "ERS-003: a JWKS endpoint that 503s once then succeeds still verifies the id_token",
      () => {
        let jwksCalls = 0;
        return Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state, location } = yield* oauth.authorize("okta", {
            callbackURL: undefined,
            link: undefined,
          });
          currentClaims = oidcClaims(location, { sub: "retry-sub", email: "retry@example.com" });
          const outcome = yield* oauth.callback("okta", {
            code: "c1",
            state,
            iss: undefined,
            cookieState: state,
          });
          assert.isDefined(outcome.session);
          assert.strictEqual(jwksCalls, 2);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta()],
              httpRoutes: {
                ...idTokenRoutes(),
                "/jwks": () => {
                  jwksCalls += 1;
                  return jwksCalls === 1 ? new FakeReply(503) : { keys: [jwk] };
                },
              },
            }),
          ),
        );
      },
    );

    it.effect("EEM-004: a JWKS endpoint that keeps answering 503 is ProviderUnavailable", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = oidcClaims(location, { sub: "down-sub" });
        const failure = yield* oauth
          .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "ProviderUnavailable");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [okta()],
            httpRoutes: { ...idTokenRoutes(), "/jwks": new FakeReply(503) },
          }),
        ),
      ),
    );

    // ---- claim integrity: MA-002 clock, OIT-003 aud/azp, OIT-004 skew, OIT-006/008/009 ----

    /** Runs one authorize+callback with claims built from the flow's redirect URL. */
    const attempt = (claimsFor: (location: string) => Record<string, unknown>) =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        currentClaims = claimsFor(location);
        return yield* oauth
          .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.result);
      });

    /** Claims valid at TestClock time 0 (`iat`/`nbf` absent unless `extra` sets them). */
    const claimsAtZero = (location: string, extra: Record<string, unknown> = {}) => ({
      iss: "https://okta.example.com/oauth2/default",
      aud: "okta-client-id",
      sub: "claims-user",
      exp: 100000,
      nonce: nonceFrom(location),
      ...extra,
    });

    const oktaLayer = (config?: Partial<OAuth.OAuthConfigInput>) =>
      buildLayer({
        providers: [okta()],
        httpRoutes: idTokenRoutes(),
        ...(config === undefined ? {} : { config }),
      });

    it.effect("MA-002: an id_token becomes expired when the TestClock advances past exp", () =>
      Effect.gen(function* () {
        const fresh = yield* attempt((location) => claimsAtZero(location, { exp: 3600 }));
        assert.strictEqual(fresh._tag, "Success");
        // exp + the default 60s skew has passed.
        yield* TestClock.adjust(Duration.seconds(3600 + 61));
        const stale = yield* attempt((location) => claimsAtZero(location, { exp: 3600 }));
        assert.strictEqual(stale._tag, "Failure");
      }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect(
      "MA-002: the JWKS cache refetches only after the TestClock passes the 15 minute TTL",
      () => {
        let jwksCalls = 0;
        return Effect.gen(function* () {
          yield* attempt((location) => claimsAtZero(location, { sub: "ttl-1" }));
          yield* TestClock.adjust(Duration.minutes(1));
          yield* attempt((location) => claimsAtZero(location, { sub: "ttl-2" }));
          assert.strictEqual(jwksCalls, 1);
          yield* TestClock.adjust(Duration.minutes(16));
          yield* attempt((location) => claimsAtZero(location, { sub: "ttl-3" }));
          assert.strictEqual(jwksCalls, 2);
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [okta()],
              httpRoutes: {
                ...idTokenRoutes(),
                "/jwks": () => {
                  jwksCalls += 1;
                  return { keys: [jwk] };
                },
              },
            }),
          ),
        );
      },
    );

    it.effect("OIT-003: an array aud containing the client id is accepted", () =>
      Effect.gen(function* () {
        const result = yield* attempt((location) =>
          claimsAtZero(location, { aud: ["okta-client-id"] }),
        );
        assert.strictEqual(result._tag, "Success");
      }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect("OIT-003: a multi-value aud with azp naming this client is accepted", () =>
      Effect.gen(function* () {
        const result = yield* attempt((location) =>
          claimsAtZero(location, { aud: ["okta-client-id", "other-api"], azp: "okta-client-id" }),
        );
        assert.strictEqual(result._tag, "Success");
      }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect("OIT-003: a multi-value aud without azp is rejected", () =>
      Effect.gen(function* () {
        const result = yield* attempt((location) =>
          claimsAtZero(location, { aud: ["okta-client-id", "other-api"] }),
        );
        assert.strictEqual(result._tag, "Failure");
      }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect("OIT-003: an azp naming another client is rejected even when aud matches", () =>
      Effect.gen(function* () {
        const result = yield* attempt((location) =>
          claimsAtZero(location, { azp: "someone-elses-client" }),
        );
        assert.strictEqual(result._tag, "Failure");
      }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect(
      "OIT-003: an aud that does not contain the client id, or is not strings, is rejected",
      () =>
        Effect.gen(function* () {
          assert.strictEqual(
            (yield* attempt((location) => claimsAtZero(location, { aud: ["another-client"] })))
              ._tag,
            "Failure",
          );
          assert.strictEqual(
            (yield* attempt((location) => claimsAtZero(location, { aud: ["okta-client-id", 7] })))
              ._tag,
            "Failure",
          );
        }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect("OIT-004: an id_token expired by less than the skew is accepted", () =>
      Effect.gen(function* () {
        // exp 30s in the past at clock 0, inside the default 60s leeway.
        const result = yield* attempt((location) => claimsAtZero(location, { exp: -30 }));
        assert.strictEqual(result._tag, "Success");
      }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect("OIT-004: the skew is configurable (zero skew rejects a token 30s past exp)", () =>
      Effect.gen(function* () {
        const result = yield* attempt((location) => claimsAtZero(location, { exp: -30 }));
        assert.strictEqual(result._tag, "Failure");
      }).pipe(Effect.provide(oktaLayer({ clockSkew: Duration.zero }))),
    );

    it.effect("OIT-004: an id_token with iat in the future beyond the skew is rejected", () =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* attempt((location) => claimsAtZero(location, { iat: 300 })))._tag,
          "Failure",
        );
        // Within the skew is fine.
        assert.strictEqual(
          (yield* attempt((location) => claimsAtZero(location, { iat: 30 })))._tag,
          "Success",
        );
      }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect(
      "OIT-004: an id_token with nbf in the future is rejected; a non-numeric nbf/iat too",
      () =>
        Effect.gen(function* () {
          assert.strictEqual(
            (yield* attempt((location) => claimsAtZero(location, { nbf: 300 })))._tag,
            "Failure",
          );
          assert.strictEqual(
            (yield* attempt((location) => claimsAtZero(location, { nbf: "soon" })))._tag,
            "Failure",
          );
          assert.strictEqual(
            (yield* attempt((location) => claimsAtZero(location, { iat: "yesterday" })))._tag,
            "Failure",
          );
        }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect(
      "OIT-004: maxIdTokenAge rejects an old iat (and a missing one), driven by the TestClock",
      () =>
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.minutes(30));
          // iat = 0 is 30 minutes old against a 10 minute cap.
          assert.strictEqual(
            (yield* attempt((location) => claimsAtZero(location, { iat: 0 })))._tag,
            "Failure",
          );
          // A recent iat passes; no iat at all cannot be aged, so it fails.
          assert.strictEqual(
            (yield* attempt((location) => claimsAtZero(location, { iat: 30 * 60 - 5 })))._tag,
            "Success",
          );
          assert.strictEqual(
            (yield* attempt((location) => claimsAtZero(location)))._tag,
            "Failure",
          );
        }).pipe(Effect.provide(oktaLayer({ maxIdTokenAge: Duration.minutes(10) }))),
    );

    it.effect("OIT-006: an id_token without a nonce claim is rejected", () =>
      Effect.gen(function* () {
        const result = yield* attempt((location) => {
          const { nonce: _dropped, ...rest } = claimsAtZero(location);
          return rest;
        });
        assert.strictEqual(result._tag, "Failure");
      }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect("OIT-006: an oidc flow whose persisted payload lacks a nonce fails closed", () =>
      Effect.gen(function* () {
        const encryption = yield* Encryption.Encryption;
        const verification = yield* Verification.Verification;
        const oauth = yield* OAuth.OAuth;
        const identifier = "oauth.flow:hand-made-1";
        const codeVerifier = yield* encryption.encrypt(Redacted.make("a-verifier"), identifier);
        const { value } = yield* verification.issue({
          identifier,
          ttl: Duration.minutes(5),
          // No `nonce`: what a legacy or tampered flow row would look like.
          payload: { providerId: "okta", codeVerifier, callbackURL: "/" },
        });
        const state = `${identifier}.${Redacted.value(value)}`;
        currentClaims = claimsAtZero("https://x/?nonce=irrelevant");
        const failure = yield* oauth
          .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect("an id_token without a sub claim is rejected", () =>
      Effect.gen(function* () {
        const result = yield* attempt((location) => {
          const { sub: _dropped, ...rest } = claimsAtZero(location);
          return rest;
        });
        assert.strictEqual(result._tag, "Failure");
      }).pipe(Effect.provide(oktaLayer())),
    );

    it.effect(
      "OIT-008: a wrong-nonce failure logs reason=nonce while the error stays field-less",
      () => {
        const logs: Array<string> = [];
        const capture = Logger.make((entry) => {
          logs.push(JSON.stringify(entry.message));
        });
        return Effect.gen(function* () {
          const result = yield* attempt((location) => claimsAtZero(location, { nonce: "wrong" }));
          if (result._tag !== "Failure") return assert.fail("expected the nonce mismatch to fail");
          // The wire error carries no reason at all.
          assert.strictEqual(JSON.stringify(result.failure), '{"_tag":"OAuthCallbackFailed"}');
          assert.isTrue(logs.some((line) => line.includes("oauth callback failed: nonce")));
        }).pipe(Effect.provide(Layer.merge(oktaLayer(), Logger.layer([capture]))));
      },
    );

    // OIT-009: algorithm-confusion pins (both already fail at the RS256 gate).
    const forgedToken = (
      header: Record<string, unknown>,
      claims: Record<string, unknown>,
      signature: string,
    ) => {
      const head = toBase64Url(Buffer.from(JSON.stringify(header)));
      const body = toBase64Url(Buffer.from(JSON.stringify(claims)));
      return `${head}.${body}.${signature}`;
    };

    const forgedAttempt = (forge: (claims: Record<string, unknown>) => string) =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state, location } = yield* oauth.authorize("okta", {
          callbackURL: undefined,
          link: undefined,
        });
        forgedIdToken = forge(claimsAtZero(location));
        return yield* oauth
          .callback("okta", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
      });

    let forgedIdToken = "";
    const forgedLayer = buildLayer({
      providers: [okta()],
      httpRoutes: {
        ...idTokenRoutes(),
        "/token": () => ({ access_token: "at-1", id_token: forgedIdToken }),
      },
    });

    it.effect(
      "OIT-009: an id_token with alg HS256 (signed with the RSA modulus as the HMAC key) is rejected",
      () =>
        Effect.gen(function* () {
          const failure = yield* forgedAttempt((claims) => {
            const header = { alg: "HS256", typ: "JWT", kid: KID };
            const unsigned = forgedToken(header, claims, "").slice(0, -1);
            const key = Buffer.from(
              String(keyPair.publicKey.export({ format: "jwk" }).n),
              "base64url",
            );
            const mac = createHmac("sha256", key).update(unsigned).digest("base64url");
            return `${unsigned}.${mac}`;
          });
          assert.strictEqual(failure._tag, "OAuthCallbackFailed");
        }).pipe(Effect.provide(forgedLayer)),
    );

    it.effect("OIT-009: an alg:none id_token is rejected", () =>
      Effect.gen(function* () {
        const failure = yield* forgedAttempt((claims) =>
          forgedToken({ alg: "none", typ: "JWT" }, claims, ""),
        );
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(Effect.provide(forgedLayer)),
    );

    it.effect("a userinfo body that yields no subject never becomes an account (no-subject)", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        const failure = yield* oauth
          .callback("acme", { code: "c1", state, iss: undefined, cookieState: state })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "OAuthCallbackFailed");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              "/token": { access_token: "at-1" },
              "/userinfo": { email: "no-id@example.com" },
            },
          }),
        ),
      ),
    );
  });

  describe("BE-002: exchanged provider tokens are persisted, not discarded", () => {
    it.effect("a new sign-up persists the full exchanged token set on the linked account", () =>
      Effect.gen(function* () {
        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: undefined,
        });
        yield* oauth.callback("acme", { code: "c1", state, iss: undefined, cookieState: state });

        const accounts = yield* Accounts.Accounts;
        const linked = yield* accounts.findByProviderSubject("acme", "new-sub");
        const account = Option.getOrThrow(linked);
        const stored = yield* accounts.findProviderTokens(account.id);
        const tokens = Option.getOrThrow(stored);
        assert.strictEqual(Redacted.value(tokens.accessToken), "at-1");
        assert.strictEqual(Redacted.value(Option.getOrThrow(tokens.refreshToken)), "rt-1");
        assert.isTrue(Option.isSome(tokens.accessTokenExpiresAt));
        assert.isTrue(Option.isNone(tokens.refreshTokenExpiresAt));
        assert.strictEqual(Option.getOrThrow(tokens.scope), "read write");
        assert.strictEqual(Option.getOrThrow(tokens.tokenType), "Bearer");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              "/token": {
                access_token: "at-1",
                refresh_token: "rt-1",
                expires_in: 3600,
                scope: "read write",
                token_type: "Bearer",
              },
              "/userinfo": { id: "new-sub", email: "new-provider-tokens@example.com" },
            },
          }),
        ),
      ),
    );

    it.effect(
      "ESS-003: a token response with expires_in as a numeric string persists the right expiry",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: undefined,
          });
          yield* oauth.callback("acme", { code: "c1", state, iss: undefined, cookieState: state });

          const accounts = yield* Accounts.Accounts;
          const account = Option.getOrThrow(
            yield* accounts.findByProviderSubject("acme", "str-sub"),
          );
          const tokens = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
          assert.isTrue(Option.isSome(tokens.accessTokenExpiresAt));
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-str", expires_in: "3600" },
                "/userinfo": { id: "str-sub", email: "str-expiry@example.com" },
              },
            }),
          ),
        ),
    );

    it.effect(
      "a linked account with no token fields in the response stores none — no crash on the missing keys",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: undefined,
          });
          yield* oauth.callback("acme", { code: "c1", state, iss: undefined, cookieState: state });

          const accounts = yield* Accounts.Accounts;
          const linked = yield* accounts.findByProviderSubject("acme", "bare-sub");
          const account = Option.getOrThrow(linked);
          const stored = yield* accounts.findProviderTokens(account.id);
          const tokens = Option.getOrThrow(stored);
          assert.strictEqual(Redacted.value(tokens.accessToken), "at-bare");
          assert.isTrue(Option.isNone(tokens.refreshToken));
          assert.isTrue(Option.isNone(tokens.accessTokenExpiresAt));
          assert.isTrue(Option.isNone(tokens.scope));
          assert.isTrue(Option.isNone(tokens.tokenType));
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                "/token": { access_token: "at-bare" },
                "/userinfo": { id: "bare-sub", email: "bare-provider-tokens@example.com" },
              },
            }),
          ),
        ),
    );

    it.effect(
      "re-authenticating an already-linked account overwrites the stored token set with the fresh one",
      () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const first = yield* oauth.authorize("acme", { callbackURL: undefined, link: undefined });
          yield* oauth.callback("acme", {
            code: "c1",
            state: first.state,
            iss: undefined,
            cookieState: first.state,
          });

          const accounts = yield* Accounts.Accounts;
          const linked = yield* accounts.findByProviderSubject("acme", "returning-tokens-sub");
          const account = Option.getOrThrow(linked);
          const firstStored = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
          assert.strictEqual(Redacted.value(firstStored.accessToken), "at-old");

          const second = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: undefined,
          });
          yield* oauth.callback("acme", {
            code: "c2",
            state: second.state,
            iss: undefined,
            cookieState: second.state,
          });

          const secondStored = Option.getOrThrow(yield* accounts.findProviderTokens(account.id));
          assert.strictEqual(Redacted.value(secondStored.accessToken), "at-new");
          assert.strictEqual(
            Redacted.value(Option.getOrThrow(secondStored.refreshToken)),
            "rt-new",
          );
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              httpRoutes: {
                // A fake route's value may itself be a function
                // (`fakeHttpClient`'s own dispatch) — closing over a
                // counter reproduces the real world's "each callback gets
                // a fresh exchange" shape, exercising the re-authentication
                // branch's own `updateProviderTokens` call, not just the
                // first-link one.
                "/token": (() => {
                  let call = 0;
                  return () => {
                    call += 1;
                    return call === 1
                      ? { access_token: "at-old", refresh_token: "rt-old" }
                      : { access_token: "at-new", refresh_token: "rt-new" };
                  };
                })(),
                "/userinfo": { id: "returning-tokens-sub", email: "returning-tokens@example.com" },
              },
            }),
          ),
        ),
    );

    it.effect("an authenticated caller's explicit link also persists the exchanged token set", () =>
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const alice = yield* users.create({
          identity: { _tag: "Email", email: "alice-tokens@example.com" },
          name: "Alice",
        });

        const oauth = yield* OAuth.OAuth;
        const { state } = yield* oauth.authorize("acme", {
          callbackURL: undefined,
          link: { userId: alice.id },
        });
        yield* oauth.callback("acme", { code: "c1", state, iss: undefined, cookieState: state });

        const accounts = yield* Accounts.Accounts;
        const linked = yield* accounts.findByProviderSubject("acme", "link-tokens-sub");
        const account = Option.getOrThrow(linked);
        const stored = yield* accounts.findProviderTokens(account.id);
        assert.strictEqual(Redacted.value(Option.getOrThrow(stored).accessToken), "at-link");
      }).pipe(
        Effect.provide(
          buildLayer({
            providers: [acme()],
            httpRoutes: {
              "/token": { access_token: "at-link" },
              "/userinfo": { id: "link-tokens-sub", email: "link-tokens-target@example.com" },
            },
          }),
        ),
      ),
    );

    it.effect(
      "auto-linking a trusted provider to an existing user also persists the token set",
      () =>
        Effect.gen(function* () {
          const users = yield* Users.Users;
          const existing = yield* users.create({
            identity: { _tag: "Email", email: "auto-link-tokens@example.com" },
            name: "Auto Link",
          });
          // TMS-007: auto-link needs the local account's email proven too.
          yield* users.verifyEmail(existing.id);

          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: undefined,
            link: undefined,
          });
          yield* oauth.callback("acme", { code: "c1", state, iss: undefined, cookieState: state });

          const accounts = yield* Accounts.Accounts;
          const linked = yield* accounts.findByProviderSubject("acme", "auto-link-tokens-sub");
          const account = Option.getOrThrow(linked);
          assert.strictEqual(account.userId, existing.id);
          const stored = yield* accounts.findProviderTokens(account.id);
          assert.strictEqual(Redacted.value(Option.getOrThrow(stored).accessToken), "at-autolink");
        }).pipe(
          Effect.provide(
            buildLayer({
              providers: [acme()],
              linking: { trustedProviders: ["acme"] },
              httpRoutes: {
                "/token": { access_token: "at-autolink" },
                "/userinfo": {
                  id: "auto-link-tokens-sub",
                  email: "auto-link-tokens@example.com",
                  email_verified: true,
                },
              },
            }),
          ),
        ),
    );
  });
});

describe("EP-004: per-organization connections (BEH-EA-235)", () => {
  const connectionId = "org:org-1:conn-1";
  const userinfoRoutes = {
    "/token": { access_token: "at-1" },
    "/userinfo": { id: "acme-user-1", email: "ada@example.com" },
  };

  /** A resolver over a fixed table; `calls` counts lookups, `revision` is mutable per test. */
  const resolverOver = (table: Record<string, () => OAuthProvider.OAuthProviderConfig>) => {
    const calls: Array<string> = [];
    const state = { revision: "r1" };
    const resolver: OAuthConnections.OAuthConnectionResolverShape = {
      find: (providerId) =>
        Effect.sync(() => {
          calls.push(providerId);
          const build = table[providerId];
          return build === undefined
            ? Option.none()
            : Option.some({ config: build(), revision: state.revision });
        }),
    };
    return { resolver, calls, state };
  };

  it.effect("a connection id that is not in the static registry completes a full callback", () => {
    const { resolver } = resolverOver({ [connectionId]: () => acme({ id: connectionId }) });
    return Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const accounts = yield* Accounts.Accounts;
      const { location, state } = yield* oauth.authorize(connectionId, {
        callbackURL: undefined,
        link: undefined,
      });
      assert.strictEqual(
        new URL(location).searchParams.get("redirect_uri"),
        `${baseUrl}/oauth/${connectionId}/callback`,
      );
      const outcome = yield* oauth.callback(connectionId, {
        code: "auth-code",
        state,
        iss: undefined,
        cookieState: state,
      });
      assert.isDefined(outcome.session);
      // The account is linked under the namespaced connection id, never a static provider's.
      const linked = yield* accounts.findByProviderSubject(connectionId, "acme-user-1", "");
      assert.isTrue(Option.isSome(linked));
    }).pipe(
      Effect.provide(
        buildLayer({ providers: [], httpRoutes: userinfoRoutes, connections: resolver }),
      ),
    );
  });

  it.effect("a static provider id still wins over a connection with the same id", () => {
    const { resolver, calls } = resolverOver({
      acme: () => acme({ id: "acme", clientId: Config.succeed("hijacked-client") }),
    });
    return Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const { location } = yield* oauth.authorize("acme", { callbackURL: undefined, link: undefined });
      assert.strictEqual(new URL(location).searchParams.get("client_id"), "acme-client-id");
      assert.deepStrictEqual(calls, []);
    }).pipe(
      Effect.provide(buildLayer({ providers: [acme()], connections: resolver })),
    );
  });

  it.effect("an id that is neither static nor a known connection is ProviderNotFound", () => {
    const { resolver } = resolverOver({});
    return Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const failure = yield* oauth
        .authorize("org:org-1:missing", { callbackURL: undefined, link: undefined })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ProviderNotFound");
    }).pipe(Effect.provide(buildLayer({ providers: [], connections: resolver })));
  });

  it.effect("with no resolver installed, connection ids are unknown (single-tenant unchanged)", () =>
    Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const failure = yield* oauth
        .authorize(connectionId, { callbackURL: undefined, link: undefined })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ProviderNotFound");
    }).pipe(Effect.provide(buildLayer({ providers: [acme()] }))),
  );

  it.effect("a connection's discovery is fetched once per revision and refetched when it changes", () => {
    let discoveries = 0;
    const oidcConnection = () =>
      okta({ id: connectionId });
    const { resolver, state } = resolverOver({ [connectionId]: oidcConnection });
    return Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const authorize = () =>
        oauth.authorize(connectionId, { callbackURL: undefined, link: undefined });
      yield* authorize();
      yield* authorize();
      assert.strictEqual(discoveries, 1);
      state.revision = "r2";
      yield* authorize();
      assert.strictEqual(discoveries, 2);
    }).pipe(
      Effect.provide(
        buildLayer({
          providers: [],
          connections: resolver,
          httpRoutes: {
            ".well-known/openid-configuration": () => {
              discoveries += 1;
              return oktaDiscovery;
            },
          },
        }),
      ),
    );
  });

  it.effect("a connection whose discovery is unreachable answers ProviderUnavailable and is retried", () => {
    let reachable = false;
    const { resolver } = resolverOver({ [connectionId]: () => okta({ id: connectionId }) });
    return Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const down = yield* oauth
        .authorize(connectionId, { callbackURL: undefined, link: undefined })
        .pipe(Effect.flip);
      assert.strictEqual(down._tag, "ProviderUnavailable");
      reachable = true;
      const up = yield* oauth.authorize(connectionId, { callbackURL: undefined, link: undefined });
      assert.isString(up.location);
    }).pipe(
      Effect.provide(
        buildLayer({
          providers: [],
          connections: resolver,
          retry: { times: 0 },
          httpRoutes: {
            ".well-known/openid-configuration": () =>
              reachable ? oktaDiscovery : new FakeReply(503),
          },
        }),
      ),
    );
  });

  it.effect("a connection whose discovery issuer mismatches is refused, never a defect of the runtime", () => {
    const { resolver } = resolverOver({
      [connectionId]: () => okta({ id: connectionId, issuer: Config.succeed("https://evil.example.com") }),
    });
    return Effect.gen(function* () {
      const oauth = yield* OAuth.OAuth;
      const failure = yield* oauth
        .authorize(connectionId, { callbackURL: undefined, link: undefined })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ProviderUnavailable");
    }).pipe(
      Effect.provide(
        buildLayer({
          providers: [],
          connections: resolver,
          httpRoutes: { ".well-known/openid-configuration": oktaDiscovery },
        }),
      ),
    );
  });
});
