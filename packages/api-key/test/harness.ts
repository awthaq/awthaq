// Shared test composition for @awthaq/api-key: `Auth.make([Jwt, ApiKey], { extraGroups })` through `TestAuth.layer`
// (plan 08): the plugin over real `Jwt`, the derived `Authentication`/`MachineAuthentication`/CSRF middleware and
// the credential-resolver registry, with the api-key records either in memory or on a real migrated database
// (`records: "sql"`, SQLite by default, Postgres under `AWTHAQ_POSTGRES_URL`).
import { Api } from "@awthaq/api";
import { Accounts, Auth, Erasure, Persistence, Sessions, Users, Verification } from "@awthaq/core";
import { Jwt, JwtConfig } from "@awthaq/jwt";
import { TestAuth } from "@awthaq/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as ApiKey from "../src/ApiKey.ts";

const ORIGIN = "http://localhost:3000";

const describePrincipal = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  const scopes =
    principal._tag === "ApiKey" || principal._tag === "Service" ? principal.scopes.join(",") : "";
  return `${principal._tag}:${principal.ref.id}:${scopes}`;
});

/**
 * Two probe groups an application would declare: one for machine callers
 * (`MachineAuthentication`) and one that assumes a session (`Authentication`).
 */
const ProbeMachine = HttpApiGroup.make("probeMachine")
  .add(HttpApiEndpoint.get("whoAmI", "/probe/machine", { success: Schema.String }))
  .middleware(Api.MachineAuthentication);
const ProbeUser = HttpApiGroup.make("probeUser")
  .add(HttpApiEndpoint.get("whoAmI", "/probe/user", { success: Schema.String }))
  .middleware(Api.Authentication);
const ProbeApi = HttpApi.make("auth").add(ProbeMachine).add(ProbeUser);

const built = Auth.make([Jwt.Jwt, ApiKey.ApiKey], { extraGroups: [ProbeMachine, ProbeUser] });

const ProbeHandlers = Layer.mergeAll(
  HttpApiBuilder.group(ProbeApi, "probeMachine", (handlers) =>
    handlers.handle("whoAmI", () => describePrincipal),
  ),
  HttpApiBuilder.group(ProbeApi, "probeUser", (handlers) =>
    handlers.handle("whoAmI", () => describePrincipal),
  ),
);

export interface HarnessOptions {
  readonly store: "memory" | "sql";
  /** Names the schema on Postgres; one distinct value per test file. */
  readonly suite?: string;
  readonly config?: Partial<ApiKey.ApiKeyConfigShape>;
  readonly rateLimiter?: "permissive" | "enforcing";
}

export const buildLayer = (options: HarnessOptions) => {
  const common = {
    rateLimiter: options.rateLimiter ?? "permissive",
    services: Layer.mergeAll(
      ProbeHandlers,
      ApiKey.config(options.config ?? {}),
      JwtConfig.config({ issuer: "https://issuer.test", audience: "https://api.test" }),
    ),
  };
  return options.store === "sql"
    ? TestAuth.layer(built, { ...common, records: "sql", suite: options.suite ?? "api_key" })
    : TestAuth.layer(built, common);
};

export type HarnessServices = Layer.Success<ReturnType<typeof buildLayer>>;

/** A running app: the real web handler, and a way to reach the very services it runs against. */
export const makeApp = (options: HarnessOptions) => {
  const layer = buildLayer(options);
  const app = TestAuth.app(layer, { baseUrl: ORIGIN });
  const withContext = <A, E>(effect: Effect.Effect<A, E, HarnessServices>): Promise<A> =>
    app.run(effect);

  /**
   * A real session (cookie) for the user named `label`, against the same running `Sessions`. The
   * user is a stored one (created on first use): a key resolves only while its owner exists.
   */
  const sessionCookie = (label: string): Promise<string> =>
    withContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const users = yield* Users.Users;
        const { user } = yield* users.createOrGet({
          identity: { _tag: "Email", email: `${label}@example.com` },
          name: label,
        });
        const issued = yield* sessions.issue({ userId: user.id });
        return `${Api.SESSION_COOKIE_NAME}=${encodeURIComponent(Redacted.value(issued.token))}`;
      }),
    );

  return { handler: app.handler, withContext, sessionCookie, request: app.request, layer };
};

/**
 * Erases `userId` through the core cascade with none of the plugins' contributions (not even
 * api-key's own): the deliberate orphan the owner-standing gate exists for.
 */
export const orphanOwner = (userId: Users.UserId) =>
  Erasure.AccountErasure.use((erasure) =>
    erasure.eraseAccount(userId, Erasure.ErasureInitiator.Self()),
  ).pipe(
    Effect.provide(
      Erasure.layer.pipe(
        // `Layer.fresh`: the composition's own registry (holding api-key's contribution) is memoized
        // by reference, so without `fresh` it would be reused.
        Layer.provide(Layer.fresh(Erasure.registryLayer)),
        Layer.provide(Accounts.layer.pipe(Layer.provide(Persistence.memory))),
        Layer.provide(Verification.layer.pipe(Layer.provide(Persistence.memory))),
      ),
    ),
    Effect.orDie,
  );

/**
 * Registers real users for the key owners: a key resolves only while its owner exists and
 * may sign in, so a fixture owner must be a stored user, not just an id string.
 */
export const seedUser = (email: string) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    return (yield* users.create({ identity: { _tag: "Email", email }, name: email })).id;
  });
