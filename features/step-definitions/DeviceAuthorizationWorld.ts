// BEH-EA-299 to BEH-EA-306: the composition the device-authorization feature runs against — the real
// `DeviceAuthorization` plugin over in-memory grant and client records, `Users` and `Sessions`, the real
// `@awthaq/two-factor` gate (so the MFA divert is a real divert), and the plugin's contract served on one
// `HttpRouter` behind the real CSRF and authentication middleware.
//
// Two ways in over the very same rows: the web `handler` (a scenario about the wire — a form-encoded body,
// an RFC 6749 error, no cookie) and `direct` (a scenario about the service — an interval or an expiry under
// `TestClock`, a concurrent poll, an error tag). The layers are built on the real clock, outside the step's
// `TestClock` (the MagicLinkWorld lesson: `CsrfProtection` would otherwise be pinned to 1970); a direct call
// reads the caller's clock per call, so a time-dependent scenario never goes through HTTP.
//
// The app is built lazily on first use so a `Given` can configure it first (`configureApp` merges options;
// nothing may have been requested yet, since state does not carry over a rebuild).
import { Api } from "@awthaq/api";
import {
  AuditLog,
  DataExport,
  Erasure,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import {
  DeviceAuthorization,
  DeviceAuthorizationApi,
  DeviceClientRecords,
  DeviceGrantRecords,
} from "@awthaq/device-authorization";
import { ClientAddress, Encryption, KeyProvider, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import { SecondFactor, Totp, TwoFactor, TwoFactorStore } from "@awthaq/two-factor";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_TEST_COOKIE_VALUE,
  CsrfConfigForTests,
} from "./CsrfTestSupport.ts";
import { cheapArgon2id, makeNamedRegistry, TestServices } from "./shared/Harness.ts";
import { makeOutcomes } from "./shared/Outcomes.ts";
import { snapshot, type Snapshot } from "./shared/WireJson.ts";

export type NamedRegistry<A> = ReturnType<typeof makeNamedRegistry<A>>;

/** What a scenario may configure before the first request. */
export interface AppOptions {
  readonly config?: Partial<DeviceAuthorization.DeviceAuthorizationConfigShape>;
  /** The enforcing limiter over the in-memory store, instead of the permissive one every other scenario wants. */
  readonly realLimits?: boolean;
}

/** What a direct (non-HTTP) step may ask of the composition. */
export type DeviceServices =
  | DeviceAuthorization.DeviceAuthorization
  | DeviceGrantRecords.DeviceGrantRecords
  | DeviceClientRecords.DeviceClientRecords
  | Users.Users
  | Sessions.Sessions
  | AuditLog.AuditLog
  | Erasure.ErasureRegistry
  | DataExport.DataExportRegistry
  | RateLimits.RateLimitsRegistry
  | TwoFactor.TwoFactor
  | Crypto.Crypto;

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

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

/** `@awthaq/two-factor`, gate included, so a confirmed second factor really diverts a session issue. */
const TwoFactorLive = TwoFactor.TwoFactor.layer.pipe(
  Layer.provideMerge(TwoFactor.sessionGate),
  Layer.provideMerge(TwoFactor.credentialResetGate),
  Layer.provideMerge(SecondFactor.layer),
  Layer.provideMerge(
    Layer.mergeAll(TwoFactorStore.layerSecretsMemory, TwoFactorStore.layerRecoveryCodesMemory),
  ),
  Layer.provideMerge(EncryptionLive),
);

const realLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

const buildApp = (options: AppOptions) => {
  // One build of the plugin serves both the routes and the direct steps (the same layer object, so the
  // memo map shares the instance).
  const plugin = DeviceAuthorization.DeviceAuthorization.layer;
  const routes = AuthHttp.routes(DeviceAuthorizationApi.DeviceAuthorizationApi).pipe(
    Layer.provide(plugin),
  );
  return Layer.merge(routes, plugin).pipe(
    Layer.provideMerge(TwoFactorLive),
    Layer.provideMerge(DeviceAuthorization.DeviceAuthorizationHooksLive),
    Layer.provideMerge(
      Layer.mergeAll(DeviceGrantRecords.layerMemory, DeviceClientRecords.layerMemory),
    ),
    Layer.provideMerge(Authentication.AuthenticationLive),
    Layer.provideMerge(Authentication.OptionalAuthenticationLive),
    Layer.provide(Authentication.PrincipalResolverLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(
      Layer.mergeAll(
        Users.layerMemory,
        Sessions.layerMemory,
        Verification.layerMemory,
        cheapArgon2id,
      ),
    ),
    Layer.provideMerge(TestAuth.memoryFoundation),
    Layer.provideMerge(RateLimits.layer),
    Layer.provideMerge(options.realLimits === true ? realLimiter : RateLimiter.layerPermissive),
    Layer.provideMerge(ClientAddress.layerDirect),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
    Layer.provideMerge(DeviceAuthorization.config(options.config ?? {})),
  );
};

interface App {
  readonly handler: (request: Request) => Promise<Response>;
  readonly ctx: Context.Context<DeviceServices>;
  readonly dispose: () => Promise<void>;
}

const startApp = (options: AppOptions): Promise<App> => {
  const appLayer = buildApp(options);
  const scope = Scope.makeUnsafe();
  const memoMap = Layer.makeMemoMapUnsafe();
  return Effect.runPromise(Layer.buildWithMemoMap(appLayer, memoMap, scope)).then((ctx) => {
    const web = HttpRouter.toWebHandler(appLayer, { memoMap });
    return {
      handler: web.handler,
      ctx,
      dispose: async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await web.dispose();
      },
    };
  });
};

/** The scenario's own scratch pad: typed cells, so a step narrows nothing by assertion. */
export interface WorldShape {
  readonly options: Ref.Ref<AppOptions>;
  readonly app: Ref.Ref<Option.Option<App>>;
  /** Every device code the scenario has requested, newest last; a step names one by position from the end. */
  readonly codes: Ref.Ref<ReadonlyArray<DeviceAuthorization.CodeIssued>>;
  /** The people a scenario names: the claiming user (`primary`) and a second, unrelated one (`other`). */
  readonly callers: Ref.Ref<Readonly<Record<string, DeviceAuthorization.Caller>>>;
  /** The outcome of the step that last ran, whatever it was: an error's RFC name or `_tag`, or `success`. */
  readonly last: Ref.Ref<Option.Option<Exit.Exit<unknown, unknown>>>;
  /** Every poll the scenario has made, newest last, with the value a redeeming poll received. */
  readonly polls: Ref.Ref<
    ReadonlyArray<Exit.Exit<DeviceAuthorization.RedeemedGrant, DeviceAuthorization.PollError>>
  >;
  readonly responses: NamedRegistry<Snapshot>;
  readonly outcomes: Effect.Success<typeof makeOutcomes>;
}

export class World extends Context.Service<World, WorldShape>()(
  "features/DeviceAuthorizationWorld",
) {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const world = World.of({
      options: yield* Ref.make<AppOptions>({}),
      app: yield* Ref.make(Option.none<App>()),
      codes: yield* Ref.make<ReadonlyArray<DeviceAuthorization.CodeIssued>>([]),
      callers: yield* Ref.make<Readonly<Record<string, DeviceAuthorization.Caller>>>({}),
      last: yield* Ref.make(Option.none<Exit.Exit<unknown, unknown>>()),
      polls: yield* Ref.make<
        ReadonlyArray<Exit.Exit<DeviceAuthorization.RedeemedGrant, DeviceAuthorization.PollError>>
      >([]),
      responses: makeNamedRegistry<Snapshot>("response"),
      outcomes: yield* makeOutcomes,
    });
    yield* Effect.addFinalizer(() =>
      Ref.get(world.app).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (app) => Effect.promise(() => app.dispose()),
          }),
        ),
      ),
    );
    return world;
  }),
);

