// AH-003 (decision 36, Tier 2): the shared World for the qadi authorization-bridge features
// (18-roles-subject-resolver, 19-qadi-bridge-path-a, 20-qadi-bridge-path-b,
// 21-qadi-resolvers-obligations).
//
// qadi's own policy evaluation is a black box here (features/STYLE.md, "The qadi boundary"):
// "the evaluator would return Allow/Deny" is arranged by giving the *real* evaluator a subject and
// a resource it decides that way about, never by stubbing the evaluator. What is asserted is
// awthaq's own bridge responsibilities — the subject a request resolves to, the status a
// resolver outage or a missing annotation ends in, the extractor reusing Authentication's
// session logic.
//
// One composite `HttpApi` ("bridge-fixture") carries a Path A group (`AuthorizedSubject`) and a
// Path B group (`RequirePermission`); the reference handlers in it are the documented handler
// patterns (BEH-EA-146..152) written out once, over real `@qadi/core` calls, so the scenarios can
// drive them over real HTTP. They are fixtures for those patterns, not shipped awthaq code.
import { Api } from "@awthaq/api";
import {
  Accounts,
  AuditLog,
  AuthEvents,
  DataExport,
  Erasure,
  Hooks,
  Sessions,
  Slots,
  Users,
} from "@awthaq/core";
import { AuthorizedSubject, SubjectApi, SubjectExtractor, SubjectResolver } from "@awthaq/qadi";
import { Roles } from "@awthaq/roles";
import { Authentication, AuthHttp } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AttributeResolver,
  AttributeResolveError,
  CurrentSubject,
  DecisionHistory,
  DecisionHistoryUnavailable,
  DecisionSink,
  EvaluationServicesNone,
  RelationshipResolveError,
  RelationshipResolver,
  allOf,
  enforce,
  enforceProjected,
  eq,
  exists,
  check,
  filter,
  filterStream,
  guard,
  hasActed,
  hasAttribute,
  hasPermission,
  hasRelationship,
  hasResourceAttribute,
  hasRole,
  literal,
  obligation,
  obliged,
  permission,
  role,
  subjectId,
} from "@qadi/core";
import type { ActedResult, AuthSubject, Authorized, RelatedResult, Role } from "@qadi/core";
import {
  PublicEndpoint,
  RequirePermission,
  RequirePermissionLive,
  decisionStreamRoute,
  RequiredPermission,
  addGuardedRoute,
  permissionRegistryRoute,
  PermissionRegistryLive,
  publicEndpoint,
  registerApi,
  requiresPermission,
} from "@qadi/http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type { OrganizationFixtureServices, WalkProbe } from "./QadiOrganizationFixture.ts";
import { makeWalkProbe } from "./QadiOrganizationFixture.ts";
import { makeNamedRegistry, TestServices } from "./shared/Harness.ts";

// ---- the fixture's authorization vocabulary ----

export const projectRead = permission("project", "read");
export const projectDelete = permission("project", "delete");
export const projectAdmin = permission("project", "admin");

/** A role catalog: `reader` holds `project:read`; `admin` inherits it and adds `project:delete`. */
export const readerRole = role({ name: "reader", permissions: [projectRead] });
export const adminRole = role({
  name: "admin",
  permissions: [projectDelete, projectAdmin],
  inherits: [readerRole],
});

/** The tenant every caller in these scenarios belongs to; a project in any other tenant is one the caller cannot access. */
export const CALLER_TENANT = "acme";

export type Project = {
  readonly id: string;
  readonly tenant: string;
  readonly name: string;
  readonly budget: number;
  readonly secret: string;
};

export const PROJECTS: ReadonlyArray<Project> = [
  { id: "project-42", tenant: "other", name: "Foreign", budget: 10, secret: "s-42" },
  { id: "project-7", tenant: CALLER_TENANT, name: "Seven", budget: 70, secret: "s-7" },
  { id: "project-8", tenant: CALLER_TENANT, name: "Eight", budget: 80, secret: "s-8" },
  { id: "project-9", tenant: "other", name: "Nine", budget: 90, secret: "s-9" },
];

/** Read access to a project: the resource must live in the caller's tenant. The real evaluator decides. */
export const sameTenant = hasResourceAttribute("tenant", eq(literal(CALLER_TENANT)));
export const canReadProject = allOf([sameTenant]);
/** Field-level grant: a holder of `project:read` sees only `id` and `name`. */
export const canReadProjectSummary = hasPermission(projectRead, { fields: ["id", "name"] });
/** Ownership, judged from the loaded resource's `ownerId` against the caller's own subject id. */
export const ownerPolicy = hasResourceAttribute("ownerId", eq(subjectId()));
export const canDeleteProject = hasPermission(projectDelete);
/** A bare route's policy: the permission *and* the tenant, so an anonymous caller (no permission) is refused. */
const canExportProject = allOf([hasPermission(projectRead), sameTenant]);

