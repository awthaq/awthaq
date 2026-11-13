// Shipping-gap map (.scratch/shipping-gaps), ticket 20: the Password
// plugin's real wire-level seam, reused from
// `packages/password/test/AuthHttp.test.ts` (the same `HttpRouter.toWebHandler`
// + the app's own `TestMailbox`) rather than a new one invented for this suite. Requests go
// through the plugin's real HTTP surface. P20a (AH-004/TIR-005/PHS-005): a
// few *read handles* reach the same running services the handler uses, so a
// Given can assert absence ("no user exists"), a Then can observe stored
// state (credential hash, session liveness) the wire never exposes, and the
// reset scenario can run over a real SQLite transaction with an injectable
// fault.
import { Accounts, Auth, AuthEvents, Sessions, Users, Verification } from "@awthaq/core";
import { Mailer, PasswordHasher } from "@awthaq/ports";
import { mailedToken } from "./MailedToken.ts";
import { awaitStable, makeNamedRegistry } from "./shared/Harness.ts";
import { Admin, AdminAccounts } from "@awthaq/admin";
import { Password } from "@awthaq/password";
import { TestAuth, TestMailbox } from "@awthaq/test";
import { Api } from "@awthaq/api";
import { parseCookieHeader } from "@awthaq/web/cookies";
import { agentOver } from "./shared/Csrf.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/** Which fault, if any, the fault-injecting `Sessions` wrapper raises when the flow reaches it (TIR-005). */
export type Fault = "none" | "sessionIssue" | "revokeAll";

/**
 * TIR-005: wraps a real `Sessions` so a step can make one operation die on demand — `issue`
 * (reached inside sign-up's transaction after the user and credential are written) or
 * `revokeAll` (reached inside `confirmReset`'s transaction after the token is consumed and the
 * hash updated). A defect, not a typed failure: the rollback under test must not depend on the
 * failure being one the handler recovers from.
 */
const faultInjectingSessions = (fault: Ref.Ref<Fault>) =>
  Layer.effect(
    Sessions.Sessions,
    Effect.gen(function* () {
      const real = yield* Sessions.Sessions;
      const armed = (at: Fault) => Ref.get(fault).pipe(Effect.map((current) => current === at));
      return Sessions.Sessions.of({
        ...real,
        issue: (input) =>
          armed("sessionIssue").pipe(
            Effect.flatMap((hit) =>
              hit
                ? Effect.die(new Error("injected failure while issuing the initial session"))
                : real.issue(input),
            ),
          ),
        revokeAll: (userId, reason) =>
          armed("revokeAll").pipe(
            Effect.flatMap((hit) =>
              hit
                ? Effect.die(new Error("injected failure after the credential hash update"))
                : real.revokeAll(userId, reason),
            ),
          ),
      });
    }),
  );

/** BEH-EA-119: a corpus nothing ever matches, the same default `AuthHttp.test.ts` uses — a Scenario opting into a real breach lookup overrides this via `configureBreach`. */
const NoBreachHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

/** A `Mailer` whose `send` never returns (nothing is recorded): the slowest provider there can be. */
const neverAnsweringMailer = Layer.mock(Mailer.Mailer)({ send: () => Effect.never });

export interface AppOptions {
  readonly hasher?: Layer.Layer<
    PasswordHasher.PasswordHasher,
    Config.ConfigError,
    SecureRandom.SecureRandom
  >;
  readonly breachHttpClient?: Layer.Layer<HttpClient.HttpClient>;
  /** AH-007: the `Password.config` overrides in force, merged (not replaced) by successive `configureApp` calls. */
  readonly passwordConfig?: Partial<Password.PasswordConfigShape>;
  /** TIR-005: `"sqlite"` runs the core stores over a real migrated SQLite database with real transactions; the default is memory. */
  readonly storage?: "memory" | "sqlite";
  /** REQ-EA-306: a mail provider that never answers a `send`: any latency the caller sees is not the provider's. */
  readonly slowMailer?: boolean;
  /** APS-003: enforce the plugin's production rate limits (the default is permissive, so an ordinary scenario never trips one). */
  readonly realLimits?: boolean;
  /** BEH-EA-120/345: compose `AdminAccounts` beside Password, every administrator allowed to manage credentials (memory only). */
  readonly adminAccounts?: boolean;
}

