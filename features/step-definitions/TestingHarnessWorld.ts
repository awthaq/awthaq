// BEH-EA-193..200 (25-testing-harness.feature): what a plugin author's test suite gets from
// `@awthaq/test`. Every scenario drives the harness through its public exports only
// (`TestAuth.layer`, `TestAuth.signInAs`, `TestAuth.runPluginContractTests`) — the same seam a
// third-party author has (REQ-EA-565) — over plugins built here, never over `@awthaq/test`'s own
// test fixtures.
import { Api, SubjectContract } from "@awthaq/api";
import { Auth, AuthPlugin } from "@awthaq/core";
import { Password } from "@awthaq/password";
import { AuthorizedSubject, SubjectApi, SubjectExtractor } from "@awthaq/qadi";
import { Roles } from "@awthaq/roles";
import { Authentication, Csrf } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EvaluationServicesNone, hasPermission, permission, role } from "@qadi/core";
import {
  RequirePermission,
  RequirePermissionLive,
  RequiredPermission,
  requiresPermission,
} from "@qadi/http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Ref from "effect/Ref";
import { makeOutcomes, type Outcomes } from "./shared/Outcomes.ts";

/** A breach corpus nothing matches: the plugin's own breach check is not what these scenarios are about. */
const NoBreachHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

/** The support layers `Password` needs beyond `TestAuth`'s memory bundle — exactly the ones a suite passes as `services`. */
export const HarnessServices = Layer.mergeAll(
  Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  Csrf.CsrfProtectionLive.pipe(
    Layer.provide(
      Layer.succeed(Csrf.CsrfConfig, {
        secret: Redacted.make("features-testing-harness-csrf-secret-32-bytes!"),
        allowedOrigins: [],
      }),
    ),
  ),
  NoBreachHttpClient,
).pipe(Layer.provide(NodeCrypto.layer));

/** BEH-EA-193: the application's own tuple, as `Auth.make` sees it. */
export const passwordTuple = Auth.make([Password.Password]);

export const passwordApp = TestAuth.layer(passwordTuple, HarnessServices);

// ---- a small authenticated plugin, for the signInAs / TestClock scenarios -------------------

class Whoami extends Schema.Class<Whoami>("HarnessWhoami")({ userId: Schema.String }) {}

const WhoamiApi = HttpApi.make("auth").add(
  HttpApiGroup.make("harnesswhoami")
    .add(HttpApiEndpoint.get("get", "/whoami", { success: Whoami }))
    .middleware(Api.Authentication),
);

/** The handler body, callable directly with a fabricated principal (REQ-EA-559) or reached through the middleware chain. */
export const whoamiFor = (principal: Api.Principal) =>
  principal._tag === "User"
    ? Effect.succeed(new Whoami({ userId: principal.ref.id }))
    : Effect.die(new Error("expected a User principal"));

class WhoamiPlugin extends AuthPlugin.Service<WhoamiPlugin, Record<string, never>>()(
  "harnesswhoami",
  { apiVersion: 1, contract: WhoamiApi, tables: [] },
) {
  static readonly layer = AuthPlugin.layer(WhoamiPlugin, {
    make: Effect.succeed({}),
    handlers: HttpApiBuilder.group(WhoamiApi, "harnesswhoami", (handlers) =>
      handlers.handle("get", () => Effect.flatMap(Api.CurrentPrincipal, whoamiFor)),
    ),
  });
}

export const whoamiTuple = Auth.make([WhoamiPlugin]);

export const whoamiApp = TestAuth.layer(whoamiTuple, HarnessServices);

// ---- an HTTP-level authorization test: RequirePermission over TestAuth.signInAs (PV-261) ----

const projectRead = permission("project", "read");
const projectAdmin = permission("project", "admin");
const memberRole = role({ name: "member", permissions: [projectRead] });
const adminRole = role({ name: "admin", permissions: [projectAdmin], inherits: [memberRole] });

const adminOnly = HttpApiEndpoint.get("adminOnly", "/admin-only", { success: Schema.String }).pipe(
  (endpoint) =>
    endpoint.annotate(
      RequiredPermission,
      requiresPermission(endpoint, {
        permission: projectAdmin,
        policy: hasPermission(projectAdmin),
      }),
    ),
);