// ---- wire shapes ----

class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}, { httpApiStatus: 404 }) {}

class Whoami extends Schema.Class<Whoami>("Whoami")({
  subjectId: Schema.String,
  permissions: Schema.Array(Schema.String),
  roles: Schema.Array(Schema.String),
}) {}

class Ok extends Schema.Class<Ok>("Ok")({ endpoint: Schema.String }) {}

const IdParams = Schema.Struct({ id: Schema.String });
const KindParams = Schema.Struct({ kind: Schema.String });
const Fields = Schema.Record(Schema.String, Schema.Unknown);
const Ids = Schema.Array(Schema.String);

const attributeName = "plan";
const historyEvent = "accepted-terms";
const dutyReason = "test/duty";

/** Path A: `AuthorizedSubject` after `Authentication` (declared in the one order that works, YL-008). */
const PathAGroup = HttpApiGroup.make("authz")
  .add(HttpApiEndpoint.get("whoami", "/a/whoami", { success: Whoami }))
  .add(HttpApiEndpoint.get("project", "/a/projects/:id", { params: IdParams, success: Fields, error: NotFound }))
  .add(
    HttpApiEndpoint.get("summary", "/a/projects/:id/summary", {
      params: IdParams,
      success: Fields,
      error: NotFound,
    }),
  )
  .add(HttpApiEndpoint.get("outage", "/a/outage/:kind", { params: KindParams, success: Ok, error: NotFound }))
  .add(HttpApiEndpoint.get("list", "/a/projects", { success: Ids }))
  .add(HttpApiEndpoint.get("streamed", "/a/projects-stream", { success: Ids }))
  .add(HttpApiEndpoint.get("remove", "/a/projects/:id/remove", { params: IdParams, success: Ok, error: NotFound }))
  .add(HttpApiEndpoint.get("sessionId", "/a/repeated-subject", { success: Ids }))
  .add(HttpApiEndpoint.get("multi", "/a/multi-call", { success: Ids }))
  .add(HttpApiEndpoint.get("owned", "/a/owned/:id", { params: IdParams, success: Ok, error: NotFound }))
  .middleware(AuthorizedSubject.AuthorizedSubject)
  .middleware(Api.Authentication);

/**
 * Path B: `RequirePermission` alone — no awthaq contract middleware in front, so the
 * `SubjectExtractor` has to resolve the subject from the raw request (BEH-EA-153).
 */
const readEndpoint = HttpApiEndpoint.get("read", "/b/read", { success: Ok }).pipe((e) =>
  e.annotate(RequiredPermission, requiresPermission(e, { permission: projectRead, policy: hasPermission(projectRead) })),
);
const deleteEndpoint = HttpApiEndpoint.get("deleteIt", "/b/delete", { success: Ok }).pipe((e) =>
  e.annotate(RequiredPermission, requiresPermission(e, { permission: projectDelete, policy: hasPermission(projectDelete) })),
);
const adminOnlyEndpoint = HttpApiEndpoint.get("adminOnly", "/b/admin-only", { success: Ok }).pipe((e) =>
  e.annotate(RequiredPermission, requiresPermission(e, { permission: projectAdmin, policy: hasRole("admin") })),
);
const ownedEndpoint = HttpApiEndpoint.get("owned", "/b/owned", { success: Ok }).pipe((e) =>
  e.annotate(
    RequiredPermission,
    requiresPermission(e, {
      permission: projectRead,
      policy: ownerPolicy,
    }),
  ),
);
const planEndpoint = HttpApiEndpoint.get("plan", "/b/plan", { success: Ok }).pipe((e) =>
  e.annotate(
    RequiredPermission,
    requiresPermission(e, { permission: projectRead, policy: hasAttribute(attributeName, exists()) }),
  ),
);
const dutyEndpoint = HttpApiEndpoint.get("duty", "/b/duty", { success: Ok }).pipe((e) =>
  e.annotate(
    RequiredPermission,
    requiresPermission(e, {
      permission: projectRead,
      policy: obliged(obligation(dutyReason), allOf([])),
    }),
  ),
);
const whoamiBEndpoint = HttpApiEndpoint.get("whoamiB", "/b/whoami", { success: Whoami }).pipe((e) =>
  e.annotate(RequiredPermission, requiresPermission(e, { permission: projectRead, policy: hasPermission(projectRead) })),
);
const healthEndpoint = HttpApiEndpoint.get("health", "/b/health", { success: Ok }).pipe((e) =>
  e.annotate(PublicEndpoint, publicEndpoint("liveness probe, no subject exists yet")),
);
const forgottenEndpoint = HttpApiEndpoint.get("forgotten", "/b/forgotten", { success: Ok });

