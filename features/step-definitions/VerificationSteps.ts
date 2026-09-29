// P20a (AH-003, decision 36 tier 1): 02-domain/08-verification-tokens.feature, BEH-EA-057..064,
// INV-EA-009/010. Everything runs over `DomainWorld`'s SQLite-backed composition: the wire
// (`/verify-email`, `/password/*`) where a scenario is about what a caller sees, the
// `Verification` service directly (under `TestClock`) where it is about expiry or races, and
// raw row reads where the claim is about what is persisted.
import { AuditLog, AuthEvents, Hooks, Verification } from "@awthaq/core";
import { Repositories } from "@awthaq/sql";
import { defineSteps } from "@effect-cucumber/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import { direct, directExit, World, type HeldToken } from "./DomainWorld.ts";
import {
  awaitMail,
  bodyText,
  currentPersonName,
  getPerson,
  heldTokenFrom,
  newPerson,
  request,
  rows,
  setPerson,
  signUp,
  signUpVerified,
} from "./DomainSupport.ts";

const NEW_PASSWORD = "an entirely different passphrase 4711";
const REPLAY = "auth.token.replay";

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const emailOf = (name: string) => `${name}@example.com`;

/** The event bus copy of what happened, polled on the real clock: the subscriber fiber is not driven by `TestClock`. */
const awaitEvent = Effect.fn("features.verification.awaitEvent")(function* (
  tag: string,
  identifier?: string,
) {
  const { probes } = yield* World;
  for (let attempt = 0; attempt < 500; attempt++) {
    const seen = yield* Ref.get(probes.events);
    const match = seen.find(
      (event) =>
        event._tag === tag &&
        (identifier === undefined || ("identifier" in event && event.identifier === identifier)),
    );
    if (match !== undefined) return match;
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)));
  }
  return yield* Effect.die(new Error(`no "${tag}" event was published`));
});

const eventsTagged = Effect.fn("features.verification.eventsTagged")(function* (tag: string) {
  const { probes } = yield* World;
  return (yield* Ref.get(probes.events)).filter((event) => event._tag === tag);
});

/** A token the way its issuer holds it: the row's identifier plus the plaintext only the recipient sees. */
const issueDirect = Effect.fn("features.verification.issueDirect")(function* (
  identifier: string,
  ttl: Duration.Duration,
) {
  const issued = yield* direct(
    Effect.flatMap(Verification.Verification, (verification) =>
      verification.issue({ identifier, ttl }),
    ),
  );
  const secret = Redacted.value(issued.value);
  const held: HeldToken = { identifier, mailed: `${identifier}.${secret}`, secret };
  return held;
});

const consumeDirect = (held: HeldToken) =>
  directExit(
    Effect.flatMap(Verification.Verification, (verification) =>
      verification.consume(held.identifier, Redacted.make(held.secret)),
    ),
  );

const tokenRows = (identifier: string) =>
  rows(
    "SELECT identifier, valueHash, consumedAt, userId FROM verification_tokens WHERE identifier = ?",
    identifier,
  );

const isTokenConsumedFailure = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return false;
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  return failure !== undefined && failure.error instanceof Verification.TokenConsumed;
};