/** What a step reads through `inApp`: the running services the handler uses. */
type ReadHandles =
  | Users.Users
  | Accounts.Accounts
  | Sessions.Sessions
  | Verification.Verification
  | PasswordHasher.PasswordHasher;

export interface AppHandle {
  readonly handler: (request: Request) => Promise<Response>;
  /** The mailbox the app's `TestAuth` base records into (nothing under `slowMailer`: its `Mailer` never answers). */
  readonly mailbox: TestMailbox.MailboxShape;
  readonly publishedEvents: Effect.Effect<ReadonlyArray<AuthEvents.PublishedAny>>;
  readonly fault: Ref.Ref<Fault>;
  /** Runs `effect` against the same running services `handler` uses (real clock, like `AdminWorld`'s reads). */
  readonly inApp: <A, E>(effect: Effect.Effect<A, E, ReadHandles>) => Promise<A>;
}

const built = Auth.make([Password.Password]);

/** BEH-EA-120/345: Password beside the administrator's credential surface, built only for the scenario that asks for it. */
const builtWithAdminAccounts = Auth.make([
  Password.Password,
  Admin.Admin,
  AdminAccounts.AdminAccounts,
]);

/** Held open: the handler's own (lazy) build then finds these layers in the shared memo map. */
const openApp = <A, E>(app: TestAuth.App<A | ReadHandles | TestMailbox.Mailbox, E>) =>
  Effect.promise(async () => {
    await app.run(Effect.void);
    return app.context();
  }).pipe(
    Effect.map((ctx) => ({
      handler: app.handler,
      mailbox: Context.get(ctx, TestMailbox.Mailbox),
      inApp: <X, XE>(effect: Effect.Effect<X, XE, ReadHandles>) => app.run(effect),
    })),
  );

/**
 * Mail is read through the app's own `TestMailbox`. Events are captured in a cell built *outside* the layer graph,
 * subscribing to `AuthEvents`'s real `PubSub` the same way `AuthEvents.test.ts`'s own `seen` `Ref` does.
 */
const buildApp = Effect.fn("features.password.buildApp")(function* (options: AppOptions) {
  // The never-answering mailer: releasing waits for the mail drain timeout with requests still in flight, so that
  // app is released off the scenario's fiber instead of by it (it would time the scenario out).
  const served = Scope.makeUnsafe();
  const serve = <A, E>(layer: Layer.Layer<A | TestAuth.AppNeeds, E>) =>
    options.slowMailer === true
      ? TestAuth.serve(layer).pipe(Scope.provide(served))
      : TestAuth.serve(layer);
  if (options.slowMailer === true) {
    yield* Effect.addFinalizer(() => Effect.forkDetach(Scope.close(served, Exit.void)));
  }

  const events = yield* Ref.make<ReadonlyArray<AuthEvents.PublishedAny>>([]);
  const fault = yield* Ref.make<Fault>("none");
  const eventsLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const authEvents = yield* AuthEvents.AuthEvents;
      // `startImmediately`: the stream is a live broadcast, so a publish that beats the
      // subscription is gone for good (AdminWorld's own reproduced race).
      yield* authEvents.stream.pipe(
        // Every event, core's and the password plugin's (ADR-EA-049): this world reads them back by tag.
        Stream.runForEach((event) => Ref.update(events, (existing) => [...existing, event])),
        Effect.forkScoped({ startImmediately: true }),
      );
    }),
  );

  const common = {
    // The plugin's own configuration, the breach transport, the mailer and the event subscriber are this world's
    // `services`; the fault-injecting `Sessions` (and a scenario's own hasher) wrap the base for the plugin and the
    // read handles alike (`decorate`). `Layer.fresh`: the base already built a hasher on the shared memo map.
    services: Layer.mergeAll(
      Password.config(options.passwordConfig ?? {}),
      options.breachHttpClient ?? NoBreachHttpClient,
      ...(options.slowMailer === true ? [neverAnsweringMailer] : []),
      eventsLayer,
    ),
    decorate: Layer.mergeAll(
      faultInjectingSessions(fault),
      options.hasher === undefined ? Layer.empty : Layer.orDie(Layer.fresh(options.hasher)),
    ),
    rateLimiter: options.realLimits === true ? ("enforcing" as const) : ("permissive" as const),
    openapiPath: "/openapi.json" as const,
    docsPath: "/docs" as const,
  };
  // TIR-005: `"sqlite"` runs the core stores over a real migrated SQLite database with real transactions, so
  // atomicity is observable; the default is memory.
  // Built eagerly and held open: the handler's own (lazy) build then finds these layers in the shared memo map, so
  // a read handle used before the first request neither builds a second copy nor tears the first down. Run on the
  // real clock, like the handler's own runtime (a step's fiber may sit under a `TestClock`).
  const { handler, inApp, mailbox } =
    options.adminAccounts === true
      ? yield* openApp(
          yield* serve(
            TestAuth.layer(builtWithAdminAccounts, {
              ...common,
              services: Layer.merge(
                common.services,
                Admin.config({ canManageCredentials: () => Effect.succeed(true) }),
              ),
            }),
          ),
        )
      : options.storage === "sqlite"
        ? yield* openApp(
            yield* serve(
              TestAuth.layer(built, { ...common, records: "sql", suite: "features_PasswordWorld" }),
            ),
          )
        : yield* openApp(yield* serve(TestAuth.layer(built, common)));
  return { handler, mailbox, publishedEvents: Ref.get(events), fault, inApp };
});