const PathBGroup = HttpApiGroup.make("gated")
  .add(readEndpoint)
  .add(deleteEndpoint)
  .add(adminOnlyEndpoint)
  .add(ownedEndpoint)
  .add(planEndpoint)
  .add(dutyEndpoint)
  .add(whoamiBEndpoint)
  .add(healthEndpoint)
  .add(forgottenEndpoint)
  .middleware(RequirePermission);

export const FixtureApi = HttpApi.make("bridge-fixture").add(PathAGroup).add(PathBGroup);

// ---- per-scenario configuration ----

export type OutageKind = "attribute" | "relationship" | "history";

export interface BridgeOptions {
  /** Install `@awthaq/roles` (the exclusive `SubjectResolver` override) over this catalog. */
  readonly roles?: ReadonlyArray<Role>;
  /** Make one of qadi's evaluation ports fail instead of answering. */
  readonly outage?: OutageKind;
  /** Log a `plan` attribute lookup as "pro" and record every attribute the evaluator asks for. */
  readonly recordAttributeLookups?: boolean;
}

export interface DecisionLine {
  readonly subjectId: string;
  readonly policyTag: string;
  readonly verdict: "Allow" | "Deny" | "Failed";
  /** How many attributes the evaluated resource carried: 0 means no resource had been loaded (`NO_RESOURCE`). */
  readonly resourceKeys: number;
}

export interface WorldShape {
  readonly options: Ref.Ref<BridgeOptions>;
  readonly app: Ref.Ref<App | undefined>;
  readonly domain: Ref.Ref<Context.Context<DomainServices> | undefined>;
  readonly plan: Ref.Ref<Plan | undefined>;
  /** The principal a Given constructed, for the shared "resolves the principal" When. */
  readonly principal: Ref.Ref<Api.Principal | undefined>;
  /** The subject a resolution produced (named, so a scenario can keep several). */
  readonly subjects: ReturnType<typeof makeNamedRegistry<AuthSubject>>;
  /** BEH-EA-162: the organization stores + `Organization.relationships`, and the probe steering the application's resource -> organization lookup. */
  readonly walk: WalkProbe;
  readonly organization: Ref.Ref<Context.Context<OrganizationFixtureServices> | undefined>;
  /** Extra, independently built apps (scenarios that compare two compositions). */
  readonly apps: ReturnType<typeof makeNamedRegistry<App>>;
  /** Names of the handlers that actually ran (BEH-EA-158: the registry is derived without running any). */
  readonly executed: Ref.Ref<ReadonlyArray<string>>;
  /** `SubjectResolver.resolve` invocations (BEH-EA-145/139/160). */
  readonly resolutions: Ref.Ref<number>;
  /** Every attribute name the evaluator asked the `AttributeResolver` for. */
  readonly attributeLookups: Ref.Ref<ReadonlyArray<string>>;
  /** Which subject owns which project id (set by a scenario once it knows who the caller is). */
  readonly owners: Ref.Ref<Readonly<Record<string, string>>>;
  /** One line per completed policy evaluation qadi's evaluator reported to the `DecisionSink` (subject, policy tag, verdict). */
  readonly decisions: Ref.Ref<ReadonlyArray<DecisionLine>>;
  /** Log lines emitted while serving requests. */
  readonly logs: Ref.Ref<ReadonlyArray<string>>;
  readonly outcomes: Ref.Ref<Readonly<Record<string, unknown>>>;
  readonly actors: ReturnType<typeof makeNamedRegistry<Actor>>;
  readonly responses: ReturnType<typeof makeNamedRegistry<Captured>>;
}

export class World extends Context.Service<World, WorldShape>()("features/QadiBridgeWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      options: yield* Ref.make<BridgeOptions>({}),
      app: yield* Ref.make<App | undefined>(undefined),
      domain: yield* Ref.make<Context.Context<DomainServices> | undefined>(undefined),
      plan: yield* Ref.make<Plan | undefined>(undefined),
      principal: yield* Ref.make<Api.Principal | undefined>(undefined),
      subjects: makeNamedRegistry<AuthSubject>("subject"),
      apps: makeNamedRegistry<App>("app"),
      walk: makeWalkProbe(),
      organization: yield* Ref.make<Context.Context<OrganizationFixtureServices> | undefined>(undefined),
      executed: yield* Ref.make<ReadonlyArray<string>>([]),
      resolutions: yield* Ref.make(0),
      attributeLookups: yield* Ref.make<ReadonlyArray<string>>([]),
      owners: yield* Ref.make<Readonly<Record<string, string>>>({}),
      decisions: yield* Ref.make<ReadonlyArray<DecisionLine>>([]),
      logs: yield* Ref.make<ReadonlyArray<string>>([]),
      outcomes: yield* Ref.make<Readonly<Record<string, unknown>>>({}),
      actors: makeNamedRegistry<Actor>("actor"),
      responses: makeNamedRegistry<Captured>("response"),
    });
  }),
);

