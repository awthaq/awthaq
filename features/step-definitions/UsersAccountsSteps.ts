// P20a (AH-003, decision 36 tier 1): 02-domain/06-users-accounts.feature, BEH-EA-041..047.
// Runs over `DomainWorld`'s SQLite-backed composition: the schema-level unique constraints
// these Rules are about (case-insensitive email, `(providerId, subject)`) only exist in a
// database, and the cascade Rule is exercised through the real `DELETE /user`.
//
// BEH-EA-048 (plugin-contributed fields), and the zero-credential *policy* exception of
// BEH-EA-045, describe capabilities the shipped code does not have; their scenarios stay
// `@skip` with the reason in the .feature file rather than being wired against a stand-in.
import { Accounts, Sessions, Users } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql/SqlError";
import { direct, directExit, World } from "./DomainWorld.ts";
import {
  bodyText,
  getPerson,
  newPerson,
  request,
  rows,
  setPerson,
  signUp,
  signUpVerified,
} from "./DomainSupport.ts";
import { mailedToken } from "./MailedToken.ts";
import { cookieFrom, STRONG_PASSWORD } from "./shared/Harness.ts";

const emailOf = (name: string) => `${name}@example.com`;

/** SQLite hands a boolean column back as 0/1 (Postgres as a boolean). */
const isTrue = (value: unknown) => value === 1 || value === true;

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) return undefined;
  return exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
};

const hasDefect = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die");

const createUser = (email: string) =>
  directExit(
    Effect.flatMap(Users.Users, (users) =>
      users.create({ identity: { _tag: "Email", email }, name: email }),
    ),
  );

/** A user reached only through the domain services — no HTTP sign-up — like one created by an OAuth callback. */
const createUserDirect = Effect.fn("features.usersAccounts.createUserDirect")(function* (
  name: string,
) {
  const user = yield* direct(
    Effect.flatMap(Users.Users, (users) =>
      users.create({ identity: { _tag: "Email", email: emailOf(name) }, name }),
    ),
  );
  yield* setPerson(name, { ...newPerson(emailOf(name)), userId: Option.some(user.id) });
  return user;
});

const userIdOf = Effect.fn("features.usersAccounts.userIdOf")(function* (name: string) {
  const person = yield* getPerson(name);
  if (Option.isNone(person.userId)) return yield* Effect.die(new Error(`${name} has no user id`));
  return person.userId.value;
});

const linkDirect = (userId: Users.UserId, providerId: string, subject: string) =>
  directExit(
    Effect.flatMap(Accounts.Accounts, (accounts) => accounts.link({ userId, providerId, subject })),
  );

const accountsOf = Effect.fn("features.usersAccounts.accountsOf")(function* (userId: Users.UserId) {
  return yield* direct(
    Effect.flatMap(Accounts.Accounts, (accounts) => accounts.listByUser(userId)),
  );
});

/**
 * A user signed up over the wire (password Account + a live session, address verified) who
 * also has `providers` linked — the "signed-in user with Accounts ..." precondition. Naming the
 * user makes them the current one (BDD-008).
 */
const signedInWith = Effect.fn("features.usersAccounts.signedInWith")(function* (
  name: string,
  providers: ReadonlyArray<string>,
) {
  yield* setPerson(name, newPerson(emailOf(name)));
  yield* signUpVerified(name);
  const userId = yield* userIdOf(name);
  for (const provider of providers) {
    if (provider === "password") continue;
    const outcome = yield* linkDirect(userId, provider, `${provider}-${name}`);
    assert.ok(Exit.isSuccess(outcome), `linking ${provider} for ${name} must succeed`);
  }
});

/** A session cookie by the name the scenario gives it ("s1"). */
const nameSession = Effect.fn("features.usersAccounts.nameSession")(function* (
  session: string,
  cookie: string,
) {
  const { strings } = yield* World;
  yield* strings.set(`session:${session}`, cookie);
});

const sessionCookie = Effect.fn("features.usersAccounts.sessionCookie")(function* (
  session: string,
) {
  const { strings } = yield* World;
  return yield* strings.get(`session:${session}`);
});

