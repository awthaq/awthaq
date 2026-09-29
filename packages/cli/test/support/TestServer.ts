// A REAL auth server for the session commands: core's own `session` and `account` groups
// (`AuthCore.AuthCoreApi`) served by the real handlers, real `Authentication` middleware and real CSRF
// protection over in-memory `Users`/`Sessions`, on a real Node HTTP socket. `whoami` and `login`
// speak to it exactly as they speak to a deployed server — through the generated `HttpApiClient`
// with `Authorization: Bearer` — so what the suite proves is the wire, not a stub.
import { AuthCore } from "@awthaq/api";
import {
  Accounts,
  AuditLog,
  AuthEvents,
  DataExport,
  Erasure,
  Hooks,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Account, Authentication, AuthHttp, Csrf, Session } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as NetAddress from "effect/unstable/net/NetAddress";

// The `account` group's handlers call core's erasure and export (CSG-001/CSG-005), over these stores.
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
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const Middleware = Layer.mergeAll(
  Authentication.AuthenticationLive.pipe(Layer.provide(Authentication.PrincipalResolverLive)),
  Csrf.CsrfProtectionLive.pipe(
    Layer.provide(
      Layer.succeed(Csrf.CsrfConfig, {
        secret: Redacted.make("cli-session-suite-csrf-secret-0123456789"),
        allowedOrigins: [],
      }),
    ),
  ),
);

const Services = Middleware.pipe(Layer.provideMerge(Base));

/**
 * Starts the server (in the caller's scope — provide `NodeHttpServer.layerTest` around the whole
 * test, as the body-limit suite does, or the socket closes with the layer) and returns its base URL
 * plus a way to mint a real session token.
 */
export const serveAuth = Effect.gen(function* () {
  const services = yield* Layer.build(Services);
  const sessions = yield* Sessions.Sessions.pipe(Effect.provide(Layer.succeedContext(services)));
  const users = yield* Users.Users.pipe(Effect.provide(Layer.succeedContext(services)));
  yield* AuthHttp.routes(AuthCore.AuthCoreApi).pipe(
    Layer.provide(Session.SessionHandlers),
    Layer.provide(Account.AccountHandlers),
    Layer.provide(Layer.succeedContext(services)),
    HttpRouter.serve,
    Layer.build,
  );
  const server = yield* HttpServer.HttpServer;
  if (!NetAddress.isInetAddress(server.address)) {
    return yield* Effect.die("the test server did not bind a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${server.address.port}`;
  /** A fresh user with one live session; the returned token is what `AWTHAQ_TOKEN` / `login --token` carries. */
  const issue = (email: string) =>
    Effect.gen(function* () {
      const user = yield* users
        .create({ identity: { _tag: "Email", email }, name: "Test" })
        .pipe(Effect.orDie);
      const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
      return { userId: user.id, sessionId: issued.session.id, token: Redacted.value(issued.token) };
    });
  /** Revokes every session of the user server-side, as an admin or another device would. */
  const revokeAll = (userId: Users.UserId) => sessions.revokeAll(userId, "userRevoked");
  return { baseUrl, issue, revokeAll };
});