export const configure = Effect.fn("features.qadiBridge.configure")(function* (patch: BridgeOptions) {
  const world = yield* World;
  const { app } = world;
  if ((yield* Ref.get(app)) !== undefined) {
    throw new Error("configure() must run before the first request: the app is already built");
  }
  yield* Ref.update(world.options, (existing) => ({ ...existing, ...patch }));
});

// ---- the app ----

export const CoreLive = Layer.mergeAll(Users.layerMemory, Accounts.layerMemory, Sessions.layerMemory).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(Slots.layer),
  Layer.provideMerge(Erasure.registryLayer),
  Layer.provideMerge(DataExport.registryLayer),
  Layer.provideMerge(NodeCrypto.layer),
);

const unrelated: RelatedResult = "Unrelated";
const notActed: ActedResult = "NotActed";

const failing = (cause: string) => new Error(`bridge fixture: ${cause}`);

const evaluationPorts = (world: WorldShape, options: BridgeOptions) => {
  const attributes = Layer.succeed(
    AttributeResolver,
    AttributeResolver.of({
      name: "bridge-fixture/attributes",
      resolve: (_subject, attribute) =>
        Ref.update(world.attributeLookups, (seen) => [...seen, attribute]).pipe(
          Effect.andThen(
            options.outage === "attribute"
              ? Effect.fail(new AttributeResolveError({ attribute, cause: failing("attribute source down") }))
              : Effect.succeed(attribute === attributeName ? "pro" : undefined),
          ),
        ),
    }),
  );
  const relationships = Layer.succeed(
    RelationshipResolver,
    RelationshipResolver.of({
      name: "bridge-fixture/relationships",
      check: (query) =>
        options.outage === "relationship"
          ? Effect.fail(
              new RelationshipResolveError({
                relation: query.relation,
                resourceId: query.resourceId,
                cause: failing("relationship source down"),
              }),
            )
          : Effect.succeed(unrelated),
    }),
  );
  const history = Layer.succeed(
    DecisionHistory,
    DecisionHistory.of({
      hasActed: (query) =>
        options.outage === "history"
          ? Effect.fail(
              new DecisionHistoryUnavailable({ event: query.event, cause: failing("history source down") }),
            )
          : Effect.succeed(notActed),
    }),
  );
  return Layer.mergeAll(EvaluationServicesNone, attributes, relationships, history);
};

/** Counts every `SubjectResolver.resolve`, over whichever resolver is in effect (default, or `Roles`'s override). */
const countingResolver = (world: WorldShape) =>
  Layer.effect(
    SubjectResolver.SubjectResolver,
    Effect.gen(function* () {
      const inner = yield* SubjectResolver.SubjectResolver;
      return {
        resolve: (principal: Api.Principal) =>
          Ref.update(world.resolutions, (n) => n + 1).pipe(Effect.andThen(inner.resolve(principal))),
      };
    }),
  );

const notFound = Effect.fail(new NotFound());

const projectById = (id: string) => PROJECTS.find((candidate) => candidate.id === id);

const noteExecuted = (world: WorldShape, name: string) =>
  Ref.update(world.executed, (seen) => [...seen, name]);

const ok = (world: WorldShape, endpoint: string) =>
  noteExecuted(world, endpoint).pipe(Effect.as(new Ok({ endpoint })));

const outagePolicy = (kind: string) =>
  kind === "relationship"
    ? hasRelationship("member", { depth: 2 })
    : kind === "history"
      ? hasActed(historyEvent, { scope: "Any" })
      : hasAttribute(attributeName, exists());

/**
 * BEH-EA-147/148: the reference Path A handler. A denial on a tenant-scoped resource id becomes the
 * resource's own not-found (the caller must not learn the id exists); every *other* enforcement
 * failure (a resolver outage) is a defect, never a 403/404.
 */
const hideDenied = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catch((error) =>
      error._tag === "NotFound"
        ? notFound
        : error._tag === "AccessDenied"
          ? notFound
          : Effect.die(error),
    ),
  );

