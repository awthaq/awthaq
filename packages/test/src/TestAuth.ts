// @awthaq/test — TestAuth
//
// spec/behaviors/25-testing-harness.md, BEH-EA-193 through BEH-EA-200.
//
// **What is deliberately not built here, and why:**
// - BEH-EA-193's "permissive `RateLimiter`" is wired in below
//   (`RateLimiter.layerPermissive`, `@awthaq/ports`'s own BEH-EA-112
//   default). `RateLimits.layer` (`@awthaq/core`'s per-plugin rule
//   *registry* half) is provided too, as of the shipping-gap map's ticket
//   12 — `Password` is the first real `RateLimits.rule` consumer, so
//   building `Password.layer` (and, by extension, `TestAuth.layer(built)`
//   for any composition that includes it) now genuinely needs a
//   `RateLimitsRegistry` instance to register into.
// - BEH-EA-194 (`TestClock`) and BEH-EA-195 (`Layer.mock`) are `effect`'s own
//   exports, not awthaq's — nothing to wrap; a test simply imports them
//   directly (`effect/testing/TestClock`, `effect/Layer`).
// - BEH-EA-196 (`qadiTestLayer`, `subjectWith`) is `@qadi/testing`'s own
//   package, already published and real — again nothing to wrap. Its
//   illustrative `subjectWith` does not exist under that name in the real,
//   installed `@qadi/testing`/`@qadi/core`; the real equivalent is
//   `@qadi/core`'s own `makeSubject`/`fromRoles`, and `@qadi/testing`'s
//   `Fixtures.ts` ready-made subjects — a test imports those directly.
// - BEH-EA-200 (hook veto/observe isolation) is directly testable via
//   `@awthaq/core`'s `HookPoint.ts` (see `packages/core/test/HookPoint.test.ts`
//   for veto-abort/observe-isolation/divert coverage), and every core hook
//   point is wired into the real sign-up/sign-in flows (NAM-002). Every point's
//   own layer (`Hooks.HooksLive`) rides in `MemoryPorts`, so a test taps a point
//   by passing the tap in `TestAuth.layer`'s second parameter — it requires its
//   point, which `MemoryPorts` provides.
// - BEH-EA-199's "no `Redacted` value reaches a span or event" check is
//   mechanical (EOTS-002): `RedactionGuard` installs a recording tracer and
//   logger (and an `AuthEvents` inspector) into `TestAuth.layer`, and
//   `runPluginContractTests`' opt-in `redaction` option drives a plugin's flows
//   against it with canary secrets.
//
// **`TestAuth.signInAs` targets `HttpRouter.toWebHandler`'s raw
// `(Request) => Promise<Response>` shape, not `HttpApiTest.groups`'s
// in-memory client.** BEH-EA-197's own illustrative code calls
// `client.admin.stats()` with no visible session plumbing after
// `signInAs`, implying some ambient mechanism thread a session into later
// calls automatically — but `HttpApiTest.groups` builds its own internal
// `HttpClient` with no seam for injecting a cookie header into it, and
// exposes no such seam itself. Every wire-level test already built in this
// repository (`password`'s, `oauth`'s, `qadi`'s, `server`'s own
// `AuthHttp.test.ts` files) instead threads a `Set-Cookie`/`cookie` header
// by hand between `HttpRouter.toWebHandler`'s real `Request`/`Response`
// objects — a proven, already-exercised pattern with a real extension seam.
// `signInAs` returns the ready-to-use cookie header string for exactly that
// pattern, rather than reimplementing (or fighting) `HttpApiTest.groups`'s
// internals for an ambient-session mechanism this codebase does not
// otherwise use anywhere.
//
// **`signInAs`'s `roles` is a caller-supplied callback, not a `{roles: [...]}`
// list.** `@awthaq/test` sits in the same stratum as `@awthaq/roles`
// (both are downstream of `core`/`server`/`qadi`/`sql`/`ports`/`api`, per
// `spec/overview.md`'s own package map) — it does not depend on `roles` (or
// any other plugin package), so it has no way to assign a role itself. A
// caller that has installed `Roles` passes `onSignedUp: (userId) =>
// roles.assign(userId, "member")`; `signInAs` runs it, if given, right after
// issuing the user and before minting the session.
import {
  Accounts,
  Auth,
  AuditLog,
  AuthEvents,
  AuthPlugin,
  DataExport,
  Erasure,
  Hooks,
  Migrations,
  RateLimits,
  Sessions,
  Slots,
  Users,
  Verification,
} from "@awthaq/core";
import { ClientAddress, Mailer, PasswordHasher, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { AuthHttp } from "@awthaq/server";
import { CoreMigrations } from "@awthaq/sql";
import * as RedactionGuard from "./RedactionGuard.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * BEH-EA-193: memory repositories, `Mailer.layerMemory`, and
 * `HttpServer.layerServices` — re-used directly (`HttpPlatform`/`Path`/a weak
 * `Etag` generator/a no-op `FileSystem`), not reassembled by hand the way
 * every wire-level test elsewhere in this repository currently does.
 * `RateLimiter.layerPermissive` (BEH-EA-112) is included too — a test that
 * signs in fifty times in a loop shouldn't fail for a reason unrelated to
 * what it's testing; see this module's own header comment for what
 * BEH-EA-193's rate-limiting piece still leaves out. `RateLimits.layer`
 * (the registry half, `@awthaq/core`) rides along in the same merge —
 * it's not a "port," but every plugin composition needs it satisfied the
 * same way, and a second, separately-named layer here would be a
 * distinction with no practical difference for callers of this module.
 */
/**
 * ETVS-004: a real argon2id hasher at the smallest legal cost, so a sign-up/sign-in suite
 * does not pay production KDF time per hash (the algorithm, salt, PHC format and rehash
 * path are the real ones; only m/t are lowered). A ConfigError here is a defect in this
 * fixed table, not a runtime condition.
 */
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

const MemoryStores = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  // ETVS-004/MW-002: what every password-style composition needs beyond the core stores
  // (also `AuthHttp.coreHandlers`' always-served `account` group).
  Verification.layerMemory,
  TestHasher,
  Mailer.layerMemory,
  RateLimiter.layerPermissive,
  RateLimits.layer,
  // MA-005: `Auth.make` provides its own `SlotsRegistry`; this one is for a plugin layer a
  // test composes standalone (outside `Auth.make`), whose `Slots.override` requires one.
  Slots.layer,
  SqlTransaction.layerNoop,
  // AGA-001/NHS-003: `ClientAddress.layerDirect` — the raw-`remoteAddress`
  // passthrough every zero-config app (and every composition here) gets
  // by default; `layerTrustedProxy` is an opt-in an application makes for
  // itself when it actually sits behind a gateway/load balancer.
  ClientAddress.layerDirect,
);

