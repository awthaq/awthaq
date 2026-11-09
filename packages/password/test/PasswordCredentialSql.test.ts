// Plan 27: what only a real transaction proves about the password credential. Over SQLite here
// (`:memory:`), and over a per-suite Postgres schema under `pnpm test:pg` (`scripts/test-pg.sh`).
import { Accounts, Auth, Errors, Sessions, Users } from "@awthaq/core";
import { SqlTransaction } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import * as PasswordCredential from "../src/PasswordCredential.ts";
import { NoBreachHttpClient } from "./harness.ts";

const email = "ada@example.com";
const oldPassword = Redacted.make("correct horse battery staple");
const newPassword = Redacted.make("a whole new strong password");

/** `Sessions.issue` fails once while `failNextIssue` is set (then clears it). */
const issueFailsOnce = (switches: { failNextIssue: boolean }) =>
  Layer.effect(
    Sessions.Sessions,
    Effect.map(Sessions.Sessions, (real) =>
      Sessions.Sessions.of({
        ...real,
        issue: (input) => {
          if (!switches.failNextIssue) return real.issue(input);
          switches.failNextIssue = false;
          return Effect.fail(new Errors.StoreUnavailable({ operation: "Sessions.issue" }));
        },
      }),
    ),
  );

const sqlLayer = (switches: { failNextIssue: boolean }) =>
  TestAuth.layer(Auth.make([Password.Password]), {
    records: "sql",
    suite: "password_credential",
    services: Layer.mergeAll(
      NoBreachHttpClient,
      Password.config({ requireVerifiedEmail: false, signInTimingFloor: "off" }),
    ),
    decorate: issueFailsOnce(switches),
  });

describe("changePassword is one unit of work (plan 27, BEH-EA-053)", () => {
  it.live(
    "S3: a changePassword that fails after the hash write keeps the old password and every other session",
    () => {
      const switches = { failNextIssue: false };
      return Effect.gen(function* () {
        const password = yield* Password.Password;
        const sessions = yield* Sessions.Sessions;
        const current = yield* password.signUp({ email, password: oldPassword });
        const others = [
          yield* password.signIn({ email, password: oldPassword }),
          yield* password.signIn({ email, password: oldPassword }),
        ];
        const userId: Users.UserId = current.session.userId;

        switches.failNextIssue = true;
        const failure = yield* password
          .changePassword({
            userId,
            currentSessionId: current.session.id,
            currentPassword: oldPassword,
            newPassword,
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");

        // The hash write and the revocation rolled back with the failed rotation.
        yield* password.signIn({ email, password: oldPassword });
        const wrong = yield* password.signIn({ email, password: newPassword }).pipe(Effect.flip);
        assert.strictEqual(wrong._tag, "InvalidCredentials");
        for (const other of [current, ...others]) {
          assert.isTrue(yield* sessions.isLive(userId, other.session.id), "a session was revoked");
        }
      }).pipe(TestAuth.withoutRequest, Effect.provide(sqlLayer(switches)));
    },
  );
});

class RolledBack extends Data.TaggedError("RolledBack")<{}> {}

/** A user with no password credential. */
const credentialLess = Effect.flatMap(Users.Users, (users) =>
  users.create({ identity: { _tag: "Email", email }, name: "Ada" }),
);

const passwordAccounts = (userId: Users.UserId) =>
  Effect.flatMap(Accounts.Accounts, (accounts) => accounts.listByUser(userId)).pipe(
    Effect.map((all) => all.filter((a) => a.providerId === Accounts.PASSWORD_PROVIDER_ID)),
  );

describe("PasswordCredential writes over a real store (plan 27)", () => {
  it.live(
    "S1: two concurrent sets for a user with no password credential leave one password account, holding one of the two hashes",
    () =>
      Effect.gen(function* () {
        const credential = yield* PasswordCredential.PasswordCredential;
        const user = yield* credentialLess;
        const first = Redacted.make("the first strong password");
        const second = Redacted.make("the second strong password");
        const a = yield* credential.accept(first);
        const b = yield* credential.accept(second);
        yield* Effect.all([credential.set(user.id, a), credential.set(user.id, b)], {
          concurrency: 2,
        });

        assert.strictEqual((yield* passwordAccounts(user.id)).length, 1);
        const verdicts = yield* Effect.all(
          [first, second].map((candidate) =>
            credential.verify(Effect.succeedSome({ id: user.id }), candidate),
          ),
        );
        assert.strictEqual(verdicts.filter((verdict) => verdict._tag === "Verified").length, 1);
      }).pipe(TestAuth.withoutRequest, Effect.provide(sqlLayer({ failNextIssue: false }))),
  );

  it.live("S2: replace inside a unit that rolls back leaves the old hash", () =>
    Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const transaction = yield* SqlTransaction.SqlTransaction;
      const user = yield* credentialLess;
      yield* credential.set(user.id, yield* credential.accept(oldPassword));
      const replacement = yield* credential.accept(newPassword);

      const failure = yield* transaction
        .withTransaction(
          Effect.gen(function* () {
            assert.isTrue(yield* credential.replace(user.id, replacement));
            return yield* Effect.fail(new RolledBack());
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "RolledBack");

      const old = yield* credential.verify(Effect.succeedSome({ id: user.id }), oldPassword);
      assert.strictEqual(old._tag, "Verified");
      const replaced = yield* credential.verify(Effect.succeedSome({ id: user.id }), newPassword);
      assert.strictEqual(replaced._tag, "Refused");
    }).pipe(TestAuth.withoutRequest, Effect.provide(sqlLayer({ failNextIssue: false }))),
  );
});
