// MTI-011/P20a: the Organization plugin's real wire-level seam, the same
// `HttpRouter.toWebHandler` composition `packages/organization/test/AuthHttp.test.ts`
// establishes. Every scenario drives the plugin through its HTTP group as a real signed-in
// caller (a real user row with a verified address and a real session cookie), so the
// cross-tenant Rule asserts exactly what an attacker holding a valid session would see.
// The World is rebuilt per scenario, so the tenants a scenario names are the only tenants
// that exist.
import { Auth, AuthEvents, SessionCookie, Sessions, Users } from "@awthaq/core";
import { Admin } from "@awthaq/admin";
import {
  DomainClaims,
  Organization,
  OrganizationActiveContext,
  OrganizationAuthority,
  OrganizationDeletion,
  OrganizationDirectory,
  OrganizationHooks,
  OrganizationInvitations,
  OrganizationMembers,
  OrganizationRoles,
  OrganizationTeams,
} from "@awthaq/organization";
import {
  ActiveContextRecords,
  ConnectionRecords,
  InvitationRecords,
  MembershipRecords,
  OrganizationRecords,
  OrgRoleRecords,
  TeamRecords,
} from "@awthaq/organization/records";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { makeNamedRegistry } from "./shared/Harness.ts";
import { snapshot, type Snapshot } from "./shared/WireJson.ts";
import { TestAuth, TestMailbox, type UserAgent } from "@awthaq/test";
import * as Cookies from "effect/http/Cookies";

/** The record stores the memory layer provides, named so the inferred layer type below can be emitted. */
export type RecordServiceNames =
  | ActiveContextRecords.ActiveContextRecords
  | InvitationRecords.InvitationRecords
  | MembershipRecords.MembershipRecords
  | OrganizationRecords.OrganizationRecords
  | OrgRoleRecords.OrgRoleRecords
  | TeamRecords.TeamRecords;

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

const built = Auth.make([Organization.Organization, Admin.Admin]);

/**
 * `Auth.make([Organization, Admin])` through `TestAuth.layer`: the real organization plugin and, beside it, the admin
 * plugin (REQ-EA-723) so an impersonated session can be opened for real, over the real in-memory core, served behind
 * the derived authentication, admin authentication and CSRF middleware. A scenario's hook taps ride `taps`; the
 * events subscriber is this world's `services`.
 */
const buildAppLayer = (
  options: AppOptions,
  eventsLayer: Layer.Layer<never, never, AuthEvents.AuthEvents>,
) =>
  TestAuth.layer(built, {
    services: Layer.mergeAll(
      Organization.config(options.config ?? {}),
      Admin.config({ canImpersonate: () => Effect.succeed(options.canImpersonate === true) }),
      eventsLayer,
    ),
    taps: options.hooks ?? Layer.empty,
    openapiPath: "/openapi.json",
    docsPath: "/docs",
  });

/** The organization services and record stores the composition provides, named so its inferred type can be emitted (declaration emit needs each namespace in scope). */
export type OrganizationServiceNames =
  | OrganizationActiveContext.OrganizationActiveContext
  | OrganizationAuthority.OrganizationAuthority
  | OrganizationDeletion.OrganizationDeletion
  | OrganizationDirectory.OrganizationDirectory
  | OrganizationInvitations.OrganizationInvitations
  | OrganizationMembers.OrganizationMembers
  | OrganizationRoles.OrganizationRoles
  | OrganizationTeams.OrganizationTeams
  | ConnectionRecords.ConnectionRecords
  | DomainClaims.DomainClaims;

type AppLayer = ReturnType<typeof buildAppLayer>;

export interface AppHandle {
  readonly handler: (request: Request) => Promise<Response>;
  /** A fresh browser over the app (its own cookies, a CSRF cookie already held). */
  readonly agent: () => Promise<UserAgent.UserAgent>;
  /** Runs `effect` against the exact services `handler` runs on (the same memo map). */
  readonly withContext: <A, E>(effect: Effect.Effect<A, E, Layer.Success<AppLayer>>) => Promise<A>;
  readonly mailbox: Effect.Effect<TestMailbox.MailboxShape>;
  readonly publishedEvents: Effect.Effect<ReadonlyArray<AuthEvents.PublishedAny>>;
}

