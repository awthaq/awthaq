// An authenticated user with no password credential at all (an OAuth-only account) calling the
// two password-gated session endpoints. Both run the real hasher against a dummy hash so a caller
// cannot tell "no password set" from "wrong password" by timing (TSS-006), and both answer
// WrongPassword. These paths hold the uniform-cost fallbacks (`onNone` account lookup and the
// `dummyHash` default) that no other test reaches.
import { Accounts, Sessions, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import { makeTestLayer } from "./harness.ts";

const TestLayer = makeTestLayer();

const oauthOnlyUser = Effect.gen(function* () {
  const users = yield* Users.Users;
  const accounts = yield* Accounts.Accounts;
  const user = yield* users.create({
    identity: { _tag: "Email", email: "oauth-only@example.com" },
    name: "Oauth Only",
  });
  yield* accounts.link({ userId: user.id, providerId: "github", subject: "gh-no-password" });
  return user;
});

describe("password-gated endpoints for a user with no password credential", () => {
  it.effect("changePassword answers WrongPassword and changes nothing", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const user = yield* oauthOnlyUser;
      const failure = yield* password
        .changePassword({
          userId: user.id,
          currentSessionId: Sessions.SessionId("no-such-session"),
          currentPassword: Redacted.make("whatever password"),
          newPassword: Redacted.make("a whole new strong password"),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WrongPassword");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reauthenticate answers WrongPassword", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const user = yield* oauthOnlyUser;
      const failure = yield* password
        .reauthenticate({
          userId: user.id,
          currentSessionId: Sessions.SessionId("no-such-session"),
          currentPassword: Redacted.make("whatever password"),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WrongPassword");
    }).pipe(Effect.provide(TestLayer)),
  );
});
