// Shipping-gap map (.scratch/shipping-gaps), ticket 22: the real
// domain-level seam `packages/oauth/test/OAuth.test.ts` establishes — a
// real in-memory `Users`/`Accounts`/`Sessions`/`Verification`/`AuthEvents`
// and a fake `HttpClient` only for the provider transport. None of this
// ticket's own implemented scenarios need a full, id_token-carrying OIDC
// callback (the linking/identity-anchor rules are exercised with plain
// `oauth2` providers — no `id_token` involved at all — and the discovery
// scenarios, REQ-EA-349/350/351, only exercise provider *registration*,
// never a callback), so unlike `OAuth.test.ts` itself this World has no
// RS256 test-signing machinery to carry.
//
// Unlike `PasswordWorld`/`SessionWorld` (which build a fully-isolated
// `HttpRouter.toWebHandler` runtime per app), this World builds the
// `OAuth.OAuth` service via `Layer.build` called directly from inside a
// step's own Effect — the ambient ScenarioLayer's ambient ManagedRuntime
// remains the one construction runs under, so services `OAuth.layer`
// depends on (e.g. `DateTime.now`) see the same simulated `TestClock` every
// other step does. Several of this feature's own scenarios (REQ-EA-334's
// flow-TTL expiry) depend on that.
import { AuthEvents, Accounts, RateLimits, Sessions, Users, Verification } from "@awthaq/core";
import { ClientAddress, RateLimiter, SqlTransaction, Encryption, KeyProvider } from "@awthaq/ports";
import { Authentication } from "@awthaq/server";
import { OAuth, OAuthProvider } from "@awthaq/oauth";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

// ---- fake HttpClient: routes by URL substring ----

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

// ---- provider fixtures, parameterized by id ----

export const oauth2Provider = (
  id: string,
  overrides?: Partial<OAuthProvider.OAuthProviderConfig>,
): OAuthProvider.OAuthProviderConfig =>
  OAuthProvider.oauth2({
    id,
    clientId: Config.succeed(`${id}-client-id`),
    clientSecret: Config.succeed(Redacted.make(`${id}-secret`)),
    scopes: ["read"],
    endpoints: {
      authorizationEndpoint: `https://${id}.example.com/authorize`,
      tokenEndpoint: `https://${id}.example.com/token`,
      userinfoEndpoint: `https://${id}.example.com/userinfo`,
    },
    mapProfile: (claims) => ({
      subject: claims["id"] as string,
      ...(claims["email"] !== undefined ? { email: claims["email"] as string } : {}),
      ...(claims["email_verified"] !== undefined
        ? { emailVerified: claims["email_verified"] as boolean }
        : {}),
    }),
    ...overrides,
  });

export const oidcProvider = (
  id: string,
  overrides?: Partial<OAuthProvider.OAuthProviderConfig>,
): OAuthProvider.OAuthProviderConfig =>
  OAuthProvider.oidc({
    id,
    issuer: Config.succeed(`https://${id}.example.com`),
    discoveryUrl: Config.succeed(`https://${id}.example.com/.well-known/openid-configuration`),
    clientId: Config.succeed(`${id}-client-id`),
    clientSecret: Config.succeed(Redacted.make(`${id}-secret`)),
    scopes: ["openid", "email"],
    mapProfile: (claims) => ({
      subject: claims["sub"] as string,
      ...(claims["email"] !== undefined ? { email: claims["email"] as string } : {}),
      ...(claims["email_verified"] !== undefined
        ? { emailVerified: claims["email_verified"] as boolean }
        : {}),
    }),
    ...overrides,
  });

export const discoveryFor = (id: string): Record<string, unknown> => ({
  issuer: `https://${id}.example.com`,
  authorization_endpoint: `https://${id}.example.com/authorize`,
  token_endpoint: `https://${id}.example.com/token`,
  jwks_uri: `https://${id}.example.com/jwks`,
});

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(Layer.provideMerge(AuthEvents.layer), Layer.provideMerge(NodeCrypto.layer));

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

export interface BuildOptions {
  readonly providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>;
  readonly linking?: "explicit" | { readonly trustedProviders: ReadonlyArray<string> };
  readonly trustedOrigins?: ReadonlyArray<string>;
  readonly httpRoutes?: FakeRoutes;
  readonly baseUrl?: string;
}

