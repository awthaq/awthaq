// Shipping-gap map (.scratch/shipping-gaps), ticket 21; AH-005/AH-004/BDD-008 rework: a Given
// arranges (or asserts) state, the When performs the action its scenario names, and no Then
// hardcodes an actor — pronoun steps resolve the current actor from the World's registry.
import { defineSteps } from "@effect-cucumber/vitest";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  World,
  advance,
  assertNoLeaks,
  assertSecretNeverObserved,
  awaitGateEntered,
  configureSessions,
  countSessionRows,
  gateAdmitted,
  getSession,
  mailedTo,
  nowMillis,
  pinSessionSecret,
  postSession,
  readSessionRow,
  releaseGate,
  requestAsActor,
  settle,
  signInAgain,
  signUp,
  startRequest,
  aliasActor,
  type SessionRow,
} from "./SessionWorld.ts";
import { mailedToken } from "./MailedToken.ts";
import { cookieFrom, setCookieFrom, STRONG_PASSWORD } from "./shared/Harness.ts";

/** The `id.secret` halves of a `__Host-session=...` cookie pair. */
const tokenParts = (cookie: string) => {
  const token = decodeURIComponent(cookie.replace(/^__Host-session=/, ""));
  const parts = token.split(".");
  assert.equal(parts.length, 2, "a session token is exactly <id>.<secret>");
  const [id, secret] = parts;
  assert.ok(id !== undefined && id.length > 0, "the token's id half is present");
  assert.ok(secret !== undefined && secret.length > 0, "the token's secret half is present");
  return { id, secret };
};

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const column = (row: SessionRow, name: string) => {
  const value = row[name];
  assert.equal(typeof value, "string", `expected column "${name}" to be text`);
  return String(value);
};

const millis = (row: SessionRow, name: string) => {
  const parsed = Date.parse(column(row, name));
  assert.ok(!Number.isNaN(parsed), `column "${name}" is not a timestamp: ${column(row, name)}`);
  return parsed;
};

const SessionBody = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    current: Schema.Boolean,
    userAgent: Schema.NullOr(Schema.String),
  }),
);

