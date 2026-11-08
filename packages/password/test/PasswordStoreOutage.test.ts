// ADR-EA-028: a store outage on the password credential path is a typed `StoreUnavailable` (503),
// never a defect: sign-in, change-password, reauthenticate and confirm-reset alike.
import { Accounts, Auth, Errors } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import {
  email,
  letForkedFibersRun,
  makeTestLayer,
  NoBreachHttpClient,
  strongPassword,
  tokenOf,
} from "./harness.ts";

interface Outage {
  /** `Accounts.findCredentialHash` reports an outage. */
  read: boolean;
  /** `Accounts.updateCredentialHash` reports an outage. */
  write: boolean;
}

const healthy = (): Outage => ({ read: false, write: false });

/** The real `Accounts`, except that reading or writing the credential hash reports an outage while `down` says so. */
const accountsDownWhen = (down: Outage) =>
  Layer.effect(
    Accounts.Accounts,
    Effect.gen(function* () {
      const real = yield* Accounts.Accounts;
      return Accounts.Accounts.of({
        ...real,
        findCredentialHash: (accountId) =>
          down.read
            ? Effect.fail(new Errors.StoreUnavailable({ operation: "Accounts.findCredentialHash" }))
            : real.findCredentialHash(accountId),
        updateCredentialHash: (accountId, hash) =>
          down.write
            ? Effect.fail(
                new Errors.StoreUnavailable({ operation: "Accounts.updateCredentialHash" }),
              )
            : real.updateCredentialHash(accountId, hash),
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

const signedIn = Effect.gen(function* () {
  const password = yield* registered;
  const issued = yield* password.signIn({ email, password: strongPassword });
  return { password, userId: issued.session.userId, currentSessionId: issued.session.id };
});

const newPassword = Redacted.make("a whole new strong password");

describe("ADR-EA-028: password sign-in during a store outage", () => {
  it.effect("ADR-EA-028: Accounts.findCredentialHash outage is StoreUnavailable", () => {
    const down = healthy();
    return Effect.gen(function* () {
      const password = yield* registered;
      down.read = true;
      const failure = yield* password.signIn({ email, password: strongPassword }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(makeTestLayer({ coreOverride: accountsDownWhen(down) })),
    );
  });
});

describe("ADR-EA-028: the authenticated credential endpoints during a store outage", () => {
  it.effect("changePassword during a credential-read outage is StoreUnavailable", () => {
    const down = healthy();
    return Effect.gen(function* () {
      const { password, userId, currentSessionId } = yield* signedIn;
      down.read = true;
      const failure = yield* password
        .changePassword({ userId, currentSessionId, currentPassword: strongPassword, newPassword })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(makeTestLayer({ coreOverride: accountsDownWhen(down) })),
    );
  });

  it.effect("changePassword during a credential-write outage is StoreUnavailable", () => {
    const down = healthy();
    return Effect.gen(function* () {
      const { password, userId, currentSessionId } = yield* signedIn;
      down.write = true;
      const failure = yield* password
        .changePassword({ userId, currentSessionId, currentPassword: strongPassword, newPassword })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(makeTestLayer({ coreOverride: accountsDownWhen(down) })),
    );
  });

  it.effect("reauthenticate during a credential-read outage is StoreUnavailable", () => {
    const down = healthy();
    return Effect.gen(function* () {
      const { password, userId, currentSessionId } = yield* signedIn;
      down.read = true;
      const failure = yield* password
        .reauthenticate({ userId, currentSessionId, currentPassword: strongPassword })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "StoreUnavailable");
    }).pipe(
      TestAuth.withoutRequest,
      Effect.provide(makeTestLayer({ coreOverride: accountsDownWhen(down) })),
    );
  });
});

// Over a real database (SQLite here, Postgres under `test:pg`): the reset's transaction rolls the
// token's consumption back with the failed write, so the same link works once the store is back.
const sqlLayer = (down: Outage) =>
  TestAuth.layer(Auth.make([Password.Password]), {
    records: "sql",
    suite: "password_store_outage",
    services: Layer.mergeAll(NoBreachHttpClient, Password.config({})),
    decorate: accountsDownWhen(down),
  });

/** The token of the last `template` mail, once the dispatched mail work (real I/O over Postgres) has sent it. */
const mailedToken = (template: string) =>
  Effect.gen(function* () {
    const mailer = yield* Mailer.Mailer;
    for (let attempt = 0; attempt < 200; attempt++) {
      const mail = (yield* mailer.sent).findLast((m) => m.template === template);
      if (mail !== undefined) return Redacted.make(tokenOf(mail));
      yield* Effect.sleep(Duration.millis(10));
    }
    return assert.fail(`no ${template} mail was sent`);
  });

describe("ADR-EA-028: confirmReset during a store outage", () => {
  it.live(
    "confirmReset during a credential-write outage is StoreUnavailable and the token is not spent",
    () => {
      const down = healthy();
      return Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });
        yield* password.requestReset({ email });
        const token = yield* mailedToken("reset-password");

        down.write = true;
        const failure = yield* password
          .confirmReset({ token, password: newPassword })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "StoreUnavailable");

        // Were the token spent by the failed attempt this would be TokenConsumed.
        down.write = false;
        yield* password.confirmReset({ token, password: newPassword });
        yield* password.signIn({ email, password: newPassword });
      }).pipe(TestAuth.withoutRequest, Effect.provide(sqlLayer(down)));
    },
  );
});