export const verificationSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-057 / REQ-EA-160..162: one purpose per token ----

  Given("a request to issue an email-verification token for {string}", function* (email: string) {
    const { strings } = yield* World;
    const name = email.split("@")[0] ?? email;
    yield* setPerson(name, newPerson(email));
    yield* strings.set("purpose", "verify-email");
  });

  Given("a request to issue a password-reset token for {string}", function* (name: string) {
    // The address must belong to a real account for `requestReset` to mint a token at all.
    const { strings } = yield* World;
    yield* setPerson(name, newPerson(emailOf(name)));
    yield* signUpVerified(name);
    yield* strings.set("purpose", "reset-password");
  });

  When("the VerificationToken row is created", function* () {
    const { strings, tokens } = yield* World;
    const name = yield* currentPersonName();
    const person = yield* getPerson(name);
    const purpose = yield* strings.get("purpose");
    if (purpose === "verify-email") {
      yield* signUp(name);
      yield* tokens.set("issued", heldTokenFrom(yield* awaitMail(person.email, "verify-email")));
    } else {
      const response = yield* request("POST", "/password/request-reset", {
        body: { email: person.email },
      });
      assert.equal(response.status, 202);
      yield* tokens.set("issued", heldTokenFrom(yield* awaitMail(person.email, "reset-password")));
    }
  });

  Then("its identifier is scoped to {string}", function* (scoped: string) {
    const { tokens } = yield* World;
    const held = yield* tokens.get("issued");
    const prefix = scoped.slice(0, scoped.indexOf("<"));
    const persisted = yield* tokenRows(held.identifier);
    assert.equal(
      persisted.length,
      1,
      "the token must be persisted under the identifier it was mailed with",
    );
    assert.ok(held.identifier.startsWith(prefix), `${held.identifier} must start with ${prefix}`);
    assert.ok(
      held.identifier.length > prefix.length,
      "the purpose prefix is followed by a token id",
    );
    assert.ok(held.mailed.startsWith(`${held.identifier}.`), "the mailed token names its own row");
    // ARF-009: the identifier is a random public id, never the user's id or address.
    const person = yield* getPerson(yield* currentPersonName());
    assert.ok(!held.identifier.includes(person.email), "the identifier must not carry the address");
  });

  Given("a VerificationToken issued for email verification", function* () {
    const { tokens } = yield* World;
    yield* setPerson("alice", newPerson(emailOf("alice")));
    yield* signUp("alice");
    yield* tokens.set("verify", heldTokenFrom(yield* awaitMail(emailOf("alice"), "verify-email")));
  });

  When("that token is presented to the password-reset consumption check", function* () {
    const { tokens, responses } = yield* World;
    const held = yield* tokens.get("verify");
    yield* responses.set(
      "presented",
      yield* request("POST", "/password/confirm-reset", {
        body: { token: held.mailed, password: NEW_PASSWORD },
      }),
    );
  });

  Then(
    "the password-reset check fails, since the token's identifier is not scoped to {string}",
    function* (prefix: string) {
      const { tokens, responses } = yield* World;
      const held = yield* tokens.get("verify");
      const response = yield* responses.get("presented");
      assert.equal(response.status, 410);
      assert.match(yield* bodyText(response), /TokenConsumed/);
      assert.ok(!held.identifier.startsWith(prefix), "the presented token is of another purpose");
      // Refused before any consume: the email-verification row must still be live.
      const persisted = yield* tokenRows(held.identifier);
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]?.["consumedAt"], null);
    },
  );

  Given("a user {string} with a live email-verification token", function* (name: string) {
    const { tokens } = yield* World;
    yield* setPerson(name, newPerson(emailOf(name)));
    yield* signUp(name);
    yield* tokens.set("verify", heldTokenFrom(yield* awaitMail(emailOf(name), "verify-email")));
  });

  When("a password-reset token is also issued for {string}", function* (name: string) {
    const { tokens } = yield* World;
    const person = yield* getPerson(name);
    const response = yield* request("POST", "/password/request-reset", {
      body: { email: person.email },
    });
    assert.equal(response.status, 202);
    yield* tokens.set("reset", heldTokenFrom(yield* awaitMail(person.email, "reset-password")));
  });

  Then("both tokens coexist as structurally distinct VerificationToken rows", function* () {
    const { tokens } = yield* World;
    const verify = yield* tokens.get("verify");
    const reset = yield* tokens.get("reset");
    assert.notEqual(verify.identifier, reset.identifier);
    assert.match(verify.identifier, /^verify-email:/);
    assert.match(reset.identifier, /^reset-password:/);
    for (const held of [verify, reset]) {
      const persisted = yield* tokenRows(held.identifier);
      assert.equal(persisted.length, 1, `${held.identifier} must be its own row`);
      assert.equal(persisted[0]?.["consumedAt"], null, `${held.identifier} must still be live`);
    }
  });

  // ---- BEH-EA-058 / REQ-EA-163..165: consume + state change, one transaction ----

  Given("a live password-reset token for {string}", function* (name: string) {
    const { tokens, strings } = yield* World;
    yield* setPerson(name, newPerson(emailOf(name)));
    yield* signUpVerified(name);
    const response = yield* request("POST", "/password/request-reset", {
      body: { email: emailOf(name) },
    });
    assert.equal(response.status, 202);
    yield* tokens.set("reset", heldTokenFrom(yield* awaitMail(emailOf(name), "reset-password")));
    yield* strings.set("resetter", name);
  });

  When("{string} confirms the reset with that token", function* (name: string) {
    const { tokens, responses } = yield* World;
    const held = yield* tokens.get("reset");
    yield* getPerson(name);
    yield* responses.set(
      "confirm",
      yield* request("POST", "/password/confirm-reset", {
        body: { token: held.mailed, password: NEW_PASSWORD },
      }),
    );
  });

  Then("the token is marked consumed", function* () {
    const { tokens, responses } = yield* World;
    const held = yield* tokens.get("reset");
    assert.equal((yield* responses.get("confirm")).status, 204);
    const persisted = yield* tokenRows(held.identifier);
    assert.equal(persisted.length, 1);
    assert.notEqual(persisted[0]?.["consumedAt"], null, "the row must carry a consumption time");
    // And the mailed link is dead for a second use.
    const replay = yield* request("POST", "/password/confirm-reset", {
      body: { token: held.mailed, password: NEW_PASSWORD },
    });
    assert.equal(replay.status, 410);
  });

  Then("the password change is applied", function* () {
    const { strings } = yield* World;
    const person = yield* getPerson(yield* strings.get("resetter"));
    const withNew = yield* request("POST", "/password/sign-in", {
      body: { email: person.email, password: NEW_PASSWORD },
    });
    assert.equal(withNew.status, 200, "the new password must sign in");
    const withOld = yield* request("POST", "/password/sign-in", {
      body: { email: person.email, password: person.password },
    });
    assert.equal(withOld.status, 401, "the old password must no longer sign in");
  });

  Then("both effects commit under one SQL transaction", function* () {
    const { probes } = yield* World;
    const sightings = yield* Ref.get(probes.sightings);
    // One `SqlTransaction.withTransaction` saw the token consumed, the password written and
    // the sessions revoked: same non-zero transaction id for all three.
    const byTransaction = new Map<number, Set<string>>();
    for (const sighting of sightings) {
      if (sighting.transaction === 0) continue;
      byTransaction.set(
        sighting.transaction,
        (byTransaction.get(sighting.transaction) ?? new Set()).add(sighting.operation),
      );
    }
    const together = [...byTransaction.values()].some(
      (operations) =>
        operations.has("Verification.consume") &&
        operations.has("Accounts.updateCredentialHash") &&
        operations.has("Sessions.revokeAll"),
    );
    assert.ok(
      together,
      `consume, the credential write and the session revocation must share one transaction; saw ${JSON.stringify(sightings)}`,
    );
    const outside = sightings.filter(
      (sighting) =>
        sighting.transaction === 0 && sighting.operation === "Accounts.updateCredentialHash",
    );
    assert.equal(outside.length, 0, "the credential write must never run outside a transaction");
  });

  When("two concurrent requests race to confirm the reset using that same token", function* () {
    const { tokens, responses } = yield* World;
    const held = yield* tokens.get("reset");
    const [first, second] = yield* Effect.all(
      [
        request("POST", "/password/confirm-reset", {
          body: { token: held.mailed, password: `${NEW_PASSWORD} one` },
        }),
        request("POST", "/password/confirm-reset", {
          body: { token: held.mailed, password: `${NEW_PASSWORD} two` },
        }),
      ],
      { concurrency: 2 },
    );
    yield* responses.set("race-one", first);
    yield* responses.set("race-two", second);
  });

  Then("at most one request applies the password change", function* () {
    const { responses, strings } = yield* World;
    const first = yield* responses.get("race-one");
    const second = yield* responses.get("race-two");
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(
      statuses,
      [204, 410],
      "exactly one caller wins, the other is told the token is spent",
    );
    // Whichever won, only its password is in force.
    const person = yield* getPerson(yield* strings.get("resetter"));
    const winnerPassword = first.status === 204 ? `${NEW_PASSWORD} one` : `${NEW_PASSWORD} two`;
    const loserPassword = first.status === 204 ? `${NEW_PASSWORD} two` : `${NEW_PASSWORD} one`;
    const signInWith = (password: string) =>
      request("POST", "/password/sign-in", { body: { email: person.email, password } });
    assert.equal((yield* signInWith(winnerPassword)).status, 200);
    assert.equal((yield* signInWith(loserPassword)).status, 401);
  });

  Then("the token is consumed exactly once, not twice", function* () {
    const { tokens, probes } = yield* World;
    const held = yield* tokens.get("reset");
    const persisted = yield* tokenRows(held.identifier);
    assert.equal(persisted.length, 1);
    assert.notEqual(persisted[0]?.["consumedAt"], null);
    const sightings = yield* Ref.get(probes.sightings);
    const writes = sightings.filter(
      (sighting) => sighting.operation === "Accounts.updateCredentialHash",
    );
    assert.equal(writes.length, 1, "the password change was applied by exactly one request");
  });

  When("confirming the reset fails while applying the password change", function* () {
    const { tokens, responses, probes } = yield* World;
    const held = yield* tokens.get("reset");
    yield* Ref.update(probes.faults, (faults) => ({ ...faults, failCredentialUpdate: true }));
    yield* responses.set(
      "confirm",
      yield* request("POST", "/password/confirm-reset", {
        body: { token: held.mailed, password: NEW_PASSWORD },
      }),
    );
    yield* Ref.update(probes.faults, (faults) => ({ ...faults, failCredentialUpdate: false }));
  });

  Then("the token is not left marked consumed", function* () {
    const { tokens, responses } = yield* World;
    const held = yield* tokens.get("reset");
    assert.equal(
      (yield* responses.get("confirm")).status,
      500,
      "the injected crash surfaces as a server error",
    );
    const persisted = yield* tokenRows(held.identifier);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.["consumedAt"], null, "the consumption must have rolled back");
  });

  Then(
    "the transaction rolls back both the consumption and the state change together",
    function* () {
      const { tokens, strings } = yield* World;
      const held = yield* tokens.get("reset");
      const person = yield* getPerson(yield* strings.get("resetter"));
      // The state change is undone: the old password still signs in, the new one does not.
      const withOld = yield* request("POST", "/password/sign-in", {
        body: { email: person.email, password: person.password },
      });
      assert.equal(withOld.status, 200);
      const withNew = yield* request("POST", "/password/sign-in", {
        body: { email: person.email, password: NEW_PASSWORD },
      });
      assert.equal(withNew.status, 401);
      // The consumption is undone: the very same token still redeems once the fault is gone.
      const retry = yield* request("POST", "/password/confirm-reset", {
        body: { token: held.mailed, password: NEW_PASSWORD },
      });
      assert.equal(retry.status, 204);
    },
  );

  // ---- BEH-EA-059 / REQ-EA-166..170: replay is observable ----

  Given("a VerificationToken that has already been consumed", function* () {
    const { tokens } = yield* World;
    yield* setPerson("alice", newPerson(emailOf("alice")));
    yield* signUp("alice");
    const held = heldTokenFrom(yield* awaitMail(emailOf("alice"), "verify-email"));
    const consumed = yield* request("POST", "/verify-email", { body: { token: held.mailed } });
    assert.equal(consumed.status, 204);
    yield* tokens.set("consumed", held);
  });

  Given("an already-consumed token is presented again", function* () {
    const { tokens } = yield* World;
    yield* setPerson("alice", newPerson(emailOf("alice")));
    yield* signUp("alice");
    const held = heldTokenFrom(yield* awaitMail(emailOf("alice"), "verify-email"));
    const consumed = yield* request("POST", "/verify-email", { body: { token: held.mailed } });
    assert.equal(consumed.status, 204);
    yield* tokens.set("consumed", held);
  });

  When("the same token is presented for consumption again", function* () {
    const { tokens, responses, strings } = yield* World;
    const held = yield* tokens.get("consumed");
    yield* strings.set("presented", held.identifier);
    yield* strings.set("channel", "http");
    yield* responses.set(
      "presented",
      yield* request("POST", "/verify-email", { body: { token: held.mailed } }),
    );
  });

  When("the replay attempt is handled", function* () {
    const { tokens, responses, strings } = yield* World;
    const held = yield* tokens.get("consumed");
    yield* strings.set("presented", held.identifier);
    yield* strings.set("channel", "http");
    yield* responses.set(
      "presented",
      yield* request("POST", "/verify-email", { body: { token: held.mailed } }),
    );
  });

  Then("the request fails with {string}", function* (failure: string) {
    const { responses } = yield* World;
    const [status, tag] = failure.split(" ");
    const response = yield* responses.get("presented");
    assert.equal(response.status, Number(status));
    assert.match(yield* bodyText(response), new RegExp(String(tag)));
  });

  Then("an {string} event is published to AuthEvents", function* (tag: string) {
    const { strings } = yield* World;
    yield* awaitEvent(tag, yield* strings.get("presented"));
  });

  Given("a VerificationToken past its expiresAt", function* () {
    const { tokens } = yield* World;
    const held = yield* issueDirect("verify-email:expired-token-id", Duration.minutes(15));
    yield* TestClock.adjust(Duration.minutes(16));
    yield* tokens.set("expired", held);
  });

  When("the token is presented for consumption", function* () {
    const { tokens, exits, strings } = yield* World;
    const held = yield* tokens.get("expired");
    yield* strings.set("presented", held.identifier);
    yield* strings.set("channel", "exit");
    yield* exits.set("presented", yield* consumeDirect(held));
  });

  Then("the request fails", function* () {
    const { exits, responses, strings } = yield* World;
    if ((yield* strings.get("channel")) === "exit") {
      assert.ok(
        isTokenConsumedFailure(yield* exits.get("presented")),
        "consumption must fail with TokenConsumed",
      );
    } else {
      assert.equal((yield* responses.get("presented")).status, 410);
    }
  });

  Given("a token identifier that does not correspond to any VerificationToken row", function* () {
    const { tokens } = yield* World;
    const identifier = "verify-email:no-such-token-id";
    assert.equal((yield* tokenRows(identifier)).length, 0);
    yield* tokens.set("unknown", {
      identifier,
      mailed: `${identifier}.not-a-real-secret`,
      secret: "not-a-real-secret",
    });
  });

  When("it is presented for consumption", function* () {
    const { tokens, responses, strings } = yield* World;
    const held = yield* tokens.get("unknown");
    yield* strings.set("presented", held.identifier);
    yield* strings.set("channel", "http");
    yield* responses.set(
      "presented",
      yield* request("POST", "/verify-email", { body: { token: held.mailed } }),
    );
  });

  Then("{string} is published to AuthEvents", function* (tag: string) {
    const { strings } = yield* World;
    yield* awaitEvent(tag, yield* strings.get("presented"));
  });

  Then(
    "this publication happens regardless of whatever the audit table separately records as the durable record of record",
    function* () {
      // The bus copy is published exactly once for the presented identifier whatever the audit
      // table holds: the transaction the replayed consume ran in rolled back with the failure
      // (PV-220), yet the subscriber still saw the event.
      const { strings, probes } = yield* World;
      const identifier = yield* strings.get("presented");
      yield* awaitEvent(REPLAY, identifier);
      const seen = (yield* Ref.get(probes.events)).filter(
        (event) => event._tag === REPLAY && event.identifier === identifier,
      );
      assert.equal(seen.length, 1);
    },
  );

  Then("the durable audit table holds an {string} row for that token", function* (tag: string) {
    const { strings } = yield* World;
    const identifier = yield* strings.get("presented");
    yield* awaitEvent(tag, identifier);
    const audited = yield* direct(
      Effect.flatMap(AuditLog.AuditLog, (log) => log.list({ eventTag: REPLAY })),
    );
    assert.ok(
      audited.some(
        (record) => record.payload._tag === REPLAY && record.payload.identifier === identifier,
      ),
      "the replay must leave a durable audit row even though its consume failed",
    );
  });

  Given("a VerificationToken that has not yet been consumed", function* () {
    const { tokens } = yield* World;
    yield* setPerson("alice", newPerson(emailOf("alice")));
    yield* signUp("alice");
    yield* tokens.set("fresh", heldTokenFrom(yield* awaitMail(emailOf("alice"), "verify-email")));
  });

  When("it is consumed for the first time", function* () {
    const { tokens, responses } = yield* World;
    const held = yield* tokens.get("fresh");
    yield* responses.set(
      "presented",
      yield* request("POST", "/verify-email", { body: { token: held.mailed } }),
    );
  });

  Then("no {string} event is published", function* (tag: string) {
    const { responses } = yield* World;
    assert.equal((yield* responses.get("presented")).status, 204);
    // The success event proves the publish pipeline has drained; only then is absence meaningful.
    yield* awaitEvent("auth.user.emailVerified");
    yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    assert.equal((yield* eventsTagged(tag)).length, 0);
  });

  // ---- BEH-EA-060 / REQ-EA-171..173: hashed at rest ----

  Then("the persisted row stores a hash of the token value", function* () {
    const { tokens } = yield* World;
    const held = yield* tokens.get("issued");
    const persisted = yield* tokenRows(held.identifier);
    assert.equal(persisted.length, 1);
    // An independent SHA-256 (node:crypto, not the code under test) of the plaintext secret.
    assert.equal(persisted[0]?.["valueHash"], sha256Hex(held.secret));
  });

  Then("it does not store the token's plaintext", function* () {
    const { tokens } = yield* World;
    const held = yield* tokens.get("issued");
    const all = yield* rows("SELECT * FROM verification_tokens");
    for (const row of all) {
      for (const value of Object.values(row)) {
        assert.ok(
          typeof value !== "string" || !value.includes(held.secret),
          "no persisted column may contain the plaintext token value",
        );
      }
    }
  });

  Given("a live VerificationToken whose hash was computed at issuance", function* () {
    const { tokens } = yield* World;
    yield* setPerson("alice", newPerson(emailOf("alice")));
    yield* signUp("alice");
    const held = heldTokenFrom(yield* awaitMail(emailOf("alice"), "verify-email"));
    const persisted = yield* tokenRows(held.identifier);
    assert.equal(persisted[0]?.["valueHash"], sha256Hex(held.secret));
    yield* tokens.set("live", held);
  });

  When("the caller presents the plaintext token for consumption", function* () {
    const { tokens, responses } = yield* World;
    const held = yield* tokens.get("live");
    yield* responses.set(
      "presented",
      yield* request("POST", "/verify-email", { body: { token: held.mailed } }),
    );
  });

  Then(
    "the presented value is hashed the same way and compared against the stored hash",
    function* () {
      const { tokens, responses } = yield* World;
      const held = yield* tokens.get("live");
      // Consumption only succeeds when hash(presented) equals the stored hash…
      assert.equal((yield* responses.get("presented")).status, 204);
      // …and the stored hash is exactly SHA-256 of the plaintext that was presented.
      const persisted = yield* tokenRows(held.identifier);
      assert.equal(persisted[0]?.["valueHash"], sha256Hex(held.secret));
    },
  );

  Given("the VerificationToken table's rows have been disclosed", function* () {
    const { tokens } = yield* World;
    yield* setPerson("alice", newPerson(emailOf("alice")));
    yield* signUpVerified("alice");
    const response = yield* request("POST", "/password/request-reset", {
      body: { email: emailOf("alice") },
    });
    assert.equal(response.status, 202);
    const held = heldTokenFrom(yield* awaitMail(emailOf("alice"), "reset-password"));
    yield* tokens.set("reset", held);
  });

  When(
    "an attacker presents a disclosed row's stored hash directly as if it were the plaintext token",
    function* () {
      const { tokens, responses } = yield* World;
      const held = yield* tokens.get("reset");
      const disclosed = yield* tokenRows(held.identifier);
      const storedHash = String(disclosed[0]?.["valueHash"]);
      yield* responses.set(
        "presented",
        yield* request("POST", "/password/confirm-reset", {
          body: { token: `${held.identifier}.${storedHash}`, password: NEW_PASSWORD },
        }),
      );
    },
  );

  Then(
    "the consumption check fails, since presenting the hash does not reproduce the plaintext token",
    function* () {
      const { tokens, responses } = yield* World;
      const held = yield* tokens.get("reset");
      assert.equal((yield* responses.get("presented")).status, 410);
      const persisted = yield* tokenRows(held.identifier);
      assert.equal(
        persisted[0]?.["consumedAt"],
        null,
        "the attempt must not have consumed the real token",
      );
    },
  );

  // ---- BEH-EA-061 / REQ-EA-174..175: expiry is enforced on read ----

  Given(
    "a VerificationToken whose expiresAt has passed and whose row has not been physically deleted",
    function* () {
      const { tokens } = yield* World;
      const held = yield* issueDirect("verify-email:expired-row-id", Duration.minutes(15));
      yield* TestClock.adjust(Duration.minutes(16));
      assert.equal(
        (yield* tokenRows(held.identifier)).length,
        1,
        "the row is still physically there",
      );
      yield* tokens.set("expired", held);
    },
  );

  Then("it is rejected as invalid", function* () {
    const { exits } = yield* World;
    assert.ok(isTokenConsumedFailure(yield* exits.get("presented")));
  });

  Given(
    "a VerificationToken that expired long ago and no cleanup process has ever executed",
    function* () {
      const { tokens } = yield* World;
      const held = yield* issueDirect("verify-email:long-expired-id", Duration.minutes(15));
      yield* TestClock.adjust(Duration.days(400));
      // Nothing in this composition schedules `Retention.sweep`; the row is proof no cleanup ran.
      assert.equal((yield* tokenRows(held.identifier)).length, 1);
      yield* tokens.set("expired", held);
    },
  );

  Then("it is rejected as invalid based on its expiresAt alone", function* () {
    const { exits, tokens } = yield* World;
    assert.ok(isTokenConsumedFailure(yield* exits.get("presented")));
    const held = yield* tokens.get("expired");
    const persisted = yield* tokenRows(held.identifier);
    assert.equal(persisted.length, 1, "the row was rejected while still present");
    assert.equal(
      persisted[0]?.["consumedAt"],
      null,
      "and it was rejected by expiry, not because it was consumed",
    );
  });

  // ---- BEH-EA-062 / REQ-EA-176..179: race-safe consumption ----

  Given("a live VerificationToken identifier", function* () {
    const { tokens } = yield* World;
    yield* tokens.set(
      "live",
      yield* issueDirect("reset-password:race-token-id", Duration.minutes(15)),
    );
  });

  When(
    "{int} callers race to consume that same token identifier concurrently",
    function* (callers: number) {
      const { tokens, exits } = yield* World;
      const held = yield* tokens.get("live");
      const outcomes = yield* Effect.all(
        Array.from({ length: callers }, () => consumeDirect(held)),
        { concurrency: "unbounded" },
      );
      for (const [index, outcome] of outcomes.entries()) {
        yield* exits.set(`caller-${index}`, outcome);
      }
      const { numbers } = yield* World;
      yield* numbers.set("callers", callers);
    },
  );

  Then("at most one caller receives the non-expired row as a success", function* () {
    const { exits, numbers } = yield* World;
    const callers = yield* numbers.get("callers");
    let winners = 0;
    for (let index = 0; index < callers; index++) {
      if (Exit.isSuccess(yield* exits.get(`caller-${index}`))) winners++;
    }
    assert.equal(winners, 1, "the live token is consumed by exactly one caller");
  });

  Then("every caller other than the winner receives {string}", function* (_notFound: string) {
    // "not found" is `TokenConsumed`: unknown, expired and already-consumed are one indistinguishable outcome.
    const { exits, numbers } = yield* World;
    const callers = yield* numbers.get("callers");
    let losers = 0;
    for (let index = 0; index < callers; index++) {
      const outcome = yield* exits.get(`caller-${index}`);
      if (Exit.isSuccess(outcome)) continue;
      assert.ok(isTokenConsumedFailure(outcome), "a losing caller must be told the token is gone");
      losers++;
    }
    assert.equal(losers, callers - 1);
  });

  Then(
    "no live VerificationToken row for it remains once the race resolves, regardless of which caller won",
    function* () {
      // As shipped (CSG-003/BEH-EA-061): `layerSql` keeps the consumed row as replay evidence
      // until the retention window passes, so "gone" means no *live* row remains and no caller
      // can consume it again — not that the record was physically deleted.
      const { tokens } = yield* World;
      const held = yield* tokens.get("live");
      const live = yield* rows(
        "SELECT id FROM verification_tokens WHERE identifier = ? AND consumedAt IS NULL",
        held.identifier,
      );
      assert.equal(live.length, 0);
      assert.ok(isTokenConsumedFailure(yield* consumeDirect(held)));
    },
  );

  When(
    "a caller applies its state change unconditionally without gating on a non-null consume result",
    function* () {
      const { tokens, numbers } = yield* World;
      const held = yield* tokens.get("live");
      const applied = yield* Ref.make(0);
      const callers = 3;
      const outcomes = yield* Effect.all(
        Array.from({ length: callers }, () =>
          consumeDirect(held).pipe(
            // The bug under test: the state change does not look at what `consume` returned.
            Effect.tap(() => Ref.update(applied, (count) => count + 1)),
          ),
        ),
        { concurrency: "unbounded" },
      );
      yield* numbers.set("applied", yield* Ref.get(applied));
      yield* numbers.set("granted", outcomes.filter((outcome) => Exit.isSuccess(outcome)).length);
    },
  );

  Then("the race-safety guarantee does not protect that caller", function* () {
    const { numbers } = yield* World;
    const applied = yield* numbers.get("applied");
    const granted = yield* numbers.get("granted");
    assert.ok(
      applied > granted,
      `the change applied ${applied} times though consume granted ${granted}`,
    );
  });

  Then(
    "any resulting double-application is attributable to the caller, not to the consumption operation",
    function* () {
      const { numbers } = yield* World;
      // The operation itself held: exactly one success. Only the ungated callers applied more.
      assert.equal(yield* numbers.get("granted"), 1);
    },
  );

  // ---- BEH-EA-063 / REQ-EA-180..183: reservations ----

  const RESERVATION_TTL = Duration.minutes(10);
  const reserveDirect = (identifier: string) =>
    directExit(
      Effect.flatMap(Verification.Verification, (verification) =>
        verification.reserve({ identifier, ttl: RESERVATION_TTL }),
      ),
    );

  Given("no reservation exists for identifier {string}", function* (identifier: string) {
    const reserved = yield* rows(
      "SELECT identifier FROM verification_reservations WHERE identifier = ?",
      identifier,
    );
    assert.equal(reserved.length, 0);
  });

  Given(
    "identifier {string} was just reserved and has not expired",
    function* (identifier: string) {
      assert.deepEqual(yield* reserveDirect(identifier), Exit.succeed(true));
    },
  );

  Given(
    "identifier {string} was reserved and that reservation has since expired",
    function* (identifier: string) {
      assert.deepEqual(yield* reserveDirect(identifier), Exit.succeed(true));
      yield* TestClock.adjust(Duration.minutes(11));
    },
  );

  When("a caller reserves identifier {string}", function* (identifier: string) {
    const { exits } = yield* World;
    yield* exits.set("reservation", yield* reserveDirect(identifier));
  });

  When("a second caller reserves the same identifier {string}", function* (identifier: string) {
    const { exits } = yield* World;
    yield* exits.set("reservation", yield* reserveDirect(identifier));
  });

  When("a caller reserves identifier {string} again", function* (identifier: string) {
    const { exits } = yield* World;
    yield* exits.set("reservation", yield* reserveDirect(identifier));
  });

  Then("the reservation returns {string}", function* (expected: string) {
    const { exits } = yield* World;
    assert.deepEqual(yield* exits.get("reservation"), Exit.succeed(expected === "true"));
  });

  Given("a store implementation that cannot guarantee atomic reservation", function* () {
    // A reservations repository whose conditional claim (the atomic step) is unavailable.
    const { strings } = yield* World;
    yield* strings.set("store", "cannot-claim-atomically");
  });

  When("a caller attempts to reserve an identifier against that store", function* () {
    const { exits } = yield* World;
    const DownReservations = Layer.effect(
      Repositories.VerificationReservationsRepository,
      Effect.gen(function* () {
        const real = yield* Repositories.VerificationReservationsRepository;
        return {
          ...real,
          claim: () =>
            Effect.fail(
              new SqlError({ reason: new UnknownError({ cause: new Error("claim unavailable") }) }),
            ),
        };
      }),
    ).pipe(Layer.provide(Repositories.VerificationReservationsRepositoryLive));
    const DownVerification = Verification.layerSql.pipe(
      Layer.provide(Layer.mergeAll(Repositories.VerificationRepositoryLive, DownReservations)),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(AuthEvents.layer),
      Layer.provide(AuditLog.layerMemory),
      Layer.provide(Hooks.HooksLive),
    );
    yield* exits.set(
      "reservation",
      yield* directExit(
        Effect.flatMap(Verification.Verification, (verification) =>
          verification.reserve({ identifier: "promote-user-42", ttl: RESERVATION_TTL }),
        ).pipe(Effect.provide(DownVerification, { local: true })),
      ),
    );
  });

  Then("the reservation fails closed", function* () {
    const { exits } = yield* World;
    const outcome = yield* exits.get("reservation");
    assert.ok(Exit.isFailure(outcome), "an unavailable store must not answer at all");
    const failure = Exit.isFailure(outcome)
      ? outcome.cause.reasons.find((reason) => reason._tag === "Fail")
      : undefined;
    assert.equal(failure?._tag, "Fail", "the failure is typed (StoreUnavailable), not a defect");
  });

  Then("it never reports a false success", function* () {
    const { exits } = yield* World;
    assert.ok(!Exit.isSuccess(yield* exits.get("reservation")));
  });

  // ---- BEH-EA-064 / REQ-EA-184: uniform response ----

  Given(
    "a {string} request submitted for an email belonging to {}",
    function* (flow: string, state: string) {
      const { strings } = yield* World;
      const exists = state === "an existing account";
      const email = exists ? emailOf("dana") : "nobody@example.com";
      if (exists) {
        yield* setPerson("dana", newPerson(email));
        yield* signUp("dana");
      }
      yield* strings.set("flow", flow);
      yield* strings.set("email", email);
      yield* strings.set("exists", exists ? "yes" : "no");
    },
  );

  When("the request is handled", function* () {
    const { strings, responses } = yield* World;
    const path = flowPath(yield* strings.get("flow"));
    yield* responses.set(
      "presented",
      yield* request("POST", path, { body: { email: yield* strings.get("email") } }),
    );
  });

  Then("the response is {string}", function* (expected: string) {
    const { responses } = yield* World;
    const [status] = expected.split(" ");
    assert.equal((yield* responses.get("presented")).status, Number(status));
  });

  Then("the response body does not reveal whether the account exists", function* () {
    const { strings, responses } = yield* World;
    const flow = yield* strings.get("flow");
    const mine = yield* responses.get("presented");
    // The counterpart request, for the opposite account state, must be indistinguishable.
    const existed = (yield* strings.get("exists")) === "yes";
    let otherEmail = "still-nobody@example.com";
    if (!existed) {
      yield* setPerson("erin", newPerson(emailOf("erin")));
      yield* signUp("erin");
      otherEmail = emailOf("erin");
    }
    const other = yield* request("POST", flowPath(flow), { body: { email: otherEmail } });
    assert.equal(other.status, mine.status);
    assert.equal(yield* bodyText(other), yield* bodyText(mine));
    assert.equal(other.headers.get("content-type"), mine.headers.get("content-type"));
    assert.ok(!(yield* bodyText(mine)).includes(yield* strings.get("email")));
  });
});

const flowPath = (flow: string) =>
  flow === "password reset" ? "/password/request-reset" : "/resend-verification";
