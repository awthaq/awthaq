// ADR-EA-028: a store outage during sign-in is a typed `StoreUnavailable` (503), never a defect.
import { Accounts, Errors, Sessions } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import { email, letForkedFibersRun, makeTestLayer, strongPassword, tokenOf } from "./harness.ts";

/** The real in-memory `Sessions`, except that `issue` reports an outage once `down.value` is set. */
const sessionsDownWhen = (down: { value: boolean }) =>
  Layer.effect(
    Sessions.Sessions,
    Effect.gen(function* () {
      const real = yield* Sessions.Sessions;
      return Sessions.Sessions.of({
        ...real,
        issue: (input) =>
          down.value
            ? Effect.fail(new Errors.StoreUnavailable({ operation: "Sessions.issue" }))
            : real.issue(input),
      });
    }),
  );

/** The real in-memory `Accounts`, except that reading the credential hash reports an outage once `down.value` is set. */
const accountsDownWhen = (down: { value: boolean }) =>
  Layer.effect(
    Accounts.Accounts,
    Effect.gen(function* () {
      const real = yield* Accounts.Accounts;
      return Accounts.Accounts.of({
        ...real,
        findCredentialHash: (accountId) =>
          down.value
            ? Effect.fail(new Errors.StoreUnavailable({ operation: "Accounts.findCredentialHash" }))
            : real.findCredentialHash(accountId),
      });
    }),
  );

const registered = Effect.gen(function* () {
  const password = yield* Password.Password;
  const mailer = yield* Mailer.Mailer;
  yield* password.signUp({ email, password: strongPassword });
  yield* letForkedFibersRun;
  const verifyMail = (yield* mailer.sent).find((m) => m.template === "verify-email");
  yield* password.verifyEmail({ token: Redacted.make(tokenOf(verifyMail)) });
  return password;
});

describe("ADR-EA-028: password sign-in during a store outage", () => {
  it.effect("ADR-EA-028: Sessions.issue outage is StoreUnavailable", () => {
    const down = { value: false };
    return Effect.gen(function* () {
      const password = yield* registered;
      down.value = true;
      const failure = yield* password.signIn({ email, password: strongPassword }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
    }).pipe(Effect.provide(makeTestLayer({ coreOverride: sessionsDownWhen(down) })));
  });

  it.effect("ADR-EA-028: Accounts.findCredentialHash outage is StoreUnavailable", () => {
    const down = { value: false };
    return Effect.gen(function* () {
      const password = yield* registered;
      down.value = true;
      const failure = yield* password.signIn({ email, password: strongPassword }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
    }).pipe(Effect.provide(makeTestLayer({ coreOverride: accountsDownWhen(down) })));
  });
});