export interface ActorState {
  readonly email: string;
  readonly password: string;
  readonly cookie: string | undefined;
}

/** AH-007/CSD-009: the breach-provider failure modes a Given can name. */
export type BreachFailure = "timeout" | "5xx" | "malformed";

export interface WorldShape {
  /** `configureApp` merges onto the cell's options rather than replacing them wholesale, so two Given steps (e.g. "breachCheck: onUnavailable reject" then, separately, "the provider is unreachable") compose instead of the second silently discarding the first's choice. */
  readonly app: TestAuth.LazyApp<AppOptions, AppHandle>;
  /** BDD-008/AH-008: actors and sessions are registered under the exact name the Gherkin uses; `actors.current` is what an implicit-subject step resolves to. */
  readonly actors: ReturnType<typeof makeNamedRegistry<ActorState>>;
  /** Session name ("s1", "s-attacker") to the bare `name=value` cookie that session was issued under. */
  readonly sessions: ReturnType<typeof makeNamedRegistry<string>>;
  readonly responses: Ref.Ref<Record<string, Response>>;
  /** Free-form scenario memory (tokens, hashes, previous passwords), keyed by a step-local name. */
  readonly notes: Ref.Ref<Record<string, string>>;
  readonly breachFailures: Ref.Ref<ReadonlyArray<BreachFailure>>;
  /** AH-009: the published event tags at a point in time, to diff against later. */
  readonly eventTags: Ref.Ref<ReadonlyArray<string>>;
}

export class World extends Context.Service<World, WorldShape>()("features/PasswordWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const app = yield* TestAuth.lazyApp<AppOptions, AppHandle>({}, buildApp, {
      name: "PasswordWorld",
    });
    return World.of({
      app,
      actors: makeNamedRegistry<ActorState>("actor"),
      sessions: makeNamedRegistry<string>("session"),
      responses: yield* Ref.make<Record<string, Response>>({}),
      notes: yield* Ref.make<Record<string, string>>({}),
      breachFailures: yield* Ref.make<ReadonlyArray<BreachFailure>>([]),
      eventTags: yield* Ref.make<ReadonlyArray<string>>([]),
    });
  }),
);

const mergeOptions = (previous: AppOptions, options: AppOptions): AppOptions => ({
  ...previous,
  ...options,
  passwordConfig: { ...previous.passwordConfig, ...options.passwordConfig },
});

/** Merges `options` onto what was configured so far — before the first request, since state does not carry over a build. */
export const configureApp = Effect.fn("features.password.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  yield* world.app.configure((previous) => mergeOptions(previous, options));
});