/** Whether a named session is still valid over the wire. */
const sessionStatus = Effect.fn("features.usersAccounts.sessionStatus")(function* (
  session: string,
) {
  const cookie = yield* sessionCookie(session);
  return (yield* request("GET", "/session", { cookie })).status;
});

const unlinkProvider = Effect.fn("features.usersAccounts.unlinkProvider")(function* (
  name: string,
  provider: string,
) {
  const { exits } = yield* World;
  const userId = yield* userIdOf(name);
  const account = (yield* accountsOf(userId)).find((record) => record.providerId === provider);
  assert.ok(account !== undefined, `${name} has a ${provider} Account to unlink`);
  yield* exits.set(
    "unlink",
    yield* directExit(Effect.flatMap(Accounts.Accounts, (accounts) => accounts.unlink(account.id))),
  );
});

/** The `emailVerified` a person's row holds, read straight from `users`. */
const storedEmailVerified = Effect.fn("features.usersAccounts.storedEmailVerified")(function* (
  name: string,
) {
  const person = yield* getPerson(name);
  const found = yield* rows(
    "SELECT emailVerified FROM users WHERE lower(email) = ?",
    person.email.toLowerCase(),
  );
  assert.equal(found.length, 1, `exactly one users row for ${person.email}`);
  return isTrue(found[0]?.["emailVerified"]);
});

/** The name of the person the scenario most recently referred to (BDD-008). */
const currentName = Effect.fn("features.usersAccounts.currentName")(function* () {
  const { people } = yield* World;
  return yield* people.current;
});

const NAME_UPDATE = "A Freshly Changed Name";