/**
 * CSG-001: the `AccountErasure` service the account handler calls, built over these same
 * stores and over the erasure registry `Hooks.HooksLive` provides (the one every plugin's
 * erasure contribution registers into), so a plugin installed in a `TestAuth` composition is
 * erased like any other.
 */
const MemoryPorts = Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
  Layer.provideMerge(MemoryStores),
  Layer.provideMerge(NodeCrypto.layer),
  // RRS-003: `Sessions.layerMemory` now also needs `AuthEvents`.
  Layer.provideMerge(AuthEvents.layer),
  // BEH-EA-100: `AuthEvents.layer` now needs `AuditLog` too — see its own
  // header comment.
  Layer.provideMerge(AuditLog.layerMemory),
  // AOMS-006/BCR-004/CSG-002/THS-002 (wayfinder ticket 03): every hook
  // point's own default (no-tap) layer — `Users.layerMemory` and every
  // plugin's own `make` now consult one directly. See `Hooks.HooksLive`'s
  // own doc comment.
  Layer.provideMerge(Hooks.HooksLive),
);

const GuardLive = RedactionGuard.layerEvents.pipe(Layer.provideMerge(RedactionGuard.layer));

/**
 * BEH-EA-193: `TestAuth.layer(Auth.make(plugins))` — the whole pipeline over
 * memory.
 *
 * Takes the already-`Auth.make`-built `{api, layer}` pair rather than a raw
 * plugin list. `Auth.make` is itself only callable, from outside its own
 * module, through its precise, `Validate<P>`-checked overload — a generic
 * `TestAuth.layer<P>(plugins: Auth.Validate<P>)` forwarding to it cannot
 * simplify its own abstract `Validate<P>` back down to a concrete tuple to
 * pass along (the same reason `Auth.ts`'s own header comment gives for why
 * `Auth.make`'s *implementation* signature is separate from what it
 * exports), and re-deriving a second, parallel non-empty-tuple check here
 * would duplicate — and could drift from — `Auth.make`'s own. Accepting the
 * *result* of a call the caller already made sidesteps the problem
 * entirely: `Auth.Built<P>` is a plain interface, not a conditional type, so
 * ordinary generic inference over it needs no special-cased forwarding, and
 * the caller gets `Validate<P>`'s real compile-time checking exactly where
 * they'd get it if they called `Auth.make` for production use anyway.
 *
 * **`services` is a real, necessary second parameter, not an
 * afterthought** (ETVS-004: it was named `middleware` until it was clear it carries
 * every support layer a plugin needs, not only `HttpApi` middleware — `Authentication`,
 * `CsrfProtection`, a plugin's own record stores, an `HttpClient`). Do **not** provide a
 * second copy of a service the bundled memory ports already supply (`Verification`,
 * `PasswordHasher`, `Users`, ...): the plugin would use yours and a test's own
 * `yield*` the bundle's, two instances of one store.** The first version of this function had none, and folded
 * `Layer.provideMerge(MemoryPorts)` immediately after `Layer.provide(built.layer)`.
 * That silently made any plugin using `Api.Authentication` (or any other
 * middleware whose *implementation* needs a service `MemoryPorts` itself
 * provides — the ordinary case, since `Authentication.AuthenticationLive`
 * needs `Sessions`) impossible to compose correctly: `Layer.provideMerge`
 * only ever lets its second argument satisfy its first, never the reverse,
 * so no ordering of a separately-built `AuthenticationLive` around the
 * *already-sealed* result of the old `layer(built)` could satisfy both
 * "`built.layer` needs `Api.Authentication`" and "`AuthenticationLive` needs
 * `Sessions`" at once — confirmed empirically with `ManagedRuntime.make`,
 * whose two-parameter signature (`Layer<R, E, never>` — no `RIn` slot to go
 * stale) surfaces a real `Missing 'Authentication'`/`Missing 'Sessions'`
 * error instead of the confusing `unknown` `HttpRouter.toWebHandler`'s own
 * far more permissive constraint let through. The fix is structural, not a
 * type annotation: `services` is folded in via `Layer.provide` *before*
 * `MemoryPorts` is `provideMerge`d — the identical position `CoreLive`
 * occupies in every wire-level `AuthHttp.test.ts` already in this
 * repository — so a middleware implementation's own requirement on a
 * memory-backed port is satisfied the same way theirs already is. Pass
 * `Layer.empty` when nothing needs providing.
 *
 * Declared as an overload for the same reason `Auth.make` itself is:
 * checked against an abstract `P` (inside this function's own body, `P` is
 * not yet the caller's concrete type), the precise formula below cannot be
 * verified — so the implementation is checked against a separate,
 * deliberately widened signature instead, matching the exact convention
 * `AuthPlugin.Any` itself already establishes for a plugin's `layer` field
 * (`Layer.Layer<never, unknown, unknown>` — `never`, not `unknown`, in the
 * `ROut` position specifically, because `Layer`'s `ROut` is contravariant:
 * `never` is what a contravariant slot accepts from any concrete success
 * type, the same reasoning `Auth.ts`'s own comments give for that field).
 */