/** R3: the explicit rebuild, for a scenario that reconfigures after it has used the app (the old app is released). */
export const reconfigureApp = Effect.fn("features.password.reconfigureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  yield* world.app.replace(mergeOptions(yield* world.app.options, options));
});

const appHandle = Effect.fn("features.password.appHandle")(function* () {
  return yield* (yield* World).app.get;
});

/** The `name=value` pair of the session cookie `agent` holds, as a browser sends it back; `undefined` when none. */
const sessionPairOf = (agent: ReturnType<typeof agentOver>) => {
  const held = agent.cookies.get(Api.SESSION_COOKIE_NAME);
  return held === undefined ? undefined : `${held.name}=${held.value}`;
};

/**
 * A JSON POST from a user agent already holding the double-submit CSRF cookie (`agentOver`), carrying `cookie`
 * (a session pair) beside it. `sessionPair` is the session cookie the agent holds afterwards (what a sign-up set).
 */
export const requestWithAgent = Effect.fn("features.password.requestWithAgent")(function* (
  path: string,
  body: unknown,
  cookie?: string,
) {
  const { handler } = yield* appHandle();
  const agent = agentOver(handler);
  const response = yield* Effect.promise(() =>
    agent.request("POST", path, {
      json: body,
      extraCookies: Object.fromEntries(
        parseCookieHeader(cookie).map((pair) => [pair.name, pair.value]),
      ),
    }),
  );
  return { response, sessionPair: sessionPairOf(agent) };
});

export const request = Effect.fn("features.password.request")(function* (
  path: string,
  body: unknown,
  cookie?: string,
) {
  return (yield* requestWithAgent(path, body, cookie)).response;
});

export const setLastResponse = Effect.fn("features.password.setLastResponse")(function* (
  key: string,
  response: Response,
) {
  const { responses } = yield* World;
  yield* Ref.update(responses, (existing) => ({ ...existing, [key]: response }));
});

export const getLastResponse = Effect.fn("features.password.getLastResponse")(function* (
  key: string,
) {
  const { responses } = yield* World;
  const found = (yield* Ref.get(responses))[key];
  if (found === undefined) return yield* Effect.die(new Error(`no response recorded for "${key}"`));
  return found;
});

/** Registers `name` and makes it the current actor (the subject of a later pronoun step). */
export const setActor = Effect.fn("features.password.setActor")(function* (
  name: string,
  state: ActorState,
) {
  const { actors } = yield* World;
  yield* actors.set(name, state);
});

export const getActor = Effect.fn("features.password.getActor")(function* (name: string) {
  const { actors } = yield* World;
  const actor = yield* actors.get(name);
  yield* actors.use(name);
  return actor;
});

/** BDD-008: the actor the most recent step named — for Thens with no explicit subject. */
export const currentActor = Effect.fn("features.password.currentActor")(function* () {
  const { actors } = yield* World;
  return yield* actors.get(yield* actors.current);
});

export const setSession = Effect.fn("features.password.setSession")(function* (
  name: string,
  cookie: string,
) {
  const { sessions } = yield* World;
  yield* sessions.set(name, cookie);
});

export const getSessionCookie = Effect.fn("features.password.getSessionCookie")(function* (
  name: string,
) {
  const { sessions } = yield* World;
  return yield* sessions.get(name);
});

export const setNote = Effect.fn("features.password.setNote")(function* (
  key: string,
  value: string,
) {
  const { notes } = yield* World;
  yield* Ref.update(notes, (existing) => ({ ...existing, [key]: value }));
});

export const getNote = Effect.fn("features.password.getNote")(function* (key: string) {
  const { notes } = yield* World;
  const found = (yield* Ref.get(notes))[key];
  if (found === undefined) return yield* Effect.die(new Error(`no note recorded for "${key}"`));
  return found;
});

export const mailbox = Effect.fn("features.password.mailbox")(function* () {
  return (yield* appHandle()).mailbox;
});

/** The newest `template` mail (to `to`, when given), once the detached dispatch fiber has sent it. */
export const latestMail = Effect.fn("features.password.latestMail")(function* (
  template: string,
  to?: string,
) {
  const box = yield* mailbox();
  const match = (message: Mailer.MailMessage) =>
    message.template === template && (to === undefined || message.to === to);
  const recorded = (yield* box.mail.messages).filter(match).length;
  return yield* box.mail.waitFor(match, { nth: Math.max(recorded, 1) });
});

