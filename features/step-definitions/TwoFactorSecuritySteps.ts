// BCR-010/P20a: step definitions for 14-mfa-passwordless/31-two-factor.feature, BEH-EA-263's
// secret-at-rest half and BEH-EA-264..266 (recovery codes, the replay guard, the failure budget and
// the audit trail), over `TwoFactorWorld`'s composition.
import { AuditLog, DataExport, Erasure, Users } from "@awthaq/core";
import { Encryption, PasswordHasher } from "@awthaq/ports";
import { SecondFactor, TwoFactor, TwoFactorStore } from "@awthaq/two-factor";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  auditRows,
  currentCode,
  direct,
  directExit,
  divertedChallenge,
  failureOf,
  failureTag,
  freshChallenge,
  getPerson,
  openSqlRecoveryCodes,
  requireSecret,
  sqlExit,
  type TwoFactorServices,
  updatePerson,
  verifyRecoveryWith,
  verifyWith,
  World,
} from "./TwoFactorWorld.ts";
import { answer, current, field, setAnswer, successValue, textOf } from "./TwoFactorSupport.ts";

const CODE_SHAPE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;

export const twoFactorSecuritySteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-263: the secret at rest -------------------------------------------------------

  const envelopeOf = (name: string) =>
    Effect.gen(function* () {
      const person = yield* getPerson(name);
      const row = yield* direct(
        Effect.flatMap(TwoFactorStore.TwoFactorSecrets, (secrets) => secrets.find(person.userId)),
      );
      assert.ok(Option.isSome(row), `no secret row for "${name}"`);
      return row.value;
    });

  Then(
    "the stored secret row of {string} does not contain her base32 secret",
    function* (name: string) {
      const row = yield* envelopeOf(name);
      assert.ok(!textOf(row).includes(requireSecret(yield* getPerson(name))));
    },
  );

  Then(
    "{string}'s envelope decrypts to her secret under the additional data {string} followed by her user id",
    function* (name: string, aadPrefix: string) {
      const person = yield* getPerson(name);
      const row = yield* envelopeOf(name);
      const decrypted = successValue(
        yield* directExit(
          Effect.flatMap(Encryption.Encryption, (encryption) =>
            encryption.decrypt(row.envelope, `${aadPrefix}${person.userId}`),
          ),
        ),
      );
      const plaintext = field(decrypted, "plaintext");
      assert.ok(Redacted.isRedacted(plaintext));
      assert.equal(Redacted.value(plaintext), requireSecret(person));
    },
  );

  Then(
    "{string}'s envelope moved to {string}'s row fails authentication",
    function* (name: string, other: string) {
      const otherPerson = yield* getPerson(other);
      const row = yield* envelopeOf(name);
      const exit = yield* directExit(
        Effect.flatMap(Encryption.Encryption, (encryption) =>
          encryption.decrypt(row.envelope, `two_factor_secret:${otherPerson.userId}`),
        ),
      );
      assert.equal(failureTag(exit), "DecryptionFailed");
    },
  );

  When("the audit log and the data export of {string} are read", function* (name: string) {
    const person = yield* getPerson(name);
    const { strings, documents } = yield* World;
    const rows = yield* direct(Effect.flatMap(AuditLog.AuditLog, (audit) => audit.list()));
    const document = yield* direct(
      Effect.flatMap(DataExport.AccountExport, (exporter) => exporter.exportAccount(person.userId)),
    );
    yield* documents.set(name, document);
    yield* strings.set("observed", textOf(rows));
  });

  const forbiddenTexts = (name: string) =>
    Effect.gen(function* () {
      const person = yield* getPerson(name);
      return [
        requireSecret(person),
        ...person.recoveryCodes,
        ...person.recoveryCodes.map((code) => code.replaceAll("-", "")),
        "$argon2id$",
      ];
    });

  Then("neither contains her base32 secret, a recovery code or a recovery-code hash", function* () {
    const { strings, documents, people } = yield* World;
    const name = yield* people.current;
    const observed = (yield* strings.get("observed")) + textOf(yield* documents.get(name));
    for (const forbidden of yield* forbiddenTexts(name)) {
      assert.ok(!observed.includes(forbidden), `an observable surface contains a secret`);
    }
  });

  Then(
    "the export says a second factor is enabled with {int} recovery codes remaining",
    function* (remaining: number) {
      const { documents, people } = yield* World;
      const document = yield* documents.get(yield* people.current);
      const section = field(document.sections, "two_factor");
      assert.equal(field(section, "enabled"), true);
      assert.equal(field(section, "remainingRecoveryCodes"), remaining);
    },
  );

  When("{string}'s account is erased", function* (name: string) {
    const person = yield* getPerson(name);
    yield* direct(
      Effect.flatMap(Erasure.AccountErasure, (erasure) => erasure.eraseAccount(person.userId)),
    );
  });

  const rowsOf = (name: string) =>
    Effect.gen(function* () {
      const person = yield* getPerson(name);
      return yield* direct(
        Effect.gen(function* () {
          const secrets = yield* TwoFactorStore.TwoFactorSecrets;
          const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
          return {
            secret: yield* secrets.find(person.userId),
            codes: yield* codes.countUnused(person.userId),
          };
        }),
      );
    });

  Then("no secret row and no recovery code remains for {string}", function* (name: string) {
    const { secret, codes } = yield* rowsOf(name);
    assert.ok(Option.isNone(secret));
    assert.equal(codes, 0);
  });

  Then("{string}'s secret and recovery codes are untouched", function* (name: string) {
    const { secret, codes } = yield* rowsOf(name);
    assert.ok(Option.isSome(secret));
    assert.equal(codes, 10);
  });

  // ---- BEH-EA-264: recovery codes -----------------------------------------------------------

  Then(
    "{string} was shown {int} recovery codes of {int} characters each, grouped as {string}",
    function* (name: string, count: number, length: number, _grouping: string) {
      const codes = (yield* getPerson(name)).recoveryCodes;
      assert.equal(codes.length, count);
      for (const code of codes) {
        assert.equal(code.replaceAll("-", "").length, length);
        assert.match(code, CODE_SHAPE);
      }
    },
  );

  Then("the recovery codes use only the 32 unambiguous symbols", function* () {
    const person = yield* current;
    for (const code of person.recoveryCodes) assert.match(code, CODE_SHAPE);
    const symbols = new Set(person.recoveryCodes.join("").replaceAll("-", ""));
    for (const forbidden of ["0", "O", "1", "I"]) assert.ok(!symbols.has(forbidden));
  });

  Then(
    "the stored recovery codes of {string} are argon2id hashes containing none of the codes she was shown",
    function* (name: string) {
      const person = yield* getPerson(name);
      const stored = yield* direct(
        Effect.flatMap(TwoFactorStore.TwoFactorRecoveryCodes, (codes) =>
          codes.listUnused(person.userId),
        ),
      );
      assert.equal(stored.length, person.recoveryCodes.length);
      for (const row of stored) {
        const hash = Redacted.value(row.codeHash);
        assert.match(hash, /^\$argon2id\$/);
        for (const plain of person.recoveryCodes) {
          assert.ok(!hash.includes(plain.replaceAll("-", "")));
        }
      }
    },
  );

  When(
    "{string} presents her first recovery code in lower case with her challenge",
    function* (name: string) {
      const person = yield* getPerson(name);
      const { strings } = yield* World;
      const challenge = yield* strings.get(`challenge:${name}`);
      yield* strings.set("firstCode", person.recoveryCodes[0] ?? "");
      yield* setAnswer(
        yield* verifyRecoveryWith(challenge, (person.recoveryCodes[0] ?? "").toLowerCase()),
      );
    },
  );

  const remainingOf = (name: string) =>
    Effect.gen(function* () {
      const person = yield* getPerson(name);
      return yield* direct(
        Effect.flatMap(TwoFactor.TwoFactor, (twoFactor) => twoFactor.status(person.userId)),
      );
    });

  Then("{string} has {int} recovery codes remaining", function* (name: string, remaining: number) {
    assert.equal((yield* remainingOf(name)).remainingRecoveryCodes, remaining);
  });

  Then(
    "{string} still has {int} recovery codes remaining",
    function* (name: string, remaining: number) {
      assert.equal((yield* remainingOf(name)).remainingRecoveryCodes, remaining);
    },
  );

  Then(
    "the status of {string} reports a second factor with {int} recovery codes remaining",
    function* (name: string, remaining: number) {
      const status = yield* remainingOf(name);
      assert.equal(status.enabled, true);
      assert.equal(status.remainingRecoveryCodes, remaining);
    },
  );

  Then(
    "an {string} event was published with {int} remaining",
    function* (tag: string, remaining: number) {
      const rows = yield* auditRows(tag);
      assert.equal(rows.length, 1);
      assert.ok(textOf(rows).includes(`"remaining":${remaining}`), textOf(rows));
    },
  );

  Then("an {string} event was published", function* (tag: string) {
    assert.ok((yield* auditRows(tag)).length >= 1, `no ${tag} event`);
  });

  When("{string} is diverted again and presents the same recovery code", function* (name: string) {
    const { strings } = yield* World;
    const challenge = yield* divertedChallenge(name);
    yield* setAnswer(yield* verifyRecoveryWith(challenge, yield* strings.get("firstCode")));
  });

  const concurrently = <A, E, B, F>(
    first: Effect.Effect<A, E, TwoFactorServices>,
    second: Effect.Effect<B, F, TwoFactorServices>,
  ) => direct(Effect.all([Effect.exit(first), Effect.exit(second)], { concurrency: 2 }));

  When(
    "her first recovery code is presented twice concurrently to the second factor",
    function* () {
      const person = yield* current;
      const code = Redacted.make(person.recoveryCodes[0] ?? "");
      const present = Effect.flatMap(SecondFactor.SecondFactor, (factor) =>
        factor.verifyRecoveryCode(person.userId, code, "signIn"),
      );
      const [a, b] = yield* concurrently(present, present);
      const { exits } = yield* World;
      yield* exits.set("concurrent:1", a);
      yield* exits.set("concurrent:2", b);
    },
  );

  When(
    "her current authenticator code is presented twice concurrently to the second factor",
    function* () {
      const person = yield* current;
      const { people } = yield* World;
      const code = Redacted.make(yield* currentCode(yield* people.current));
      const present = Effect.flatMap(SecondFactor.SecondFactor, (factor) =>
        factor.verifyTotp(person.userId, code, "signIn"),
      );
      const [a, b] = yield* concurrently(present, present);
      const { exits } = yield* World;
      yield* exits.set("concurrent:1", a);
      yield* exits.set("concurrent:2", b);
    },
  );

  Then("exactly one presentation is accepted", function* () {
    const { exits } = yield* World;
    const outcomes = [yield* exits.get("concurrent:1"), yield* exits.get("concurrent:2")];
    assert.equal(outcomes.filter((exit) => Exit.isSuccess(exit)).length, 1);
  });

  Then("the other is an {string}", function* (tag: string) {
    const { exits } = yield* World;
    const outcomes = [yield* exits.get("concurrent:1"), yield* exits.get("concurrent:2")];
    const failed = outcomes.filter((exit) => Exit.isFailure(exit));
    assert.equal(failed.length, 1);
    assert.equal(failureTag(failed[0] ?? Exit.void), tag);
  });

  When(
    "{string} regenerates her recovery codes with her second recovery code",
    function* (name: string) {
      const person = yield* getPerson(name);
      const { lists } = yield* World;
      yield* lists.set(`old:${name}`, person.recoveryCodes);
      const fresh = successValue(
        yield* directExit(
          Effect.flatMap(TwoFactor.TwoFactor, (twoFactor) =>
            twoFactor.regenerateRecoveryCodes(
              person.userId,
              person.sessionId,
              Redacted.make(person.recoveryCodes[1] ?? ""),
            ),
          ),
        ),
      );
      assert.ok(Array.isArray(fresh));
      yield* updatePerson(name, (existing) => ({ ...existing, recoveryCodes: fresh.map(String) }));
    },
  );

  Then(
    "she is shown {int} new recovery codes and has {int} remaining",
    function* (count: number, remaining: number) {
      const person = yield* current;
      const { lists, people } = yield* World;
      const old = yield* lists.get(`old:${yield* people.current}`);
      assert.equal(person.recoveryCodes.length, count);
      assert.ok(person.recoveryCodes.every((code) => !old.includes(code)));
      assert.equal((yield* remainingOf(yield* people.current)).remainingRecoveryCodes, remaining);
    },
  );

  Then(
    "a diverted sign-in presenting one of her old recovery codes is an {string}",
    function* (tag: string) {
      const { lists, people } = yield* World;
      const name = yield* people.current;
      const old = yield* lists.get(`old:${name}`);
      const exit = yield* verifyRecoveryWith(yield* divertedChallenge(name), old[2] ?? "");
      assert.equal(failureTag(exit), tag);
    },
  );

  Then("a diverted sign-in presenting one of her new recovery codes succeeds", function* () {
    const person = yield* current;
    const { people } = yield* World;
    const exit = yield* verifyRecoveryWith(
      yield* divertedChallenge(yield* people.current),
      person.recoveryCodes[0] ?? "",
    );
    successValue(exit);
  });

  Given("a SQL-backed recovery-code store holding two unused codes for a user", function* () {
    yield* openSqlRecoveryCodes();
    const { lists } = yield* World;
    const ids = successValue(
      yield* sqlExit(
        Effect.gen(function* () {
          const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
          const user = Users.UserId("user-a");
          yield* codes.replaceAll(user, [
            PasswordHasher.PhcHash("$argon2id$test$old-1"),
            PasswordHasher.PhcHash("$argon2id$test$old-2"),
          ]);
          return (yield* codes.listUnused(user)).map((row) => row.id).sort();
        }),
      ),
    );
    assert.ok(Array.isArray(ids) && ids.length === 2);
    yield* lists.set("before", ids.map(String));
  });

  When("replacing the set fails while inserting the first new code", function* () {
    const { exits } = yield* World;
    successValue(
      yield* sqlExit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // The delete of the old set succeeds, then the first insert fails: without the transaction the
          // user would be left with no codes at all.
          yield* sql.unsafe(
            `CREATE TRIGGER two_factor_fail_insert BEFORE INSERT ON two_factor_recovery_code
             BEGIN SELECT RAISE(ABORT, 'injected'); END`,
          );
        }),
      ),
    );
    yield* exits.set(
      "replace",
      yield* sqlExit(
        Effect.gen(function* () {
          const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
          return yield* codes.replaceAll(Users.UserId("user-a"), [
            PasswordHasher.PhcHash("$argon2id$test$new-1"),
          ]);
        }),
      ),
    );
  });

  Then("the user still holds exactly the same two unused codes", function* () {
    const { exits, lists } = yield* World;
    assert.ok(Exit.isFailure(yield* exits.get("replace")), "the replacement should have failed");
    const after = successValue(
      yield* sqlExit(
        Effect.gen(function* () {
          const codes = yield* TwoFactorStore.TwoFactorRecoveryCodes;
          return (yield* codes.listUnused(Users.UserId("user-a"))).map((row) => row.id).sort();
        }),
      ),
    );
    assert.deepEqual(after, yield* lists.get("before"));
  });

  // ---- BEH-EA-265: the replay guard ---------------------------------------------------------

  When("{string} is diverted again and presents the same code", function* (name: string) {
    const { strings } = yield* World;
    const challenge = yield* divertedChallenge(name);
    yield* setAnswer(yield* verifyWith(challenge, yield* strings.get(`lastCode:${name}`)));
  });

  When("{string} presents that same confirming code with her challenge", function* (name: string) {
    const { strings } = yield* World;
    const challenge = yield* strings.get(`challenge:${name}`);
    yield* setAnswer(yield* verifyWith(challenge, yield* strings.get(`lastCode:${name}`)));
  });

  When(
    "a pending secret is stored for {string} directly in the secrets store",
    function* (name: string) {
      const person = yield* getPerson(name);
      const { strings, exits } = yield* World;
      yield* strings.set("envelopeBefore", (yield* envelopeOf(name)).envelope);
      yield* exits.set(
        "upsert",
        yield* directExit(
          Effect.flatMap(TwoFactorStore.TwoFactorSecrets, (secrets) =>
            secrets.upsertPending(person.userId, "another-envelope"),
          ),
        ),
      );
    },
  );

  Then(
    "the store refuses it and {string}'s confirmed secret is unchanged",
    function* (name: string) {
      const { strings, exits } = yield* World;
      assert.equal(successValue(yield* exits.get("upsert")), false);
      assert.equal((yield* envelopeOf(name)).envelope, yield* strings.get("envelopeBefore"));
    },
  );

  // ---- BEH-EA-266: the failure budget and the audit trail -------------------------------------

  const failOnce = (name: string, kind: "totp" | "recovery") =>
    Effect.gen(function* () {
      const challenge = yield* freshChallenge(name);
      const exit =
        kind === "totp"
          ? yield* verifyWith(challenge, "000000")
          : yield* verifyRecoveryWith(challenge, "ZZZZZ-ZZZZZ");
      assert.equal(failureTag(exit), "InvalidTwoFactorCode");
    });

  When(
    "{string} fails {int} TOTP presentations and {int} recovery-code presentations, each on a fresh challenge",
    function* (name: string, totps: number, recoveries: number) {
      for (let i = 0; i < totps; i += 1) yield* failOnce(name, "totp");
      for (let i = 0; i < recoveries; i += 1) yield* failOnce(name, "recovery");
    },
  );

  Given("{string} has failed {int} presentations", function* (name: string, count: number) {
    for (let i = 0; i < count; i += 1) yield* failOnce(name, "totp");
  });

  When("{string} fails {int} more presentation", function* (name: string, count: number) {
    for (let i = 0; i < count; i += 1) yield* failOnce(name, "totp");
  });

  Then(
    "an {string} event was published exactly once for {string}",
    function* (tag: string, name: string) {
      const person = yield* getPerson(name);
      const rows = yield* auditRows(tag);
      assert.equal(rows.length, 1);
      assert.ok(textOf(rows).includes(person.userId));
    },
  );

  Then("still only one {string} event was published", function* (tag: string) {
    assert.equal((yield* auditRows(tag)).length, 1);
  });

  const presentCorrectCode = Effect.fn("features.twoFactor.presentCorrectCode")(function* (
    name: string,
  ) {
    const challenge = yield* freshChallenge(name);
    return yield* verifyWith(challenge, yield* currentCode(name));
  });

  Then(
    "presenting her correct current authenticator code is refused as {string} with a positive retry delay",
    function* (tag: string) {
      const { people } = yield* World;
      const exit = yield* presentCorrectCode(yield* people.current);
      assert.equal(failureTag(exit), tag);
      const delay = field(failureOf(exit), "retryAfterMillis");
      assert.ok(typeof delay === "number" && delay > 0);
    },
  );

  Then(
    "presenting her correct current authenticator code is refused as {string}",
    function* (tag: string) {
      const { people } = yield* World;
      assert.equal(failureTag(yield* presentCorrectCode(yield* people.current)), tag);
    },
  );

  When("{string} presents her first recovery code", function* (name: string) {
    const person = yield* getPerson(name);
    yield* setAnswer(
      yield* verifyRecoveryWith(yield* freshChallenge(name), person.recoveryCodes[0] ?? ""),
    );
  });

  When(
    "{string} presents her correct current authenticator code on a fresh challenge",
    function* (name: string) {
      yield* setAnswer(yield* presentCorrectCode(name));
    },
  );

  When("{string} disables the second factor with her recovery code", function* (name: string) {
    const person = yield* getPerson(name);
    yield* setAnswer(
      yield* directExit(
        Effect.flatMap(TwoFactor.TwoFactor, (twoFactor) =>
          twoFactor.disable(
            person.userId,
            person.sessionId,
            Redacted.make(person.recoveryCodes[3] ?? ""),
          ),
        ),
      ),
    );
    successValue(yield* answer);
  });

  Then(
    "the audit log holds {string}, {string}, {string} and {string} events for {string}",
    function* (a: string, b: string, c: string, d: string, name: string) {
      const person = yield* getPerson(name);
      for (const tag of [a, b, c, d]) {
        const rows = yield* auditRows(tag);
        assert.ok(rows.length >= 1, `no ${tag} event`);
        assert.ok(textOf(rows).includes(person.userId), `${tag} does not name the user`);
      }
    },
  );

  Then("none of those events carries a code, a secret or a hash", function* () {
    const { people } = yield* World;
    const name = yield* people.current;
    const person = yield* getPerson(name);
    const tags = [
      "auth.twoFactor.enabled",
      "auth.twoFactor.challengeFailed",
      "auth.twoFactor.verified",
      "auth.twoFactor.disabled",
      "auth.twoFactor.recoveryCodeUsed",
    ];
    let text = "";
    for (const tag of tags) text += textOf(yield* auditRows(tag));
    const forbidden = [
      requireSecret(person),
      "$argon2id$",
      ...person.recoveryCodes,
      ...person.recoveryCodes.map((code) => code.replaceAll("-", "")),
    ];
    for (const item of forbidden)
      assert.ok(!text.includes(item), "an audit event carries a secret");
  });
});
