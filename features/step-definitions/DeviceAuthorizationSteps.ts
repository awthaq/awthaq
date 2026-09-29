// BEH-EA-299 to BEH-EA-306: steps for features/features/05-authentication-methods/28-device-authorization.feature.
// The service is driven directly where a clock, a race or an error tag is the point, and over the web handler
// where the wire is (a form-encoded body, an RFC 6749 error, a bearer answer that sets no cookie).
import { AuditLog, DataExport, Erasure, Sessions, Users } from "@awthaq/core";
import { DeviceAuthorization, DeviceGrantRecords, UserCode } from "@awthaq/device-authorization";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import {
  configureApp,
  direct,
  directExit,
  enrolSecondFactor,
  request,
  signedInCaller,
  World,
} from "./DeviceAuthorizationWorld.ts";
import { isNumber, isString } from "./shared/Outcomes.ts";
import { isRecord, objectOf } from "./shared/WireJson.ts";

const service = DeviceAuthorization.DeviceAuthorization;
const CLI = DeviceAuthorization.CLI_CLIENT.clientId;
const DEVICE_IP = "203.0.113.7";
const PAGE_IP = "198.51.100.20";
const VERIFICATION_BASE = "https://app.test/device";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** The names a refusal answers to: its RFC 6749 `error` member and its `_tag` — a scenario may use either. */
const namesOf = (error: unknown): ReadonlyArray<string> =>
  isRecord(error)
    ? [error["error"], error["_tag"]].filter((name): name is string => typeof name === "string")
    : [];

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none<E>();