export const publishedEvents = Effect.fn("features.password.publishedEvents")(function* () {
  return yield* (yield* appHandle()).publishedEvents;
});

/**
 * Gives every detached fiber a chance to finish: `signUp`'s verification mail is dispatched via
 * `Effect.forkDetach` (BEH-EA-113: never awaited) and the events subscriber runs in the app's own
 * runtime, so a few cooperative turns plus one real timer tick let both settle before a read.
 */
export const settle = Effect.gen(function* () {
  const app = yield* appHandle();
  yield* awaitStable(Effect.zip(app.mailbox.mail.messages, app.publishedEvents));
});

/**
 * Upstream-hardening map, ticket 04: `signIn` now hard-blocks an
 * unverified account — every scenario that needs a real, working sign-in
 * after sign-up must consume signUp's own dispatched verification mail
 * first, the same wiring `packages/password/test/AuthHttp.test.ts`'s own
 * `verifyLatestSignUp` proves works at the HTTP layer.
 */
export const verifyLatestSignUp = Effect.fn("features.password.verifyLatestSignUp")(function* (
  email?: string,
) {
  const mail = yield* latestMail("verify-email", email);
  const token = mailedToken(mail);
  const response = yield* request("/verify-email", { token });
  if (response.status !== 204) {
    throw new Error(`verify-email failed: ${response.status}`);
  }
});

/** TIR-005: arms (or disarms) the fault-injecting `Sessions` wrapper. */
export const setFault = Effect.fn("features.password.setFault")(function* (fault: Fault) {
  const { fault: cell } = yield* appHandle();
  yield* Ref.set(cell, fault);
});

// ---- read handles (AH-004/PHS-005/AH-008): the running services the handler uses ----

/** AH-004: whether any user row exists for `email` — what "no user exists" must actually check. */
export const userExists = Effect.fn("features.password.userExists")(function* (email: string) {
  const { inApp } = yield* appHandle();
  const found = yield* Effect.promise(() =>
    inApp(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        return yield* users.findByEmail(email);
      }),
    ),
  );
  return Option.isSome(found);
});

const passwordAccountOf = Effect.fnUntraced(function* (email: string) {
  const users = yield* Users.Users;
  const accounts = yield* Accounts.Accounts;
  const user = yield* users.findByEmail(email);
  if (Option.isNone(user)) return yield* Effect.die(new Error(`no user for ${email}`));
  const account = yield* accounts.findByProviderSubject(
    Accounts.PASSWORD_PROVIDER_ID,
    user.value.id,
  );
  if (Option.isNone(account)) {
    return yield* Effect.die(new Error(`no password account for ${email}`));
  }
  return { accounts, account: account.value, user: user.value };
});

/** PHS-005: the stored credential hash (PHC string) of `email`'s password account. */
export const storedCredentialHash = Effect.fn("features.password.storedCredentialHash")(function* (
  email: string,
) {
  const { inApp } = yield* appHandle();
  return yield* Effect.promise(() =>
    inApp(
      Effect.gen(function* () {
        const { accounts, account } = yield* passwordAccountOf(email);
        const hash = yield* accounts.findCredentialHash(account.id);
        if (Option.isNone(hash)) {
          return yield* Effect.die(new Error("account has no credential hash"));
        }
        return String(Redacted.value(hash.value));
      }),
    ),
  );
});

/** PHS-005: overwrites the stored credential hash, standing in for "computed under previously configured parameters". */
export const plantCredentialHash = Effect.fn("features.password.plantCredentialHash")(function* (
  email: string,
  phc: string,
) {
  const { inApp } = yield* appHandle();
  yield* Effect.promise(() =>
    inApp(
      Effect.gen(function* () {
        const { accounts, account } = yield* passwordAccountOf(email);
        yield* accounts.updateCredentialHash(
          account.id,
          Redacted.make(PasswordHasher.PhcHash(phc)),
        );
      }),
    ),
  );
});