export function layer<
  P extends ReadonlyArray<AuthPlugin.Any>,
  Extra extends HttpApiGroup.Constraint,
  MR,
  ME,
  MRIn,
>(
  built: Auth.Built<P, Extra>,
  services: Layer.Layer<MR, ME, MRIn>,
): Layer.Layer<
  | Layer.Success<typeof MemoryPorts>
  | Layer.Success<typeof GuardLive>
  | Layer.Success<Auth.Built<P>["layer"]>
  | Layer.Success<typeof HttpServer.layerServices>
  | Layer.Success<typeof HttpRouter.layer>
  | MR,
  ME,
  Exclude<
    | Layer.Services<Auth.Built<P, Extra>["layer"]>
    | Layer.Services<typeof AuthHttp.coreHandlers>
    | MRIn,
    Layer.Success<typeof MemoryPorts> | MR
  >
>;
export function layer(
  built: Auth.Built<ReadonlyArray<AuthPlugin.Any>, HttpApiGroup.Constraint>,
  services: Layer.Layer<unknown, unknown, unknown>,
): Layer.Layer<never, unknown, unknown> {
  // MW-002: `built.api` always carries core's session/account groups, so their
  // handlers are part of every test pipeline (the same layer `AuthHttp.coreHandlers` gives a host).
  // The plugins' own services stay in the output (`provideMerge`), so a test can
  // `yield* Password.Password` from the same composition it serves over HTTP.
  return AuthHttp.routes(built.api, {}).pipe(
    Layer.provide(AuthHttp.coreHandlers),
    Layer.provideMerge(built.layer),
    Layer.provide(services),
    // EOTS-002: the recording tracer/logger (and the `AuthEvents` inspector) are part
    // of every `TestAuth` composition; they only record, `assertNoLeaks` is what fails.
    Layer.provideMerge(GuardLive),
    Layer.provideMerge(MemoryPorts),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provideMerge(HttpRouter.layer),
  );
}