const GatedApi = HttpApi.make("auth").add(
  HttpApiGroup.make("harnessgated").add(adminOnly).middleware(RequirePermission),
);

class GatedPlugin extends AuthPlugin.Service<GatedPlugin, Record<string, never>>()("harnessgated", {
  apiVersion: 1,
  contract: GatedApi,
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(GatedPlugin, {
    make: Effect.succeed({}),
    handlers: HttpApiBuilder.group(GatedApi, "harnessgated", (handlers) =>
      handlers.handle("adminOnly", () => Effect.succeed("admin data")),
    ),
  });
}

/**
 * The real Path B pipeline a suite merges next to `TestAuth.layer`: qadi's `RequirePermissionLive`
 * over awthaq's `SubjectExtractorLive`, the `Roles` resolver flattening the catalog, and qadi's real
 * evaluator (`EvaluationServicesNone`: no attribute/relationship ports, none needed by a role policy).
 */
const GatedServices = RequirePermissionLive.pipe(
  Layer.provide(EvaluationServicesNone),
  Layer.provide(SubjectExtractor.SubjectExtractorLive),
  Layer.provide(Authentication.PrincipalResolverLive),
  Layer.provideMerge(Roles.Roles.layer),
  Layer.provide(Roles.config([memberRole, adminRole])),
);

// Core's own session/account groups ride in every `TestAuth.layer`, so their `Authentication`/CSRF middleware is provided too.
export const gatedApp = TestAuth.layer(
  Auth.make([Roles.Roles, GatedPlugin]),
  Layer.mergeAll(GatedServices, HarnessServices),
);

// ---- qadi's GET /subject over the same harness (REQ-EA-063) ----

/** `GET /subject` served next to the `Roles` resolver: what a browser's `subjectAtom` reads. */
const SubjectServices = SubjectApi.SubjectHandlers.pipe(
  Layer.provide(AuthorizedSubject.AuthorizedSubjectLive),
  Layer.provideMerge(Roles.Roles.layer),
  Layer.provide(Roles.config([memberRole, adminRole])),
  // `GET /subject` is served behind the optional-authentication middleware.
  Layer.provideMerge(
    Authentication.OptionalAuthenticationLive.pipe(
      Layer.provide(Authentication.PrincipalResolverLive),
    ),
  ),
);

export const subjectApp = TestAuth.layer(
  Auth.make([Roles.Roles], { extraGroups: [SubjectApi.SubjectGroup] }),
  Layer.mergeAll(SubjectServices, HarnessServices),
);

/** Signs in with exactly `roles` and reads the caller's own `GET /subject`, decoded as the wire `SubjectDto`. */
export const subjectFor = (email: string, roles: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const rolesService = yield* Roles.Roles;
    const signedIn = yield* TestAuth.signInAs({
      email,
      onSignedUp: (userId) =>
        Effect.forEach(roles, (name) => rolesService.assign(userId, name), {
          discard: true,
        }).pipe(Effect.orDie),
    });
    const response = yield* dispatch(
      new Request("http://localhost/subject", { headers: { cookie: signedIn.cookieHeader } }),
    );
    const body = yield* Effect.promise(() => response.json());
    return {
      status: response.status,
      userId: signedIn.userId,
      subject: yield* Schema.decodeUnknownEffect(SubjectContract.SubjectDto)(body).pipe(
        Effect.orDie,
      ),
    };
  });

/** Signs in with exactly `roles` (assigned through the real `Roles` service) and requests the admin-only endpoint. */
export const requestAdminOnlyAs = (email: string, roles: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const rolesService = yield* Roles.Roles;
    const signedIn = yield* TestAuth.signInAs({
      email,
      onSignedUp: (userId) =>
        Effect.forEach(roles, (name) => rolesService.assign(userId, name), {
          discard: true,
        }).pipe(Effect.orDie),
    });
    const response = yield* dispatch(
      new Request("http://localhost/admin-only", { headers: { cookie: signedIn.cookieHeader } }),
    );
    return { status: response.status, body: yield* Effect.promise(() => response.text()) };
  });