export const sessionSteps = defineSteps<World>(({ Given, When, Then }) => {
  const signedUp = (name: string) =>
    Effect.gen(function* () {
      const { actors } = yield* World;
      yield* signUp(name);
      return yield* actors.get(name);
    });

  // ---- REQ-EA-136..140: token shape, persisted row, disclosed table ----

  Given("a signed-in user {string}", function* (name: string) {
    yield* signUp(name);
  });

  Given("a session has been issued for {string}", function* (name: string) {
    yield* signUp(name);
  });

  When("a session is issued for {string}", function* (name: string) {
    const { actors, responses } = yield* World;
    const response = yield* signInAgain(name, name);
    yield* actors.use(name);
    yield* responses.set(name, response);
  });

  Then('the returned token has the shape "<id>.<secret>"', function* () {
    const { actors, responses } = yield* World;
    const name = yield* actors.current;
    const response = yield* responses.get(name);
    const { id, secret } = tokenParts(cookieFrom(response));
    // The id half is the public session id the service reports for that very session.
    const current = yield* getSession("/session", (yield* actors.get(name)).cookie);
    const body = yield* Effect.promise(() => current.json());
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
      body,
    ).pipe(Effect.orDie);
    assert.equal(decoded.id, id);
    assert.ok(secret.length >= 16, "the secret half carries real entropy");
  });

  // AH-005: the guard records every span, log line and published event. Issuance already
  // happened before the secret was known, so it is the *use* of the token that is watched for
  // the plaintext; a `Redacted` instance reaching any channel is flagged whenever it happens.
  Then("the secret component is redacted in any log or span", function* () {
    const { actors } = yield* World;
    const actor = yield* actors.get(yield* actors.current);
    yield* assertSecretNeverObserved(tokenParts(actor.cookie).secret);
    assert.equal((yield* getSession("/session", actor.cookie)).status, 200);
    yield* assertNoLeaks();
  });

  When(
    "the persisted Session row is read directly, without the value returned at issuance",
    function* () {
      const { actors, snapshots } = yield* World;
      const actor = yield* actors.get(yield* actors.current);
      yield* snapshots.set("row", yield* readSessionRow(tokenParts(actor.cookie).id));
    },
  );

  Then("the secret component cannot be reconstructed from it", function* () {
    const { actors, snapshots } = yield* World;
    const { secret } = tokenParts((yield* actors.get(yield* actors.current)).cookie);
    const row = yield* snapshots.get("row");
    // No column carries the secret, and the one credential column is a one-way digest of it.
    for (const [key, value] of Object.entries(row)) {
      assert.ok(!String(value).includes(secret), `column "${key}" leaks the secret`);
    }
    assert.match(column(row, "secretHash"), /^[0-9a-f]{64}$/);
    assert.notEqual(column(row, "secretHash"), secret);
  });

  Then('the persisted Session row stores "SHA-256\\(secret\\)"', function* () {
    const { actors } = yield* World;
    const { id, secret } = tokenParts((yield* actors.get(yield* actors.current)).cookie);
    const row = yield* readSessionRow(id);
    // Computed independently with node:crypto, not the code under test.
    assert.equal(column(row, "secretHash"), sha256Hex(secret));
  });

  Then("the persisted Session row does not store the plaintext secret", function* () {
    const { actors } = yield* World;
    const { id, secret } = tokenParts((yield* actors.get(yield* actors.current)).cookie);
    const row = yield* readSessionRow(id);
    for (const [key, value] of Object.entries(row)) {
      assert.ok(!String(value).includes(secret), `column "${key}" stores the plaintext secret`);
    }
  });

  // The scenario names the secret "s3cr3t"; the real secret is service-generated, so the row's
  // digest is pinned to SHA-256("s3cr3t") and the session's cookie carries that secret.
  Given(
    "a session issued for {string} with secret {string}",
    function* (name: string, secret: string) {
      const { actors } = yield* World;
      yield* signUp(name);
      const actor = yield* actors.get(name);
      const { id } = tokenParts(actor.cookie);
      yield* pinSessionSecret(id, sha256Hex(secret));
      yield* actors.set(name, { ...actor, cookie: `__Host-session=${id}.${secret}` });
    },
  );

  When("the token is presented for verification", function* () {
    const { actors, responses } = yield* World;
    const name = yield* actors.current;
    const actor = yield* actors.get(name);
    yield* responses.set(name, yield* getSession("/session", actor.cookie));
  });

  Then(
    "the presented secret is hashed and the hash is compared against the stored hash",
    function* () {
      const { actors, responses } = yield* World;
      const name = yield* actors.current;
      const actor = yield* actors.get(name);
      const { id, secret } = tokenParts(actor.cookie);
      assert.equal((yield* responses.get(name)).status, 200);
      const stored = column(yield* readSessionRow(id), "secretHash");
      assert.equal(stored, sha256Hex(secret));
      // Only the hash of the presented secret matches: the stored digest itself is no secret,
      // and a one-character change to the real secret is rejected.
      assert.equal((yield* getSession("/session", `__Host-session=${id}.${stored}`)).status, 401);
      assert.equal((yield* getSession("/session", `__Host-session=${id}.${secret}x`)).status, 401);
    },
  );

  Then("no comparison is made against a stored plaintext value", function* () {
    const { actors } = yield* World;
    const { id, secret } = tokenParts((yield* actors.get(yield* actors.current)).cookie);
    const row = yield* readSessionRow(id);
    for (const [key, value] of Object.entries(row)) {
      assert.ok(!String(value).includes(secret), `column "${key}" stores the plaintext secret`);
    }
  });

  Given(
    "the Session table's rows have been disclosed, as by a backup or a compromised read replica",
    function* () {
      const { actors, snapshots } = yield* World;
      yield* signUp("alice");
      const actor = yield* actors.get("alice");
      yield* snapshots.set("disclosed", yield* readSessionRow(tokenParts(actor.cookie).id));
    },
  );

  When(
    "an attacker attempts to authenticate using a disclosed row's stored hash as if it were the secret",
    function* () {
      const { snapshots, responses } = yield* World;
      const row = yield* snapshots.get("disclosed");
      const forged = `__Host-session=${column(row, "id")}.${column(row, "secretHash")}`;
      yield* responses.set("attacker", yield* getSession("/session", forged));
    },
  );

  Then(
    "authentication fails, because the disclosed hash cannot be replayed as a token",
    function* () {
      const { actors, responses } = yield* World;
      assert.equal((yield* responses.get("attacker")).status, 401);
      // The victim's real token is what is still accepted — the rejection is about the hash.
      assert.equal(
        (yield* getSession("/session", (yield* actors.get("alice")).cookie)).status,
        200,
      );
    },
  );

  // ---- REQ-EA-141..144: absolute and idle expiry (TestClock through the World) ----

  Given(
    "a session issued for {string} with an absolute expiry of {int} days from issuance",
    function* (name: string, days: number) {
      const { snapshots } = yield* World;
      yield* configureSessions({ absolute: Duration.days(days) });
      const actor = yield* signedUp(name);
      yield* snapshots.set("issued", yield* readSessionRow(tokenParts(actor.cookie).id));
    },
  );

  When(
    "{string} makes requests using that session every day for {int} days",
    function* (name: string, days: number) {
      for (let day = 0; day < days; day++) {
        yield* advance(Duration.days(1));
        assert.equal((yield* requestAsActor(name, "/session")).status, 200);
      }
    },
  );

  Then(
    "the session's absolute expiry remains exactly {int} days from issuance",
    function* (days: number) {
      const { snapshots } = yield* World;
      const issued = yield* snapshots.get("issued");
      const row = yield* readSessionRow(column(issued, "id"));
      assert.equal(column(row, "absoluteExpiresAt"), column(issued, "absoluteExpiresAt"));
      assert.equal(
        millis(row, "absoluteExpiresAt") - millis(row, "createdAt"),
        Duration.toMillis(Duration.days(days)),
      );
    },
  );

  Given(
    "a session for {string} with an idle expiry {int} hour from its last touch",
    function* (name: string, hours: number) {
      const { snapshots } = yield* World;
      // touchEvery is shortened so half an hour of inactivity is already refreshable; idle is
      // the scenario's own 1 hour. The 30 minutes since the last touch is arranged here.
      yield* configureSessions({ idle: Duration.hours(hours), touchEvery: Duration.minutes(1) });
      const actor = yield* signedUp(name);
      yield* advance(Duration.minutes(30));
      yield* snapshots.set("before", yield* readSessionRow(tokenParts(actor.cookie).id));
    },
  );

  When("{string} makes a request using that session", function* (name: string) {
    const { actors } = yield* World;
    yield* actors.use(name);
    assert.equal((yield* requestAsActor(name, "/session")).status, 200);
  });

  Then("the session's idle expiry is pushed forward by activity", function* () {
    const { snapshots } = yield* World;
    const before = yield* snapshots.get("before");
    const after = yield* readSessionRow(column(before, "id"));
    assert.ok(millis(after, "idleExpiresAt") > millis(before, "idleExpiresAt"));
  });

  Given(
    "a session for {string} whose absolute expiry is {int} minutes away and whose idle window is {int} hour",
    function* (name: string, minutes: number, hours: number) {
      const { snapshots } = yield* World;
      const elapsed = Duration.minutes(50);
      yield* configureSessions({
        absolute: Duration.sum(elapsed, Duration.minutes(minutes)),
        idle: Duration.hours(hours),
        touchEvery: Duration.minutes(1),
      });
      const actor = yield* signedUp(name);
      yield* advance(elapsed);
      yield* snapshots.set("before", yield* readSessionRow(tokenParts(actor.cookie).id));
    },
  );

  Then("the session's idle expiry is capped at the absolute expiry", function* () {
    const { snapshots } = yield* World;
    const before = yield* snapshots.get("before");
    const after = yield* readSessionRow(column(before, "id"));
    assert.equal(millis(after, "idleExpiresAt"), millis(after, "absoluteExpiresAt"));
  });

  Then(
    "the idle expiry is not extended {int} hour past the absolute expiry",
    function* (hours: number) {
      const { snapshots } = yield* World;
      const before = yield* snapshots.get("before");
      const after = yield* readSessionRow(column(before, "id"));
      const uncapped = (yield* nowMillis()) + Duration.toMillis(Duration.hours(hours));
      assert.ok(millis(after, "idleExpiresAt") < uncapped);
      assert.ok(millis(after, "idleExpiresAt") <= millis(after, "absoluteExpiresAt"));
    },
  );

  Given(
    "a session for {string} with an absolute expiry of {int} days from issuance",
    function* (name: string, days: number) {
      yield* configureSessions({ absolute: Duration.days(days) });
      yield* signUp(name);
    },
  );

  // "Every minute for 30 days" is 43,200 simulated requests (~5ms each: minutes of wall time),
  // so the stimulus is sampled every 3 hours. That loses nothing the assertion depends on: the
  // touch throttle (touchEvery = 1 hour) makes any request finer than that a persistence no-op
  // (REQ-EA-145), each sample below earns a refresh write (the densest activity the row can
  // see), and the idle window (7 days) is never in play. Every touch rotates the secret —
  // `requestAsActor` carries the rotated cookie forward. Statuses are recorded; the Then reads
  // them.
  When(
    "{string} makes a request using that session every minute for the full {int} days",
    function* (name: string, days: number) {
      const { statuses } = yield* World;
      const step = Duration.hours(3);
      const samples = Duration.toMillis(Duration.days(days)) / Duration.toMillis(step);
      for (let sample = 0; sample < samples; sample++) {
        yield* advance(step);
        const response = yield* requestAsActor(name, "/session");
        yield* Ref.update(statuses, (seen) => [...seen, response.status]);
      }
    },
  );

  Then(
    "the session is no longer valid once the original absolute expiry passes, regardless of the continuous activity",
    function* () {
      const { statuses } = yield* World;
      const seen = yield* Ref.get(statuses);
      // Live at every minute before the 30-day deadline, rejected at it — never extended.
      assert.ok(seen.length > 1);
      assert.ok(
        seen.slice(0, -1).every((status) => status === 200),
        "continuous activity keeps the session live until the deadline",
      );
      assert.equal(seen[seen.length - 1], 401);
    },
  );

  // ---- REQ-EA-145/146: touchEvery throttling ----

  Given("a session last touched {int} minutes ago", function* (minutes: number) {
    const { snapshots } = yield* World;
    const actor = yield* signedUp("alice");
    yield* advance(Duration.minutes(minutes));
    yield* snapshots.set("before", yield* readSessionRow(tokenParts(actor.cookie).id));
  });

  // The World is built from `SessionConfig` (default touchEvery = 1 hour) when the session is
  // issued, so this asserts the effective throttle rather than silently assuming it.
  Given("{string} is configured to {int} hour", function* (knob: string, hours: number) {
    const { settings } = yield* World;
    assert.equal(knob, "touchEvery");
    assert.equal(
      Duration.toMillis((yield* Ref.get(settings)).touchEvery),
      Duration.toMillis(Duration.hours(hours)),
    );
  });

  When("a request is served using that session", function* () {
    const { actors, statuses } = yield* World;
    const response = yield* requestAsActor(yield* actors.current, "/session");
    yield* Ref.set(statuses, [response.status]);
  });

  When(
    "{int} requests are served using that session within the next {int} minutes",
    function* (count: number, minutes: number) {
      const { actors, statuses } = yield* World;
      const name = yield* actors.current;
      const seen: Array<number> = [];
      for (let i = 0; i < count; i++) {
        yield* advance(Duration.millis(Duration.toMillis(Duration.minutes(minutes)) / count));
        seen.push((yield* requestAsActor(name, "/session")).status);
      }
      yield* Ref.set(statuses, seen);
    },
  );

  const writesSinceSnapshot = Effect.gen(function* () {
    const { snapshots, statuses } = yield* World;
    const before = yield* snapshots.get("before");
    const after = yield* readSessionRow(column(before, "id"));
    assert.ok((yield* Ref.get(statuses)).every((status) => status === 200));
    // A refresh write moves lastActiveAt and rotates the stored secret hash together.
    const wrote =
      column(after, "lastActiveAt") !== column(before, "lastActiveAt") ||
      column(after, "secretHash") !== column(before, "secretHash");
    return wrote;
  });

  Then("no idle-refresh write occurs", function* () {
    assert.equal(yield* writesSinceSnapshot, false);
  });

  Then("at most one idle-refresh write occurs", function* () {
    // Within one touchEvery window no request earns a write at all, so there are zero (which
    // is at most one) — and one write would reset the window, so never more.
    assert.equal(yield* writesSinceSnapshot, false);
  });

  // ---- REQ-EA-147: sign-in issues a newly minted session ----

  // Arranges the user (their sign-up minted a session) and then removes every session, so the
  // precondition — an account with no live session — is asserted, not assumed.
  Given("{string} has no existing session", function* (name: string) {
    const { snapshots } = yield* World;
    const actor = yield* signedUp(name);
    const prior = yield* readSessionRow(tokenParts(actor.cookie).id);
    yield* snapshots.set(`prior:${name}`, prior);
    const revoked = yield* postSession("/session/revoke-all", undefined, actor.cookie);
    assert.equal(revoked.status, 204);
    assert.equal((yield* getSession("/session", actor.cookie)).status, 401);
    assert.equal(yield* countSessionRows(column(prior, "userId")), 0);
  });

  When("{string} signs in", function* (name: string) {
    const { actors, responses } = yield* World;
    yield* actors.use(name);
    yield* responses.set(name, yield* signInAgain(name, name));
  });

  Then("a newly minted session is issued for {string}", function* (name: string) {
    const { responses, snapshots } = yield* World;
    const response = yield* responses.get(name);
    assert.equal(response.status, 200);
    const { id } = tokenParts(cookieFrom(response));
    const prior = yield* snapshots.get(`prior:${name}`);
    assert.notEqual(id, column(prior, "id"));
    const row = yield* readSessionRow(id);
    assert.equal(column(row, "userId"), column(prior, "userId"));
  });

  // ---- REQ-EA-148: a privilege change issues a new session ----

  Given(
    "a signed-in user {string} with session {string}",
    function* (name: string, sessionName: string) {
      const { snapshots } = yield* World;
      const actor = yield* signedUp(name);
      yield* aliasActor(sessionName, name);
      yield* snapshots.set(
        `session:${sessionName}`,
        yield* readSessionRow(tokenParts(actor.cookie).id),
      );
    },
  );

  When("{string} performs a {string}", function* (name: string, operation: string) {
    const { actors, responses } = yield* World;
    const actor = yield* actors.get(name);
    if (operation === "email change") {
      // The shipped flow: an authenticated request mails a token to the NEW address; confirming it
      // (a public endpoint: the link may be opened anywhere) replaces the address.
      const { texts } = yield* World;
      const newEmail = `${name}-changed@example.com`;
      const requested = yield* postSession("/change-email", { newEmail }, actor.cookie);
      assert.equal(requested.status, 202);
      const token = mailedToken(yield* mailedTo(newEmail, "change-email"));
      yield* texts.set(`newEmail:${name}`, newEmail);
      yield* responses.set(name, yield* postSession("/change-email/confirm", { token }));
      yield* actors.use(name);
      return;
    }
    if (operation !== "password change") {
      return yield* Effect.die(new Error(`no wiring for "${operation}": no such capability ships`));
    }
    yield* responses.set(
      name,
      yield* postSession(
        "/change-password",
        { currentPassword: STRONG_PASSWORD, newPassword: `${STRONG_PASSWORD} again` },
        actor.cookie,
      ),
    );
    yield* actors.use(name);
  });

  // REQ-EA-686: the confirmation ends the account's sessions (there is no caller session to rotate).
  Then("session {string} no longer verifies", function* (sessionName: string) {
    const { actors, responses } = yield* World;
    assert.equal((yield* responses.get(yield* actors.current)).status, 204);
    assert.equal(
      (yield* getSession("/session", (yield* actors.get(sessionName)).cookie)).status,
      401,
    );
  });

  Then("{string} signs in afresh under the new address", function* (name: string) {
    const { texts } = yield* World;
    const newEmail = yield* texts.get(`newEmail:${name}`);
    const response = yield* postSession("/password/sign-in", {
      email: newEmail,
      password: STRONG_PASSWORD,
    });
    assert.equal(response.status, 200);
  });

  Then("a newly minted session replaces {string}", function* (sessionName: string) {
    const { actors, responses, snapshots } = yield* World;
    const response = yield* responses.get(yield* actors.current);
    assert.equal(response.status, 200);
    const replacement = cookieFrom(response);
    const original = yield* snapshots.get(`session:${sessionName}`);
    assert.notEqual(tokenParts(replacement).id, column(original, "id"));
    assert.equal((yield* getSession("/session", replacement)).status, 200);
  });

  Then(
    "session {string} no longer verifies, its row tombstoned rather than left valid",
    function* (sessionName: string) {
      const { actors, responses, snapshots } = yield* World;
      const original = yield* snapshots.get(`session:${sessionName}`);
      // The row first: presenting the superseded token is itself refresh-reuse (RRS-003), which
      // revokes the whole family, replacement included.
      const row = yield* readSessionRow(column(original, "id"));
      assert.equal(typeof row["supersededAt"], "string", "the superseded row carries a tombstone");
      const replacement = tokenParts(cookieFrom(yield* responses.get(yield* actors.current))).id;
      assert.equal(row["supersededBy"], replacement);
      assert.equal(
        (yield* getSession("/session", (yield* actors.get(sessionName)).cookie)).status,
        401,
      );
    },
  );

  // ---- REQ-EA-149: session list ----

  Given("{string} has {int} active sessions", function* (name: string, count: number) {
    yield* signUp(name);
    for (let i = 1; i < count; i++) {
      yield* signInAgain(`${name}-session-${i}`, name);
    }
  });

  When("{string} requests her session list", function* (name: string) {
    const { actors, responses } = yield* World;
    const actor = yield* actors.get(name);
    yield* actors.use(name);
    yield* responses.set(name, yield* getSession("/session/list", actor.cookie));
  });

  Then(
    'she sees {int} sessions, each with its own userAgent and a "current" flag on the session serving the request',
    function* (count: number) {
      const { actors, responses } = yield* World;
      const response = yield* responses.get(yield* actors.current);
      assert.equal(response.status, 200);
      const body = yield* Schema.decodeUnknownEffect(SessionBody)(
        yield* Effect.promise(() => response.json()),
      ).pipe(Effect.orDie);
      assert.equal(body.length, count);
      assert.equal(
        body.filter((s) => s.current).length,
        1,
        "expected exactly one session flagged current — the one serving this request",
      );
      // Each device signed in with its own User-Agent header; each row records its own.
      const agents = body.map((s) => s.userAgent);
      assert.ok(agents.every((agent) => agent !== null && agent.length > 0));
      assert.equal(new Set(agents).size, count, "every session has its own userAgent");
    },
  );

  // ---- REQ-EA-150: revoke one by id ----

  Given(
    "{string} has sessions {string} and {string}",
    function* (name: string, session1: string, session2: string) {
      yield* signUp(session1);
      yield* aliasActor(name, session1);
      yield* signInAgain(session2, session1);
    },
  );

  When("{string} revokes session {string}", function* (name: string, sessionName: string) {
    const { actors, responses } = yield* World;
    const actor = yield* actors.get(name);
    const target = yield* actors.get(sessionName);
    yield* actors.use(name);
    const response = yield* postSession(
      "/session/revoke",
      { id: tokenParts(target.cookie).id },
      actor.cookie,
    );
    yield* responses.set("revoke", response);
  });

  Then("session {string} is no longer valid", function* (sessionName: string) {
    const { actors } = yield* World;
    const target = yield* actors.get(sessionName);
    assert.equal((yield* getSession("/session", target.cookie)).status, 401);
  });

  Then("session {string} remains valid", function* (sessionName: string) {
    const { actors } = yield* World;
    const target = yield* actors.get(sessionName);
    assert.equal((yield* getSession("/session", target.cookie)).status, 200);
  });

  // ---- REQ-EA-151: revoke-others ----

  Given(
    "{string} has sessions {string} \\(current), {string}, and {string}",
    function* (name: string, current: string, session2: string, session3: string) {
      yield* signUp(current);
      yield* aliasActor(name, current);
      yield* signInAgain(session2, current);
      yield* signInAgain(session3, current);
    },
  );

  When("{string} revokes all other sessions", function* (name: string) {
    const { actors, responses } = yield* World;
    const actor = yield* actors.get(name);
    yield* actors.use(name);
    yield* responses.set(
      "revokeOthers",
      yield* postSession("/session/revoke-others", undefined, actor.cookie),
    );
  });

  Then("{string} and {string} are no longer valid", function* (session2: string, session3: string) {
    const { actors } = yield* World;
    for (const name of [session2, session3]) {
      assert.equal((yield* getSession("/session", (yield* actors.get(name)).cookie)).status, 401);
    }
  });

  Then("{string} remains valid", function* (sessionName: string) {
    const { actors } = yield* World;
    const target = yield* actors.get(sessionName);
    assert.equal((yield* getSession("/session", target.cookie)).status, 200);
  });

  // ---- TIR-006: revoke-all ----

  When("{string} revokes all of her sessions", function* (name: string) {
    const { actors, responses } = yield* World;
    const actor = yield* actors.get(name);
    yield* actors.use(name);
    yield* responses.set(
      "revokeAll",
      yield* postSession("/session/revoke-all", undefined, actor.cookie),
    );
  });

  Then(
    "{string}, {string}, and {string} are no longer valid",
    function* (session1: string, session2: string, session3: string) {
      const { actors } = yield* World;
      for (const name of [session1, session2, session3]) {
        assert.equal((yield* getSession("/session", (yield* actors.get(name)).cookie)).status, 401);
      }
    },
  );

  Then("the response expires the {string} cookie", function* (cookieName: string) {
    const { responses } = yield* World;
    const raw = setCookieFrom(yield* responses.get("revokeAll"));
    assert.ok(raw.startsWith(`${cookieName}=`), "the expiring cookie is the session cookie");
    assert.match(raw, /max-age=0/i);
  });

  // ---- REQ-EA-152/153: in-flight requests around a revoke ----

  const startInFlight = (name: string, sessionName: string) =>
    Effect.gen(function* () {
      const { actors } = yield* World;
      yield* signUp(name);
      yield* aliasActor(sessionName, name);
      yield* startRequest("first", "/gate/hold", (yield* actors.get(sessionName)).cookie);
      yield* awaitGateEntered();
    });

  const revokeConcurrently = (sessionName: string) =>
    Effect.gen(function* () {
      const { actors, responses } = yield* World;
      const cookie = (yield* actors.get(sessionName)).cookie;
      const revoked = yield* postSession("/session/revoke", { id: tokenParts(cookie).id }, cookie);
      assert.equal(revoked.status, 204);
      yield* responses.set("concurrentRevoke", revoked);
    });

  Given(
    "{string}'s session {string} is validated by the authentication middleware for an in-flight request",
    function* (name: string, sessionName: string) {
      yield* startInFlight(name, sessionName);
    },
  );

  When(
    "session {string} is revoked by a concurrent request before {string}'s handler completes",
    function* (sessionName: string, _owner: string) {
      yield* revokeConcurrently(sessionName);
    },
  );

  Then(
    "the in-flight request completes normally on the principal it already resolved",
    function* () {
      yield* releaseGate();
      const response = yield* settle("first");
      assert.equal(response.status, 200);
      assert.equal(yield* Effect.promise(() => response.json()), "completed");
    },
  );

  Then("the next request presenting session {string} is rejected", function* (sessionName: string) {
    const { actors } = yield* World;
    assert.equal(
      (yield* getSession("/session", (yield* actors.get(sessionName)).cookie)).status,
      401,
    );
  });

  Given(
    "{string}'s session {string} is validated by the authentication middleware for an in-flight request, and session {string} is then revoked",
    function* (name: string, sessionName: string, revoked: string) {
      yield* startInFlight(name, sessionName);
      yield* revokeConcurrently(revoked);
    },
  );

  When(
    "a second, new request presents session {string} while the first request is still in flight",
    function* (sessionName: string) {
      const { actors } = yield* World;
      yield* startRequest("second", "/gate/hold", (yield* actors.get(sessionName)).cookie);
    },
  );

  Then(
    `the second request's own "Sessions.verify" re-validates from scratch and is rejected`,
    function* () {
      // It settles without the gate being released: it never reached the blocked handler.
      assert.equal((yield* settle("second")).status, 401);
    },
  );

  Then(
    "the bounded window applies only to the one request that had already passed middleware, never to a second one",
    function* () {
      assert.equal(yield* gateAdmitted(), 1);
      yield* releaseGate();
      assert.equal((yield* settle("first")).status, 200);
    },
  );

  // ---- REQ-EA-154/155: cookie attributes ----

  Then('the response sets a cookie named "__Host-session"', function* () {
    const { actors, responses } = yield* World;
    assert.match(cookieFrom(yield* responses.get(yield* actors.current)), /^__Host-session=/);
  });

  Then('the cookie carries "Secure", "HttpOnly", and "SameSite=Strict"', function* () {
    const { actors, responses } = yield* World;
    const setCookie = setCookieFrom(yield* responses.get(yield* actors.current));
    assert.match(setCookie, /secure/i);
    assert.match(setCookie, /httponly/i);
    assert.match(setCookie, /samesite=strict/i);
  });

  Then('the cookie sets "Path=\\/"', function* () {
    const { actors, responses } = yield* World;
    assert.match(setCookieFrom(yield* responses.get(yield* actors.current)), /path=\//i);
  });

  Then('the cookie sets no "Domain" attribute', function* () {
    const { actors, responses } = yield* World;
    assert.doesNotMatch(setCookieFrom(yield* responses.get(yield* actors.current)), /domain=/i);
  });
});