const pathAHandlers = (world: WorldShape) =>
  HttpApiBuilder.group(FixtureApi, "authz", (handlers) =>
    handlers
      .handle("whoami", () =>
        Effect.gen(function* () {
          // BEH-EA-145: the handler reads `CurrentSubject` as a provided value, twice, and calls no resolver.
          const subject = yield* CurrentSubject;
          const again = yield* CurrentSubject;
          yield* noteExecuted(world, "whoami");
          return new Whoami({
            subjectId: subject.id,
            permissions: [...again.permissions].map(String),
            roles: [...again.roles].map(String),
          });
        }),
      )
      .handle("project", ({ params }) =>
        Effect.gen(function* () {
          const project = projectById(params.id);
          if (project === undefined) return yield* notFound;
          return yield* guard(projectRead, canReadProject)(project, (_witness, resource) =>
            Effect.succeed({ id: resource.id, name: resource.name }),
          );
        }).pipe(hideDenied),
      )
      .handle("summary", ({ params }) =>
        Effect.gen(function* () {
          const project = projectById(params.id);
          if (project === undefined) return yield* notFound;
          // `enforceProjected` alone: the gate and the field trim in one call (BEH-EA-149).
          return yield* enforceProjected(canReadProjectSummary, { resource: project })(
            Effect.succeed({ id: project.id, name: project.name, budget: project.budget, secret: project.secret }),
          );
        }).pipe(hideDenied),
      )
      .handle("outage", ({ params }) =>
        enforce(outagePolicy(params.kind))(ok(world, `outage-${params.kind}`)).pipe(hideDenied),
      )
      .handle("list", () =>
        filter(sameTenant, PROJECTS.map((project) => ({ ...project }))).pipe(
          Effect.map((allowed) => allowed.map((project) => String(project["id"]))),
          Effect.orDie,
        ),
      )
      .handle("streamed", () =>
        Stream.fromIterable(PROJECTS.map((project) => ({ ...project }))).pipe(
          (source) => filterStream(sameTenant, source),
          Stream.map((project) => String(project["id"])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.orDie,
        ),
      )
      .handle("remove", ({ params }) =>
        Effect.gen(function* () {
          const project = projectById(params.id);
          if (project === undefined) return yield* notFound;
          // BEH-EA-151: the removal below can only be reached with the witness `guard` mints.
          const removeProject = (witness: Authorized<typeof projectDelete>, target: Project) =>
            noteExecuted(world, `removed:${target.id}:${witness.permission.action}`).pipe(
              Effect.as(new Ok({ endpoint: `removed ${target.id}` })),
            );
          return yield* guard(projectDelete, canDeleteProject)(project, removeProject);
        }).pipe(hideDenied),
      )
      .handle("owned", ({ params }) =>
        Effect.gen(function* () {
          // BEH-EA-159: a policy over the *loaded resource's* attribute (`ownerId`) is a Path A guard —
          // the handler loads the resource first, which annotation-only Path B never does.
          const owner = (yield* Ref.get(world.owners))[params.id];
          if (owner === undefined) return yield* notFound;
          return yield* guard(projectRead, ownerPolicy)(
            { id: params.id, ownerId: owner },
            () => ok(world, `owned-${params.id}`),
          );
        }).pipe(hideDenied),
      )
      .handle("sessionId", () =>
        Effect.gen(function* () {
          const subject = yield* CurrentSubject;
          return [subject.id];
        }),
      )
      .handle("multi", () =>
        Effect.gen(function* () {
          const subject = yield* CurrentSubject;
          // several separate qadi calls against the one already-resolved subject (BEH-EA-139): none resolves again
          const policy = hasPermission(projectRead);
          const checked = yield* check(policy);
          yield* enforce(policy)(Effect.void);
          const allowed = yield* filter(policy, [{ id: "a" }, { id: "b" }]);
          return [subject.id, `check=${checked}`, "enforce=ok", `filter=${allowed.length}`];
        }).pipe(Effect.orDie),
      ),
  );

const pathBHandlers = (world: WorldShape) =>
  HttpApiBuilder.group(FixtureApi, "gated", (handlers) =>
    handlers
      .handle("read", () => ok(world, "read"))
      .handle("deleteIt", () => ok(world, "deleteIt"))
      .handle("adminOnly", () => ok(world, "adminOnly"))
      .handle("owned", () => ok(world, "owned"))
      .handle("plan", () => ok(world, "plan"))
      .handle("duty", () => ok(world, "duty"))
      .handle("whoamiB", () =>
        Effect.gen(function* () {
          const subject = yield* CurrentSubject;
          yield* noteExecuted(world, "whoamiB");
          return new Whoami({
            subjectId: subject.id,
            permissions: [...subject.permissions].map(String),
            roles: [...subject.roles].map(String),
          });
        }),
      )
      .handle("health", () => ok(world, "health"))
      .handle("forgotten", () => ok(world, "forgotten")),
  );

/** BEH-EA-152: a bare `HttpRouter` route outside the `HttpApi` contract, authorized by `addGuardedRoute`. */
const bareExportRoute = addGuardedRoute(
  "GET",
  "/projects/:id/export.csv",
  projectRead,
  canExportProject,
  (request) =>
    Effect.succeed(
      projectById(request.url.split("/projects/")[1]?.split("/")[0] ?? "") ?? {
        id: "unknown",
        tenant: "none",
      },
    ),
)((witness, resource) =>
  Effect.gen(function* () {
    const subject = yield* CurrentSubject;
    return HttpServerResponse.text(
      `id=${String(resource["id"])};witness=${witness.permission.resource}:${witness.permission.action};subject=${subject.id}`,
    );
  }),
);

/** BEH-EA-158: the registry route, guarded by a policy — only a subject holding `project:admin` may read it. */
const registryRoute = permissionRegistryRoute(projectAdmin, hasPermission(projectAdmin));

/** BEH-EA-168: qadi's guarded devtools decision stream, re-authorizing an open connection every 30 seconds. */
const decisionStream = decisionStreamRoute(projectAdmin, hasPermission(projectAdmin), Stream.never, {
  reauth: { interval: "30 seconds" },
});

/** qadi's `DecisionSink` port: what the evaluator reports, recorded so a scenario can count evaluations (and see which policy ran). */
const decisionLog = (world: WorldShape) =>
  Layer.succeed(
    DecisionSink,
    DecisionSink.of({
      record: (record) =>
        record._tag !== "Decision"
          ? Effect.void
          : Ref.update(world.decisions, (seen) => {
              const line: DecisionLine = {
                subjectId: record.subjectId,
                policyTag: record.policy._tag,
                verdict:
                  record.outcome._tag === "Failed" ? "Failed" : record.outcome.decision._tag,
                resourceKeys: Object.keys(record.resource ?? {}).length,
              };
              return [...seen, line];
            }),
    }),
  );

const captureLogs = (world: WorldShape) =>
  Logger.layer([
    Logger.make((options) => {
      Effect.runSync(Ref.update(world.logs, (seen) => [...seen, String(options.message)]));
    }),
  ]);

const buildBridge = (world: WorldShape, options: BridgeOptions) => {
  const rolesLayer =
    options.roles === undefined
      ? Layer.empty
      : Roles.Roles.layer.pipe(Layer.provide(Roles.config(options.roles)));
  // `Roles` claims the exclusive slot; the counting decorator wraps whichever resolver is in effect.
  const subjects = countingResolver(world).pipe(Layer.provideMerge(rolesLayer));
  return { subjects, evaluation: evaluationPorts(world, options) };
};

/**
 * BEH-EA-160: both bridges' layers merged into the one layer an application provides — Path A's
 * `AuthorizedSubjectLive`, Path B's `RequirePermissionLive` over its `SubjectExtractorLive`.
 */
const AuthzLive = Layer.mergeAll(
  AuthorizedSubject.AuthorizedSubjectLive,
  RequirePermissionLive.pipe(Layer.provideMerge(SubjectExtractor.SubjectExtractorLive)),
);

/** Builds the served fixture (routes, both bridges, both middleware) over one shared core and resolver stack. */
const buildApp = (world: WorldShape, options: BridgeOptions) => {
  const { subjects, evaluation } = buildBridge(world, options);

  // One core, one resolver stack: every consumer below sees the very same instances (BEH-EA-160).
  const sharedCore = subjects.pipe(Layer.provideMerge(CoreLive));
  const principals = Authentication.PrincipalResolverLive.pipe(Layer.provideMerge(sharedCore));
  // What qadi's enforcement (and a bare route's `guardRoute`) needs per request, not at build time.
  const requestServices = AuthzLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(evaluation, PermissionRegistryLive, decisionLog(world)).pipe(
        Layer.provideMerge(principals),
      ),
    ),
  );

  const routes = Layer.mergeAll(
    AuthHttp.routes(FixtureApi, {}).pipe(
      Layer.provide(pathAHandlers(world)),
      Layer.provide(pathBHandlers(world)),
    ),
    // BEH-EA-144: `@awthaq/qadi`'s own `GET /subject` (the shipped session-view of the resolved subject).
    AuthHttp.routes(SubjectApi.SubjectApi, {}).pipe(Layer.provide(SubjectApi.SubjectHandlers)),
    bareExportRoute,
    registryRoute,
    decisionStream,
    registerApi(FixtureApi),
  );

  const appLayer = routes.pipe(
    Layer.provide(Authentication.AuthenticationLive),
    Layer.provide(Authentication.OptionalAuthenticationLive),
    Layer.provideMerge(requestServices),
    Layer.provideMerge(captureLogs(world)),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );
  return { appLayer, requestServices };
};