/** Merges `options` onto what was configured so far. Nothing may have been requested against the old app: state does not carry over. */
export const configureApp = Effect.fn("features.deviceAuthorization.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  if (Option.isSome(yield* Ref.get(world.app))) {
    return yield* Effect.die(new Error("configureApp: the app is already running"));
  }
  yield* Ref.update(world.options, (existing) => ({
    ...existing,
    ...options,
    config: { ...existing.config, ...options.config },
  }));
});

export const appOf = Effect.fn("features.deviceAuthorization.app")(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.app);
  if (Option.isSome(existing)) return existing.value;
  // The handler runs on the real clock and a direct call on the step's `TestClock`, which starts at the
  // epoch: line the two up once, so a row minted one way does not read as expired the other.
  yield* TestClock.setTime(Date.now());
  const started = yield* Effect.promise(async () =>
    startApp(await Effect.runPromise(Ref.get(world.options))),
  );
  yield* Ref.set(world.app, Option.some(started));
  return started;
});

/** Runs a service-level effect against the same composition (and rows) the handler serves; a typed failure is a defect here. */
export const direct = <A, E>(effect: Effect.Effect<A, E, DeviceServices>) =>
  Effect.gen(function* () {
    const { ctx } = yield* appOf();
    return yield* Effect.provide(effect, ctx).pipe(Effect.orDie);
  });

