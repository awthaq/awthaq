// AH-003 tier 3: 12-hooks.feature's World. Taps and their effects are exercised through the
// real flows that run them — `Password.signUp`/`signIn` (BeforeSignUp, AfterSignUp,
// BeforeSessionIssue) and `Users.delete` (BeforeUserDelete) — over `TestAuth`'s bundle, with a
// tap layer handed to the composition the way a host application's `Point.tap(...)` is. The
// plugin-declared side of BEH-EA-091/096 (dependency order, the static manifest) uses real
// `AuthPlugin`s with `taps` declared on `AuthPlugin.layer`, composed by the real `Auth.make`.
import { Auth, AuthPlugin, HookPoint, Hooks, Users } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { CsrfConfigForTests } from "./CsrfTestSupport.ts";
import { type Contribution, type Host, makeHost } from "./CrossCuttingApp.ts";
import { STRONG_PASSWORD } from "./shared/Harness.ts";

// ---- plugin fixtures: real plugins whose taps are declared statically ----

/**
 * How many times any fixture plugin's tap has run. The taps are declared on plugin *classes*
 * (module scope), so this is the one piece of module-level state here; a Given that cares
 * resets it.
 */
export const fixtureTapRuns = { count: 0 };

const countingVeto = (input: {
  readonly email?: string | undefined;
  readonly name: string;
  readonly strategy: string;
}) =>
  Effect.sync(() => {
    fixtureTapRuns.count++;
    return input;
  });

const countingObserve = () =>
  Effect.sync(() => {
    fixtureTapRuns.count++;
  });

const AuditApi = HttpApi.make("auth").add(
  HttpApiGroup.make("acme.audit").add(
    HttpApiEndpoint.get("ping", "/acme-audit/ping", { success: Schema.String }),
  ),
);
export class AcmeAudit extends AuthPlugin.Service<AcmeAudit, Record<string, never>>()(
  "acme.audit",
  {
    apiVersion: 1,
    contract: AuditApi,
  },
) {
  static readonly layer = AuthPlugin.layer(AcmeAudit, {
    make: Effect.succeed({}),
    taps: [
      Hooks.BeforeSignUp.declareTap(countingVeto),
      Hooks.AfterSignUp.declareTap(countingObserve),
    ],
    handlers: HttpApiBuilder.group(AuditApi, "acme.audit", (handlers) =>
      handlers.handle("ping", () => Effect.succeed("ok")),
    ),
  });
}

const NormalizeApi = HttpApi.make("auth").add(
  HttpApiGroup.make("acme.normalize").add(
    HttpApiEndpoint.get("ping", "/acme-normalize/ping", { success: Schema.String }),
  ),
);
/** `order: -100` is what the feature's "pre" stands for: it runs ahead of every default-order tap it has no dependency relationship with. */
export const PRE = -100;
export class AcmeNormalize extends AuthPlugin.Service<AcmeNormalize, Record<string, never>>()(
  "acme.normalize",
  { apiVersion: 1, contract: NormalizeApi },
) {
  static readonly layer = AuthPlugin.layer(AcmeNormalize, {
    make: Effect.succeed({}),
    taps: [Hooks.BeforeSignUp.declareTap(countingVeto, { order: PRE })],
    handlers: HttpApiBuilder.group(NormalizeApi, "acme.normalize", (handlers) =>
      handlers.handle("ping", () => Effect.succeed("ok")),
    ),
  });
}

const GateApi = HttpApi.make("auth").add(
  HttpApiGroup.make("acme.gate").add(
    HttpApiEndpoint.get("ping", "/acme-gate/ping", { success: Schema.String }),
  ),
);
export class AcmeGate extends AuthPlugin.Service<AcmeGate, Record<string, never>>()("acme.gate", {
  apiVersion: 1,
  contract: GateApi,
}) {
  static readonly layer = AuthPlugin.layer(AcmeGate, {
    dependsOn: [AcmeNormalize],
    make: Effect.succeed({}),
    taps: [Hooks.BeforeSignUp.declareTap(countingVeto)],
    handlers: HttpApiBuilder.group(GateApi, "acme.gate", (handlers) =>
      handlers.handle("ping", () => Effect.succeed("ok")),
    ),
  });
}