const buildLayer = (options: BuildOptions) =>
  OAuth.OAuth.layer.pipe(
    // `OAuthApi.OAuthGroup`'s own `.middleware(Api.OptionalAuthentication)`
    // is part of what `OAuth.layer` merges its handlers with — required
    // even here, where no HTTP request is ever actually issued, because
    // `AuthPlugin.layer` ties a plugin's own service and its handlers
    // together in one `Layer.provideMerge`. Order matters, matching
    // `OAuth.test.ts`'s own `buildLayer`: `CoreLive` (which satisfies
    // `OptionalAuthenticationLive`'s own `Sessions` need) has to come after
    // these, not before.
    Layer.provide(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(RateLimiter.layerPermissive),
    Layer.provideMerge(RateLimits.layer),
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
        baseUrl: options.baseUrl ?? "https://app.example.com",
      }),
    ),
  );

export interface WorldShape {
  readonly oauth: Ref.Ref<OAuth.OAuthShape | undefined>;
  readonly accounts: Ref.Ref<Accounts.AccountsShape | undefined>;
  readonly users: Ref.Ref<Users.UsersShape | undefined>;
  readonly sessions: Ref.Ref<Sessions.SessionsShape | undefined>;
  readonly outcomes: Ref.Ref<Record<string, unknown>>;
}

export class World extends Context.Service<World, WorldShape>()("features/OAuthWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      oauth: yield* Ref.make<OAuth.OAuthShape | undefined>(undefined),
      accounts: yield* Ref.make<Accounts.AccountsShape | undefined>(undefined),
      users: yield* Ref.make<Users.UsersShape | undefined>(undefined),
      sessions: yield* Ref.make<Sessions.SessionsShape | undefined>(undefined),
      outcomes: yield* Ref.make<Record<string, unknown>>({}),
    });
  }),
);

/**
 * Builds `OAuth.OAuth` via `Layer.build` inside this step's own Effect —
 * scoped to the Scenario's own ambient `Scope`, so `TestClock` and every
 * other ambient service stay shared. `buildLayer`'s own `CoreLive` is
 * `Layer.provideMerge`d *inside* it, so the resulting context already
 * carries `Users`/`Accounts`/`Sessions` too — the exact same instances
 * `OAuth.OAuth` itself resolved against, not a second, disconnected set.
 */
export const configure = Effect.fn("features.oauth.configure")(function* (options: BuildOptions) {
  const world = yield* World;
  const context = yield* Layer.build(buildLayer(options));
  yield* Ref.set(world.oauth, Context.get(context, OAuth.OAuth));
  yield* Ref.set(world.accounts, Context.get(context, Accounts.Accounts));
  yield* Ref.set(world.users, Context.get(context, Users.Users));
  yield* Ref.set(world.sessions, Context.get(context, Sessions.Sessions));
});

/** Only builds and returns the raw `Layer` — for REQ-EA-350/351, which need to observe *layer construction itself* failing (boot-time), not a successfully-built service. */
export const tryBuild = Effect.fn("features.oauth.tryBuild")(function* (options: BuildOptions) {
  return yield* Layer.build(buildLayer(options)).pipe(Effect.exit);
});

export const oauthService = Effect.fn("features.oauth.oauthService")(function* () {
  const { oauth } = yield* World;
  const found = yield* Ref.get(oauth);
  if (found === undefined) throw new Error("OAuth not configured yet — call configure() first");
  return found;
});

export const accountsService = Effect.fn("features.oauth.accountsService")(function* () {
  const { accounts } = yield* World;
  const found = yield* Ref.get(accounts);
  if (found === undefined) throw new Error("Accounts not configured yet — call configure() first");
  return found;
});

export const usersService = Effect.fn("features.oauth.usersService")(function* () {
  const { users } = yield* World;
  const found = yield* Ref.get(users);
  if (found === undefined) throw new Error("Users not configured yet — call configure() first");
  return found;
});

export const setOutcome = Effect.fn("features.oauth.setOutcome")(function* (
  key: string,
  value: unknown,
) {
  const { outcomes } = yield* World;
  yield* Ref.update(outcomes, (existing) => ({ ...existing, [key]: value }));
});

export const getOutcome = Effect.fn("features.oauth.getOutcome")(function* (key: string) {
  const { outcomes } = yield* World;
  const found = (yield* Ref.get(outcomes))[key];
  if (found === undefined) throw new Error(`no outcome recorded for "${key}"`);
  return found;
});