/** Dispatches a web `Request` through the composed router of the ambient `TestAuth.layer` — no listener, no socket. */
export const dispatch = (request: Request) =>
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    const response = yield* router
      .asHttpEffect()
      .pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
        Effect.scoped,
      );
    return HttpServerResponse.toWeb(response);
  });

/** Whether a service is present in a built context, without requiring it. */
export const provides = <I, S>(context: Context.Context<never>, service: Context.Key<I, S>) =>
  Context.getOption(context, service)._tag === "Some";

// ---- recording a contract-test run ---------------------------------------------------------

export class Recorder {
  readonly passed: Array<string> = [];
  readonly failed: Array<string> = [];
  readonly pending: Array<Promise<void>> = [];
  settled() {
    return Promise.all(this.pending).then(() => undefined);
  }
}

/** A `TestFramework` that records each check's verdict instead of registering vitest tests, so a scenario can assert on what the suite decided. */
export const recordingFramework = (sink: Recorder): TestAuth.TestFramework => ({
  describe: (_name, body) => body(),
  it: (name, body) => {
    sink.pending.push(
      Promise.resolve()
        .then(body)
        .then(
          () => {
            sink.passed.push(name);
          },
          (error: unknown) => {
            sink.failed.push(
              `${name} :: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        ),
    );
  },
  fail: (message) => {
    throw new Error(message);
  },
});

export const fakePlugin = (overrides: Partial<AuthPlugin.Any>): AuthPlugin.Any => ({
  id: "fake",
  apiVersion: 1,
  contract: { identifier: "auth", groups: {} },
  tables: [],
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
  ...overrides,
});

/** `Auth.make` needs at least one contract group, which `fakePlugin`'s empty contract lacks. */
export const composable = (id: string, overrides: Partial<AuthPlugin.Any>): AuthPlugin.Any => {
  const group = HttpApiGroup.make(id);
  return fakePlugin({
    id,
    contract: { identifier: "auth", groups: { [id]: group } },
    ...overrides,
  });
};

// ---- the World -----------------------------------------------------------------------------

export interface ContractRun {
  readonly passed: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
}

/** The plugin factory + option combinations a Given set up, run by "the contract test suite runs". */
export interface ContractSetup {
  readonly make: (options: Readonly<Record<string, unknown>>) => AuthPlugin.Any;
  readonly options: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly host: ReadonlyArray<AuthPlugin.Any>;
  /** PV-260: stub inputs for the plugin's declared taps (the suite's opt-in `hooks` option). */
  readonly hooks?: ReadonlyArray<{
    readonly point: { readonly id: string };
    readonly input: unknown;
  }>;
}

export interface WorldShape {
  readonly outcomes: Outcomes;
  readonly contractSetup: Ref.Ref<ContractSetup | undefined>;
}

export class World extends Context.Service<World, WorldShape>()("features/TestingHarnessWorld") {}

export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({
      outcomes: yield* makeOutcomes,
      contractSetup: yield* Ref.make<ContractSetup | undefined>(undefined),
    });
  }),
);

export const isContractRun = (value: unknown): value is ContractRun =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray(Reflect.get(value, "passed")) &&
  Array.isArray(Reflect.get(value, "failed"));

/** Runs `runPluginContractTests` over a setup and resolves the recorded verdicts. */
export const runContractSuite = (setup: ContractSetup) =>
  Effect.promise(async () => {
    const sink = new Recorder();
    TestAuth.runPluginContractTests(recordingFramework(sink), setup.make, {
      options: setup.options,
      host: setup.host,
      ...(setup.hooks === undefined ? {} : { hooks: setup.hooks }),
    });
    await sink.settled();
    return { passed: sink.passed, failed: sink.failed };
  });

export const contractSetup = Effect.gen(function* () {
  const { contractSetup: cell } = yield* World;
  const found = yield* Ref.get(cell);
  return found === undefined
    ? yield* Effect.die(new Error("no plugin was set up by a Given step"))
    : found;
});