const InviteApi = HttpApi.make("auth").add(
  HttpApiGroup.make("acme.invite").add(
    HttpApiEndpoint.get("ping", "/acme-invite/ping", { success: Schema.String }),
  ),
);
/** BEH-EA-095's own example: a plugin that reacts to a user's deletion by tapping the point core exposes, over its own prefixed table. */
export class AcmeInvite extends AuthPlugin.Service<AcmeInvite, Record<string, never>>()(
  "acme.invite",
  {
    apiVersion: 1,
    contract: InviteApi,
    tables: ["acme.invite_invitation"],
  },
) {
  static readonly layer = AuthPlugin.layer(AcmeInvite, {
    make: Effect.succeed({}),
    taps: [Hooks.BeforeUserDelete.declareTap((input) => Effect.succeed(input))],
    handlers: HttpApiBuilder.group(InviteApi, "acme.invite", (handlers) =>
      handlers.handle("ping", () => Effect.succeed("ok")),
    ),
  });
}

/** The BEH-EA-095 anti-example: the same plugin claiming core's `users` table for itself. */
export const InviteClaimingUsersTable: AuthPlugin.Any = {
  id: "acme.invite",
  apiVersion: 1,
  contract: { identifier: "auth", groups: {} },
  tables: ["users"],
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
};

// ---- composing the fixture plugins without running anything ----

const FixtureAuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);
const FixtureCsrfLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

/** `Auth.make` requires a dependency to be listed before its dependent; `acme.audit` comes last in the tuple yet runs before `acme.gate`, so tuple position is not what orders the chain. */
export const fixturePlugins = Auth.make([AcmeNormalize, AcmeGate, AcmeAudit]);

/** The resolved tap chain of `BeforeSignUp`, read from a composition of the fixture plugins built for real (`TestAuth.layer`). */
export const resolvedBeforeSignUp = Effect.gen(function* () {
  const context = yield* Layer.build(
    TestAuth.layer(fixturePlugins, Layer.mergeAll(FixtureAuthenticationLive, FixtureCsrfLive)),
  );
  return yield* Effect.flatMap(Hooks.BeforeSignUp, (point) => point.resolved).pipe(
    Effect.provide(context),
  );
}).pipe(Effect.scoped);

/** A hook manifest entry in a shape that does not drag the plugin classes' types along. */
export interface ManifestEntry {
  readonly plugin: string;
  readonly order: number;
}

/** The static hook manifest of the fixture composition: `Auth.make` alone, no layer built, no tap run. */
export const fixtureManifest = (): Readonly<Record<string, ReadonlyArray<ManifestEntry>>> =>
  fixturePlugins.manifest.hooks;

/**
 * BEH-EA-095/256: the contract suite a plugin author runs, with the framework replaced by one
 * that collects instead of throwing, so a scenario can assert on what it found.
 */
export const runContract = (makePlugin: () => AuthPlugin.Any) =>
  Effect.promise(async () => {
    const tests: Array<{ readonly name: string; readonly body: () => void | Promise<void> }> = [];
    const framework: TestAuth.TestFramework = {
      describe: (_name, body) => body(),
      it: (name, body) => {
        tests.push({ name, body });
      },
      fail: (message) => {
        throw new Error(message);
      },
    };
    TestAuth.runPluginContractTests(framework, makePlugin, { options: [{}] });
    const failures: Array<string> = [];
    for (const test of tests) {
      try {
        await test.body();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { total: tests.length, failures };
  });

// ---- the World ----

export type SignUpOutcome =
  | { readonly _tag: "Success"; readonly userId: string }
  | {
      readonly _tag: "Failure";
      /** The failure's own `_tag` (`HookAborted`, `TwoFactorRequired`, ...). */
      readonly error: string;
      readonly code: string | undefined;
      readonly message: string | undefined;
      readonly point: string | undefined;
    };

export interface WorldShape {
  readonly host: Host;
  readonly outcome: Ref.Ref<SignUpOutcome | undefined>;
  /** What each named tap was handed, in order (a tap records the email it received). */
  readonly seen: Ref.Ref<Readonly<Record<string, ReadonlyArray<string>>>>;
  /** Users a scenario's stand-in second-factor tap treats as having two-factor enabled. */
  readonly twoFactorEnabled: Ref.Ref<ReadonlyArray<string>>;
  /** The Invite plugin's own rows — `acme.invite_invitation`: (row id, user id). */
  readonly invitations: Ref.Ref<ReadonlyArray<{ readonly id: string; readonly userId: string }>>;
  readonly userIds: Ref.Ref<Readonly<Record<string, string>>>;
  /** The hook manifest a scenario read off the composition, when it did. */
  readonly manifest: Ref.Ref<Readonly<Record<string, ReadonlyArray<ManifestEntry>>> | undefined>;
}

export class World extends Context.Service<World, WorldShape>()("features/HooksWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      host: yield* makeHost,
      outcome: yield* Ref.make<SignUpOutcome | undefined>(undefined),
      seen: yield* Ref.make<Readonly<Record<string, ReadonlyArray<string>>>>({}),
      twoFactorEnabled: yield* Ref.make<ReadonlyArray<string>>([]),
      invitations: yield* Ref.make<ReadonlyArray<{ readonly id: string; readonly userId: string }>>(
        [],
      ),
      userIds: yield* Ref.make<Readonly<Record<string, string>>>({}),
      manifest: yield* Ref.make<Readonly<Record<string, ReadonlyArray<ManifestEntry>>> | undefined>(
        undefined,
      ),
    });
  }),
);

