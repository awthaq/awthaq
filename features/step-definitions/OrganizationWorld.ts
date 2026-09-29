// MTI-011/P20a: the Organization plugin's real wire-level seam, the same
// `HttpRouter.toWebHandler` composition `packages/organization/test/AuthHttp.test.ts`
// establishes. Every scenario drives the plugin through its HTTP group as a real signed-in
// caller (a real user row with a verified address and a real session cookie), so the
// cross-tenant Rule asserts exactly what an attacker holding a valid session would see.
// The World is rebuilt per scenario, so the tenants a scenario names are the only tenants
// that exist.
import {
  Accounts,
  AuditChain,
  AuthEvents,
  Erasure,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { Admin, AdminApi, ImpersonationRecords } from "@awthaq/admin";
import { Mailer, SqlTransaction } from "@awthaq/ports";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import {
  Organization,
  OrganizationApi,
  OrganizationHooks,
  OrganizationMemory,
} from "@awthaq/organization";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { CSRF_TEST_COOKIE_VALUE, CsrfConfigForTests, withCsrfCookie } from "./CsrfTestSupport.ts";
import { makeCapturingMailer, makeNamedRegistry, TestServices } from "./shared/Harness.ts";
import { snapshot, type Snapshot } from "./shared/WireJson.ts";
import { TestAuth } from "@awthaq/test";

// `Accounts`/`Verification` are here only because `Erasure.layer` (BEH-EA-290's erasure
// clause) sweeps them too; the organization group itself never touches them.
const CoreLive = Layer.mergeAll(
  Sessions.layerMemory,
  Users.layerMemory,
  Accounts.layerMemory,
  Verification.layerMemory,
).pipe(Layer.provideMerge(TestAuth.memoryFoundation));

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

// AR-003: the admin group sits behind `Api.AdminAuthentication`; the default just delegates.
const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(AuthenticationLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(Layer.succeed(Csrf.CsrfConfig, CsrfConfigForTests)),
  Layer.provide(NodeCrypto.layer),
);

type HookTaps = Layer.Layer<
  never,
  never,
  Layer.Success<typeof OrganizationHooks.OrganizationHooksLive>
>;

export interface AppOptions {
  readonly config?: Partial<Organization.OrganizationConfigShape>;
  /** Whether the admin plugin, mounted beside this one (REQ-EA-723), lets any admin impersonate. Off by default: `AdminConfig`'s own fail-closed answer. */
  readonly canImpersonate?: boolean;
  /** `OrganizationHooks.*.tap(...)` layers — how a scenario installs a veto or a failing observer. */
  readonly hooks?: HookTaps;
}

const buildAppLayer = (
  options: AppOptions,
  mailer: Layer.Layer<Mailer.Mailer>,
  eventsLayer: Layer.Layer<never, never, AuthEvents.AuthEvents>,
) =>
  Layer.mergeAll(
    AuthHttp.routes(OrganizationApi.OrganizationApi, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(Organization.Organization.layer),
      Layer.provide(Organization.config(options.config ?? {})),
      Layer.provide(AuthenticationLive),
    ),
    AuthHttp.docs(OrganizationApi.OrganizationApi),
    // The admin plugin beside this one, so an impersonated session can be opened for real.
    AuthHttp.routes(AdminApi.AdminApi).pipe(
      Layer.provide(Admin.Admin.layer),
      Layer.provide(
        Admin.config({ canImpersonate: () => Effect.succeed(options.canImpersonate === true) }),
      ),
      Layer.provide(AdminAuthenticationLive),
    ),
  ).pipe(
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(eventsLayer),
    Layer.provideMerge(Erasure.layer),
    Layer.provideMerge(OrganizationMemory.layer),
    Layer.provideMerge(
      ImpersonationRecords.layerMemory.pipe(
        Layer.provide(NodeCrypto.layer),
        Layer.provide(AuditChain.layer.pipe(Layer.provide(NodeCrypto.layer))),
      ),
    ),
    Layer.provideMerge(CoreLive),
    Layer.provideMerge(mailer),
    Layer.provideMerge(SqlTransaction.layerNoop),
    Layer.provideMerge(options.hooks ?? Layer.empty),
    Layer.provideMerge(OrganizationHooks.OrganizationHooksLive),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

type AppLayer = ReturnType<typeof buildAppLayer>;

export interface AppHandle {
  readonly handler: (request: Request) => Promise<Response>;
  /** Runs `effect` against the exact services `handler` runs on (the same memo map). */
  readonly withContext: <A, E>(effect: Effect.Effect<A, E, Layer.Success<AppLayer>>) => Promise<A>;
  readonly sentMail: Effect.Effect<ReadonlyArray<Mailer.MailMessage>>;
  readonly publishedEvents: Effect.Effect<ReadonlyArray<AuthEvents.AuthEvent>>;
  /** Releases the built layer; the World does this when the scenario ends. */
  readonly close: Effect.Effect<void>;
}

const buildApp = (options: AppOptions = {}): AppHandle => {
  const { layer: mailer, sent } = makeCapturingMailer();
  // Subscribing to the real `AuthEvents` stream, as `PasswordWorld` does: the capture cell
  // lives outside the layer graph so a step can read it after the graph is sealed.
  const events = Effect.runSync(Ref.make<ReadonlyArray<AuthEvents.AuthEvent>>([]));
  const eventsLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const authEvents = yield* AuthEvents.AuthEvents;
      // `subscribe` registers the subscription now, in the layer's scope; the lazy `stream`
      // would register only once the forked fiber first ran, and could miss an early event.
      const subscription = yield* authEvents.subscribe;
      yield* subscription.pipe(
        Stream.runForEach((event) => Ref.update(events, (existing) => [...existing, event])),
        Effect.forkScoped,
      );
    }),
  );
  const layer = buildAppLayer(options, mailer, eventsLayer);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(layer, { memoMap });
  // One long-lived scope owns the built layer (and with it the events subscriber): a scope
  // closed after every helper call would tear the subscription down and lose later events.
  const scope = Effect.runSync(Scope.make());
  let built: Promise<Context.Context<Layer.Success<AppLayer>>> | undefined;
  const context = () =>
    (built ??= Effect.runPromise(Layer.buildWithMemoMap(layer, memoMap, scope)));
  const withContext: AppHandle["withContext"] = (effect) =>
    context().then((services) => Effect.runPromise(effect.pipe(Effect.provide(services))));
  return {
    handler,
    withContext,
    sentMail: sent,
    publishedEvents: Ref.get(events),
    close: Scope.close(scope, Exit.void),
  };
};

