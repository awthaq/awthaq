// P20a (AH-003, decision 36 tier 1): the real, SQL-backed composition the domain features
// (06-users-accounts, 08-verification-tokens) run against — `Users`/`Accounts`/`Sessions`/
// `Verification` over an in-memory SQLite database migrated by `@awthaq/sql`'s own
// `CoreMigrations`, a real `SqlTransaction`, plus the password plugin and the core `session`/
// `account` groups on one `HttpRouter` so a scenario can drive the wire *and* the services
// over the very same rows. Memory-store behaviour is proven by the package suites; what only
// a database can show here — the schema-level unique constraints (BEH-EA-041/043), atomic
// consumption (BEH-EA-062), one transaction around consume + state change (BEH-EA-058) — is
// why these features do not run over `layerMemory`.
//
// `Effect.runPromise`-style HTTP handlers run on the real clock; a scenario that needs
// expiry uses the direct `ctx` services under `TestClock` and never mixes the two.
import { AuthCore } from "@awthaq/api";
import {
  Accounts,
  AuditLog,
  AuthEvents,
  DataExport,
  Erasure,
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
  type PasswordHasher,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { Password, PasswordApi } from "@awthaq/password";
import { Account, Authentication, AuthHttp, Csrf, Session } from "@awthaq/server";
import { CoreMigrations, Repositories } from "@awthaq/sql";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";
import {
  cheapArgon2id,
  makeCapturingMailer,
  makeNamedRegistry,
  TestServices,
} from "./shared/Harness.ts";

type NamedRegistry<A> = ReturnType<typeof makeNamedRegistry<A>>;

/** Which SQL transaction (if any) the fiber is running in — set by the probed `SqlTransaction`, read by the probed services. `0` is "none". */
const CurrentTransaction = Context.Reference<number>("features/DomainWorld/CurrentTransaction", {
  defaultValue: () => 0,
});

export interface TransactionSighting {
  readonly operation: string;
  /** `0`: the operation ran outside any `SqlTransaction.withTransaction`. */
  readonly transaction: number;
}

export interface Faults {
  /** BEH-EA-058: makes `Accounts.updateCredentialHash` crash mid-`confirmReset`, after the token was consumed inside the same transaction. */
  failCredentialUpdate: boolean;
}

export interface Probes {
  readonly faults: Ref.Ref<Faults>;
  readonly sightings: Ref.Ref<ReadonlyArray<TransactionSighting>>;
  readonly events: Ref.Ref<ReadonlyArray<AuthEvents.Published>>;
}

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

const SqlLive = SqliteClient.layer({ filename: ":memory:" });
const Migrated = Layer.effectDiscard(
  Migrator.make({})({ loader: CoreMigrations.coreMigrations }),
).pipe(Layer.provide(SqlLive));

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

/** A breach corpus nothing ever matches — this composition is about identity rows, not the breach check. */
const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const sighting = (probes: Probes, operation: string) =>
  Effect.gen(function* () {
    const transaction = yield* CurrentTransaction;
    yield* Ref.update(probes.sightings, (seen) => [...seen, { operation, transaction }]);
  });

/** Observes (never alters) which transaction each of the three effects of `confirmReset` runs in, and lets a scenario crash the credential write. */
const probesLayer = (probes: Probes) => {
  let nextTransaction = 0;
  const TransactionProbe = Layer.effect(
    SqlTransaction.SqlTransaction,
    Effect.gen(function* () {
      const real = yield* SqlTransaction.SqlTransaction;
      return SqlTransaction.SqlTransaction.of({
        withTransaction: (effect) =>
          Effect.suspend(() => {
            const id = ++nextTransaction;
            return real.withTransaction(Effect.provideService(effect, CurrentTransaction, id));
          }),
      });
    }),
  );
  const AccountsProbe = Layer.effect(
    Accounts.Accounts,
    Effect.gen(function* () {
      const real = yield* Accounts.Accounts;
      return Accounts.Accounts.of({
        ...real,
        updateCredentialHash: (id, hash) =>
          Effect.gen(function* () {
            yield* sighting(probes, "Accounts.updateCredentialHash");
            if ((yield* Ref.get(probes.faults)).failCredentialUpdate) {
              return yield* Effect.die(
                new Error("injected: crash while applying the new password"),
              );
            }
            return yield* real.updateCredentialHash(id, hash);
          }),
      });
    }),
  );
  const VerificationProbe = Layer.effect(
    Verification.Verification,
    Effect.gen(function* () {
      const real = yield* Verification.Verification;
      return Verification.Verification.of({
        ...real,
        consume: (identifier, value) =>
          sighting(probes, "Verification.consume").pipe(
            Effect.andThen(real.consume(identifier, value)),
          ),
      });
    }),
  );
  const SessionsProbe = Layer.effect(
    Sessions.Sessions,
    Effect.gen(function* () {
      const real = yield* Sessions.Sessions;
      return Sessions.Sessions.of({
        ...real,
        revokeAll: (userId, reason) =>
          sighting(probes, "Sessions.revokeAll").pipe(
            Effect.andThen(real.revokeAll(userId, reason)),
          ),
      });
    }),
  );
  return { TransactionProbe, AccountsProbe, VerificationProbe, SessionsProbe };
};

/** The one `AuthEvents` subscriber a scenario reads back: registered before anything can publish (`startImmediately`, the AdminWorld lesson). */
const eventsLayer = (probes: Probes) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const authEvents = yield* AuthEvents.AuthEvents;
      yield* authEvents.stream.pipe(
        Stream.runForEach((event) => Ref.update(probes.events, (existing) => [...existing, event])),
        Effect.forkScoped({ startImmediately: true }),
      );
    }),
  );

