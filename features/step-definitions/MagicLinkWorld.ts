// P20a (BCR-010): the composition the magic-link and email-otp features run against — the real
// `MagicLink` and `EmailOtp` plugins over in-memory `Users`/`Accounts`/`Sessions`/`Verification`,
// the real `@awthaq/two-factor` gates (so the MFA divert is a real divert, not a stub), both plugin
// contracts served on one `HttpRouter` behind the real CSRF and authentication middleware, and a
// capturing `Mailer` so a step plays the recipient.
//
// Two ways in over the very same rows: the web `handler` (a scenario about the wire — status
// codes, GET refusal, the 202 body) and `direct` (a scenario about the service — an expiry under
// `TestClock`, an error tag). The layers are built on the real clock, outside the step's
// `TestClock` (the DomainWorld lesson: `CsrfProtection` would otherwise be pinned to 1970); a
// direct call reads the caller's clock per call, so an expiry scenario never goes through HTTP.
//
// The app is built lazily on first use so a `Given` can configure it first (`configureApp` merges
// options; nothing may have been requested yet, since state does not carry over a rebuild).
import { Api } from "@awthaq/api";
import {
  Accounts,
  AuditLog,
  HookPoint,
  Hooks,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import {
  ClientAddress,
  Encryption,
  KeyProvider,
  type Mailer,
  PasswordHasher,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { EmailOtp, EmailOtpApi, MagicLink, MagicLinkApi } from "@awthaq/magic-link";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import { SecondFactor, Totp, TwoFactor, TwoFactorStore } from "@awthaq/two-factor";
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
import { mailedToken } from "./MailedToken.ts";
import {
  cheapArgon2id,
  makeCapturingMailer,
  makeNamedRegistry,
  TestServices,
} from "./shared/Harness.ts";
import { makeOutcomes } from "./shared/Outcomes.ts";
import { snapshot, type Snapshot } from "./shared/WireJson.ts";
import { TestAuth } from "@awthaq/test";

export type NamedRegistry<A> = ReturnType<typeof makeNamedRegistry<A>>;

/** What a scenario may configure before the first request. */
export interface AppOptions {
  readonly magicLink?: Partial<MagicLink.MagicLinkConfigShape>;
  readonly emailOtp?: Partial<EmailOtp.EmailOtpConfigShape>;
  /** The enforcing limiter over the in-memory store, instead of the permissive one every other scenario wants. */
  readonly realLimits?: boolean;
}

/** What a direct (non-HTTP) step may ask of the composition. */
export type MagicLinkServices =
  | MagicLink.MagicLink
  | EmailOtp.EmailOtp
  | Users.Users
  | Accounts.Accounts
  | Sessions.Sessions
  | Verification.Verification
  | AuditLog.AuditLog
  | TwoFactor.TwoFactor
  | SecondFactor.SecondFactor
  | PasswordHasher.PasswordHasher
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

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
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

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(Layer.provideMerge(TestAuth.memoryFoundation));

const realLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));

const buildApp = (options: AppOptions) => {
  const mailer = makeCapturingMailer();
  /** Addresses whose sign-in a `BeforeSignIn` tap refuses (a scenario's own veto, BEH-EA-269). */
  const vetoed = Ref.makeUnsafe<ReadonlyArray<string>>([]);

  const Veto = Hooks.BeforeSignIn.tap((input) =>
    Effect.gen(function* () {
      const refused = yield* Ref.get(vetoed);
      return input.email !== undefined && refused.includes(input.email)
        ? yield* new HookPoint.HookAbort({ code: "USER_BANNED" })
        : input;
    }),
  );

  // One build of each plugin serves both the routes and the direct steps (the same layer object,
  // so the memo map shares the instance).
  const plugins = Layer.mergeAll(MagicLink.MagicLink.layer, EmailOtp.EmailOtp.layer);
  const routes = Layer.mergeAll(
    AuthHttp.routes(MagicLinkApi.MagicLinkApi, { openapiPath: "/magic-link.json" }),
    AuthHttp.routes(EmailOtpApi.EmailOtpApi, { openapiPath: "/email-otp.json" }),
  ).pipe(Layer.provide(plugins));

  const appLayer = Layer.merge(routes, plugins).pipe(
    Layer.provideMerge(Layer.mergeAll(TwoFactorLive, Veto)),
    Layer.provideMerge(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(
        cheapArgon2id,
        mailer.layer,
        options.realLimits === true ? realLimiter : RateLimiter.layerPermissive,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(SqlTransaction.layerNoop),
    Layer.provide(ClientAddress.layerDirect),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
    Layer.provideMerge(MagicLink.config(options.magicLink ?? {})),
    Layer.provideMerge(EmailOtp.config(options.emailOtp ?? {})),
  );
  return { appLayer, sentMail: mailer.sent, vetoed };
};

interface App {
  readonly handler: (request: Request) => Promise<Response>;
  readonly ctx: Context.Context<MagicLinkServices>;
  readonly sentMail: Effect.Effect<ReadonlyArray<Mailer.MailMessage>>;
  readonly vetoed: Ref.Ref<ReadonlyArray<string>>;
  readonly dispose: () => Promise<void>;
}

const startApp = (options: AppOptions): Promise<App> => {
  const { appLayer, sentMail, vetoed } = buildApp(options);
  const scope = Scope.makeUnsafe();
  const memoMap = Layer.makeMemoMapUnsafe();
  return Effect.runPromise(Layer.buildWithMemoMap(appLayer, memoMap, scope)).then((ctx) => {
    const web = HttpRouter.toWebHandler(appLayer, { memoMap });
    return {
      handler: web.handler,
      ctx,
      sentMail,
      vetoed,
      dispose: async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void));
        await web.dispose();
      },
    };
  });
};