/** One signed-in caller: a real user and one real session cookie. */
export interface Actor {
  readonly name: string;
  readonly userId: Users.UserId;
  readonly email: string;
  readonly cookie: string;
}

export interface WorldShape {
  readonly app: Ref.Ref<AppHandle>;
  readonly options: Ref.Ref<AppOptions>;
  /** Signed-in callers by the name the Gherkin text uses ("alice"); a second session of one user ("alice's phone") is its own entry. */
  readonly users: ReturnType<typeof makeNamedRegistry<Actor>>;
  /** Every real user created so far, so a user id on the wire can be turned back into the name the scenario used. */
  readonly roster: Ref.Ref<ReadonlyArray<Actor>>;
  /** Organization ids by the slug the Gherkin text uses ("acme"). */
  readonly organizations: ReturnType<typeof makeNamedRegistry<string>>;
  /** Anything else a scenario names and later refers to (a team id, a role id). */
  readonly ids: ReturnType<typeof makeNamedRegistry<string>>;
  /** Per-organization quota overrides `limitsFor` reads (EP-006); a step fills it once the organization exists. */
  readonly quotaOverrides: Map<string, Organization.OrganizationLimits>;
  readonly last: Ref.Ref<Snapshot | undefined>;
  /** Every response body a step has received, so "never appears on the wire" can be asserted over the whole scenario. */
  readonly transcript: Ref.Ref<ReadonlyArray<string>>;
  /** The last request sent through the generic "sends" step, placeholders unresolved, so a Then can replay it against an organization that does not exist. */
  readonly lastTemplate: Ref.Ref<RequestTemplate | undefined>;
}

export interface RequestTemplate {
  readonly who: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

export class World extends Context.Service<World, WorldShape>()("features/OrganizationWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    const app = yield* Ref.make(buildApp());
    yield* Effect.addFinalizer(() => Ref.get(app).pipe(Effect.flatMap((handle) => handle.close)));
    return World.of({
      app,
      options: yield* Ref.make<AppOptions>({}),
      users: makeNamedRegistry<Actor>("user"),
      roster: yield* Ref.make<ReadonlyArray<Actor>>([]),
      organizations: makeNamedRegistry<string>("organization"),
      ids: makeNamedRegistry<string>("id"),
      quotaOverrides: new Map(),
      last: yield* Ref.make<Snapshot | undefined>(undefined),
      transcript: yield* Ref.make<ReadonlyArray<string>>([]),
      lastTemplate: yield* Ref.make<RequestTemplate | undefined>(undefined),
    });
  }),
);