/** Like `direct`, but the outcome (a typed failure included) is the value. */
export const directExit = <A, E>(effect: Effect.Effect<A, E, DeviceServices>) =>
  Effect.gen(function* () {
    const { ctx } = yield* appOf();
    return yield* Effect.exit(Effect.provide(effect, ctx));
  });

/** A `POST` playing the client it is: a device (form-encoded, no cookie, no CSRF) or a person's browser (JSON, cookie, double-submit). */
export const request = Effect.fn("features.deviceAuthorization.request")(function* (
  path: string,
  init:
    | { readonly form: Readonly<Record<string, string>> }
    | { readonly json: unknown; readonly cookie?: string },
) {
  const { handler } = yield* appOf();
  const response = yield* Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers:
          "form" in init
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {
                "content-type": "application/json",
                cookie: [init.cookie, `${CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`]
                  .filter((part) => part !== undefined)
                  .join("; "),
                [CSRF_HEADER_NAME]: CSRF_TEST_COOKIE_VALUE,
              },
        body:
          "form" in init ? new URLSearchParams(init.form).toString() : JSON.stringify(init.json),
      }),
    ),
  );
  return yield* snapshot(response);
});

export const SESSION_COOKIE = Api.SESSION_COOKIE_NAME;

/** A fresh user with a live session recording `amr`: the caller a verification page or decision endpoint resolves. */
export const signedInCaller = (email: string, amr: ReadonlyArray<Sessions.AuthMethod>) =>
  direct(
    Effect.gen(function* () {
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const user = yield* users.create({ identity: { _tag: "Email", email }, name: email });
      const issued = yield* sessions.issue({ userId: user.id, amr });
      const caller: DeviceAuthorization.Caller = {
        userId: user.id,
        sessionId: issued.session.id,
        impersonated: false,
        amr,
      };
      return { caller, token: issued.token };
    }),
  );

/** Enrols and confirms a TOTP second factor for `userId`, exactly as the two-factor package's own tests do. */
export const enrolSecondFactor = (userId: Users.UserId) =>
  direct(
    Effect.gen(function* () {
      const sessions = yield* Sessions.Sessions;
      const twoFactor = yield* TwoFactor.TwoFactor;
      const crypto = yield* Crypto.Crypto;
      const fresh = yield* sessions.issue({ userId });
      const enrolment = yield* twoFactor.enable(userId, fresh.session.id);
      const key = Option.getOrThrow(Totp.base32Decode(enrolment.secret));
      const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
      const code = yield* Totp.totp(crypto, key, now, { period: 30, digits: 6 });
      yield* twoFactor.confirm(userId, Redacted.make(code));
    }),
  );