/** What a step may run directly against the served app's own services (real clock, the same instances the handlers use). */
type AppServices = Layer.Success<ReturnType<typeof buildApp>["requestServices"]>;

export interface App {
  /** One request through the served fixture; evaluation ports are supplied per request, as qadi's enforcement expects. */
  readonly send: (
    path: string,
    init?: { readonly cookie?: string; readonly headers?: Record<string, string> },
  ) => Promise<Response>;
  /** Runs `effect` against the running app's own services on the real clock (sessions issued here are valid to the handlers). */
  readonly run: <A, E>(effect: Effect.Effect<A, E, AppServices>) => Promise<A>;
}

/** Serves one fresh, independent fixture app (own stores, own memo map) built from `options`. */
export const startApp = Effect.fn("features.qadiBridge.startApp")(function* (
  options: BridgeOptions,
) {
  const world = yield* World;
  const { appLayer, requestServices } = buildApp(world, options);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(appLayer, { memoMap });
  const scope = yield* Effect.scope;
  const evaluationContext = yield* Layer.buildWithMemoMap(requestServices, memoMap, scope);
  const built: App = {
    send: (path, init) =>
      handler(
        new Request(`http://localhost${path}`, {
          headers: {
            ...init?.headers,
            ...(init?.cookie === undefined ? {} : { cookie: init.cookie }),
          },
        }),
        evaluationContext,
      ),
    run: (effect) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.buildWithMemoMap(
              requestServices,
              memoMap,
              yield* Effect.scope,
            );
            return yield* effect.pipe(Effect.provide(services));
          }),
        ),
      ),
  };
  return built;
});

