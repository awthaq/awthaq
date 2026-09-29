// The shared composition for this package's tests: the real `DeviceAuthorization` plugin over in-memory
// `Users`/`Sessions`, its grant and client records either in memory or on a real migrated database
// (`TestSql`: `:memory:` SQLite by default, a real per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`),
// the real `@awthaq/two-factor` gates when a test asks (so the MFA divert is a real divert), and the
// contract served behind the real CSRF and authentication middleware — so a test can go through the wire
// (`makeApp`) or call the service directly (`buildLayer`), over the very same rows.
import { Api } from "@awthaq/api";
import { Migrations, RateLimits, Sessions, Users, Verification } from "@awthaq/core";
import type { Hooks } from "@awthaq/core";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  PasswordHasher,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import { SecondFactor, TwoFactor, TwoFactorStore } from "@awthaq/two-factor";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { createHmac, randomBytes } from "node:crypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as TestSql from "../../../sql/test/support/TestSql.ts";
import * as DeviceAuthorization from "../../src/DeviceAuthorization.ts";
import * as DeviceAuthorizationApi from "../../src/DeviceAuthorizationApi.ts";
import * as DeviceClientRecords from "../../src/DeviceClientRecords.ts";
import * as DeviceGrantRecords from "../../src/DeviceGrantRecords.ts";

const ORIGIN = "http://localhost:3000";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CSRF_SECRET = "device-authorization-test-csrf-secret-padded-to-thirty-two-bytes";
const CSRF_TOKEN = (() => {
  // `<iat>.<random>.<hmac(iat.random)>` (CDS-006).
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", CSRF_SECRET).update(signed).digest("hex")}`;
})();

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** Cheap Argon2id: `TwoFactor` hashes recovery codes, and a test does not need them slow. */
const TestHasher = PasswordHasher.layerArgon2id.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: { AUTH_ARGON2_MEMORY_KIB: "1024", AUTH_ARGON2_ITERATIONS: "1" },
      }),
    ),
  ),
  Layer.orDie,
);

const EncryptionLive = Encryption.layer.pipe(
  Layer.provide(
    KeyProvider.layerEnv.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { AWTHAQ_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") },
          }),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** `@awthaq/two-factor`, gates included, so a confirmed second factor really diverts a sign-in. */
const TwoFactorLive = TwoFactor.TwoFactor.layer.pipe(
  Layer.provideMerge(TwoFactor.sessionGate),
  Layer.provideMerge(TwoFactor.credentialResetGate),
  Layer.provideMerge(SecondFactor.layer),
  Layer.provideMerge(
    Layer.mergeAll(TwoFactorStore.layerSecretsMemory, TwoFactorStore.layerRecoveryCodesMemory),
  ),
  Layer.provideMerge(EncryptionLive),
);

export interface HarnessOptions {
  readonly store: "memory" | "sql";
  /** Names the schema on Postgres; one distinct value per test file. */
  readonly suite?: string;
  readonly config?: Partial<DeviceAuthorization.DeviceAuthorizationConfigShape>;
  /** The enforcing limiter over the in-memory store, instead of the permissive one. */
  readonly rateLimiter?: "permissive" | "enforcing";
}

/** The grant and client records, in memory or over a real database migrated with the plugin's own migrations. */
const recordsLayer = (options: HarnessOptions) => {
  if (options.store === "memory") {
    return Layer.mergeAll(DeviceGrantRecords.layerMemory, DeviceClientRecords.layerMemory);
  }
  const SqlLive = TestSql.layer(options.suite ?? "device_authorization");
  const Migrated = Layer.effectDiscard(
    Migrations.run(DeviceAuthorization.DeviceAuthorization.migrations),
  ).pipe(Layer.provide(SqlLive));
  return Layer.mergeAll(DeviceGrantRecords.layerSql, DeviceClientRecords.layerSql).pipe(
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );
};

/** Hook taps a test installs: they need the points the composition provides. */
type Taps = Layer.Layer<
  never,
  never,
  | Hooks.BeforeSignIn
  | Hooks.BeforeSessionIssue
  | DeviceAuthorization.BeforeDeviceApproval
  | DeviceAuthorization.AfterDeviceApproval
>;

export const buildLayer = (options: HarnessOptions, taps: Taps = Layer.empty) =>
  Layer.mergeAll(AuthHttp.routes(DeviceAuthorizationApi.DeviceAuthorizationApi), taps)
    .pipe(
      Layer.provideMerge(DeviceAuthorization.DeviceAuthorization.layer),
      // `@awthaq/two-factor`'s gate is always installed: it diverts only a user with a confirmed second factor.
      Layer.provideMerge(TwoFactorLive),
      Layer.provideMerge(DeviceAuthorization.DeviceAuthorizationHooksLive),
      Layer.provideMerge(recordsLayer(options)),
      Layer.provideMerge(Authentication.AuthenticationLive),
      Layer.provideMerge(Authentication.OptionalAuthenticationLive),
      Layer.provide(Authentication.PrincipalResolverLive),
      Layer.provide(CsrfProtectionLive),
    )
    .pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Users.layerMemory,
          Sessions.layerMemory,
          Verification.layerMemory,
          TestHasher,
        ),
      ),
      Layer.provideMerge(TestAuth.memoryFoundation),
      Layer.provideMerge(RateLimits.layer),
      Layer.provideMerge(
        options.rateLimiter === "enforcing"
          ? RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))
          : RateLimiter.layerPermissive,
      ),
      Layer.provideMerge(ClientAddress.layerDirect),
      Layer.provideMerge(SqlTransaction.layerNoop),
      Layer.provideMerge(TestServices),
      Layer.provideMerge(HttpRouter.layer),
      Layer.provideMerge(DeviceAuthorization.config(options.config ?? {})),
    );

