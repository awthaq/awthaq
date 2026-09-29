// Shared test composition for @awthaq/api-key: the plugin over real `Jwt`, real
// `Authentication`/`MachineAuthentication`/CSRF middleware and the credential-resolver
// registry, with the api-key records either in memory or on a real migrated database
// (`TestSql`, SQLite by default, Postgres under `AWTHAQ_POSTGRES_URL`).
import { Api } from "@awthaq/api";
import { AuditLog, AuthEvents, Hooks, Migrations, RateLimits, Sessions, Users } from "@awthaq/core";
import { Jwt, JwtConfig, KeyRing, RevocationStore, SigningKeyRecords } from "@awthaq/jwt";
import { ClientAddress, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as TestSql from "../../sql/test/support/TestSql.ts";
import * as ApiKey from "../src/ApiKey.ts";
import * as ApiKeyApi from "../src/ApiKeyApi.ts";
import * as ApiKeyClientRecords from "../src/ApiKeyClientRecords.ts";
import * as ApiKeyRecords from "../src/ApiKeyRecords.ts";

const ORIGIN = "http://localhost:3000";

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CSRF_SECRET = "api-key-test-csrf-secret-padded-to-thirty-two-bytes";
const CSRF_TOKEN = (() => {
  // `<iat>.<random>.<hmac(iat.random)>` (CDS-006).
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  return `${signed}.${createHmac("sha256", CSRF_SECRET).update(signed).digest("hex")}`;
})();

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

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
const ProbeApi = HttpApi.make("auth")
  .add(
    HttpApiGroup.make("probeMachine")
      .add(HttpApiEndpoint.get("whoAmI", "/probe/machine", { success: Schema.String }))
      .middleware(Api.MachineAuthentication),
  )
  .add(
    HttpApiGroup.make("probeUser")
      .add(HttpApiEndpoint.get("whoAmI", "/probe/user", { success: Schema.String }))
      .middleware(Api.Authentication),
  );

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

/** The api-key records, in memory or over a real database migrated with the plugin's own migrations. */
const recordsLayer = (options: HarnessOptions) => {
  if (options.store === "memory") {
    return Layer.mergeAll(ApiKeyRecords.layerMemory, ApiKeyClientRecords.layerMemory);
  }
  const SqlLive = TestSql.layer(options.suite ?? "api_key");
  const Migrated = Layer.effectDiscard(Migrations.run(ApiKey.ApiKey.migrations)).pipe(
    Layer.provide(SqlLive),
  );
  return Layer.mergeAll(ApiKeyRecords.layerSql, ApiKeyClientRecords.layerSql).pipe(
    Layer.provideMerge(SqlLive),
    Layer.provideMerge(Migrated),
  );
};

export const buildLayer = (options: HarnessOptions) =>
  Layer.mergeAll(AuthHttp.routes(ApiKeyApi.ApiKeyApi), AuthHttp.routes(ProbeApi))
    .pipe(
      Layer.provide(ProbeHandlers),
      Layer.provideMerge(ApiKey.ApiKey.layer),
      Layer.provideMerge(Jwt.Jwt.layer),
      // The registry must sit below every layer that contributes to it.
      Layer.provideMerge(Authentication.CredentialResolversLive),
      Layer.provideMerge(recordsLayer(options)),
      Layer.provideMerge(KeyRing.KeyRing.layer),
      Layer.provideMerge(SigningKeyRecords.layerMemory),
      Layer.provideMerge(RevocationStore.layerMemory),
      Layer.provideMerge(SqlTransaction.layerNoop),
      Layer.provideMerge(Authentication.AuthenticationLive),
      Layer.provideMerge(Authentication.MachineAuthenticationLive),
      Layer.provide(Authentication.PrincipalResolverLive),
      Layer.provide(CsrfProtectionLive),
    )
    .pipe(
      Layer.provideMerge(Sessions.layerMemory),
      Layer.provideMerge(Users.layerMemory),
      Layer.provideMerge(AuthEvents.layer),
      Layer.provideMerge(AuditLog.layerMemory),
      Layer.provideMerge(Hooks.HooksLive),
      Layer.provideMerge(RateLimits.layer),
      Layer.provideMerge(
        options.rateLimiter === "enforcing"
          ? RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory))
          : RateLimiter.layerPermissive,
      ),
      Layer.provideMerge(ClientAddress.layerDirect),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(TestServices),
      Layer.provideMerge(HttpRouter.layer),
      Layer.provideMerge(ApiKey.config(options.config ?? {})),
      Layer.provideMerge(
        JwtConfig.config({ issuer: "https://issuer.test", audience: "https://api.test" }),
      ),
    );

export type HarnessServices = Layer.Success<ReturnType<typeof buildLayer>>;

/** A running app: the real web handler, and a way to reach the very services it runs against. */
export const makeApp = (options: HarnessOptions) => {
  const layer = buildLayer(options);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(layer, { memoMap });
  const withContext = <A, E>(effect: Effect.Effect<A, E, HarnessServices>): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(layer, memoMap, scope);
          return yield* effect.pipe(Effect.provide(context));
        }),
      ),
    );

  /** A real session (cookie) for `userId`, against the same running `Sessions`. */
  const sessionCookie = (userId: string): Promise<string> =>
    withContext(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
        return `${Api.SESSION_COOKIE_NAME}=${encodeURIComponent(Redacted.value(issued.token))}`;
      }),
    );

  const request = (
    method: string,
    path: string,
    options?: {
      readonly cookie?: string;
      readonly headers?: Record<string, string>;
      readonly json?: unknown;
      readonly form?: Record<string, string>;
    },
  ) =>
    handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(options?.json === undefined ? {} : { "content-type": "application/json" }),
          ...(options?.form === undefined
            ? {}
            : { "content-type": "application/x-www-form-urlencoded" }),
          // Unsafe methods pass the double-submit CSRF check the way a browser client would.
          cookie: [options?.cookie, `${Api.CSRF_COOKIE_NAME}=${CSRF_TOKEN}`]
            .filter((part) => part !== undefined)
            .join("; "),
          [Api.CSRF_HEADER_NAME]: CSRF_TOKEN,
          ...options?.headers,
        },
        ...(options?.json === undefined ? {} : { body: JSON.stringify(options.json) }),
        ...(options?.form === undefined
          ? {}
          : { body: new URLSearchParams(options.form).toString() }),
      }),
    );

  return { handler, withContext, sessionCookie, request, layer };
};
