// BAM-005/BAM-009 (BEH-EA-225): the `admin.accounts` group over a real `HttpRouter` — real status
// codes, a real session cookie, the CSRF double-submit: deny-by-default 403, the erasure cascade
// behind DELETE, the 202 of a mailed email change, the 422 of a weak password.
import { Accounts, Auth, Sessions, Users } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Admin from "../src/Admin.ts";
import * as AdminAccounts from "../src/AdminAccounts.ts";

const built = Auth.make([Admin.Admin, AdminAccounts.AdminAccounts]);

const allow = () => Effect.succeed(true);

const buildHandler = (config: Partial<Admin.AdminConfigShape>) => {
  const app = TestAuth.app(
    TestAuth.layer(built, { services: Admin.config(config), openapiPath: "/openapi.json" }),
  );

  /** Runs `program` against the same running services the handler uses. */
  const inApp = <A, E>(
    program: Effect.Effect<
      A,
      E,
      Users.Users | Sessions.Sessions | Accounts.Accounts | Mailer.Mailer
    >,
  ): Promise<A> => app.run(program);

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

  /** The CSRF double-submit pair a browser would send comes with `TestAuth.app`'s `request`. */
  const call = (method: "POST" | "DELETE", path: string, cookie: string, body?: unknown) =>
    app.request(method, path, { cookie, ...(body === undefined ? {} : { json: body }) });

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