/** PHS-005: a real argon2id hash of `password` under explicitly chosen cost parameters (env-style keys), e.g. "previously configured" ones. `Layer.fresh`: the app already built `layerArgon2id` on its memo map; a shared instance would ignore `env`. */
export const hashUnderArgon2Params = (env: Record<string, string>, password: string) =>
  Effect.promise(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const hasher = yield* PasswordHasher.PasswordHasher;
        return String(yield* hasher.hash(Redacted.make(password)));
      }).pipe(
        Effect.provide(
          Layer.fresh(PasswordHasher.layerArgon2id).pipe(
            Layer.provide(NodeCrypto.layer),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
            Layer.orDie,
          ),
        ),
      ),
    ),
  );

/** PHS-005: the app's own configured hasher's verdict on a stored hash. */
export const currentHasherNeedsRehash = Effect.fn("features.password.currentHasherNeedsRehash")(
  function* (phc: string) {
    const { inApp } = yield* appHandle();
    return yield* Effect.promise(() =>
      inApp(
        Effect.gen(function* () {
          const hasher = yield* PasswordHasher.PasswordHasher;
          return hasher.needsRehash(PasswordHasher.PhcHash(phc));
        }),
      ),
    );
  },
);

export const currentHasherVerifies = Effect.fn("features.password.currentHasherVerifies")(
  function* (password: string, phc: string) {
    const { inApp } = yield* appHandle();
    return yield* Effect.promise(() =>
      inApp(
        Effect.gen(function* () {
          const hasher = yield* PasswordHasher.PasswordHasher;
          return yield* hasher.verify(Redacted.make(password), PasswordHasher.PhcHash(phc));
        }),
      ),
    );
  },
);

/** AH-008/TIR-005: whether the session behind `cookie` still verifies — the direct observation of "session s1 is revoked", not a proxy through another endpoint's 401. */
export const sessionIsLive = Effect.fn("features.password.sessionIsLive")(function* (
  cookie: string,
) {
  const { inApp } = yield* appHandle();
  const token = decodeURIComponent(cookie.replace(/^__Host-session=/, ""));
  return yield* Effect.promise(() =>
    inApp(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        return yield* sessions
          .verify(Redacted.make(token))
          .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
      }),
    ),
  );
});

/** AH-004: a user with an email identity and no password account — the honest arrangement of "the account has no password credential at all". */
export const createUserWithoutCredential = Effect.fn(
  "features.password.createUserWithoutCredential",
)(function* (email: string) {
  const { inApp } = yield* appHandle();
  yield* Effect.promise(() =>
    inApp(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        yield* users.create({ identity: { _tag: "Email", email }, name: email });
      }),
    ),
  );
});

/** AH-009: whether the user's email is verified right now. */
export const emailIsVerified = Effect.fn("features.password.emailIsVerified")(function* (
  email: string,
) {
  const { inApp } = yield* appHandle();
  return yield* Effect.promise(() =>
    inApp(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const user = yield* users.findByEmail(email);
        return Option.isSome(user) && Users.isEmailVerified(user.value);
      }),
    ),
  );
});

/** TIR-005/AH-007: the options the current app was built from. */
export const currentOptions = Effect.fn("features.password.currentOptions")(function* () {
  return yield* (yield* World).app.options;
});

/**
 * BEH-EA-120/345: a signed-in administrator's session cookie (`name=value`) on the `adminAccounts`
 * composition, and the id of the user `email` names.
 */
export const administratorOver = Effect.fn("features.password.administratorOver")(function* (
  email: string,
) {
  const { inApp } = yield* appHandle();
  return yield* Effect.promise(() =>
    inApp(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const target = yield* users.findByEmail(email);
        if (Option.isNone(target)) return yield* Effect.die(new Error(`no user for ${email}`));
        const admin = yield* users.create({
          identity: { _tag: "Email", email: "an-administrator@example.com" },
          name: "An administrator",
        });
        const issued = yield* sessions.issue({ userId: admin.id }).pipe(TestAuth.withoutRequest);
        const setCookie = yield* TestAuth.sessionSetCookie(issued);
        return { cookie: setCookie.split(";")[0] ?? "", targetId: target.value.id };
      }),
    ),
  );
});