/** Merges `config` over what earlier Givens configured. The app is rebuilt, so this must run before anyone signs in. */
export const configureApp = Effect.fn("features.organization.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  if ((yield* Ref.get(world.roster)).length > 0) {
    return yield* Effect.die(
      new Error(
        "configureApp rebuilds the app and drops every user: configure before signing anyone in",
      ),
    );
  }
  const before = yield* Ref.get(world.options);
  const merged: AppOptions = {
    config: { ...before.config, ...options.config },
    ...((options.canImpersonate ?? before.canImpersonate) === undefined
      ? {}
      : { canImpersonate: options.canImpersonate ?? before.canImpersonate }),
    ...(options.hooks !== undefined
      ? {
          hooks:
            before.hooks === undefined ? options.hooks : Layer.merge(before.hooks, options.hooks),
        }
      : before.hooks === undefined
        ? {}
        : { hooks: before.hooks }),
  };
  yield* Ref.set(world.options, merged);
  yield* Ref.set(world.app, buildApp(merged));
});

export const currentApp = Effect.gen(function* () {
  const { app } = yield* World;
  return yield* Ref.get(app);
});

const sessionCookieFor = (token: Redacted.Redacted<string>) =>
  `${Sessions.SESSION_COOKIE_NAME}=${encodeURIComponent(Redacted.value(token))}`;

/**
 * Creates a real user (with a verified address unless `verified: false`) and a real
 * session for it, registered under `name`. `email` defaults to `<name>@example.com`.
 */
export const signInUser = Effect.fn("features.organization.signInUser")(function* (
  name: string,
  input: { readonly email?: string; readonly verified?: boolean } = {},
) {
  const world = yield* World;
  const app = yield* currentApp;
  const email = input.email ?? `${name}@example.com`;
  const actor = yield* Effect.promise(() =>
    app.withContext(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const created = yield* users
          .create({ identity: { _tag: "Email", email }, name })
          .pipe(Effect.orDie);
        if (input.verified !== false) yield* users.verifyEmail(created.id).pipe(Effect.orDie);
        const issued = yield* sessions.issue({ userId: created.id }).pipe(Effect.orDie);
        return { name, userId: created.id, email, cookie: sessionCookieFor(issued.token) };
      }),
    ),
  );
  yield* world.users.set(name, actor);
  yield* Ref.update(world.roster, (existing) => [...existing, actor]);
  return actor;
});

/** A second, independent session for an already signed-in user, registered under `sessionName`. */
export const openSession = Effect.fn("features.organization.openSession")(function* (
  sessionName: string,
  userName: string,
) {
  const world = yield* World;
  const app = yield* currentApp;
  const owner = yield* world.users.get(userName);
  const cookie = yield* Effect.promise(() =>
    app.withContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: owner.userId }).pipe(Effect.orDie);
        return sessionCookieFor(issued.token);
      }),
    ),
  );
  yield* world.users.set(sessionName, { ...owner, cookie });
});

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** One request as `cookie`'s owner; unsafe methods carry the double-submit CSRF pair a real client would. */
export const send = Effect.fn("features.organization.send")(function* (
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  options: { readonly observe?: boolean } = {},
) {
  const world = yield* World;
  const { handler } = yield* currentApp;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (UNSAFE.has(method)) {
    headers["cookie"] = withCsrfCookie(cookie);
    headers["x-csrf-token"] = CSRF_TEST_COOKIE_VALUE;
  } else if (cookie !== undefined) {
    headers["cookie"] = cookie;
  }
  const response = yield* Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );
  const drained = yield* snapshot(response);
  // An observation (a Then checking state as some user) must not overwrite the response
  // the scenario's own When produced, which later Thens may still assert on.
  if (options.observe !== true) yield* Ref.set(world.last, drained);
  yield* Ref.update(world.transcript, (existing) => [...existing, drained.text]);
  return drained;
});

/** `send` as a named signed-in user ("alice") or extra session ("alice's phone"). */
export const sendAs = Effect.fn("features.organization.sendAs")(function* (
  who: string,
  method: string,
  path: string,
  body?: unknown,
  options: { readonly observe?: boolean } = {},
) {
  const world = yield* World;
  const actor = yield* world.users.get(who);
  return yield* send(actor.cookie, method, path, body, options);
});

export const lastResponse = Effect.gen(function* () {
  const { last } = yield* World;
  const found = yield* Ref.get(last);
  if (found === undefined) return yield* Effect.die(new Error("no request has been made yet"));
  return found;
});

/** The mail the plugin sent to `email`, newest first — how a step plays the invitee reading their inbox. */
export const mailTo = Effect.fn("features.organization.mailTo")(function* (email: string) {
  const app = yield* currentApp;
  const mail = yield* app.sentMail;
  return mail.filter((message) => message.to === email).toReversed();
});