/** Builds (once) and returns this scenario's app. Everything a Given configured is in effect by now. */
export const app = Effect.fn("features.qadiBridge.app")(function* () {
  const world = yield* World;
  const existing = yield* Ref.get(world.app);
  if (existing !== undefined) return existing;
  const built = yield* startApp(yield* Ref.get(world.options));
  yield* Ref.set(world.app, built);
  return built;
});

/** Scenario-scoped scratch values a Given leaves for a later step (a kind of outage, the ids an evaluator would allow). */
export const setOutcome = Effect.fn("features.qadiBridge.setOutcome")(function* (
  key: string,
  value: unknown,
) {
  const world = yield* World;
  yield* Ref.update(world.outcomes, (existing) => ({ ...existing, [key]: value }));
});

export const outcome = Effect.fn("features.qadiBridge.outcome")(function* (key: string) {
  const world = yield* World;
  const found = (yield* Ref.get(world.outcomes))[key];
  if (found === undefined) throw new Error(`no outcome recorded for "${key}"`);
  return found;
});

/** The request a scenario's Givens arranged: which endpoint, and who (if anyone) sends it. */
export interface Plan {
  readonly path: string;
  readonly who?: { readonly name: string; readonly roles: ReadonlyArray<string> };
}

export const setPlan = Effect.fn("features.qadiBridge.setPlan")(function* (planned: Plan) {
  const world = yield* World;
  yield* Ref.set(world.plan, planned);
});

export const plan = Effect.fn("features.qadiBridge.plan")(function* () {
  const world = yield* World;
  const found = yield* Ref.get(world.plan);
  if (found === undefined) throw new Error("no request was planned by a Given");
  return found;
});

export const setOwner = Effect.fn("features.qadiBridge.setOwner")(function* (
  projectId: string,
  ownerSubjectId: string,
) {
  const world = yield* World;
  yield* Ref.update(world.owners, (existing) => ({ ...existing, [projectId]: ownerSubjectId }));
});

/** Domain-level composition on the *ambient* (test) clock, for scenarios that must move time: the extractor over the same core Authentication resolves against. */
const DomainLive = SubjectExtractor.SubjectExtractorLive.pipe(
  Layer.provideMerge(Authentication.PrincipalResolverLive),
  Layer.provideMerge(CoreLive),
);

export type DomainServices = Layer.Success<typeof DomainLive>;