export const deviceAuthorizationSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- small helpers over the world ------------------------------------------------------------------------

  const remember = Effect.fnUntraced(function* <A, E>(exit: Exit.Exit<A, E>) {
    const world = yield* World;
    yield* Ref.set(world.last, Option.some(exit));
    return exit;
  });

  const latestCode = Effect.gen(function* () {
    const world = yield* World;
    const codes = yield* Ref.get(world.codes);
    const found = codes.at(-1);
    if (found === undefined)
      return yield* Effect.die(new Error("no device code has been requested"));
    return found;
  });

  const codeAt = (index: number) =>
    Effect.gen(function* () {
      const world = yield* World;
      const found = (yield* Ref.get(world.codes))[index];
      if (found === undefined) return yield* Effect.die(new Error(`no device code #${index}`));
      return found;
    });

  const callerNamed = (name: string) =>
    Effect.gen(function* () {
      const world = yield* World;
      const found = (yield* Ref.get(world.callers))[name];
      if (found === undefined)
        return yield* Effect.die(new Error(`no person named "${name}" has signed in`));
      return found;
    });

  const signIn = Effect.fnUntraced(function* (
    name: string,
    amr: ReadonlyArray<Sessions.AuthMethod> = ["pwd"],
  ) {
    const world = yield* World;
    const { caller } = yield* signedInCaller(`${name}@example.com`, amr);
    yield* Ref.update(world.callers, (existing) => ({ ...existing, [name]: caller }));
    return caller;
  });

  /** Requests a code as a device would; a success is remembered as the scenario's newest code. */
  const requestCode = Effect.fnUntraced(function* (overrides?: {
    readonly clientId?: string;
    readonly scope?: ReadonlyArray<string>;
    readonly ip?: string;
  }) {
    const world = yield* World;
    const exit = yield* directExit(
      Effect.gen(function* () {
        const plugin = yield* service;
        return yield* plugin.requestCode(
          {
            clientId: overrides?.clientId ?? CLI,
            scope: overrides?.scope ?? [],
            ip: overrides?.ip ?? DEVICE_IP,
          },
          { verificationBase: VERIFICATION_BASE },
        );
      }),
    );
    yield* remember(exit);
    if (Exit.isSuccess(exit)) yield* Ref.update(world.codes, (codes) => [...codes, exit.value]);
    return exit;
  });

  const newCode = Effect.fnUntraced(function* (overrides?: Parameters<typeof requestCode>[0]) {
    const exit = yield* requestCode(overrides);
    if (Exit.isFailure(exit)) return yield* Effect.die(new Error("the code request was refused"));
    return exit.value;
  });

  const grantOf = (issued: DeviceAuthorization.CodeIssued) =>
    direct(
      Effect.gen(function* () {
        const records = yield* DeviceGrantRecords.DeviceGrantRecords;
        const crypto = yield* Crypto.Crypto;
        return yield* records.findByDeviceHash(
          yield* UserCode.hashDeviceCode(crypto, Redacted.value(issued.deviceCode)),
        );
      }),
    );

  const verify = (
    issued: DeviceAuthorization.CodeIssued,
    caller: Option.Option<DeviceAuthorization.Caller>,
    options?: { readonly userCode?: string; readonly ip?: string },
  ) =>
    directExit(
      Effect.gen(function* () {
        const plugin = yield* service;
        return yield* plugin.verify(
          { userCode: options?.userCode ?? issued.userCode, ip: options?.ip ?? PAGE_IP },
          caller,
        );
      }),
    );

  const decide = (
    decision: "approve" | "deny",
    issued: DeviceAuthorization.CodeIssued,
    caller: DeviceAuthorization.Caller,
  ) =>
    directExit(
      Effect.gen(function* () {
        const plugin = yield* service;
        const input = { userCode: issued.userCode, ip: PAGE_IP };
        return yield* decision === "approve"
          ? plugin.approve(input, caller)
          : plugin.deny(input, caller);
      }),
    );

  const poll = Effect.fnUntraced(function* (
    issued: DeviceAuthorization.CodeIssued,
    overrides?: { readonly clientId?: string; readonly userAgent?: string },
  ) {
    const world = yield* World;
    const exit = yield* directExit(
      Effect.gen(function* () {
        const plugin = yield* service;
        return yield* plugin.poll(
          { deviceCode: issued.deviceCode, clientId: overrides?.clientId ?? CLI, ip: DEVICE_IP },
          { userAgent: overrides?.userAgent ?? "smart-tv/9.1" },
        );
      }),
    );
    yield* Ref.update(world.polls, (polls) => [...polls, exit]);
    yield* remember(exit);
    return exit;
  });

  const lastPoll = Effect.gen(function* () {
    const world = yield* World;
    const found = (yield* Ref.get(world.polls)).at(-1);
    if (found === undefined) return yield* Effect.die(new Error("the device has not polled"));
    return found;
  });

  const lastOutcome = Effect.gen(function* () {
    const world = yield* World;
    const found = yield* Ref.get(world.last);
    if (Option.isNone(found))
      return yield* Effect.die(new Error("no step has produced an outcome yet"));
    return found.value;
  });

  /** Asserts the newest outcome is a refusal answering to `name` (an RFC `error` or a `_tag`). */
  const assertRefusedAs = (name: string) =>
    Effect.gen(function* () {
      const outcome = yield* lastOutcome;
      const failure = failureOf(outcome);
      assert.ok(Option.isSome(failure), `expected a refusal as "${name}", got a success`);
      assert.ok(
        namesOf(failure.value).includes(name),
        `expected "${name}", got ${JSON.stringify(namesOf(failure.value))}`,
      );
    });

  const claimedCode = Effect.fnUntraced(function* (
    person: string,
    overrides?: Parameters<typeof requestCode>[0],
  ) {
    const issued = yield* newCode(overrides);
    const caller =
      Option.getOrUndefined(
        Option.fromNullishOr((yield* Ref.get((yield* World).callers))[person]),
      ) ?? (yield* signIn(person));
    const opened = yield* verify(issued, Option.some(caller));
    assert.ok(Exit.isSuccess(opened), "the claiming user could not open the verification page");
    return { issued, caller };
  });

  const approvedCode = Effect.fnUntraced(function* (
    amr: ReadonlyArray<Sessions.AuthMethod> = ["pwd"],
    afterSignIn?: (caller: DeviceAuthorization.Caller) => Effect.Effect<void>,
  ) {
    const issued = yield* newCode();
    const caller = yield* signIn("primary", amr);
    if (afterSignIn !== undefined) yield* afterSignIn(caller);
    const opened = yield* verify(issued, Option.some(caller));
    assert.ok(Exit.isSuccess(opened));
    const approved = yield* decide("approve", issued, caller);
    assert.ok(Exit.isSuccess(approved), "the approval was refused");
    return { issued, caller };
  });

  const sessionsOf = (userId: Users.UserId) =>
    direct(
      Effect.gen(function* () {
        const sessions = yield* Sessions.Sessions;
        return yield* sessions.list(userId);
      }),
    );

  // ---- BEH-EA-299: requesting a code -----------------------------------------------------------------------

  Given("a registered device client {string}", function* (clientId: string) {
    const listed = yield* direct(
      Effect.gen(function* () {
        const plugin = yield* service;
        return yield* plugin.listClients;
      }),
    );
    assert.ok(
      listed.some((client) => client.clientId === clientId && !client.revoked),
      `"${clientId}" is not a registered client`,
    );
  });

  Given(
    "a registered device client {string} with the scope {string}",
    function* (clientId: string, scope: string) {
      yield* direct(
        Effect.gen(function* () {
          const plugin = yield* service;
          return yield* plugin.registerClient({ name: clientId, clientId, scopes: [scope] });
        }),
      );
    },
  );

  When("the client requests a device code", function* () {
    yield* requestCode();
  });

  When("a client named {string} requests a device code", function* (clientId: string) {
    yield* requestCode({ clientId });
  });

  When("the client {string} requests a device code", function* (clientId: string) {
    yield* requestCode({ clientId });
  });

  When(
    "the registered client requests a device code for the scope {string}",
    function* (scope: string) {
      yield* requestCode({ scope: [scope] });
    },
  );

  Then(
    "the answer carries a device code, a user code, the verification URIs, an expiry of {int} seconds and an interval of {int} seconds",
    function* (expiresIn: number, interval: number) {
      const outcome = yield* lastOutcome;
      assert.ok(Exit.isSuccess(outcome), "the request was refused");
      const issued = yield* latestCode;
      assert.match(Redacted.value(issued.deviceCode), /^[A-Za-z0-9_-]{43}$/);
      assert.equal(issued.expiresIn, expiresIn);
      assert.equal(issued.interval, interval);
      assert.equal(issued.verificationUri, VERIFICATION_BASE);
      assert.equal(
        issued.verificationUriComplete,
        `${VERIFICATION_BASE}?user_code=${encodeURIComponent(issued.userCode)}`,
      );
    },
  );

  Then("the answer carries a device code", function* () {
    const outcome = yield* lastOutcome;
    assert.ok(Exit.isSuccess(outcome), "the request was refused");
  });

  Then(
    "the user code is 8 symbols of the alphabet {string} shown as {string}",
    function* (alphabet: string, shape: string) {
      assert.equal(alphabet, UserCode.ALPHABET);
      assert.equal(shape, "XXXX-XXXX");
      const issued = yield* latestCode;
      assert.match(issued.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    },
  );

  Then("the request is refused as {string}", function* (name: string) {
    yield* assertRefusedAs(name);
  });

  Given("a generated user code shown as {string}", function* (shape: string) {
    assert.equal(shape, "XXXX-XXXX");
    yield* newCode();
  });

  When("it is entered lower-cased with spaces instead of the hyphen", function* () {
    const issued = yield* latestCode;
    const caller = yield* signIn("primary");
    const typed = issued.userCode.toLowerCase().replace("-", " ");
    yield* remember(yield* verify(issued, Option.some(caller), { userCode: typed }));
  });

  Then("it is normalized and matches exactly", function* () {
    const outcome = yield* lastOutcome;
    assert.ok(Exit.isSuccess(outcome), "the typed code did not match");
  });

  Then("a code one character off does not match", function* () {
    const issued = yield* latestCode;
    const caller = yield* callerNamed("primary");
    const flipped = `${issued.userCode.slice(0, -1)}${issued.userCode.endsWith("B") ? "C" : "B"}`;
    const outcome = yield* verify(issued, Option.some(caller), { userCode: flipped });
    const failure = failureOf(outcome);
    assert.ok(Option.isSome(failure) && namesOf(failure.value).includes("InvalidUserCode"));
  });

  Then("the stored row holds only the code's hash", function* () {
    const issued = yield* latestCode;
    const stored = yield* grantOf(issued);
    assert.ok(Option.isSome(stored));
    const serialized = JSON.stringify(stored.value);
    assert.ok(!serialized.includes(UserCode.normalize(issued.userCode)));
    assert.ok(!serialized.includes(Redacted.value(issued.deviceCode)));
    assert.match(stored.value.userCodeHash, /^[0-9a-f]{64}$/);
    assert.match(stored.value.deviceCodeHash, /^[0-9a-f]{64}$/);
  });

  // ---- BEH-EA-300: the poll ------------------------------------------------------------------------------------

  Given("a device code that has been requested and not yet approved", function* () {
    yield* newCode();
  });

  When("the device polls {string} at the advised interval", function* (_path: string) {
    yield* TestClock.adjust(Duration.seconds(5));
    yield* poll(yield* latestCode);
  });

  When("the device polls {string}", function* (_path: string) {
    yield* poll(yield* latestCode);
  });

  When("the device polls again", function* () {
    yield* TestClock.adjust(Duration.seconds(5));
    yield* poll(yield* latestCode);
  });

  When("the user approves the code on a second, authenticated device", function* () {
    const issued = yield* latestCode;
    const caller = yield* signIn("primary");
    assert.ok(Exit.isSuccess(yield* verify(issued, Option.some(caller))));
    assert.ok(Exit.isSuccess(yield* decide("approve", issued, caller)), "the approval was refused");
  });

  Then("the poll answers {string}", function* (name: string) {
    const outcome = yield* lastPoll;
    const failure = failureOf(outcome);
    assert.ok(Option.isSome(failure), `expected "${name}", the poll succeeded`);
    assert.ok(
      namesOf(failure.value).includes(name),
      `expected "${name}", got ${JSON.stringify(namesOf(failure.value))}`,
    );
  });

  Then("a session is issued for the approving user and the grant is consumed", function* () {
    const outcome = yield* lastPoll;
    assert.ok(Exit.isSuccess(outcome), "the poll did not issue a session");
    const caller = yield* callerNamed("primary");
    assert.equal(outcome.value.session.userId, caller.userId);
    assert.ok(Option.isNone(yield* grantOf(yield* latestCode)), "the grant still exists");
  });

  Given("a device code that the user has denied", function* () {
    const issued = yield* newCode();
    const caller = yield* signIn("primary");
    assert.ok(Exit.isSuccess(yield* verify(issued, Option.some(caller))));
    assert.ok(Exit.isSuccess(yield* decide("deny", issued, caller)));
  });

  Then("the grant row no longer exists", function* () {
    assert.ok(Option.isNone(yield* grantOf(yield* latestCode)), "the grant still exists");
  });

  Then("the grant row still exists", function* () {
    assert.ok(Option.isSome(yield* grantOf(yield* latestCode)), "the grant was deleted");
  });

  Given("a device code being polled at the advised interval", function* () {
    const issued = yield* newCode();
    const first = yield* poll(issued);
    const failure = failureOf(first);
    assert.ok(Option.isSome(failure) && namesOf(failure.value).includes("authorization_pending"));
  });

  When("the device polls again before the interval has elapsed", function* () {
    yield* poll(yield* latestCode);
  });

  Then("the interval the server advises increases by 5 seconds", function* () {
    const outcome = yield* lastPoll;
    const failure = failureOf(outcome);
    assert.ok(Option.isSome(failure) && failure.value._tag === "SlowDown");
    assert.equal(failure.value.interval, 10);
    const stored = yield* grantOf(yield* latestCode);
    assert.ok(Option.isSome(stored));
    assert.equal(stored.value.pollInterval, 10);
  });

  Given("a pending device code that was polled once", function* () {
    const issued = yield* newCode();
    yield* poll(issued);
  });

  When("the device polls again immediately, before the interval has elapsed", function* () {
    yield* poll(yield* latestCode);
  });

  Then("that second poll answers {string}", function* (name: string) {
    const outcome = yield* lastPoll;
    const failure = failureOf(outcome);
    assert.ok(Option.isSome(failure) && namesOf(failure.value).includes(name));
  });

  Then(
    "a poll made after the interval answers {string} rather than skipping the throttle",
    function* (name: string) {
      const issued = yield* latestCode;
      const stored = yield* grantOf(issued);
      assert.ok(Option.isSome(stored));
      // The raised interval is the one that applies now: wait it out from the last poll that passed.
      yield* TestClock.adjust(Duration.seconds(stored.value.pollInterval));
      const outcome = yield* poll(issued);
      const failure = failureOf(outcome);
      assert.ok(Option.isSome(failure) && namesOf(failure.value).includes(name));
    },
  );

  Given("a device code whose lifetime has elapsed", function* () {
    yield* newCode();
    yield* TestClock.adjust(Duration.minutes(16));
  });

  When("a signed-in user opens the verification page for it", function* () {
    const caller = yield* signIn("primary");
    yield* remember(yield* verify(yield* latestCode, Option.some(caller)));
  });

  Then("the page answers {string}", function* (name: string) {
    yield* assertRefusedAs(name);
  });

  When("another registered client polls with that device code", function* () {
    yield* direct(
      Effect.gen(function* () {
        const plugin = yield* service;
        return yield* plugin.registerClient({ name: "Other", clientId: "other-client" });
      }),
    );
    yield* poll(yield* latestCode, { clientId: "other-client" });
  });

  When("a device polls with a device code that was never issued", function* () {
    const world = yield* World;
    const exit = yield* directExit(
      Effect.gen(function* () {
        const plugin = yield* service;
        return yield* plugin.poll({
          deviceCode: Redacted.make("never-issued"),
          clientId: CLI,
          ip: DEVICE_IP,
        });
      }),
    );
    yield* Ref.update(world.polls, (polls) => [...polls, exit]);
    yield* remember(exit);
  });

  When(
    "a device posts to {string} with the grant type {string}",
    function* (path: string, grantType: string) {
      const world = yield* World;
      const response = yield* request(path, {
        form: { grant_type: grantType, device_code: "x", client_id: CLI },
      });
      yield* world.responses.set("last", response);
    },
  );

  When("a device posts to {string} with an empty device code", function* (path: string) {
    const world = yield* World;
    const response = yield* request(path, {
      form: { grant_type: DEVICE_GRANT, device_code: "", client_id: CLI },
    });
    yield* world.responses.set("last", response);
  });

  Then("the wire answer is {int} {string}", function* (status: number, error: string) {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.status, status, response.text);
    assert.equal(objectOf(response)["error"], error);
  });

  // ---- BEH-EA-301: claim, then decide ----------------------------------------------------------------------------

  Given("a pending, unclaimed user code and a signed-in session", function* () {
    yield* newCode();
    yield* signIn("primary");
  });

  When("that session opens the verification page twice", function* () {
    const issued = yield* latestCode;
    const caller = yield* callerNamed("primary");
    const first = yield* verify(issued, Option.some(caller));
    const second = yield* verify(issued, Option.some(caller));
    assert.ok(Exit.isSuccess(first) && Exit.isSuccess(second));
    assert.deepEqual(second.value, first.value, "opening it twice is a no-op");
  });

  Then("the code is claimed by that session's user exactly once", function* () {
    const stored = yield* grantOf(yield* latestCode);
    const caller = yield* callerNamed("primary");
    assert.ok(Option.isSome(stored));
    assert.deepEqual(stored.value.userId, Option.some(caller.userId));
  });

  Then("a different session opening the page afterwards cannot claim it", function* () {
    const issued = yield* latestCode;
    const owner = yield* callerNamed("primary");
    const stranger = yield* signIn("other");
    const view = yield* verify(issued, Option.some(stranger));
    assert.ok(Exit.isSuccess(view));
    assert.ok(Option.isNone(view.value.context));
    const stored = yield* grantOf(issued);
    assert.ok(Option.isSome(stored));
    assert.deepEqual(stored.value.userId, Option.some(owner.userId));
  });

  Given("a claimed user code", function* () {
    yield* claimedCode("primary");
  });

  When("an anonymous caller, or a different user, opens the verification page", function* () {
    const world = yield* World;
    const issued = yield* latestCode;
    const stranger = yield* signIn("other");
    const anonymous = yield* verify(issued, Option.none());
    const other = yield* verify(issued, Option.some(stranger));
    assert.ok(Exit.isSuccess(anonymous) && Exit.isSuccess(other));
    yield* world.outcomes.set("views", [anonymous.value, other.value]);
  });

  const viewsGuard = (
    value: unknown,
  ): value is ReadonlyArray<DeviceAuthorization.VerificationView> =>
    Array.isArray(value) && value.every((entry) => isRecord(entry) && "userCode" in entry);

  Then("only {string} and {string} are disclosed", function* (first: string, second: string) {
    const world = yield* World;
    const issued = yield* latestCode;
    const views = yield* world.outcomes.getAs("views", viewsGuard);
    assert.deepEqual([first, second], ["user_code", "status"]);
    for (const view of views) {
      assert.deepEqual(
        { userCode: view.userCode, status: view.status },
        { userCode: issued.userCode, status: "pending" },
      );
    }
  });

  Then("no client or scope context is shown", function* () {
    const world = yield* World;
    for (const view of yield* world.outcomes.getAs("views", viewsGuard)) {
      assert.ok(Option.isNone(view.context));
    }
  });

  Given(
    "a claimed user code for the client {string} and the scope {string}",
    function* (clientId: string, scope: string) {
      yield* claimedCode("primary", { clientId, scope: [scope] });
    },
  );

  When("the claiming user opens the verification page", function* () {
    const caller = yield* callerNamed("primary");
    yield* remember(yield* verify(yield* latestCode, Option.some(caller)));
  });

  Then(
    "the page names the client {string} and the scope {string}",
    function* (clientId: string, scope: string) {
      const outcome = yield* lastOutcome;
      assert.ok(Exit.isSuccess(outcome));
      const view = outcome.value;
      assert.ok(isRecord(view) && "context" in view);
      const context = view["context"];
      assert.ok(Option.isOption(context) && Option.isSome(context));
      const found = context.value;
      assert.ok(isRecord(found));
      const client = found["client"];
      assert.ok(isRecord(client));
      assert.equal(client["clientId"], clientId);
      assert.deepEqual(found["scopes"], [scope]);
    },
  );

  When("an anonymous caller opens the verification page", function* () {
    yield* remember(yield* verify(yield* latestCode, Option.none()));
  });

  Then("the code stays unclaimed", function* () {
    const stored = yield* grantOf(yield* latestCode);
    assert.ok(Option.isSome(stored));
    assert.ok(Option.isNone(stored.value.userId));
  });

  // ---- BEH-EA-302: decisions -------------------------------------------------------------------------------------------

  Given("a pending user code that no session has claimed", function* () {
    yield* newCode();
    yield* signIn("primary");
  });

  When("a signed-in session tries to approve it", function* () {
    const issued = yield* latestCode;
    const caller = yield* callerNamed("primary");
    yield* remember(yield* decide("approve", issued, caller));
  });

  When("that session tries to approve it", function* () {
    const caller = yield* callerNamed("primary");
    yield* remember(yield* decide("approve", yield* latestCode, caller));
  });

  Then("the approval is refused as not claimed", function* () {
    yield* assertRefusedAs("UserCodeNotClaimed");
  });

  Then("the approval is refused as {string}", function* (name: string) {
    yield* assertRefusedAs(name);
  });

  When("a different signed-in user tries to approve it", function* () {
    const stranger = yield* signIn("other");
    yield* remember(yield* decide("approve", yield* latestCode, stranger));
  });

  When("the claiming user approves and denies it concurrently", function* () {
    const world = yield* World;
    const issued = yield* latestCode;
    const caller = yield* callerNamed("primary");
    const exits = yield* Effect.all(
      [decide("approve", issued, caller), decide("deny", issued, caller)],
      { concurrency: 2 },
    );
    yield* world.outcomes.set("decisions", exits.filter(Exit.isSuccess).length);
  });

  Then("exactly one decision succeeds", function* () {
    const world = yield* World;
    assert.equal(yield* world.outcomes.getAs("decisions", isNumber), 1);
  });

  Then("deciding the code again is refused as {string}", function* (name: string) {
    const caller = yield* callerNamed("primary");
    yield* remember(yield* decide("approve", yield* latestCode, caller));
    yield* assertRefusedAs(name);
  });

  When("an impersonation session of the claiming user tries to approve it", function* () {
    const caller = yield* callerNamed("primary");
    yield* remember(yield* decide("approve", yield* latestCode, { ...caller, impersonated: true }));
  });

  Given("the plugin requires the assurance level {string}", function* (level: string) {
    yield* configureApp({
      config: { requiredAssurance: level === "aal3" ? "aal3" : level === "aal2" ? "aal2" : "aal1" },
    });
  });

  Given(
    "a claimed user code held by a session that authenticated with a password only",
    function* () {
      const issued = yield* newCode();
      const caller = yield* signIn("primary", ["pwd"]);
      assert.ok(Exit.isSuccess(yield* verify(issued, Option.some(caller))));
    },
  );

  When("that session denies it", function* () {
    const caller = yield* callerNamed("primary");
    yield* remember(yield* decide("deny", yield* latestCode, caller));
  });

  Then("the code is denied", function* () {
    const outcome = yield* lastOutcome;
    assert.ok(Exit.isSuccess(outcome), "the denial was refused");
    const stored = yield* grantOf(yield* latestCode);
    assert.ok(Option.isSome(stored));
    assert.equal(stored.value.status, "denied");
  });

  // ---- BEH-EA-303: rate limits ---------------------------------------------------------------------------------------------

  Given(
    "the verification endpoint's limit of 5 failed user-code lookups per 15 minutes",
    function* () {
      yield* configureApp({ realLimits: true });
      yield* newCode();
      yield* signIn("primary");
    },
  );

  When("a caller submits 6 wrong user codes within that window", function* () {
    const world = yield* World;
    const issued = yield* latestCode;
    const caller = yield* callerNamed("primary");
    const exits: Array<Exit.Exit<unknown, unknown>> = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      exits.push(yield* verify(issued, Option.some(caller), { userCode: "BCDF-GHJK" }));
    }
    yield* world.outcomes.set(
      "attempts",
      exits.map((exit) =>
        Option.getOrElse(Option.map(failureOf(exit), namesOf), () => ["success"]),
      ),
    );
  });

  const attemptsGuard = (value: unknown): value is ReadonlyArray<ReadonlyArray<string>> =>
    Array.isArray(value) && value.every((entry) => Array.isArray(entry));

  Then("the sixth attempt is rejected as rate limited", function* () {
    const world = yield* World;
    const attempts = yield* world.outcomes.getAs("attempts", attemptsGuard);
    for (const earlier of attempts.slice(0, 5)) assert.ok(earlier.includes("InvalidUserCode"));
    assert.ok(attempts[5]?.includes("RateLimited"), JSON.stringify(attempts));
  });

  Then("the limit applies both per IP and per session", function* () {
    const issued = yield* latestCode;
    const owner = yield* callerNamed("primary");
    const otherSession = yield* signIn("other");
    // A different session from the same address is refused: the per-address budget is spent.
    const sameAddress = yield* verify(issued, Option.some(otherSession));
    assert.ok(
      Option.exists(failureOf(sameAddress), (error) => namesOf(error).includes("RateLimited")),
    );
    // The same session from a fresh address is refused: the per-session budget is spent.
    const sameSession = yield* verify(issued, Option.some(owner), { ip: "198.51.100.201" });
    assert.ok(
      Option.exists(failureOf(sameSession), (error) => namesOf(error).includes("RateLimited")),
    );
  });

  Given("the code endpoint's limit of 5 requests per 15 minutes per address", function* () {
    yield* configureApp({ realLimits: true });
  });

  When("one address requests 6 device codes within that window", function* () {
    const world = yield* World;
    const exits: Array<Exit.Exit<unknown, unknown>> = [];
    for (let attempt = 0; attempt < 6; attempt++) exits.push(yield* requestCode());
    yield* world.outcomes.set(
      "requests",
      exits.map((exit) =>
        Option.getOrElse(Option.map(failureOf(exit), namesOf), () => ["success"]),
      ),
    );
  });

  Then("the sixth request is rejected as rate limited", function* () {
    const world = yield* World;
    const requests = yield* world.outcomes.getAs("requests", attemptsGuard);
    for (const earlier of requests.slice(0, 5)) assert.deepEqual(earlier, ["success"]);
    assert.ok(requests[5]?.includes("RateLimited"), JSON.stringify(requests));
  });

  Then("another address is still served", function* () {
    const outcome = yield* requestCode({ ip: "203.0.113.99" });
    assert.ok(Exit.isSuccess(outcome));
  });

  // ---- BEH-EA-304: redemption -------------------------------------------------------------------------------------------------

  Given("an approved device code", function* () {
    yield* approvedCode();
  });

  Given("an approved device grant", function* () {
    yield* approvedCode();
  });

  Given("an approved device code and a poll that will lose the race", function* () {
    yield* approvedCode();
  });

  When("two polls for it arrive concurrently", function* () {
    const world = yield* World;
    const issued = yield* latestCode;
    const exits = yield* Effect.all([poll(issued), poll(issued)], { concurrency: 2 });
    yield* world.outcomes.set("wins", exits.filter(Exit.isSuccess).length);
    yield* world.outcomes.set(
      "loserNames",
      exits.flatMap((exit) => Option.getOrElse(Option.map(failureOf(exit), namesOf), () => [])),
    );
  });

  When("the losing poll is processed", function* () {
    const world = yield* World;
    const issued = yield* latestCode;
    const exits = yield* Effect.all([poll(issued), poll(issued)], { concurrency: 2 });
    yield* world.outcomes.set("wins", exits.filter(Exit.isSuccess).length);
    yield* world.outcomes.set(
      "loserNames",
      exits.flatMap((exit) => Option.getOrElse(Option.map(failureOf(exit), namesOf), () => [])),
    );
  });

  Then("exactly one poll receives a session", function* () {
    const world = yield* World;
    assert.equal(yield* world.outcomes.getAs("wins", isNumber), 1);
  });

  const namesGuard = (value: unknown): value is ReadonlyArray<string> =>
    Array.isArray(value) && value.every(isString);

  Then("the other answers {string}", function* (name: string) {
    const world = yield* World;
    assert.ok((yield* world.outcomes.getAs("loserNames", namesGuard)).includes(name));
  });

  Then("only one session exists for that grant", function* () {
    const caller = yield* callerNamed("primary");
    // The approving session, plus the one the winning poll minted: never two device sessions.
    assert.equal((yield* sessionsOf(caller.userId)).length, 2);
  });

  Then("no session is ever minted from the device code it did not win", function* () {
    const world = yield* World;
    const caller = yield* callerNamed("primary");
    assert.equal(yield* world.outcomes.getAs("wins", isNumber), 1);
    assert.equal((yield* sessionsOf(caller.userId)).length, 2);
    assert.ok((yield* world.outcomes.getAs("loserNames", namesGuard)).includes("invalid_grant"));
  });

  When("the device redeems it", function* () {
    yield* poll(yield* latestCode, { userAgent: "smart-tv/9.1" });
  });

  Then("the issued session appears in the approving user's session list", function* () {
    const outcome = yield* lastPoll;
    assert.ok(Exit.isSuccess(outcome), "the device did not receive a session");
    const caller = yield* callerNamed("primary");
    const listed = yield* sessionsOf(caller.userId);
    assert.ok(listed.some((item) => item.id === outcome.value.session.id));
  });

  Then("it carries the device's client address and user agent", function* () {
    const outcome = yield* lastPoll;
    assert.ok(Exit.isSuccess(outcome));
    assert.deepEqual(outcome.value.session.ipAddress, Option.some(DEVICE_IP));
    assert.deepEqual(outcome.value.session.userAgent, Option.some("smart-tv/9.1"));
  });

  Given(
    "an approved device grant whose approving session authenticated with a password and a second factor",
    function* () {
      yield* approvedCode(["pwd", "otp", "mfa"]);
    },
  );

  Then(
    "the issued session records the amr {string}, {string} and {string}",
    function* (first: string, second: string, third: string) {
      const outcome = yield* lastPoll;
      assert.ok(Exit.isSuccess(outcome), "the device did not receive a session");
      assert.deepEqual(outcome.value.session.amr, [first, second, third]);
    },
  );

  When("the device redeems it over the wire", function* () {
    const world = yield* World;
    const issued = yield* latestCode;
    const response = yield* request("/device/token", {
      form: {
        grant_type: DEVICE_GRANT,
        device_code: Redacted.value(issued.deviceCode),
        client_id: CLI,
      },
    });
    yield* world.responses.set("last", response);
  });

  Then(
    "the wire answer is 200 with {string} {string} and an {string}",
    function* (typeField: string, typeValue: string, tokenField: string) {
      const world = yield* World;
      const response = yield* world.responses.get("last");
      assert.equal(response.status, 200, response.text);
      const body = objectOf(response);
      assert.equal(body[typeField], typeValue);
      assert.ok(typeof body[tokenField] === "string" && body[tokenField] !== "");
    },
  );

  Then("the response is {string} and sets no cookie", function* (cacheControl: string) {
    const world = yield* World;
    const response = yield* world.responses.get("last");
    assert.equal(response.headers.get("cache-control"), cacheControl);
    assert.equal(response.headers.get("set-cookie"), null);
  });

  Given(
    "a user with a confirmed second factor whose approving session authenticated with a password only",
    function* () {
      const world = yield* World;
      const { caller } = yield* signedInCaller("mfa@example.com", ["pwd"]);
      yield* enrolSecondFactor(caller.userId);
      yield* Ref.update(world.callers, (existing) => ({ ...existing, primary: caller }));
    },
  );

  Given("an approved device grant for that session", function* () {
    const issued = yield* newCode();
    const caller = yield* callerNamed("primary");
    assert.ok(Exit.isSuccess(yield* verify(issued, Option.some(caller))));
    assert.ok(Exit.isSuccess(yield* decide("approve", issued, caller)));
  });

  Given("the approving user is then suspended", function* () {
    const caller = yield* callerNamed("primary");
    yield* direct(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        return yield* users.setStatus(caller.userId, "suspended", { reason: "scenario" });
      }),
    );
  });

  Then("the redemption is refused as {string}", function* (name: string) {
    const outcome = yield* lastPoll;
    const failure = failureOf(outcome);
    assert.ok(Option.isSome(failure), "the redemption succeeded");
    assert.ok(namesOf(failure.value).includes(name), JSON.stringify(namesOf(failure.value)));
  });

  Then("no session is minted", function* () {
    const caller = yield* callerNamed("primary");
    assert.equal((yield* sessionsOf(caller.userId)).length, 1, "only the approving session exists");
  });

  // ---- BEH-EA-305: clients ------------------------------------------------------------------------------------------------------

  Given(
    "an operator registers the device client {string} named {string}",
    function* (clientId: string, name: string) {
      yield* remember(
        yield* directExit(
          Effect.gen(function* () {
            const plugin = yield* service;
            return yield* plugin.registerClient({ name, clientId });
          }),
        ),
      );
    },
  );

  When("the operator revokes the client {string}", function* (clientId: string) {
    const revoked = yield* direct(
      Effect.gen(function* () {
        const plugin = yield* service;
        return yield* plugin.revokeClient(clientId);
      }),
    );
    assert.ok(revoked, "there was no live client to revoke");
  });

  Then("the registration is refused as {string}", function* (name: string) {
    yield* assertRefusedAs(name);
  });

  // ---- BEH-EA-306: audit, erasure, export, retention --------------------------------------------------------------------------

  When("the claiming user approves it", function* () {
    const caller = yield* callerNamed("primary");
    assert.ok(Exit.isSuccess(yield* decide("approve", yield* latestCode, caller)));
  });

  Then(
    "the audit trail holds one {string} row naming that user and the client",
    function* (tag: string) {
      const caller = yield* callerNamed("primary");
      const rows = yield* direct(
        Effect.gen(function* () {
          const audit = yield* AuditLog.AuditLog;
          return yield* audit.list({ eventTag: "auth.deviceAuthorization.approved" });
        }),
      );
      assert.equal(tag, "auth.deviceAuthorization.approved");
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0]?.actorUserId, Option.some(caller.userId));
      assert.ok(JSON.stringify(rows[0]?.payload).includes(CLI));
    },
  );

  Then("no audit row holds the device code or the user code", function* () {
    const issued = yield* latestCode;
    const text = JSON.stringify(
      yield* direct(
        Effect.gen(function* () {
          const audit = yield* AuditLog.AuditLog;
          return yield* audit.list();
        }),
      ),
    );
    assert.ok(!text.includes(Redacted.value(issued.deviceCode)));
    assert.ok(!text.includes(UserCode.normalize(issued.userCode)));
  });

  Given("a claimed user code and another user's claimed user code", function* () {
    yield* claimedCode("primary");
    yield* claimedCode("other", { ip: "203.0.113.51" });
  });

  When("the first user is erased", function* () {
    const caller = yield* callerNamed("primary");
    yield* direct(
      Effect.gen(function* () {
        const registry = yield* Erasure.ErasureRegistry;
        const contribution = (yield* registry.contributions).find(
          (entry) => entry.id === "device_authorization",
        );
        if (contribution === undefined)
          return yield* Effect.die(new Error("no erasure contribution"));
        yield* contribution.erase({ userId: caller.userId });
      }),
    );
  });

  Then("only the erased user's grant is gone", function* () {
    assert.ok(Option.isNone(yield* grantOf(yield* codeAt(0))));
    assert.ok(Option.isSome(yield* grantOf(yield* codeAt(1))));
  });

  When("the claiming user's data is exported", function* () {
    const world = yield* World;
    const caller = yield* callerNamed("primary");
    const section = yield* direct(
      Effect.gen(function* () {
        const registry = yield* DataExport.DataExportRegistry;
        const contribution = (yield* registry.contributions).find(
          (entry) => entry.id === "device_authorization",
        );
        if (contribution === undefined)
          return yield* Effect.die(new Error("no export contribution"));
        return yield* contribution.collect({ userId: caller.userId });
      }),
    );
    yield* world.outcomes.set("export", JSON.stringify(section));
  });

  Then(
    "the device-authorization section names the client and the status {string}",
    function* (status: string) {
      const world = yield* World;
      const text = yield* world.outcomes.getAs("export", isString);
      assert.ok(text.includes(CLI));
      assert.ok(text.includes(status));
    },
  );

  Then("it holds no code and no hash", function* () {
    const world = yield* World;
    const issued = yield* latestCode;
    const text = yield* world.outcomes.getAs("export", isString);
    assert.ok(!text.includes(Redacted.value(issued.deviceCode)));
    assert.doesNotMatch(text, /[0-9a-f]{64}/);
  });

  Given("one device code that expired and one that is still live", function* () {
    yield* newCode();
    yield* TestClock.adjust(Duration.minutes(10));
    yield* newCode({ ip: "203.0.113.60" });
    yield* TestClock.adjust(Duration.minutes(6));
  });

  When("the operator purges expired grants", function* () {
    const world = yield* World;
    const purged = yield* direct(
      Effect.gen(function* () {
        const plugin = yield* service;
        return yield* plugin.purgeExpired();
      }),
    );
    yield* world.outcomes.set("purged", purged);
  });

  Then("one grant is reported purged and the live one remains", function* () {
    const world = yield* World;
    assert.equal(yield* world.outcomes.getAs("purged", isNumber), 1);
    assert.ok(Option.isNone(yield* grantOf(yield* codeAt(0))));
    assert.ok(Option.isSome(yield* grantOf(yield* codeAt(1))));
  });
});