/** A person a scenario names: what the app has told the recipient (the mailed secrets) is read from the mail, never from the store. */
export interface WorldShape {
  readonly options: Ref.Ref<AppOptions>;
  readonly app: Ref.Ref<Option.Option<App>>;
  readonly responses: NamedRegistry<Snapshot>;
  readonly exits: NamedRegistry<Exit.Exit<unknown, unknown>>;
  readonly strings: NamedRegistry<string>;
  readonly numbers: NamedRegistry<number>;
  readonly outcomes: Effect.Success<typeof makeOutcomes>;
}

export class World extends Context.Service<World, WorldShape>()("features/MagicLinkWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const world = World.of({
      options: yield* Ref.make<AppOptions>({}),
      app: yield* Ref.make(Option.none<App>()),
      responses: makeNamedRegistry<Snapshot>("response"),
      exits: makeNamedRegistry<Exit.Exit<unknown, unknown>>("outcome"),
      strings: makeNamedRegistry<string>("string"),
      numbers: makeNamedRegistry<number>("number"),
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
export const configureApp = Effect.fn("features.magicLink.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  if (Option.isSome(yield* Ref.get(world.app))) {
    return yield* Effect.die(new Error("configureApp: the app is already running"));
  }
  yield* Ref.update(world.options, (existing) => ({
    ...existing,
    ...options,
    magicLink: { ...existing.magicLink, ...options.magicLink },
    emailOtp: { ...existing.emailOtp, ...options.emailOtp },
  }));
});

export const appOf = Effect.fn("features.magicLink.app")(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.app);
  if (Option.isSome(existing)) return existing.value;
  // The handler runs on the real clock and a direct call on the step's `TestClock`, which starts
  // at the epoch: line the two up once, so a row minted one way does not read as expired the other.
  yield* TestClock.setTime(Date.now());
  const started = yield* Effect.promise(async () =>
    startApp(await Effect.runPromise(Ref.get(world.options))),
  );
  yield* Ref.set(world.app, Option.some(started));
  return started;
});

/** Runs a service-level effect against the same composition (and rows) the handler serves; a typed failure is a defect here. */
export const direct = <A, E>(effect: Effect.Effect<A, E, MagicLinkServices>) =>
  Effect.gen(function* () {
    const { ctx } = yield* appOf();
    return yield* Effect.provide(effect, ctx).pipe(Effect.orDie);
  });

/** Like `direct`, but the outcome (a typed failure included) is the value. */
export const directExit = <A, E>(effect: Effect.Effect<A, E, MagicLinkServices>) =>
  Effect.gen(function* () {
    const { ctx } = yield* appOf();
    return yield* Effect.exit(Effect.provide(effect, ctx));
  });

/** The mail the recipient last received of `template` for `to`, waiting (on the real timer: `TestClock` is frozen) for the background dispatch fiber. */
export const mailOf = Effect.fn("features.magicLink.mailOf")(function* (
  template: string,
  to: string,
) {
  const { sentMail } = yield* appOf();
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = (yield* sentMail).findLast(
      (message) => message.template === template && message.to.toLowerCase() === to.toLowerCase(),
    );
    if (found !== undefined) return found;
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  }
  return yield* Effect.die(new Error(`no "${template}" mail for ${to} arrived`));
});

/** The mails of `template` sent so far to `to`, after giving the background dispatch a moment to finish. */
export const mailsOf = Effect.fn("features.magicLink.mailsOf")(function* (
  template: string,
  to: string,
) {
  const { sentMail } = yield* appOf();
  // Nothing to wait for when no mail is expected: settle on the real timer, then read.
  yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 40)));
  return (yield* sentMail).filter(
    (message) => message.template === template && message.to.toLowerCase() === to.toLowerCase(),
  );
});

/** The secret a mail carries under `field` (`token` for a link, `code` for a code): a step plays the recipient. */
export const secretOf = (mail: Mailer.MailMessage, field: string): string => {
  if (field === "token") return mailedToken(mail);
  const value = mail.data?.[field];
  if (Redacted.isRedacted(value)) return String(Redacted.value(value));
  throw new Error(`expected a redacted "${field}" in the "${mail.template}" mail`);
};

/** An unsafe JSON `POST` playing the double-submit role a real client would; `query` is appended to the path verbatim. */
export const request = Effect.fn("features.magicLink.request")(function* (
  method: string,
  path: string,
  body?: unknown,
) {
  const { handler } = yield* appOf();
  const response = yield* Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          cookie: `${CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`,
          [CSRF_HEADER_NAME]: CSRF_TEST_COOKIE_VALUE,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );
  return yield* snapshot(response);
});

export const SESSION_COOKIE = Api.SESSION_COOKIE_NAME;

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