/** Builds `DomainLive` once per scenario (scoped to the scenario) and runs `effect` against it. */
export const inDomain = Effect.fn("features.qadiBridge.inDomain")(function* <A, E>(
  effect: Effect.Effect<A, E, DomainServices>,
) {
  const world = yield* World;
  const existing = yield* Ref.get(world.domain);
  const context = existing ?? (yield* Layer.build(DomainLive));
  if (existing === undefined) yield* Ref.set(world.domain, context);
  return yield* effect.pipe(Effect.provide(context));
});

export const setPrincipal = Effect.fn("features.qadiBridge.setPrincipal")(function* (
  principal: Api.Principal,
) {
  const world = yield* World;
  yield* Ref.set(world.principal, principal);
});

/** Runs the `SubjectResolver` in effect in `served` (the app's own stack, roles override included) over `principal`. */
export const resolveIn = Effect.fn("features.qadiBridge.resolveIn")(function* (
  served: App,
  principal: Api.Principal,
) {
  return yield* Effect.promise(() =>
    served.run(
      Effect.gen(function* () {
        const resolver = yield* SubjectResolver.SubjectResolver;
        return yield* resolver.resolve(principal);
      }),
    ),
  );
});

/** `resolveIn` this scenario's app, keeping the subject under `name`. */
export const resolve = Effect.fn("features.qadiBridge.resolve")(function* (
  name: string,
  principal: Api.Principal,
) {
  const world = yield* World;
  const subject = yield* resolveIn(yield* app(), principal);
  yield* world.subjects.set(name, subject);
  return subject;
});

export const userPrincipal = (userId: string, actingAs?: { readonly type: string; readonly id: string }) =>
  new Api.UserPrincipal({
    ref: new Api.PrincipalRef({ type: "user", id: userId }),
    sessionId: "s-1",
    ...(actingAs === undefined ? {} : { actingAs: new Api.PrincipalRef(actingAs) }),
  });

export interface Actor {
  readonly userId: Users.UserId;
  /** The bare `name=value` cookie a request carries. */
  readonly cookie: string;
}

/** A user and a live session for them in `served`, minted directly (no password round trip); `roles` are assigned through `@awthaq/roles` when it is installed. */
export const mintActor = Effect.fn("features.qadiBridge.mintActor")(function* (
  served: App,
  name: string,
  roles: ReadonlyArray<string> = [],
) {
  const { run } = served;
  return yield* Effect.promise(() =>
    run(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users
          .create({ identity: { _tag: "Email", email: `${name}@example.com` }, name })
          .pipe(Effect.orDie);
        const installed = yield* Effect.serviceOption(Roles.Roles);
        if (Option.isSome(installed)) {
          for (const roleName of roles) yield* installed.value.assign(user.id, roleName).pipe(Effect.orDie);
        }
        const { token } = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        return {
          userId: user.id,
          cookie: `${Sessions.SESSION_COOKIE_NAME}=${encodeURIComponent(Redacted.value(token))}`,
        };
      }),
    ),
  );
});

/** `mintActor` into this scenario's app, remembered under `name`. */
export const signIn = Effect.fn("features.qadiBridge.signIn")(function* (
  name: string,
  roles: ReadonlyArray<string> = [],
) {
  const world = yield* World;
  const actor = yield* mintActor(yield* app(), name, roles);
  yield* world.actors.set(name, actor);
  return actor;
});

export interface Captured {
  readonly status: number;
  readonly body: string;
}

/** One request to `served`, carrying `cookie` if given. */
export const fetchOn = Effect.fn("features.qadiBridge.fetchOn")(function* (
  served: App,
  cookie: string | undefined,
  path: string,
) {
  const response = yield* Effect.promise(() =>
    served.send(path, cookie === undefined ? {} : { cookie }),
  );
  const captured: Captured = {
    status: response.status,
    body: yield* Effect.promise(() => response.text()),
  };
  return captured;
});

/** One request as `who` (an actor's name) or, with no name, with no credential; recorded as the scenario's last response. */
export const fetchAs = Effect.fn("features.qadiBridge.fetchAs")(function* (
  who: string | undefined,
  path: string,
) {
  const world = yield* World;
  const cookie = who === undefined ? undefined : (yield* world.actors.get(who)).cookie;
  const captured = yield* fetchOn(yield* app(), cookie, path);
  yield* world.responses.set("last", captured);
  return captured;
});

/** Same, but keeps the response under `key` too so a scenario can compare two. */
export const fetchAndKeep = Effect.fn("features.qadiBridge.fetchAndKeep")(function* (
  key: string,
  who: string | undefined,
  path: string,
) {
  const world = yield* World;
  const captured = yield* fetchAs(who, path);
  yield* world.responses.set(key, captured);
  return captured;
});
