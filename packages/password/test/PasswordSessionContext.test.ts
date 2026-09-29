// CSD-003: the request's ip and user agent land on every session the password plugin mints.
import { Sessions } from "@awthaq/core";
import { ClientAddress, Mailer } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import { email, letForkedFibersRun, makeTestLayer, strongPassword, tokenOf } from "./harness.ts";

const request = { ip: "203.0.113.9", userAgent: "Mozilla/5.0 (TestBrowser)" };

describe("session issuance context", () => {
  it.effect("signUp, signIn and changePassword record ip and userAgent on the session", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const sessions = yield* Sessions.Sessions;
      const mailer = yield* Mailer.Mailer;

      const signedUp = yield* password.signUp({ email, password: strongPassword, ...request });
      assert.deepStrictEqual(signedUp.session.ipAddress, Option.some(request.ip));
      assert.deepStrictEqual(signedUp.session.userAgent, Option.some(request.userAgent));

      yield* letForkedFibersRun;
      const verifyMail = (yield* mailer.sent).find((m) => m.template === "verify-email");
      yield* password.verifyEmail({ token: Redacted.make(tokenOf(verifyMail)) });

      const signedIn = yield* password.signIn({ email, password: strongPassword, ...request });
      const viewed = yield* sessions.verify(signedIn.token);
      assert.deepStrictEqual(viewed.session.ipAddress, Option.some(request.ip));
      assert.deepStrictEqual(viewed.session.userAgent, Option.some(request.userAgent));

      const changed = yield* password.changePassword({
        userId: signedIn.session.userId,
        currentSessionId: signedIn.session.id,
        currentPassword: strongPassword,
        newPassword: Redacted.make("a brand new strong password"),
        ...request,
      });
      assert.deepStrictEqual(changed.session.userAgent, Option.some(request.userAgent));
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("without request metadata the session records none", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const signedUp = yield* password.signUp({ email, password: strongPassword });
      assert.isTrue(Option.isNone(signedUp.session.ipAddress));
      assert.isTrue(Option.isNone(signedUp.session.userAgent));
    }).pipe(Effect.provide(makeTestLayer())),
  );
});

describe("ClientAddress request helpers", () => {
  it("bounds an over-long user agent and omits empty ones", () => {
    const long = "x".repeat(ClientAddress.MAX_USER_AGENT_LENGTH + 100);
    assert.strictEqual(
      ClientAddress.sessionRequest("1.2.3.4", long).userAgent?.length,
      ClientAddress.MAX_USER_AGENT_LENGTH,
    );
    assert.deepStrictEqual(ClientAddress.sessionRequest(undefined, undefined), {});
    assert.deepStrictEqual(ClientAddress.sessionRequest("1.2.3.4", ""), { ip: "1.2.3.4" });
  });
});
