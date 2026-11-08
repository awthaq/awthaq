// Plan 27: what only a real transaction proves about the password credential. Over SQLite here
// (`:memory:`), and over a per-suite Postgres schema under `pnpm test:pg` (`scripts/test-pg.sh`).
import { Auth, Errors, Sessions, Users } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
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