export const usersAccountsSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-041 / REQ-EA-109..111: case-insensitively unique email ----

  Given("a signup submitted with email {string}", function* (email: string) {
    yield* setPerson("signup", newPerson(email));
  });

  When("the User row is persisted", function* () {
    yield* signUp("signup");
  });

  When("the User row is created", function* () {
    yield* signUp("signup");
  });

  Then("the stored email is {string}", function* (expected: string) {
    const stored = yield* rows("SELECT email FROM users");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.["email"], expected);
  });

  Given("a User already exists with email {string}", function* (email: string) {
    const outcome = yield* createUser(email);
    assert.ok(Exit.isSuccess(outcome));
  });

  When("a new signup attempts to create a User with email {string}", function* (email: string) {
    const { exits } = yield* World;
    yield* exits.set("create", yield* createUser(email));
  });

  Then("the creation is rejected as a duplicate email", function* () {
    const { exits } = yield* World;
    assert.ok(failureOf(yield* exits.get("create")) instanceof Users.EmailAlreadyExists);
  });

  Given("no User exists with email {string}", function* (email: string) {
    assert.equal(
      (yield* rows("SELECT id FROM users WHERE lower(email) = ?", email.toLowerCase())).length,
      0,
    );
  });

  When(
    "two concurrent signups race to create a User with email {string} and {string} respectively",
    function* (first: string, second: string) {
      const { exits } = yield* World;
      const [a, b] = yield* Effect.all([createUser(first), createUser(second)], { concurrency: 2 });
      yield* exits.set("create-1", a);
      yield* exits.set("create-2", b);
    },
  );

  Then("only one creation succeeds", function* () {
    const { exits } = yield* World;
    const outcomes = [yield* exits.get("create-1"), yield* exits.get("create-2")];
    assert.equal(outcomes.filter((outcome) => Exit.isSuccess(outcome)).length, 1);
    assert.equal((yield* rows("SELECT id FROM users")).length, 1, "and exactly one row was stored");
  });

  Then(
    "the other is rejected by the schema-level unique constraint, not by an application-level lookup that could lose the race",
    function* () {
      const { exits } = yield* World;
      const loser = [yield* exits.get("create-1"), yield* exits.get("create-2")].find((outcome) =>
        Exit.isFailure(outcome),
      );
      assert.ok(loser !== undefined);
      assert.ok(failureOf(loser) instanceof Users.EmailAlreadyExists);
      // The constraint itself: a raw insert that skips every application check is refused by
      // the database, for a case variant of the stored address.
      const stored = yield* rows("SELECT email FROM users");
      const email = String(stored[0]?.["email"]).toUpperCase();
      const bypass = yield* directExit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe(
            "INSERT INTO users (id, email, emailVerified, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
            [
              "raw-insert-1",
              email,
              0,
              "raw",
              "2026-01-01T00:00:00.000Z",
              "2026-01-01T00:00:00.000Z",
            ],
          );
        }),
      );
      const refusal = failureOf(bypass);
      assert.ok(refusal instanceof SqlError);
      assert.equal(refusal.reason._tag, "UniqueViolation");
    },
  );

  // ---- BEH-EA-042 / REQ-EA-112..115: emailVerified is monotone, never client-settable ----

  Then("{string} is {string}", function* (column: string, expected: string) {
    assert.equal(column, "emailVerified");
    const person = yield* getPerson("signup");
    const found = yield* rows(
      "SELECT emailVerified FROM users WHERE lower(email) = ?",
      person.email.toLowerCase(),
    );
    assert.equal(found.length, 1);
    assert.equal(isTrue(found[0]?.["emailVerified"]), expected === "true");
  });

  Given(
    "a signed-in user {string} whose {string} is {string}",
    function* (name: string, _column: string, state: string) {
      yield* setPerson(name, newPerson(emailOf(name)));
      if (state === "true") {
        yield* signUpVerified(name);
      } else {
        yield* signUp(name);
      }
      assert.equal(yield* storedEmailVerified(name), state === "true");
    },
  );

  When(
    "{string} submits a generic profile update with {string}",
    function* (name: string, field: string) {
      const { responses } = yield* World;
      const person = yield* getPerson(name);
      const [key, value] = field.split(": ");
      assert.ok(key !== undefined && value !== undefined);
      assert.ok(Option.isSome(person.cookie));
      yield* responses.set(
        "update",
        yield* request("PATCH", "/user", {
          body: { name: NAME_UPDATE, [key]: value === "true" },
          cookie: person.cookie.value,
        }),
      );
    },
  );

  Then(
    "the update path does not set {string} to {string}",
    function* (_field: string, _value: string) {
      const { responses } = yield* World;
      const response = yield* responses.get("update");
      // The write itself went through (the profile name changed)…
      assert.equal(response.status, 200, yield* bodyText(response));
      assert.match(yield* bodyText(response), new RegExp(NAME_UPDATE));
      // …and the unknown, client-supplied verification flag was not part of it.
      assert.equal(yield* storedEmailVerified(yield* currentName()), false);
    },
  );

  Then("{string} remains {string}", function* (_column: string, expected: string) {
    assert.equal(yield* storedEmailVerified(yield* currentName()), expected === "true");
  });

  When(
    "{string} consumes a valid email-verification token for her own address",
    function* (name: string) {
      const person = yield* getPerson(name);
      const { sentMail } = yield* World;
      const mail = (yield* sentMail).findLast(
        (message) => message.to === person.email && message.template === "verify-email",
      );
      assert.ok(mail !== undefined, "the sign-up mailed a verification token");
      const consumed = yield* request("POST", "/verify-email", {
        body: { token: mailedToken(mail) },
      });
      assert.equal(consumed.status, 204);
    },
  );

  Then("{string} transitions to {string}", function* (_column: string, expected: string) {
    assert.equal(yield* storedEmailVerified(yield* currentName()), expected === "true");
  });

  When(
    "{string} performs an ordinary profile update unrelated to verification",
    function* (name: string) {
      const person = yield* getPerson(name);
      assert.ok(Option.isSome(person.cookie));
      const response = yield* request("PATCH", "/user", {
        body: { name: NAME_UPDATE },
        cookie: person.cookie.value,
      });
      assert.equal(response.status, 200);
    },
  );

  // ---- BEH-EA-043 / REQ-EA-116..118: (providerId, subject) is unique ----

  Given(
    "no Account exists with providerId {string} and subject {string}",
    function* (providerId: string, subject: string) {
      assert.equal(
        (yield* rows(
          "SELECT id FROM accounts WHERE providerId = ? AND subject = ?",
          providerId,
          subject,
        )).length,
        0,
      );
    },
  );

  When(
    "a User links an Account with providerId {string} and subject {string}",
    function* (providerId: string, subject: string) {
      const { exits } = yield* World;
      const user = yield* createUserDirect("linker");
      yield* exits.set("link", yield* linkDirect(user.id, providerId, subject));
    },
  );

  Then("the Account is created", function* () {
    const { exits } = yield* World;
    const outcome = yield* exits.get("link");
    assert.ok(Exit.isSuccess(outcome));
    const user = yield* userIdOf("linker");
    const linked = yield* accountsOf(user);
    assert.equal(linked.length, 1);
  });

  Given(
    "an Account already exists with providerId {string} and subject {string}",
    function* (providerId: string, subject: string) {
      const user = yield* createUserDirect("holder");
      assert.ok(Exit.isSuccess(yield* linkDirect(user.id, providerId, subject)));
    },
  );

  When(
    "another link attempt uses providerId {string} and subject {string}",
    function* (providerId: string, subject: string) {
      const { exits } = yield* World;
      const other = yield* createUserDirect("other");
      yield* exits.set("link", yield* linkDirect(other.id, providerId, subject));
    },
  );

  Then("the second link attempt is rejected as a duplicate", function* () {
    const { exits } = yield* World;
    assert.ok(failureOf(yield* exits.get("link")) instanceof Accounts.AccountAlreadyLinked);
  });

  When(
    "two concurrent requests race to link providerId {string} and subject {string}",
    function* (providerId: string, subject: string) {
      const { exits } = yield* World;
      const first = yield* createUserDirect("racer-one");
      const second = yield* createUserDirect("racer-two");
      const [a, b] = yield* Effect.all(
        [linkDirect(first.id, providerId, subject), linkDirect(second.id, providerId, subject)],
        { concurrency: 2 },
      );
      yield* exits.set("link-1", a);
      yield* exits.set("link-2", b);
    },
  );

  Then("only one link attempt succeeds", function* () {
    const { exits } = yield* World;
    const outcomes = [yield* exits.get("link-1"), yield* exits.get("link-2")];
    assert.equal(outcomes.filter((outcome) => Exit.isSuccess(outcome)).length, 1);
    assert.equal((yield* rows("SELECT id FROM accounts")).length, 1);
  });

  Then(
    "the other is rejected by the database-level constraint, not by application-level query discipline that could lose the race",
    function* () {
      const { exits } = yield* World;
      const loser = [yield* exits.get("link-1"), yield* exits.get("link-2")].find((outcome) =>
        Exit.isFailure(outcome),
      );
      assert.ok(loser !== undefined);
      assert.ok(failureOf(loser) instanceof Accounts.AccountAlreadyLinked);
      const stored = yield* rows("SELECT providerId, subject, issuer FROM accounts");
      const bypass = yield* directExit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql.unsafe(
            "INSERT INTO accounts (id, userId, providerId, subject, issuer, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
              "raw-account-1",
              "someone-else",
              String(stored[0]?.["providerId"]),
              String(stored[0]?.["subject"]),
              String(stored[0]?.["issuer"]),
              "2026-01-01T00:00:00.000Z",
              "2026-01-01T00:00:00.000Z",
            ],
          );
        }),
      );
      const refusal = failureOf(bypass);
      assert.ok(refusal instanceof SqlError);
      assert.equal(refusal.reason._tag, "UniqueViolation");
    },
  );

  // ---- BEH-EA-044 / REQ-EA-119..121: a password credential is an ordinary Account row ----

  Given("a signed-in user {string} with no password credential", function* (name: string) {
    // An OAuth-style user: created and given a session, never a password Account.
    const user = yield* createUserDirect(name);
    yield* direct(
      Effect.flatMap(Sessions.Sessions, (sessions) => sessions.issue({ userId: user.id })),
    );
    assert.equal((yield* accountsOf(user.id)).length, 0);
  });

  const setPassword = Effect.fn("features.usersAccounts.setPassword")(function* (name: string) {
    // The capability under test is the Account model, not a sign-up flow: the credential is the
    // real hasher's output stored as an ordinary `(password, <userId>)` row, exactly what
    // `Password` itself writes.
    const { exits } = yield* World;
    const userId = yield* userIdOf(name);
    const hash = yield* direct(
      Effect.flatMap(PasswordHasher.PasswordHasher, (hasher) =>
        hasher.hash(Redacted.make(STRONG_PASSWORD)),
      ),
    );
    yield* exits.set(
      "set-password",
      yield* directExit(
        Effect.flatMap(Accounts.Accounts, (accounts) =>
          accounts.link({
            userId,
            providerId: Accounts.PASSWORD_PROVIDER_ID,
            subject: userId,
            credentialHash: Redacted.make(hash),
          }),
        ),
      ),
    );
  });

  When("{string} sets a password", function* (name: string) {
    yield* setPassword(name);
  });

  Then(
    "an Account row is created with providerId {string} and subject equal to {string}'s own user id",
    function* (providerId: string, name: string) {
      const userId = yield* userIdOf(name);
      const found = yield* rows(
        "SELECT providerId, subject FROM accounts WHERE userId = ?",
        userId,
      );
      assert.equal(found.length, 1);
      assert.equal(found[0]?.["providerId"], providerId);
      assert.equal(found[0]?.["subject"], userId);
    },
  );

  Given(
    "a signed-in user {string} with no Account row where providerId is {string}",
    function* (name: string, providerId: string) {
      const user = yield* createUserDirect(name);
      yield* direct(
        Effect.flatMap(Sessions.Sessions, (sessions) => sessions.issue({ userId: user.id })),
      );
      const found = yield* rows(
        "SELECT id FROM accounts WHERE userId = ? AND providerId = ?",
        user.id,
        providerId,
      );
      assert.equal(found.length, 0);
    },
  );

  When("the system checks whether {string} has a password credential", function* (name: string) {
    const { exits } = yield* World;
    const userId = yield* userIdOf(name);
    yield* exits.set(
      "credential-check",
      yield* directExit(
        Effect.flatMap(Accounts.Accounts, (accounts) =>
          accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId),
        ),
      ),
    );
  });

  Then(
    "the check reports {string}, derived from Account row absence, not from a flag on {string}",
    function* (_report: string, _table: string) {
      const { exits } = yield* World;
      const outcome = yield* exits.get("credential-check");
      assert.ok(Exit.isSuccess(outcome));
      assert.ok(Option.isOption(outcome.value) && Option.isNone(outcome.value));
      // There is no flag to consult: neither the users table nor the User record carries one.
      const columns = yield* rows("SELECT name FROM pragma_table_info('users')");
      assert.ok(
        columns.every((column) => !/password|credential/i.test(String(column["name"]))),
        "the users table has no password/credential column",
      );
    },
  );

  Given(
    "a signed-in user {string} who already has an Account row with providerId {string}",
    function* (name: string, _providerId: string) {
      yield* createUserDirect(name);
      yield* setPassword(name);
      assert.ok(Exit.isSuccess(yield* (yield* World).exits.get("set-password")));
    },
  );

  When("{string} attempts to set a second password credential", function* (name: string) {
    yield* setPassword(name);
  });

  Then("the attempt is rejected as a duplicate \\(providerId, subject) pair", function* () {
    const { exits } = yield* World;
    assert.ok(failureOf(yield* exits.get("set-password")) instanceof Accounts.AccountAlreadyLinked);
  });

  // ---- BEH-EA-045 / REQ-EA-122..125: never zero linked credentials ----

  Given(
    "a signed-in user {string} with Accounts {string} and {string}",
    function* (name: string, first: string, second: string) {
      yield* signedInWith(name, [first, second]);
    },
  );

  When("{string} unlinks the {string} Account", function* (name: string, provider: string) {
    yield* unlinkProvider(name, provider);
    const { exits } = yield* World;
    assert.ok(Exit.isSuccess(yield* exits.get("unlink")), "the unlink must succeed");
  });

  Then("the {string} Account is removed", function* (provider: string) {
    const person = yield* getPerson(yield* currentName());
    assert.ok(Option.isSome(person.userId));
    const remaining = yield* accountsOf(person.userId.value);
    assert.ok(!remaining.some((record) => record.providerId === provider));
  });

  Then("{string} still has the {string} Account", function* (name: string, provider: string) {
    const remaining = yield* accountsOf(yield* userIdOf(name));
    assert.ok(remaining.some((record) => record.providerId === provider));
  });

  Given(
    "a signed-in user {string} with exactly one Account, {string}",
    function* (name: string, provider: string) {
      yield* signedInWith(name, []);
      const accounts = yield* accountsOf(yield* userIdOf(name));
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0]?.providerId, provider);
    },
  );

  When(
    "{string} attempts to unlink the {string} Account",
    function* (name: string, provider: string) {
      yield* unlinkProvider(name, provider);
    },
  );

  When("{string} attempts to unlink his only Account", function* (name: string) {
    yield* unlinkProvider(name, Accounts.PASSWORD_PROVIDER_ID);
  });

  Then("the unlink is refused", function* () {
    const { exits } = yield* World;
    assert.ok(failureOf(yield* exits.get("unlink")) instanceof Accounts.LastAccountRefusal);
  });

  Then("the refusal is reported as an invalid request outcome", function* () {
    const { exits } = yield* World;
    const outcome = yield* exits.get("unlink");
    // A typed, tagged failure the caller can render ("you have no other way to sign in").
    const failure = failureOf(outcome);
    assert.ok(failure instanceof Accounts.LastAccountRefusal);
    assert.equal(failure._tag, "LastAccountRefusal");
  });

  Then("it is not reported as a system defect", function* () {
    const { exits } = yield* World;
    assert.ok(!hasDefect(yield* exits.get("unlink")));
    // And nothing was removed.
    const accounts = yield* accountsOf(yield* userIdOf(yield* currentName()));
    assert.equal(accounts.length, 1);
  });

  // ---- BEH-EA-046 / REQ-EA-126..129: cascade on User delete, never on Account unlink ----

  When("{string}'s User row is deleted", function* (name: string) {
    const person = yield* getPerson(name);
    assert.ok(Option.isSome(person.cookie));
    const response = yield* request("DELETE", "/user", { cookie: person.cookie.value });
    assert.equal(response.status, 204, yield* bodyText(response));
  });

  Then(
    "both the {string} and {string} Accounts are unreachable",
    function* (first: string, second: string) {
      const person = yield* getPerson(yield* currentName());
      assert.ok(Option.isSome(person.userId));
      const userId = person.userId.value;
      assert.equal((yield* accountsOf(userId)).length, 0);
      assert.equal((yield* rows("SELECT id FROM accounts WHERE userId = ?", userId)).length, 0);
      for (const provider of [first, second]) {
        const subject =
          provider === Accounts.PASSWORD_PROVIDER_ID
            ? userId
            : `${provider}-${yield* currentName()}`;
        const found = yield* direct(
          Effect.flatMap(Accounts.Accounts, (accounts) =>
            accounts.findByProviderSubject(provider, subject),
          ),
        );
        assert.ok(Option.isNone(found), `${provider} must be unreachable`);
      }
    },
  );

  Given(
    "a signed-in user {string} with sessions {string} and {string}",
    function* (name: string, first: string, second: string) {
      yield* signedInWith(name, []);
      const person = yield* getPerson(name);
      assert.ok(Option.isSome(person.cookie));
      yield* nameSession(first, person.cookie.value);
      // A second, independent session: a real sign-in.
      const signedIn = yield* request("POST", "/password/sign-in", {
        body: { email: person.email, password: person.password },
      });
      assert.equal(signedIn.status, 200);
      yield* nameSession(second, cookieFrom(signedIn));
      assert.equal(yield* sessionStatus(first), 200);
      assert.equal(yield* sessionStatus(second), 200);
    },
  );

  Then("both {string} and {string} are unreachable", function* (first: string, second: string) {
    assert.equal(yield* sessionStatus(first), 401);
    assert.equal(yield* sessionStatus(second), 401);
  });

  Then("the {string} Account remains intact", function* (provider: string) {
    const remaining = yield* accountsOf(yield* userIdOf(yield* currentName()));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.providerId, provider);
  });

  Given(
    "a signed-in user {string} with Accounts {string} and {string}, and an active session {string}",
    function* (name: string, first: string, second: string, session: string) {
      yield* signedInWith(name, [first, second]);
      const person = yield* getPerson(name);
      assert.ok(Option.isSome(person.cookie));
      yield* nameSession(session, person.cookie.value);
      assert.equal(yield* sessionStatus(session), 200);
    },
  );

  Then("session {string} remains valid", function* (session: string) {
    assert.equal(yield* sessionStatus(session), 200);
  });

  // ---- BEH-EA-047 / REQ-EA-130..132: any number of Accounts and Sessions ----

  Given("a signed-in user {string} with a password credential", function* (name: string) {
    yield* signedInWith(name, []);
  });

  When(
    "{string} links two OAuth providers and a passkey in addition to her password credential",
    function* (name: string) {
      const userId = yield* userIdOf(name);
      for (const provider of ["google", "github", "passkey"]) {
        assert.ok(Exit.isSuccess(yield* linkDirect(userId, provider, `${provider}-${name}`)));
      }
    },
  );

  Then("all four Accounts coexist on {string}'s User row", function* (name: string) {
    const linked = yield* accountsOf(yield* userIdOf(name));
    assert.deepEqual(linked.map((record) => record.providerId).sort(), [
      "github",
      "google",
      "passkey",
      "password",
    ]);
  });

  Given("a signed-in user {string}", function* (name: string) {
    yield* signedInWith(name, []);
  });

  When(
    "{string} signs in from a laptop, a phone, and a CI service account acting on her behalf",
    function* (name: string) {
      const person = yield* getPerson(name);
      for (const [session, agent] of [
        ["laptop", "Laptop/1.0"],
        ["phone", "Phone/1.0"],
        ["ci", "CI-Runner/1.0"],
      ]) {
        assert.ok(session !== undefined && agent !== undefined);
        const signedIn = yield* request("POST", "/password/sign-in", {
          body: { email: person.email, password: person.password },
          headers: { "user-agent": agent },
        });
        assert.equal(signedIn.status, 200);
        yield* nameSession(session, cookieFrom(signedIn));
      }
    },
  );

  Then("all three Sessions are simultaneously valid", function* () {
    for (const session of ["laptop", "phone", "ci"]) {
      assert.equal(yield* sessionStatus(session), 200, `${session} must be valid`);
    }
  });

  Given(
    "a signed-in user {string} with an existing valid session {string}",
    function* (name: string, session: string) {
      yield* signedInWith(name, []);
      const person = yield* getPerson(name);
      assert.ok(Option.isSome(person.cookie));
      yield* nameSession(session, person.cookie.value);
      assert.equal(yield* sessionStatus(session), 200);
    },
  );

  When("{string} signs in again from a second device", function* (name: string) {
    const person = yield* getPerson(name);
    const signedIn = yield* request("POST", "/password/sign-in", {
      body: { email: person.email, password: person.password },
      headers: { "user-agent": "SecondDevice/1.0" },
    });
    assert.equal(signedIn.status, 200);
    yield* nameSession("s2", cookieFrom(signedIn));
  });

  Then("a new session {string} is issued", function* (session: string) {
    assert.notEqual(yield* sessionCookie(session), yield* sessionCookie("s1"));
    assert.equal(yield* sessionStatus(session), 200);
  });

  Then(
    "session {string} remains valid, since the base model enforces no single-active-session policy",
    function* (session: string) {
      assert.equal(yield* sessionStatus(session), 200);
    },
  );
});
