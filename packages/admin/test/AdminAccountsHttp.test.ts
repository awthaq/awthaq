// BAM-005/BAM-009 (BEH-EA-225): the `admin.accounts` group over a real `HttpRouter` — real status
// codes, a real session cookie, the CSRF double-submit: deny-by-default 403, the erasure cascade
// behind DELETE, the 202 of a mailed email change, the 422 of a weak password.
import { Accounts, Auth, Sessions, Users } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { TestAuth, type UserAgent } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

  /** A browser holding a fresh session of `userId` (the `Set-Cookie` the server would have answered). */
  const signInAs = async (userId: string) => {
    const setCookie = await inApp(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        const issued = yield* sessions.issue({ userId: Users.UserId(userId) });
        return yield* TestAuth.sessionSetCookie(issued);
      }),
    );
    const browser = await app.agent();
    browser.cookies.receive(setCookie);
    return browser;
  };

  /** The browser sends its cookies and echoes its CSRF cookie itself. */
  const call = (
    method: "POST" | "DELETE",
    path: string,
    browser: UserAgent.UserAgent,
    body?: unknown,
  ) => browser.request(method, path, body === undefined ? {} : { json: body });

  return { inApp, seedUser, signInAs, call };
};

describe("AdminAccounts (real HTTP)", () => {
  it.effect("is fail-closed: every endpoint answers 403 until its predicate says yes", () =>
    Effect.gen(function* () {
      const app = buildHandler({});
      const adminId = yield* Effect.promise(() => app.seedUser("admin"));
      const targetId = yield* Effect.promise(() => app.seedUser("target"));
      const admin = yield* Effect.promise(() => app.signInAs(adminId));
      const statuses = yield* Effect.promise(() =>
        Promise.all([
          app.call("DELETE", `/admin/users/${targetId}`, admin),
          app.call("POST", `/admin/users/${targetId}/email`, admin, { email: "new@example.com" }),
          app.call("POST", `/admin/users/${targetId}/password`, admin, {
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
      const admin = yield* Effect.promise(() => app.signInAs(adminId));

      const self = yield* Effect.promise(() =>
        app.call("DELETE", `/admin/users/${adminId}`, admin),
      );
      assert.strictEqual(self.status, 400);
      const response = yield* Effect.promise(() =>
        app.call("DELETE", `/admin/users/${targetId}`, admin),
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
        app.call("DELETE", `/admin/users/${targetId}`, admin),
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
        const admin = yield* Effect.promise(() => app.signInAs(adminId));

        const email = yield* Effect.promise(() =>
          app.call("POST", `/admin/users/${targetId}/email`, admin, { email: "new@example.com" }),
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
          app.call("POST", `/admin/users/${targetId}/password`, admin, { password: "short" }),
        );
        assert.strictEqual(weak.status, 422);
        const changed = yield* Effect.promise(() =>
          app.call("POST", `/admin/users/${targetId}/password`, admin, {
            password: "a brand new strong password",
          }),
        );
        assert.strictEqual(changed.status, 204);
      }),
  );
});
