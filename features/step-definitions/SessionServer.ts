// BEH-EA-227/228/318 (26-cli.feature): a REAL auth server for the session commands — core's `session`
// group and the real `@awthaq/device-authorization` plugin, served by the real handlers behind real bearer
// authentication and CSRF over in-memory `Users`/`Sessions`, on a real Node HTTP socket. `login` and `whoami`
// speak to it exactly as they speak to a deployed server (the generated `HttpApiClient`), so what a scenario
// proves is the wire. Mirrors `packages/cli/test/support/TestServer.ts`, which is not exported.
//
// Every request line (`POST /device/token`) is recorded, so a Then can say what the CLI did and did not
// contact. The server runs in the caller's scope: build it inside a step and it closes with the scenario.
import { AuthCore } from "@awthaq/api";
import {
  Accounts,
  DataExport,
  Erasure,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import {
  DeviceAuthorization,
  DeviceAuthorizationApi,
  DeviceClientRecords,
  DeviceGrantRecords,
} from "@awthaq/device-authorization";
import { ClientAddress, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Account, Authentication, AuthHttp, Csrf, Session } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as http from "node:http";

const Base = Layer.mergeAll(Erasure.layer, DataExport.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SqlTransaction.layerNoop,
      RateLimiter.layerPermissive,
      Sessions.layerMemory,
      Users.layerMemory,
      Accounts.layerMemory,
      Verification.layerMemory,
    ),
  ),
  Layer.provideMerge(TestAuth.memoryFoundation),
);

const Middleware = Layer.mergeAll(
  Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  Authentication.OptionalAuthenticationLive.pipe(
    Layer.provide(Authentication.PrincipalResolverLive),
  ),
  Csrf.CsrfProtectionLive.pipe(
    Layer.provide(
      Layer.succeed(Csrf.CsrfConfig, {
        secret: Redacted.make("features-cli-session-csrf-secret-0123456789"),
        allowedOrigins: [],
      }),
    ),
  ),
);

const Services = DeviceAuthorization.DeviceAuthorization.layer.pipe(
  Layer.provideMerge(DeviceAuthorization.DeviceAuthorizationHooksLive),
  Layer.provideMerge(
    Layer.mergeAll(DeviceGrantRecords.layerMemory, DeviceClientRecords.layerMemory),
  ),
  Layer.provideMerge(RateLimits.layer),
  Layer.provideMerge(ClientAddress.layerDirect),
  Layer.provideMerge(DeviceAuthorization.config({ verificationUri: "https://app.test/device" })),
  Layer.provideMerge(Middleware.pipe(Layer.provideMerge(Base))),
);

export interface SessionServer {
  readonly baseUrl: string;
  /** A fresh user with one live session; `token` is what `AWTHAQ_TOKEN` / `login --token` carries. */
  readonly issue: (
    email: string,
  ) => Effect.Effect<{ readonly userId: Users.UserId; readonly token: string }>;
  /** The person on the second device: opens the verification page for `userCode` (which claims it) and decides. */
  readonly decide: (
    userCode: string,
    email: string,
    decision: "approve" | "deny",
  ) => Effect.Effect<void>;
  /** Every request the server has answered, as `METHOD /path`, oldest first. */
  readonly requests: Effect.Effect<ReadonlyArray<string>>;
}

/** Starts the server in the caller's scope; `device: false` leaves the device routes out (a server without the plugin). */
export const startSessionServer = (options?: { readonly device?: boolean }) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(Services);
    const context = Layer.succeedContext(services);
    const sessions = yield* Sessions.Sessions.pipe(Effect.provide(context));
    const users = yield* Users.Users.pipe(Effect.provide(context));
    const plugin = yield* DeviceAuthorization.DeviceAuthorization.pipe(Effect.provide(context));
    const requests = yield* Ref.make<ReadonlyArray<string>>([]);

    const serverContext = yield* Layer.build(
      NodeHttpServer.layer(() => http.createServer(), { port: 0, host: "127.0.0.1" }),
    );
    const core = AuthHttp.routes(AuthCore.AuthCoreApi).pipe(
      Layer.provide(Session.SessionHandlers),
      Layer.provide(Account.AccountHandlers),
    );
    const device = AuthHttp.routes(DeviceAuthorizationApi.DeviceAuthorizationApi);
    const routes = Layer.mergeAll(core, options?.device === false ? Layer.empty : device).pipe(
      Layer.provide(context),
    );
    yield* Layer.build(
      HttpRouter.serve(routes, {
        disableLogger: true,
        disableListenLog: true,
        middleware: (app) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            yield* Ref.update(requests, (all) => [...all, `${request.method} ${request.url}`]);
            return yield* app;
          }),
      }).pipe(Layer.provide(Layer.succeedContext(serverContext))),
    );
    const server = Context.get(serverContext, HttpServer.HttpServer);
    if (!NetAddress.isInetAddress(server.address)) {
      return yield* Effect.die("the session server did not bind a TCP port");
    }

    const issue: SessionServer["issue"] = (email) =>
      Effect.gen(function* () {
        const user = yield* users.create({ identity: { _tag: "Email", email }, name: "Scenario" });
        const issued = yield* sessions.issue({ userId: user.id });
        return { userId: user.id, token: Redacted.value(issued.token) };
      }).pipe(Effect.orDie);

    const decide: SessionServer["decide"] = (userCode, email, decision) =>
      Effect.gen(function* () {
        const user = yield* users.create({ identity: { _tag: "Email", email }, name: "Approver" });
        const issued = yield* sessions.issue({ userId: user.id, amr: ["pwd"] });
        const caller = {
          userId: user.id,
          sessionId: issued.session.id,
          impersonated: false,
          amr: ["pwd" as const],
        };
        const source = { userCode, ip: "198.51.100.20" };
        yield* plugin.verify(source, Option.some(caller));
        yield* decision === "approve"
          ? plugin.approve(source, caller)
          : plugin.deny(source, caller);
      }).pipe(Effect.orDie, Effect.asVoid);

    const started: SessionServer = {
      baseUrl: `http://127.0.0.1:${server.address.port}`,
      issue,
      decide,
      requests: Ref.get(requests),
    };
    return started;
  });