/** Adds a tap layer to the composition; must be called before the first action (the point freezes at its first run, BEH-EA-024). */
export const addTap = Effect.fn("features.hooks.addTap")(function* (tap: Contribution) {
  const { host } = yield* World;
  yield* host.configure((spec) => ({ ...spec, contributions: [...spec.contributions, tap] }));
});

/** A recorder a tap closes over: a tap's handler has no requirements, so it cannot `yield* World` itself. */
export const noteTo = (seen: WorldShape["seen"]) => (who: string, what: string) =>
  Ref.update(seen, (existing) => ({ ...existing, [who]: [...(existing[who] ?? []), what] }));

export const seenBy = Effect.fn("features.hooks.seenBy")(function* (who: string) {
  const { seen } = yield* World;
  return (yield* Ref.get(seen))[who] ?? [];
});

const describeFailure = (error: { readonly _tag: string }): SignUpOutcome => {
  if (error instanceof HookPoint.HookAborted) {
    return {
      _tag: "Failure",
      error: error._tag,
      code: error.code,
      message: error.message,
      point: error.point,
    };
  }
  return {
    _tag: "Failure",
    error: error._tag,
    code: undefined,
    message: undefined,
    point: undefined,
  };
};

const emailOf = (name: string) => (name.includes("@") ? name : `${name}@example.com`);

/** A real password sign-up, its outcome recorded for the Thens. */
export const attemptSignUp = Effect.fn("features.hooks.attemptSignUp")(function* (email: string) {
  const { host, outcome, userIds } = yield* World;
  const result = yield* host.run(
    Effect.flatMap(Password.Password, (password) =>
      password.signUp({ email: emailOf(email), password: Redacted.make(STRONG_PASSWORD) }),
    ).pipe(
      Effect.match({
        onFailure: describeFailure,
        onSuccess: (issued): SignUpOutcome => ({ _tag: "Success", userId: issued.session.userId }),
      }),
    ),
  );
  yield* Ref.set(outcome, result);
  if (result._tag === "Success") {
    yield* Ref.update(userIds, (existing) => ({ ...existing, [email]: result.userId }));
  }
  return result;
});

/** A real password sign-in for an account signed up earlier. */
export const attemptSignIn = Effect.fn("features.hooks.attemptSignIn")(function* (email: string) {
  const { host, outcome } = yield* World;
  const result = yield* host.run(
    Effect.flatMap(Password.Password, (password) =>
      password.signIn({ email: emailOf(email), password: Redacted.make(STRONG_PASSWORD) }),
    ).pipe(
      Effect.match({
        onFailure: describeFailure,
        onSuccess: (issued): SignUpOutcome => ({ _tag: "Success", userId: issued.session.userId }),
      }),
    ),
  );
  yield* Ref.set(outcome, result);
  return result;
});

export const lastOutcome = Effect.fn("features.hooks.lastOutcome")(function* () {
  const { outcome } = yield* World;
  const found = yield* Ref.get(outcome);
  if (found === undefined) return yield* Effect.die(new Error("no action has been attempted yet"));
  return found;
});

/** Whether a user with this email exists — the sign-up operation "stopped" means there is none. */
export const userExists = Effect.fn("features.hooks.userExists")(function* (email: string) {
  const { host } = yield* World;
  const found = yield* host.run(
    Effect.flatMap(Users.Users, (users) => users.findByEmail(emailOf(email))).pipe(Effect.orDie),
  );
  return found._tag === "Some";
});