const makeProbes = () => ({
  faults: Ref.makeUnsafe<Faults>({ failCredentialUpdate: false }),
  sightings: Ref.makeUnsafe<ReadonlyArray<TransactionSighting>>([]),
  events: Ref.makeUnsafe<ReadonlyArray<AuthEvents.Published>>([]),
});

const buildStack = (probes: Probes) => {
  const mailer = makeCapturingMailer();
  const { TransactionProbe, AccountsProbe, VerificationProbe, SessionsProbe } = probesLayer(probes);

  const RealStores = Layer.mergeAll(
    Accounts.layerSql.pipe(
      Layer.provide(Repositories.AccountsRepositoryLive.pipe(Layer.provide(EncryptionLive))),
    ),
    Sessions.layerSql.pipe(Layer.provide(Repositories.SessionsRepositoryLive)),
    Verification.layerSql.pipe(
      Layer.provide(
        Layer.mergeAll(
          Repositories.VerificationRepositoryLive,
          Repositories.VerificationReservationsRepositoryLive,
        ),
      ),
    ),
    SqlTransaction.layerSql,
  );

  // The probes wrap the real services under the same tags (provide, never merge, so the
  // probed instance is the only one anything above sees).
  const Stores = Layer.merge(
    Users.layerSql.pipe(Layer.provide(Repositories.UsersRepositoryLive)),
    Layer.mergeAll(AccountsProbe, VerificationProbe, SessionsProbe, TransactionProbe).pipe(
      Layer.provide(RealStores),
    ),
  );

  const CoreLive = Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
    Layer.provideMerge(Stores),
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layerSql.pipe(Layer.provide(Repositories.AuditLogRepositoryLive))),
    Layer.provideMerge(Hooks.HooksLive),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );

  const appLayer = Layer.mergeAll(
    AuthHttp.routes(AuthCore.AuthCoreApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Session.SessionHandlers),
      Layer.provide(Account.AccountHandlers),
    ),
    AuthHttp.routes(PasswordApi.PasswordApi, { openapiPath: "/password-openapi.json" }).pipe(
      Layer.provide(Password.Password.layer),
    ),
  ).pipe(
    Layer.provideMerge(AuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(eventsLayer(probes)),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(
      Layer.mergeAll(cheapArgon2id, mailer.layer, RateLimiter.layerPermissive).pipe(
        Layer.provideMerge(NodeCrypto.layer),
      ),
    ),
    Layer.provideMerge(RateLimits.layer),
    Layer.provide(NoBreachHttpClient),
    Layer.provide(ClientAddress.layerDirect),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
    Layer.provideMerge(Password.config({})),
  );

  return { appLayer, sentMail: mailer.sent };
};