const buildApp = Effect.fn("features.organization.buildApp")(function* (options: AppOptions) {
  // Subscribing to the real `AuthEvents` stream, as `PasswordWorld` does: the capture cell
  // lives outside the layer graph so a step can read it after the graph is sealed.
  const events = yield* Ref.make<ReadonlyArray<AuthEvents.PublishedAny>>([]);
  const eventsLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const authEvents = yield* AuthEvents.AuthEvents;
      // `subscribe` registers the subscription now, in the layer's scope; the lazy `stream`
      // would register only once the forked fiber first ran, and could miss an early event.
      const subscription = yield* authEvents.subscribe;
      yield* subscription.pipe(
        // Every event, core's and the organization plugin's (ADR-EA-049): this world reads them back by tag.
        Stream.runForEach((event) => Ref.update(events, (existing) => [...existing, event])),
        Effect.forkScoped,
      );
    }),
  );
  const app = yield* TestAuth.serve(buildAppLayer(options, eventsLayer));
  return {
    handler: app.handler,
    agent: () => app.agent(),
    withContext: (effect) => app.run(effect),
    mailbox: Effect.promise(() => app.run(TestMailbox.Mailbox)),
    publishedEvents: Ref.get(events),
  } satisfies AppHandle;
});

/** One signed-in caller: a real user and a browser holding one real session. */
export interface Actor {
  readonly name: string;
  readonly userId: Users.UserId;
  readonly email: string;
  /** The session's `Set-Cookie`, so a step can open a second browser holding the same session. */
  readonly setCookie: string;
  readonly agent: UserAgent.UserAgent;
}

export interface WorldShape {
  /** Configure before signing anyone in: the first sign-in builds the app, and a later configure is a defect. */
  readonly app: TestAuth.LazyApp<AppOptions, AppHandle>;
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
    return World.of({
      app: yield* TestAuth.lazyApp<AppOptions, AppHandle>({}, buildApp, {
        name: "OrganizationWorld",
      }),
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

/** Merges `config` over what earlier Givens configured; must run before anyone signs in (the first sign-in builds the app). */
export const configureApp = Effect.fn("features.organization.configureApp")(function* (
  options: AppOptions,
) {
  const world = yield* World;
  yield* world.app.configure((before) => ({
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
  }));
});

export const currentApp = Effect.gen(function* () {
  const { app } = yield* World;
  return yield* app.get;
});

/** The `Set-Cookie` a freshly issued session is delivered as, under the composition's cookie config. */
const renderSession = (issued: Sessions.IssuedSession) =>
  Effect.map(SessionCookie.render(issued.session, issued.token), (rendered) =>
    Cookies.serializeCookie(
      Cookies.makeCookieUnsafe(rendered.name, rendered.value, rendered.options),
    ),
  );

/** A fresh browser holding the session `setCookie` renders. */
export const browserWith = Effect.fn("features.organization.browserWith")(function* (
  setCookie: string,
) {
  const app = yield* currentApp;
  const agent = yield* Effect.promise(() => app.agent());
  const received = agent.cookies.receive(setCookie);
  if (received._tag !== "Stored") throw new Error("the browser did not store the session cookie");
  return agent;
});

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
  const minted = yield* Effect.promise(() =>
    app.withContext(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const created = yield* users
          .create({ identity: { _tag: "Email", email }, name })
          .pipe(Effect.orDie);
        if (input.verified !== false) yield* users.verifyEmail(created.id).pipe(Effect.orDie);
        const issued = yield* sessions
          .issue({ userId: created.id })
          .pipe(TestAuth.withoutRequest)
          .pipe(Effect.orDie);
        return { name, userId: created.id, email, setCookie: yield* renderSession(issued) };
      }),
    ),
  );
  const actor: Actor = { ...minted, agent: yield* browserWith(minted.setCookie) };
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
  const setCookie = yield* Effect.promise(() =>
    app.withContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions
          .issue({ userId: owner.userId })
          .pipe(TestAuth.withoutRequest)
          .pipe(Effect.orDie);
        return yield* renderSession(issued);
      }),
    ),
  );
  yield* world.users.set(sessionName, {
    ...owner,
    setCookie,
    agent: yield* browserWith(setCookie),
  });
});

/**
 * One request from `agent` (a signed-in caller's browser, which keeps its cookies and echoes CSRF on an
 * unsafe method), or from a fresh anonymous browser.
 */
export const send = Effect.fn("features.organization.send")(function* (
  agent: UserAgent.UserAgent | undefined,
  method: string,
  path: string,
  body?: unknown,
  options: { readonly observe?: boolean } = {},
) {
  const world = yield* World;
  const app = yield* currentApp;
  const from = agent ?? (yield* Effect.promise(() => app.agent()));
  const response = yield* Effect.promise(() =>
    from.request(method, path, body === undefined ? {} : { json: body }),
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
  return yield* send(actor.agent, method, path, body, options);
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
  const mail = yield* (yield* app.mailbox).mail.messages;
  return mail.filter((message) => message.to === email).toReversed();
});