export interface SignedInSession {
  readonly userId: Users.UserId;
  readonly token: Redacted.Redacted<string>;
  /** Ready to drop straight into `new Request(url, { headers: { cookie } })`. */
  readonly cookieHeader: string;
}

/**
 * BEH-EA-197: mints a real user and a real session directly against
 * `Users`/`Sessions` — no password, no HTTP round trip — so an
 * authorization test's setup cost is independent of whichever credential
 * plugin (if any) is installed, matching this behavior's own point: testing
 * *authorization*, not sign-up.
 */
export const signInAs = (input: {
  readonly email: string;
  readonly name?: string;
  readonly onSignedUp?: (userId: Users.UserId) => Effect.Effect<void>;
}): Effect.Effect<SignedInSession, never, Users.Users | Sessions.Sessions> =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users
      .create({ identity: { _tag: "Email", email: input.email }, name: input.name ?? input.email })
      .pipe(Effect.orDie);
    if (input.onSignedUp !== undefined) {
      yield* input.onSignedUp(user.id);
    }
    const { token } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
    return {
      userId: user.id,
      token,
      cookieHeader: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}`,
    };
  });

// ---------------------------------------------------------------------------
// BEH-EA-198/199 (second half): runPluginContractTests
// ---------------------------------------------------------------------------

export interface ContractTestOptions<O, R = never> {
  readonly options: ReadonlyArray<O>;
  /** Other plugins to compose alongside the plugin under test — its own declared `dependsOn`, at minimum. */
  readonly host?: ReadonlyArray<AuthPlugin.Any>;
  /**
   * EOTS-002/BEH-EA-199: opt in to the mechanical redaction check. `app` is the
   * composition to drive (normally `TestAuth.layer(Auth.make([...]), services)`, which
   * installs the `RedactionGuard`), `exercise` runs the plugin's flows against it — call
   * `guard.watch("password", canary)` first for every secret it will feed in. The check
   * fails if any `Redacted` value or watched canary reaches a span, a log line or a
   * published event (a leak names the channel and the canary's label, never the secret).
   * Without it the check is not registered: the harness cannot build a plugin whose
   * layer needs services it was not given.
   */
  readonly redaction?: {
    readonly app: Layer.Layer<RedactionGuard.RedactionGuard | R, unknown>;
    readonly exercise: (
      guard: RedactionGuard.RedactionGuardShape,
    ) => Effect.Effect<void, unknown, R | RedactionGuard.RedactionGuard>;
  };
}

/** `describe`/`it`/`assert` — kept as an injected shape rather than importing `@effect/vitest` directly, so this harness has no hard dependency on which test runner a third-party plugin author uses. `it`'s body may be async (the migration and redaction checks run real effects). */
export interface TestFramework {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => void | Promise<void>) => void;
  readonly fail: (message: string) => never;
}

/**
 * SSMS-004: one fresh in-memory SQLite database, core migrations first, then `migrations`
 * on the plugin ledger — applied a second time to prove the migrator skips what it has
 * already applied — resolving to the resulting schema (every table/index and its SQL, minus
 * the two ledgers) so two independent applications can be compared.
 */
const applyMigrations = (migrations: Auth.Built<ReadonlyArray<AuthPlugin.Any>>["migrations"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Migrator.make({})({
      loader: CoreMigrations.coreMigrations,
      table: "effect_sql_migrations",
    });
    yield* Migrations.run(migrations);
    const reapplied = yield* Migrations.run(migrations);
    const schema = yield* sql<{
      readonly type: string;
      readonly name: string;
      readonly sql: string;
    }>`
      SELECT type, name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('effect_sql_migrations', ${Migrations.pluginMigrationsTable})
      ORDER BY name`;
    return { schema, reapplied: reapplied.length };
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped);

const TABLE_PREFIX_PATTERN = (id: string): RegExp => new RegExp(`^${id}_`);

/**
 * BEH-EA-198/199: the mechanically-verifiable subset of the plugin contract
 * suite — see this module's own header comment for BEH-EA-199's other half
 * (redaction), which is not.
 *
 * A third-party plugin author runs this against their own `makePlugin`
 * factory with no dependency on `@awthaq/*`'s own test files — only on
 * this package and their own `AuthPlugin.Any`-shaped plugin classes.
 */
