// BAM-005/BAM-009 (BEH-EA-225): the `admin.accounts` group over a real `HttpRouter` — real status
// codes, a real session cookie, the CSRF double-submit: deny-by-default 403, the erasure cascade
// behind DELETE, the 202 of a mailed email change, the 422 of a weak password.
import { Api } from "@awthaq/api";
import {
  Accounts,
  AuditLog,
  AuthEvents,
  Erasure,
  Hooks,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { Mailer, PasswordHasher, SqlTransaction } from "@awthaq/ports";
import { Authentication, AuthHttp, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as Admin from "../src/Admin.ts";
import * as AdminAccounts from "../src/AdminAccounts.ts";
import * as AdminAccountsApi from "../src/AdminAccountsApi.ts";

const CSRF_TEST_SECRET = "admin-accounts-http-csrf-secret-padded-to-thirty-two-bytes";

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make(CSRF_TEST_SECRET),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const CSRF_TEST_COOKIE_VALUE: string = (() => {
  const signed = `${Math.floor(Date.now() / 1000)}.${randomBytes(32).toString("hex")}`;
  const signature = createHmac("sha256", CSRF_TEST_SECRET).update(signed).digest("hex");
  return `${signed}.${signature}`;
})();

const TestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(NodeCrypto.layer),
);

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);
const AdminAuthenticationLive = Authentication.AdminAuthenticationLive.pipe(
  Layer.provide(AuthenticationLive),
);

const buildAppLayer = (config: Partial<Admin.AdminConfigShape>) =>
  AuthHttp.routes(AdminAccountsApi.AdminAccountsApi, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(AdminAccounts.AdminAccounts.layer),
    Layer.provide(Admin.config(config)),
    Layer.provide(AdminAuthenticationLive),
    Layer.provide(CsrfProtectionLive),
    Layer.provideMerge(Erasure.layer.pipe(Layer.provideMerge(CoreLive))),
    Layer.provideMerge(
      Layer.mergeAll(
        PasswordHasher.layerArgon2id,
        Mailer.layerMemory,
        SqlTransaction.layerNoop,
      ).pipe(Layer.provideMerge(NodeCrypto.layer)),
    ),
    Layer.provideMerge(TestServices),
    Layer.provideMerge(HttpRouter.layer),
  );

const allow = () => Effect.succeed(true);

const buildHandler = (config: Partial<Admin.AdminConfigShape>) => {
  const AppLayer = buildAppLayer(config);
  const memoMap = Layer.makeMemoMapUnsafe();
  const { handler } = HttpRouter.toWebHandler(AppLayer, { memoMap });

  /** Runs `program` against the same running services the handler uses (shared via `memoMap`). */
  const inApp = <A, E>(
    program: Effect.Effect<
      A,
      E,
      Users.Users | Sessions.Sessions | Accounts.Accounts | Mailer.Mailer
    >,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const context = yield* Layer.buildWithMemoMap(AppLayer, memoMap, scope);
          return yield* program.pipe(Effect.provide(context));
        }),
      ),
    );

  const seedUser = (name: string) =>
    inApp(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const created = yield* users.create({
          identity: { _tag: "Email", email: `${name}@example.com` },
          name,
        });
        return created.id;
      }),
    );

  const cookieFor = (userId: string) =>
    inApp(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
        return `__Host-session=${encodeURIComponent(Redacted.value(issued.token))}`;
      }),
    );

  const call = (method: "POST" | "DELETE", path: string, cookie: string, body?: unknown) =>
    handler(
      new Request(`http://localhost:3000${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          cookie: `${cookie}; ${Api.CSRF_COOKIE_NAME}=${CSRF_TEST_COOKIE_VALUE}`,
          "x-csrf-token": CSRF_TEST_COOKIE_VALUE,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  return { inApp, seedUser, cookieFor, call };
};

describe("AdminAccounts (real HTTP)", () => {
  it.effect("is fail-closed: every endpoint answers 403 until its predicate says yes", () =>
    Effect.gen(function* () {
      const app = buildHandler({});
      const adminId = yield* Effect.promise(() => app.seedUser("admin"));
      const targetId = yield* Effect.promise(() => app.seedUser("target"));
      const cookie = yield* Effect.promise(() => app.cookieFor(adminId));
      const statuses = yield* Effect.promise(() =>
        Promise.all([
          app.call("DELETE", `/admin/users/${targetId}`, cookie),
          app.call("POST", `/admin/users/${targetId}/email`, cookie, { email: "new@example.com" }),
          app.call("POST", `/admin/users/${targetId}/password`, cookie, {
            password: "a brand new strong password",
          }),
        ]).then((responses) => responses.map((response) => response.status)),
      );
      assert.deepStrictEqual(statuses, [403, 403, 403]);
    }),
  );

  it.effect("DELETE erases the user through the cascade and answers 204", () =>
    Effect.gen(function* () {
      const app = buildHandler({ canDeleteUsers: allow });
      const adminId = yield* Effect.promise(() => app.seedUser("admin"));
      const targetId = yield* Effect.promise(() => app.seedUser("target"));
      const cookie = yield* Effect.promise(() => app.cookieFor(adminId));

      const self = yield* Effect.promise(() =>
        app.call("DELETE", `/admin/users/${adminId}`, cookie),
      );
      assert.strictEqual(self.status, 400);
      const response = yield* Effect.promise(() =>
        app.call("DELETE", `/admin/users/${targetId}`, cookie),
      );
      assert.strictEqual(response.status, 204);
      const gone = yield* Effect.promise(() =>
        app.inApp(
          Effect.gen(function* () {
            const users = yield* Users.Users;
            return yield* users.findById(Users.UserId(targetId)).pipe(Effect.option);
          }),
        ),
      );
      assert.isTrue(Option.isNone(gone));
      const again = yield* Effect.promise(() =>
        app.call("DELETE", `/admin/users/${targetId}`, cookie),
      );
      assert.strictEqual(again.status, 404);
    }),
  );

  it.effect(
    "setUserEmail answers 202 and mails the new address; setUserPassword answers 204 or 422",
    () =>
      Effect.gen(function* () {
        const app = buildHandler({ canManageCredentials: allow });
        const adminId = yield* Effect.promise(() => app.seedUser("admin"));
        const targetId = yield* Effect.promise(() => app.seedUser("target"));
        const cookie = yield* Effect.promise(() => app.cookieFor(adminId));

        const email = yield* Effect.promise(() =>
          app.call("POST", `/admin/users/${targetId}/email`, cookie, { email: "new@example.com" }),
        );
        assert.strictEqual(email.status, 202);
        const sent = yield* Effect.promise(() =>
          app.inApp(Mailer.Mailer.use((mailer) => mailer.sent)),
        );
        assert.deepStrictEqual(
          sent.map((mail) => [mail.template, mail.to]),
          [["change-email", "new@example.com"]],
        );

        const weak = yield* Effect.promise(() =>
          app.call("POST", `/admin/users/${targetId}/password`, cookie, { password: "short" }),
        );
        assert.strictEqual(weak.status, 422);
        const changed = yield* Effect.promise(() =>
          app.call("POST", `/admin/users/${targetId}/password`, cookie, {
            password: "a brand new strong password",
          }),
        );
        assert.strictEqual(changed.status, 204);
      }),
  );
});