export type HarnessServices = Layer.Success<ReturnType<typeof buildLayer>>;

/** A running app: the real web handler, and a way to reach the very services it runs against. */
export const makeApp = (options: HarnessOptions, taps?: Taps) => {
  const layer = buildLayer(options, taps);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(layer, { memoMap });
  const withContext = <A, E>(effect: Effect.Effect<A, E, HarnessServices>): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(layer, memoMap, scope);
          return yield* effect.pipe(Effect.provide(context));
        }),
      ),
    );

  /** A real session for a fresh user with `amr`, as `{ userId, cookie, bearer }`, against the same running `Sessions`. */
  const signedInUser = (email: string, amr: ReadonlyArray<Sessions.AuthMethod> = ["pwd"]) =>
    withContext(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ identity: { _tag: "Email", email }, name: email });
        const issued = yield* sessions.issue({ userId: user.id, amr });
        const token = Redacted.value(issued.token);
        return {
          userId: user.id,
          sessionId: issued.session.id,
          cookie: `${Api.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
          bearer: token,
        };
      }).pipe(Effect.orDie),
    );

  const request = (
    method: string,
    path: string,
    init?: {
      readonly cookie?: string;
      readonly headers?: Record<string, string>;
      readonly json?: unknown;
      readonly form?: Record<string, string>;
    },
  ) =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(init?.json === undefined ? {} : { "content-type": "application/json" }),
          ...(init?.form === undefined
            ? {}
            : { "content-type": "application/x-www-form-urlencoded" }),
          // Unsafe methods pass the double-submit CSRF check the way a browser client would.
          cookie: [init?.cookie, `${Api.CSRF_COOKIE_NAME}=${CSRF_TOKEN}`]
            .filter((part) => part !== undefined)
            .join("; "),
          [Api.CSRF_HEADER_NAME]: CSRF_TOKEN,
          ...init?.headers,
        },
        ...(init?.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        ...(init?.form === undefined ? {} : { body: new URLSearchParams(init.form).toString() }),
      }),
    );

  return { handler, withContext, signedInUser, request, layer };
};

export const CLI_CLIENT_ID = DeviceAuthorization.CLI_CLIENT.clientId;
export const DEVICE_GRANT = DeviceAuthorizationApi.DEVICE_CODE_GRANT_TYPE;