export const runPluginContractTests = <O, R = never>(
  framework: TestFramework,
  makePlugin: (options: O) => AuthPlugin.Any,
  config: ContractTestOptions<O, R>,
): void => {
  const host = config.host ?? [];
  const hostIds = new Set(host.map((plugin) => plugin.id));

  framework.describe("runPluginContractTests", () => {
    let previousContract: AuthPlugin.Any["contract"] | undefined;

    for (const options of config.options) {
      const plugin = makePlugin(options);
      const label = JSON.stringify(options);

      framework.it(`${label}: id does not collide with a host plugin`, () => {
        if (hostIds.has(plugin.id)) {
          framework.fail(`E_PLUGIN_DUPLICATE_ID: "${plugin.id}" also names a host plugin`);
        }
      });

      framework.it(`${label}: every declared table carries this plugin's own id prefix`, () => {
        const prefix = TABLE_PREFIX_PATTERN(plugin.id);
        for (const table of plugin.tables) {
          if (!prefix.test(table)) {
            framework.fail(`table "${table}" does not carry plugin "${plugin.id}"'s own prefix`);
          }
        }
      });

      framework.it(`${label}: every dependsOn entry is present among the host plugins`, () => {
        const missing = plugin.dependsOn.filter((dep) => !hostIds.has(dep.id));
        if (missing.length > 0) {
          framework.fail(
            `E_PLUGIN_MISSING_DEP: plugin "${plugin.id}" depends on ` +
              `${missing.map((dep) => `"${dep.id}"`).join(", ")}, not present in host`,
          );
        }
      });

      framework.it(`${label}: migration declarations are deterministic across builds`, () => {
        const [first, ...rest] = [...host, plugin];
        if (first === undefined) {
          framework.fail("runPluginContractTests: host plus plugin under test was empty");
          return;
        }
        // Only what a build declares (names and their order) — the `up` effects are not
        // comparable as data; the check below applies them.
        const names = (built: ReturnType<typeof Auth.make>) =>
          JSON.stringify(built.migrations.map((migration) => migration.name));
        if (names(Auth.make([first, ...rest])) !== names(Auth.make([first, ...rest]))) {
          framework.fail(
            `plugin "${plugin.id}"'s migration declarations are not deterministic across two identical builds`,
          );
        }
      });

      // SSMS-004/REQ-EA-563: an actual double application, not a JSON comparison.
      framework.it(`${label}: migrations apply identically on two fresh databases`, async () => {
        const [first, ...rest] = [...host, plugin];
        if (first === undefined) {
          framework.fail("runPluginContractTests: host plus plugin under test was empty");
          return;
        }
        const outcome = await Effect.runPromise(
          Effect.exit(
            Effect.all([
              applyMigrations(Auth.make([first, ...rest]).migrations),
              applyMigrations(Auth.make([first, ...rest]).migrations),
            ]),
          ),
        );
        if (Exit.isFailure(outcome)) {
          framework.fail(
            `plugin "${plugin.id}"'s migrations failed to apply: ${Cause.pretty(outcome.cause)}`,
          );
          return;
        }
        const [a, b] = outcome.value;
        if (JSON.stringify(a.schema) !== JSON.stringify(b.schema)) {
          framework.fail(
            `plugin "${plugin.id}"'s migrations produced different schemas on two fresh databases — an \`up\` is not deterministic`,
          );
        }
        if (a.reapplied !== 0) {
          framework.fail(
            `plugin "${plugin.id}"'s migrations were applied again on an already-migrated database (${a.reapplied} re-run)`,
          );
        }
      });

      const redaction = config.redaction;
      if (redaction !== undefined) {
        // EOTS-002/BEH-EA-199: the mechanical half — nothing secret reaches a span, log or event.
        framework.it(
          `${label}: no Redacted value or watched secret reaches a span, log line or event`,
          async () => {
            const outcome = await Effect.runPromise(
              Effect.exit(
                Effect.scoped(
                  Effect.gen(function* () {
                    const context = yield* Layer.build(redaction.app);
                    const guard = Context.get(context, RedactionGuard.RedactionGuard);
                    yield* redaction.exercise(guard).pipe(Effect.provide(context));
                    // Let subscriber fibers drain what the flows just published.
                    yield* Effect.sleep("10 millis");
                    yield* guard.assertNoLeaks;
                  }),
                ),
              ),
            );
            if (Exit.isFailure(outcome)) {
              const failure = Cause.squash(outcome.cause);
              framework.fail(
                failure instanceof RedactionGuard.RedactionLeak
                  ? failure.message
                  : `the redaction check could not run: ${Cause.pretty(outcome.cause)}`,
              );
            }
          },
        );
      }

      framework.it(`${label}: this option value does not change the plugin's own contract`, () => {
        if (previousContract !== undefined && previousContract !== plugin.contract) {
          framework.fail(
            `plugin "${plugin.id}"'s contract changed with a different option value — ` +
              "a plugin's contract must be a fixed value its options never influence (ADR-EA-011)",
          );
        }
        previousContract = plugin.contract;
      });
    }
  });
};