/** What a direct (non-HTTP) step may ask of the composition. */
export type DomainServices =
  | Users.Users
  | Accounts.Accounts
  | Sessions.Sessions
  | Verification.Verification
  | AuthEvents.AuthEvents
  | AuditLog.AuditLog
  | PasswordHasher.PasswordHasher
  | SqlClient.SqlClient;

/** A person a scenario names ("alice"): the credentials it registered, and what the app has told us about them since. */
export interface Person {
  readonly email: string;
  readonly password: string;
  readonly userId: Option.Option<Users.UserId>;
  /** The bare `name=value` session cookie, once the person is signed in over the wire. */
  readonly cookie: Option.Option<string>;
}

/** A verification token a scenario holds: the row's identifier, and the plaintext value only the recipient ever sees. */
export interface HeldToken {
  readonly identifier: string;
  /** The mailed form `<identifier>.<secret>`. */
  readonly mailed: string;
  /** The secret half alone — what `Verification.consume` takes with the identifier. */
  readonly secret: string;
}

export interface WorldShape {
  readonly handler: (request: Request) => Promise<Response>;
  readonly ctx: Context.Context<DomainServices>;
  readonly probes: Probes;
  readonly sentMail: Effect.Effect<ReadonlyArray<Mailer.MailMessage>>;
  readonly people: NamedRegistry<Person>;
  readonly tokens: NamedRegistry<HeldToken>;
  readonly responses: NamedRegistry<Response>;
  /** Outcomes of direct service calls, by the name a step chose. */
  readonly exits: NamedRegistry<Exit.Exit<unknown, unknown>>;
  /** Scalars a step wants a later step to compare against (counts, flags). */
  readonly numbers: NamedRegistry<number>;
  readonly strings: NamedRegistry<string>;
}

export class World extends Context.Service<World, WorldShape>()("features/DomainWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const probes = makeProbes();
    const { appLayer, sentMail } = buildStack(probes);
    // Built on the real clock, outside the step's `TestClock`: `CsrfProtection` (and every other
    // service that reads the clock when it is *built*) would otherwise be pinned to 1970 and
    // reject the real-clock CSRF cookie. Direct calls still read the caller's clock per call.
    const scope = Scope.makeUnsafe();
    const memoMap = Layer.makeMemoMapUnsafe();
    const ctx = yield* Effect.promise(() =>
      Effect.runPromise(Layer.buildWithMemoMap(appLayer, memoMap, scope)),
    );
    const web = HttpRouter.toWebHandler(appLayer, { memoMap });
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        Scope.close(scope, Exit.void),
        Effect.promise(() => web.dispose()),
      ),
    );
    return World.of({
      handler: web.handler,
      ctx,
      probes,
      sentMail,
      people: makeNamedRegistry<Person>("person"),
      tokens: makeNamedRegistry<HeldToken>("token"),
      responses: makeNamedRegistry<Response>("response"),
      exits: makeNamedRegistry<Exit.Exit<unknown, unknown>>("outcome"),
      numbers: makeNamedRegistry<number>("number"),
      strings: makeNamedRegistry<string>("string"),
    });
  }),
);

/**
 * Runs a service-level effect against the same composition (and rows) the HTTP handler serves.
 * Anything that fails is a defect here — a step that means to observe a typed failure uses
 * `directExit` instead.
 */
export const direct = <A, E>(effect: Effect.Effect<A, E, DomainServices>) =>
  Effect.gen(function* () {
    const { ctx } = yield* World;
    return yield* Effect.provide(effect, ctx).pipe(Effect.orDie);
  });

/** Like `direct`, but the outcome — typed failure included — is the value. */
export const directExit = <A, E>(effect: Effect.Effect<A, E, DomainServices>) =>
  Effect.gen(function* () {
    const { ctx } = yield* World;
    return yield* Effect.exit(Effect.provide(effect, ctx));
  });
