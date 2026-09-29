// BEH-EA-193..200 (25-testing-harness.feature). See TestingHarnessWorld.ts for the seam.
import { HookPoint, Hooks, Sessions, Users, Verification } from "@awthaq/core";
import { Mailer, RateLimiter } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import {
  EvaluationServicesNone,
  check,
  currentSubjectLayer,
  hasPermission,
  makeSubject,
  permission,
  permissionKey,
} from "@qadi/core";
import { ChallengeStore } from "@awthaq/passkey";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { TestAuth } from "@awthaq/test";
import { defineSteps } from "@effect-cucumber/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import assert from "node:assert/strict";
import {
  composable,
  contractSetup,
  dispatch,
  gatedApp,
  isContractRun,
  passwordApp,
  passwordTuple,
  provides,
  Recorder,
  recordingFramework,
  requestAdminOnlyAs,
  runContractSuite,
  whoamiApp,
  whoamiFor,
  World,
  type ContractSetup,
} from "./TestingHarnessWorld.ts";
import { isBoolean, isNumber, isString, isStringArray } from "./shared/Outcomes.ts";

const strongPassword = Redacted.make("correct horse battery staple");

/** What a composed `TestAuth.layer` context provides, gathered once. */
interface CompositionFacts {
  readonly hasDatabase: boolean;
  readonly hasListener: boolean;
  readonly hasHttpPlatform: boolean;
  readonly mailerIsMemory: boolean;
  readonly mailerRecords: boolean;
  readonly limiterPermissive: boolean;
  readonly usersRoundTrip: boolean;
  readonly unauthenticatedStatus: number;
}

const gatherCompositionFacts = Effect.scoped(
  Effect.gen(function* () {
    const context = yield* Layer.build(passwordApp);
    return yield* Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      yield* mailer.send({ to: "facts@example.com", template: "probe" });
      const sent = yield* mailer.sent;
      const limiter = yield* RateLimiter.RateLimiter;
      const users = yield* Users.Users;
      const created = yield* users.create({
        identity: { _tag: "Email", email: "facts@example.com" },
        name: "Facts",
      });
      const found = yield* users.findById(created.id);
      const anonymous = yield* dispatch(new Request("http://localhost/session"));
      return {
        hasDatabase: provides(context, SqlClient.SqlClient),
        hasListener: provides(context, HttpServer.HttpServer),
        hasHttpPlatform: provides(context, HttpPlatform.HttpPlatform),
        mailerIsMemory: mailer.development === true,
        mailerRecords: sent.some((message) => message.template === "probe"),
        limiterPermissive: limiter.permissive === true,
        usersRoundTrip: found.id === created.id,
        unauthenticatedStatus: anonymous.status,
      } satisfies CompositionFacts;
    }).pipe(Effect.provide(context));
  }),
);

const isFacts = (value: unknown): value is CompositionFacts =>
  typeof value === "object" &&
  value !== null &&
  isBoolean(Reflect.get(value, "hasDatabase")) &&
  isBoolean(Reflect.get(value, "mailerIsMemory"));

/** Elapsing an invariant's time under `TestClock`: what was observed on each side of the boundary, and how long the wall clock actually ran. */
interface ElapseFacts {
  readonly beforeBoundary: boolean;
  readonly afterBoundary: boolean;
  readonly virtualMillis: number;
  readonly realMillis: number;
}

const isElapse = (value: unknown): value is ElapseFacts =>
  typeof value === "object" &&
  value !== null &&
  isBoolean(Reflect.get(value, "afterBoundary")) &&
  isNumber(Reflect.get(value, "virtualMillis")) &&
  isNumber(Reflect.get(value, "realMillis"));

/** Runs `observe` for both sides of `elapse`, timing the real wall clock (`Date.now`, which `TestClock` never touches). */
const elapseUnderTestClock = <E, R>(
  elapse: Duration.Input,
  observe: Effect.Effect<boolean, E, R>,
) =>
  Effect.gen(function* () {
    const realStart = Date.now();
    const virtualStart = yield* Clock.currentTimeMillis;
    const beforeBoundary = yield* observe;
    yield* TestClock.adjust(elapse);
    const afterBoundary = yield* observe;
    const virtualMillis = (yield* Clock.currentTimeMillis) - virtualStart;
    return { beforeBoundary, afterBoundary, virtualMillis, realMillis: Date.now() - realStart };
  });

/** BEH-EA-194: a session that is live now and (once `elapse` has passed) refused — observed over the HTTP router, cookie and all. */
const sessionStillLive = (cookieHeader: string) =>
  // A fresh `Request` per observation: the router memoizes per request object, so replaying one
  // object would answer the second look from the first one's authentication.
  Effect.suspend(() =>
    dispatch(new Request("http://localhost/whoami", { headers: { cookie: cookieHeader } })),
  ).pipe(Effect.map((response) => response.status === 200));

const sessionIdleElapse = (elapse: Duration.Input) =>
  Effect.gen(function* () {
    const signedIn = yield* TestAuth.signInAs({ email: "idle@example.com" });
    return yield* elapseUnderTestClock(elapse, sessionStillLive(signedIn.cookieHeader));
  }).pipe(Effect.provide(whoamiApp));

const verificationTtlElapse = Effect.gen(function* () {
  const verification = yield* Verification.Verification;
  const issued = yield* verification.issue({ identifier: "harness:ttl", ttl: Duration.hours(1) });
  // Consuming spends the token, so the "before" side of the boundary is a separate, identical token.
  const probe = yield* verification.issue({
    identifier: "harness:ttl-probe",
    ttl: Duration.hours(1),
  });
  const liveNow = yield* verification.consume("harness:ttl-probe", probe.value).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  const realStart = Date.now();
  const virtualStart = yield* Clock.currentTimeMillis;
  yield* TestClock.adjust(Duration.hours(2));
  const stillLive = yield* verification.consume("harness:ttl", issued.value).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  return {
    beforeBoundary: liveNow,
    afterBoundary: stillLive,
    virtualMillis: (yield* Clock.currentTimeMillis) - virtualStart,
    realMillis: Date.now() - realStart,
  };
}).pipe(Effect.provide(passwordApp));

/** The passkey plugin's challenge store: a challenge lives five minutes and is single-use, so the "live" side is a separate, identical challenge. */
const passkeyChallengeElapse = Effect.gen(function* () {
  const store = yield* ChallengeStore.ChallengeStore;
  const probe = yield* store.issue("harness:probe");
  const issued = yield* store.issue("harness:ttl");
  const liveNow = yield* store.consume("harness:probe", Redacted.value(probe));
  const realStart = Date.now();
  const virtualStart = yield* Clock.currentTimeMillis;
  yield* TestClock.adjust(Duration.toMillis(ChallengeStore.CHALLENGE_TTL) + 60_000);
  const stillLive = yield* store.consume("harness:ttl", Redacted.value(issued));
  return {
    beforeBoundary: liveNow,
    afterBoundary: stillLive,
    virtualMillis: (yield* Clock.currentTimeMillis) - virtualStart,
    realMillis: Date.now() - realStart,
  };
}).pipe(Effect.provide(ChallengeStore.layerMemory.pipe(Layer.provide(NodeCrypto.layer))));

const rateLimitElapse = Effect.gen(function* () {
  const limiter = yield* RateLimiter.RateLimiter;
  const input = { key: "harness:window", limit: 1, window: Duration.minutes(1) };
  yield* limiter.consume(input);
  const withinWindow = () =>
    limiter.consume(input).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  const realStart = Date.now();
  const virtualStart = yield* Clock.currentTimeMillis;
  // "beforeBoundary" here means "still limited before the window passes", so it is inverted below.
  const admittedInside = yield* withinWindow();
  yield* TestClock.adjust(Duration.minutes(2));
  const admittedAfter = yield* withinWindow();
  return {
    beforeBoundary: !admittedInside,
    afterBoundary: !admittedAfter,
    virtualMillis: (yield* Clock.currentTimeMillis) - virtualStart,
    realMillis: Date.now() - realStart,
  };
}).pipe(Effect.provide(RateLimiter.layerMemory));

export const testingHarnessSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-193 --------------------------------------------------------------------------

  Given(
    "a plugin tuple containing {string} and {string}",
    function* (plugin: string, core: string) {
      const { outcomes } = yield* World;
      // `Session` is core's own reserved group, folded into every composition's api (MW-002).
      const groups = Object.keys(passwordTuple.api.groups);
      assert.ok(groups.includes(plugin.toLowerCase()), `the tuple's api has a "${plugin}" group`);
      assert.ok(groups.includes(core.toLowerCase()), `the tuple's api has core's "${core}" group`);
      yield* outcomes.set("tuple", groups);
    },
  );

  When("{string} composes the tuple", function* (_entry: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("facts", yield* gatherCompositionFacts);
  });

  Then(
    "the composed layer uses memory repositories, {string}, a permissive {string}, and {string}",
    function* (_mailer: string, _limiter: string, _platform: string) {
      const { outcomes } = yield* World;
      const facts = yield* outcomes.getAs("facts", isFacts);
      // Memory repositories: users round-trip with no SqlClient anywhere in the composition.
      assert.equal(facts.usersRoundTrip, true);
      assert.equal(facts.hasDatabase, false);
      assert.equal(facts.mailerIsMemory, true);
      assert.equal(facts.mailerRecords, true);
      assert.equal(facts.limiterPermissive, true);
      assert.equal(facts.hasHttpPlatform, true);
    },
  );

  Given("a test built on {string}", function* (_layer: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("composition", "TestAuth.layer(plugins)");
  });

  When("the test runs", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set("facts", yield* gatherCompositionFacts);
  });

  Then("it does not require a real database", function* () {
    const { outcomes } = yield* World;
    const facts = yield* outcomes.getAs("facts", isFacts);
    assert.equal(facts.hasDatabase, false);
    assert.equal(facts.usersRoundTrip, true);
  });

  Then("it does not require a real mailer", function* () {
    const { outcomes } = yield* World;
    const facts = yield* outcomes.getAs("facts", isFacts);
    assert.equal(facts.mailerIsMemory, true);
    assert.equal(facts.mailerRecords, true);
  });

  Then("it does not require a real network listener", function* () {
    const { outcomes } = yield* World;
    const facts = yield* outcomes.getAs("facts", isFacts);
    assert.equal(facts.hasListener, false);
    // The request still reached a real route: an unauthenticated GET /session is refused, not "not found".
    assert.equal(facts.unauthenticatedStatus, 401);
  });

  Given("an application's own plugin tuple passed to {string}", function* (_make: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("plugins", Object.keys(passwordTuple.api.groups));
  });

  When("a test composes that same tuple through {string}", function* (_layer: string) {
    const { outcomes } = yield* World;
    const result = yield* Effect.gen(function* () {
      const password = yield* Password.Password;
      const users = yield* Users.Users;
      const issued = yield* password.signUp({
        email: "same-graph@example.com",
        password: strongPassword,
      });
      const stored = yield* users.findById(issued.session.userId);
      yield* users.verifyEmail(issued.session.userId);
      const wrong = yield* password
        .signIn({
          email: "same-graph@example.com",
          password: Redacted.make("not the password at all"),
        })
        .pipe(Effect.flip);
      return { sameUserStored: stored.id === issued.session.userId, failureTag: wrong._tag };
    }).pipe(Effect.provide(passwordApp));
    yield* outcomes.set("sameUserStored", result.sameUserStored);
    yield* outcomes.set("failureTag", result.failureTag);
  });

  Then("the test exercises the actual plugin graph {string} produces", function* (_make: string) {
    const { outcomes } = yield* World;
    // `Password.Password` is only provided by `Auth.make`'s own folded layer; the user it created is
    // the one the composition's shared `Users` store holds.
    assert.equal(yield* outcomes.getAs("sameUserStored", isBoolean), true);
  });

  Then(
    "a failure in the test is a fact about the plugin wiring, not an artifact of a stubbed-out shortcut",
    function* () {
      const { outcomes } = yield* World;
      // The real hasher and the real domain error: nothing here was faked to make it fail.
      assert.equal(yield* outcomes.getAs("failureTag", isString), "InvalidCredentials");
    },
  );

  // ---- BEH-EA-194 --------------------------------------------------------------------------

  const invariantGiven = (invariant: string) =>
    Given(`a whole-pipeline HTTP test asserting ${invariant}`, function* () {
      const { outcomes } = yield* World;
      yield* outcomes.set("invariant", invariant);
    });
  invariantGiven("session idle expiry");
  invariantGiven("verification token TTL");
  invariantGiven("passkey challenge expiry");
  invariantGiven("a rate-limit window");

  When("the test needs to elapse time to observe the boundary", function* () {
    const { outcomes } = yield* World;
    const invariant = yield* outcomes.getAs("invariant", isString);
    const facts =
      invariant === "session idle expiry"
        ? yield* sessionIdleElapse(Duration.days(8))
        : invariant === "verification token TTL"
          ? yield* verificationTtlElapse
          : invariant === "a rate-limit window"
            ? yield* rateLimitElapse
            : invariant === "passkey challenge expiry"
              ? yield* passkeyChallengeElapse
              : yield* Effect.die(new Error(`no elapse wiring for "${invariant}"`));
    yield* outcomes.set("elapse", facts);
  });

  Then("it advances {string} rather than waiting in real time", function* (_clock: string) {
    const { outcomes } = yield* World;
    const facts = yield* outcomes.getAs("elapse", isElapse);
    // Something really elapsed on the virtual clock, and the boundary was observed on both sides...
    assert.ok(facts.virtualMillis >= Duration.toMillis(Duration.minutes(1)));
    assert.equal(facts.beforeBoundary, true);
    assert.equal(facts.afterBoundary, false);
    // ...while the wall clock barely moved.
    assert.ok(facts.realMillis < 5_000, `took ${facts.realMillis}ms of real time`);
  });

  Given("a whole-pipeline HTTP test asserting an eight-day session expiry", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set("invariant", "eight-day session expiry");
  });

  When("the test elapses that time", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set("elapse", yield* sessionIdleElapse(Duration.days(8)));
  });

  Then(
    "it does not call a real {string} or otherwise wait for wall-clock time to pass",
    function* (_sleep: string) {
      const { outcomes } = yield* World;
      const facts = yield* outcomes.getAs("elapse", isElapse);
      assert.ok(facts.virtualMillis >= Duration.toMillis(Duration.days(8)));
      assert.ok(facts.realMillis < 5_000, `took ${facts.realMillis}ms of real time`);
    },
  );

  Given(
    "a test dispatching through {string}'s router for a session configured to expire after 8 days",
    function* (_layer: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("configured", true);
    },
  );

  When(
    "the test adjusts {string} by {string} and then requests {string}",
    function* (_clock: string, duration: string, _endpoint: string) {
      const { outcomes } = yield* World;
      assert.equal(duration, "8 days");
      const result = yield* Effect.gen(function* () {
        const signedIn = yield* TestAuth.signInAs({ email: "eight-days@example.com" });
        const realStart = Date.now();
        const live = yield* sessionStillLive(signedIn.cookieHeader);
        yield* TestClock.adjust(Duration.days(8));
        const after = yield* dispatch(
          new Request("http://localhost/session", { headers: { cookie: signedIn.cookieHeader } }),
        );
        const body = yield* Effect.promise(() => after.json());
        return {
          live,
          status: after.status,
          tag: Reflect.get(body, "_tag"),
          realMillis: Date.now() - realStart,
        };
      }).pipe(
        Effect.provide(
          whoamiApp.pipe(
            Layer.provide(
              Layer.succeed(Sessions.SessionConfig, {
                absolute: Duration.days(8),
                idle: Duration.days(8),
                touchEvery: Duration.hours(1),
              }),
            ),
          ),
        ),
      );
      yield* outcomes.set("live", result.live);
      yield* outcomes.set("status", result.status);
      yield* outcomes.set("tag", result.tag);
      yield* outcomes.set("realMillis", result.realMillis);
    },
  );

  Then("the call fails with {string}", function* (tag: string) {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("live", isBoolean), true);
    assert.equal(yield* outcomes.getAs("status", isNumber), 401);
    assert.equal(yield* outcomes.getAs("tag", isString), tag);
  });

  Then("the test completes without any real elapsed wait", function* () {
    const { outcomes } = yield* World;
    assert.ok((yield* outcomes.getAs("realMillis", isNumber)) < 5_000);
  });

  // ---- BEH-EA-195 --------------------------------------------------------------------------

  Given(
    "a test that only needs to override {string}'s {string} method",
    function* (port: string, method: string) {
      const { outcomes } = yield* World;
      assert.equal(port, "Mailer");
      yield* outcomes.set("method", method);
    },
  );

  When("the test provides its double for {string}", function* (_port: string) {
    const { outcomes } = yield* World;
    const sentTo = yield* Ref.make<ReadonlyArray<string>>([]);
    const double = Layer.mock(Mailer.Mailer)({
      send: (message) => Ref.update(sentTo, (seen) => [...seen, message.to]),
    });
    const observed = yield* Effect.gen(function* () {
      const mailer = yield* Mailer.Mailer;
      yield* mailer.send({ to: "mock@example.com", template: "probe" });
      // Everything not overridden is a typed "unimplemented" defect, not a silent no-op.
      const unimplemented = yield* Effect.exit(mailer.sent);
      return Exit.isFailure(unimplemented)
        ? String(unimplemented.cause)
        : "sent unexpectedly succeeded";
    }).pipe(Effect.provide(double));
    yield* outcomes.set("recipients", yield* Ref.get(sentTo));
    yield* outcomes.set("unimplemented", observed);
  });

  Then("it uses {string} to override only {string}", function* (_mock: string, _method: string) {
    const { outcomes } = yield* World;
    assert.deepEqual(yield* outcomes.getAs("recipients", isStringArray), ["mock@example.com"]);
    assert.match(yield* outcomes.getAs("unimplemented", isString), /Unimplemented method "sent"/);
  });

  Then(
    "it does not hand-write a full replacement implementation of {string}'s interface",
    function* (_port: string) {
      const { outcomes } = yield* World;
      // The double answers exactly one method; a full hand-written replacement would have answered `sent` too.
      assert.match(
        yield* outcomes.getAs("unimplemented", isString),
        /UnimplementedError|Unimplemented method/,
      );
    },
  );

  Given(
    "a test that only asserts {string} was called with the expected arguments",
    function* (method: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("method", method);
    },
  );

  When(
    "the test does not need {string}'s recording or inspection behavior",
    function* (_memory: string) {
      const { outcomes } = yield* World;
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const double = Layer.mock(Mailer.Mailer)({
        send: (message) =>
          Ref.update(calls, (seen) => [...seen, `${message.template}:${message.to}`]),
      });
      yield* Effect.gen(function* () {
        const mailer = yield* Mailer.Mailer;
        yield* mailer.send({ to: "ada@example.com", template: "welcome" });
      }).pipe(Effect.provide(double));
      yield* outcomes.set("calls", yield* Ref.get(calls));
    },
  );

  Then(
    "the test uses {string} instead of the full memory implementation",
    function* (_mock: string) {
      const { outcomes } = yield* World;
      assert.deepEqual(yield* outcomes.getAs("calls", isStringArray), ["welcome:ada@example.com"]);
    },
  );

  // ---- BEH-EA-196 (PV-261): the recommended recipe, run --------------------------------------
  // makeSubject builds the caller, currentSubjectLayer + EvaluationServicesNone are the whole
  // environment: no TestAuth.layer, no client, no server layer.

  const deleteProject = permission("project", "delete");
  const canDelete = hasPermission(deleteProject);
  const ownerSubject = makeSubject({ id: "user:u1", permissions: [permissionKey(deleteProject)] });
  const strangerSubject = makeSubject({ id: "user:u2" });

  /** The whole environment a policy-level test provides. */
  const policyEnvironment = (subject: typeof ownerSubject) =>
    Layer.merge(currentSubjectLayer(subject), EvaluationServicesNone);

  Given("a test asserting a single policy's behavior in isolation", function* () {
    yield* Effect.void;
  });

  Given("a test whose only concern is a single policy's behavior", function* () {
    yield* Effect.void;
  });

  When("the test constructs the calling subject", function* () {
    const { outcomes } = yield* World;
    const [owner, stranger] = yield* Effect.all([
      Effect.provide(check(canDelete), policyEnvironment(ownerSubject)),
      Effect.provide(check(canDelete), policyEnvironment(strangerSubject)),
    ]);
    yield* outcomes.set("owner", owner);
    yield* outcomes.set("stranger", stranger);
  });

  Then(
    "it builds that subject with {string} and the policy answers for it as the subject's permissions dictate",
    function* (constructor: string) {
      assert.equal(constructor, "makeSubject");
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("owner", isBoolean), true);
      assert.equal(yield* outcomes.getAs("stranger", isBoolean), false);
    },
  );

  When("qadi's services are provided to the test", function* () {
    const { outcomes } = yield* World;
    // Only these two layers: the effect is closed by them, which is the compile-time half of the claim.
    const answer = yield* Effect.provide(check(canDelete), policyEnvironment(ownerSubject));
    yield* outcomes.set("provided", answer);
  });

  Then(
    "they are provided via {string} with {string} and nothing else",
    function* (subjectLayer: string, services: string) {
      assert.deepEqual([subjectLayer, services], ["currentSubjectLayer", "EvaluationServicesNone"]);
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("provided", isBoolean), true);
    },
  );

  When("the test is composed", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set(
      "composed",
      yield* Effect.provide(check(canDelete), policyEnvironment(ownerSubject)),
    );
  });

  Then(
    "it does not compose {string}, an HTTP client, or any server layer merely to exercise that policy, and still gets a real evaluation",
    function* (layer: string) {
      assert.equal(layer, "TestAuth.layer");
      const { outcomes } = yield* World;
      // The test's own environment held no HTTP router, client or memory port; the answer is qadi's evaluator's.
      assert.equal(yield* outcomes.getAs("composed", isBoolean), true);
    },
  );

  // ---- BEH-EA-197 --------------------------------------------------------------------------

  Given(
    "a test asserting that {string} or {string} blocks or allows a real HTTP request",
    function* (_permission: string, _subject: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("endpoint", "GET /whoami (behind Api.Authentication)");
    },
  );

  When("the test establishes its calling identity", function* () {
    const { outcomes } = yield* World;
    const result = yield* Effect.gen(function* () {
      const signedIn = yield* TestAuth.signInAs({ email: "signed-in-as@example.com" });
      const allowed = yield* dispatch(
        new Request("http://localhost/whoami", { headers: { cookie: signedIn.cookieHeader } }),
      );
      const blocked = yield* dispatch(new Request("http://localhost/whoami"));
      const body = yield* Effect.promise(() => allowed.json());
      return {
        allowedStatus: allowed.status,
        blockedStatus: blocked.status,
        principal: Reflect.get(body, "userId"),
        expected: signedIn.userId,
      };
    }).pipe(Effect.provide(whoamiApp));
    yield* outcomes.set("allowedStatus", result.allowedStatus);
    yield* outcomes.set("blockedStatus", result.blockedStatus);
    yield* outcomes.set("principal", result.principal);
    yield* outcomes.set("expected", result.expected);
  });

  Then(
    "it uses {string} rather than calling a handler function directly with a fabricated principal",
    function* (_signInAs: string) {
      const { outcomes } = yield* World;
      // The minted session travels the real middleware: the same route admits it and refuses no credential.
      assert.equal(yield* outcomes.getAs("allowedStatus", isNumber), 200);
      assert.equal(yield* outcomes.getAs("blockedStatus", isNumber), 401);
      assert.equal(
        yield* outcomes.getAs("principal", isString),
        yield* outcomes.getAs("expected", isString),
      );
    },
  );

  // PV-261: RequirePermission composed over TestAuth.layer, callers minted by signInAs.
  Given(
    "a test asserting that {string} correctly blocks or allows a request",
    function* (_permission: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("endpoint", "GET /admin-only (behind RequirePermission, project:admin)");
    },
  );

  When(
    "the test is composed with {string} over the real {string} and {string}",
    function* (_layer: string, _guard: string, _extractor: string) {
      const { outcomes } = yield* World;
      const [admin, member] = yield* Effect.gen(function* () {
        const admin = yield* requestAdminOnlyAs("admin@example.com", ["admin"]);
        const member = yield* requestAdminOnlyAs("member@example.com", ["member"]);
        return [admin, member] as const;
      }).pipe(Effect.provide(gatedApp));
      yield* outcomes.set("adminStatus", admin.status);
      yield* outcomes.set("adminBody", admin.body);
      yield* outcomes.set("memberStatus", member.status);
    },
  );

  Then(
    "a caller holding the admin role is allowed and a caller without it is blocked, decided by the real evaluator and no stub",
    function* () {
      const { outcomes } = yield* World;
      assert.equal(yield* outcomes.getAs("adminStatus", isNumber), 200);
      assert.equal(yield* outcomes.getAs("adminBody", isString), '"admin data"');
      assert.equal(yield* outcomes.getAs("memberStatus", isNumber), 403);
    },
  );

  Given(
    'a caller signed in via {string} with roles ["member"] only',
    function* (_signInAs: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("callerRoles", ["member"]);
    },
  );

  Given(
    "qadi's evaluator would return a Deny decision for that caller against the admin-only endpoint's policy",
    function* () {
      // Arranged, never stubbed: the catalog gives `member` no `project:admin`, so the real evaluator denies.
      const { outcomes } = yield* World;
      assert.deepEqual(yield* outcomes.getAs("callerRoles", isStringArray), ["member"]);
    },
  );

  When(
    "the caller requests an endpoint gated by {string} for the admin role",
    function* (_guard: string) {
      const { outcomes } = yield* World;
      const roles = yield* outcomes.getAs("callerRoles", isStringArray);
      const result = yield* requestAdminOnlyAs("member-only@example.com", roles).pipe(
        Effect.provide(gatedApp),
      );
      yield* outcomes.set("gatedStatus", result.status);
      yield* outcomes.set("gatedBody", result.body);
    },
  );

  Then("the request fails with {string}", function* (tag: string) {
    const { outcomes } = yield* World;
    assert.equal(tag, "Forbidden");
    assert.equal(yield* outcomes.getAs("gatedStatus", isNumber), 403);
    // qadi maps a Deny to an empty 403 body (BEH-EA-157): nothing about the policy leaks.
    assert.equal(yield* outcomes.getAs("gatedBody", isString), "");
  });

  Given(
    "a test that calls a handler function directly with a fabricated principal instead of using {string}",
    function* (_signInAs: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("fabricatedId", "fabricated-user");
    },
  );

  When("that approach is used", function* () {
    const { outcomes } = yield* World;
    const fabricatedId = yield* outcomes.getAs("fabricatedId", isString);
    const direct = yield* whoamiFor({
      _tag: "User",
      ref: { type: "user", id: fabricatedId },
      sessionId: "no-such-session",
    });
    // The same identity presented over HTTP, as a cookie for a session that was never issued.
    const viaHttp = yield* dispatch(
      new Request("http://localhost/whoami", {
        headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=no-such-session.no-such-secret` },
      }),
    ).pipe(Effect.provide(whoamiApp));
    yield* outcomes.set("directUserId", direct.userId);
    yield* outcomes.set("httpStatus", viaHttp.status);
  });

  Then(
    "it bypasses the {string}\\/{string} middleware chain the test is meant to verify",
    function* (_permission: string, _subject: string) {
      const { outcomes } = yield* World;
      // The handler happily answered for an identity no session backs; the middleware would not have.
      assert.equal(yield* outcomes.getAs("directUserId", isString), "fabricated-user");
      assert.equal(yield* outcomes.getAs("httpStatus", isNumber), 401);
    },
  );

  // ---- BEH-EA-198 --------------------------------------------------------------------------

  const inviteOptions = [{}, { ttl: "1 hour" }];
  // One plugin value per setup, like a real author's module-level constant: the harness compares the
  // contract *identity* across option values (ADR-EA-011), so it must not be rebuilt per call.
  const invitePlugin = (overrides: Parameters<typeof composable>[1]) => {
    const plugin = composable("invite", { tables: ["invite_codes"], ...overrides });
    return () => plugin;
  };

  const setUp = (setup: ContractSetup) =>
    Effect.gen(function* () {
      const { contractSetup: cell } = yield* World;
      yield* Ref.set(cell, setup);
    });

  Given(
    "a plugin {string} run through {string} with option combinations {string} and {string}",
    function* (_id: string, _runner: string, _first: string, _second: string) {
      yield* setUp({ make: invitePlugin({}), options: inviteOptions, host: [] });
    },
  );

  When("the contract test suite runs", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set("run", yield* runContractSuite(yield* contractSetup));
  });

  Then(
    "it asserts the plugin's manifest is legal under each supplied option combination",
    function* () {
      const { outcomes } = yield* World;
      const run = yield* outcomes.getAs("run", isContractRun);
      assert.deepEqual(run.failed, []);
      for (const options of inviteOptions) {
        const label = JSON.stringify(options);
        assert.ok(
          run.passed.some((name) => name.startsWith(`${label}: `)),
          `no check ran for option combination ${label}`,
        );
      }
    },
  );

  Given("a plugin {string} run through {string}", function* (_id: string, _runner: string) {
    yield* setUp({ make: invitePlugin({}), options: [{}], host: [] });
  });

  Then("it asserts {string}'s contract group ids are unique", function* (_id: string) {
    const { outcomes } = yield* World;
    const run = yield* outcomes.getAs("run", isContractRun);
    // Unique ids: the suite composes the plugin (with its host) cleanly...
    assert.deepEqual(run.failed, []);
    assert.ok(run.passed.some((name) => name.includes("migration declarations are deterministic")));
    // ...and the check has teeth: a host already contributing the same group id is reported by id.
    const clash = composable("hostclash", {
      contract: {
        identifier: "auth",
        groups: { invite: HttpApiGroup.make("invite") },
      },
    });
    const colliding = yield* runContractSuite({
      make: invitePlugin({}),
      options: [{}],
      host: [clash],
    });
    assert.ok(
      colliding.failed.some((message) => message.includes("E_GROUP_CONFLICT")),
      colliding.failed.join(" | "),
    );
  });

  Then(
    "it asserts every table {string} declares carries the {string} prefix",
    function* (_id: string, _prefix: string) {
      const { outcomes } = yield* World;
      const run = yield* outcomes.getAs("run", isContractRun);
      assert.deepEqual(run.failed, []);
      assert.ok(
        run.passed.some((name) =>
          name.includes("every declared table carries this plugin's own id prefix"),
        ),
      );
    },
  );

  When(
    "the contract test suite applies {string}'s migrations twice, independently",
    function* (_id: string) {
      const { outcomes } = yield* World;
      const { contractSetup: cell } = yield* World;
      const current = yield* contractSetup;
      yield* Ref.set(cell, {
        ...current,
        make: invitePlugin({
          migrations: [
            {
              name: "create_codes",
              up: Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* sql.unsafe("CREATE TABLE invite_codes (id TEXT PRIMARY KEY)");
              }),
            },
          ],
        }),
      });
      yield* outcomes.set("run", yield* runContractSuite(yield* contractSetup));
    },
  );

  Then("it asserts both runs apply the migrations identically", function* () {
    const { outcomes } = yield* World;
    const run = yield* outcomes.getAs("run", isContractRun);
    assert.deepEqual(run.failed, []);
    assert.ok(run.passed.some((name) => name.includes("apply identically on two fresh databases")));
  });

  Given(
    "a plugin {string} run through {string} with its declared host dependency omitted from {string}",
    function* (_id: string, _runner: string, _host: string) {
      const host = composable("password", {});
      yield* setUp({
        make: invitePlugin({ dependsOn: [host] }),
        options: inviteOptions,
        host: [],
      });
    },
  );

  Then("it fails with {string}", function* (code: string) {
    const { outcomes } = yield* World;
    const run = yield* outcomes.getAs("run", isContractRun);
    assert.ok(
      run.failed.some((message) => message.includes(code)),
      `no failure mentioned ${code}: ${run.failed.join(" | ")}`,
    );
  });

  Given(
    "a third-party plugin {string} built outside the awthaq repository",
    function* (_id: string) {
      // Built above from `@awthaq/core`'s public `AuthPlugin` shape and run through `@awthaq/test`'s
      // public entry point only — nothing under `packages/*/src` is reached into.
      yield* setUp({ make: invitePlugin({}), options: inviteOptions, host: [] });
    },
  );

  When("its author runs {string}", function* (_call: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("run", yield* runContractSuite(yield* contractSetup));
  });

  Then("the suite runs to completion without needing awthaq's own source code", function* () {
    const { outcomes } = yield* World;
    const run = yield* outcomes.getAs("run", isContractRun);
    assert.deepEqual(run.failed, []);
    assert.ok(run.passed.length >= inviteOptions.length, "every registered check ran and passed");
  });

  // ---- BEH-EA-199 --------------------------------------------------------------------------

  Given(
    "a plugin whose {string} tap emits a span or event containing a {string}-wrapped value",
    function* (_point: string, _wrapper: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("leak", "log");
    },
  );

  When("{string} runs against that plugin", function* (_runner: string) {
    const { outcomes } = yield* World;
    const leak = yield* outcomes.getAs("leak", isString);
    const run = yield* Effect.promise(async () => {
      const sink = new Recorder();
      TestAuth.runPluginContractTests(recordingFramework(sink), () => Password.Password, {
        options: [{}],
        redaction: {
          app: passwordApp,
          exercise: () =>
            leak === "log"
              ? Effect.log("welcome", Redacted.make("s3cr3t-welcome-token"))
              : Effect.void,
        },
      });
      await sink.settled();
      return { passed: sink.passed, failed: sink.failed };
    });
    yield* outcomes.set("run", run);
  });

  Then("the contract test fails", function* () {
    const { outcomes } = yield* World;
    const run = yield* outcomes.getAs("run", isContractRun);
    assert.ok(run.failed.length > 0);
  });

  Then("the failure is not left to a code review to catch", function* () {
    const { outcomes } = yield* World;
    const run = yield* outcomes.getAs("run", isContractRun);
    const failure = run.failed.find((message) => message.includes("BEH-EA-199"));
    assert.ok(failure !== undefined, run.failed.join(" | "));
    assert.match(failure, /Redacted instance/);
    // The verdict names the channel, never the secret itself.
    assert.doesNotMatch(failure, /s3cr3t-welcome-token/);
  });

  Given(
    "a plugin whose contract hash is computed once with its default options and again with a different {string} option",
    function* (_option: string) {
      // A contract rebuilt per option value — exactly what ADR-EA-011 forbids.
      yield* setUp({
        make: () => composable("minlen", {}),
        options: [{ minLength: 8 }, { minLength: 12 }],
        host: [],
      });
    },
  );

  When("{string} compares the two contract hashes", function* (_runner: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("run", yield* runContractSuite(yield* contractSetup));
  });

  Then("the contract test fails because the two hashes differ", function* () {
    const { outcomes } = yield* World;
    const run = yield* outcomes.getAs("run", isContractRun);
    assert.ok(
      run.failed.some((message) => message.includes("contract changed")),
      run.failed.join(" | "),
    );
  });

  Given(
    "a plugin that emits no {string} value in any span or event and whose contract hash is identical across every supplied option combination",
    function* (_wrapper: string) {
      yield* setUp({ make: () => Password.Password, options: [{}, {}], host: [] });
    },
  );

  When("{string} runs", function* (_runner: string) {
    const { outcomes } = yield* World;
    const run = yield* Effect.promise(async () => {
      const sink = new Recorder();
      TestAuth.runPluginContractTests(recordingFramework(sink), () => Password.Password, {
        options: [{}, {}],
        redaction: {
          app: passwordApp,
          exercise: () =>
            Effect.gen(function* () {
              const password = yield* Password.Password;
              yield* password.signUp({ email: "clean@example.com", password: strongPassword });
            }),
        },
      });
      await sink.settled();
      return { passed: sink.passed, failed: sink.failed };
    });
    yield* outcomes.set("run", run);
  });

  Then("both checks pass", function* () {
    const { outcomes } = yield* World;
    const run = yield* outcomes.getAs("run", isContractRun);
    assert.deepEqual(run.failed, []);
    assert.ok(run.passed.some((name) => name.includes("no Redacted value or watched secret")));
    assert.ok(
      run.passed.some((name) => name.includes("does not change the plugin's own contract")),
    );
  });

  // ---- BEH-EA-200 (PV-260) ------------------------------------------------------------------
  // The plugin under test declares a tap the way `AuthPlugin.layer`'s `taps` option does (its
  // `plugin.taps` entry then carries the handler and owner); the suite runs that handler.

  const declaring = (id: string, tap: HookPoint.TapDeclaration<unknown>) =>
    composable(id, { taps: [{ ...tap, owner: id }] });

  const observeStub = (name: string) => {
    assert.equal(name, "AfterSignUp", "this World stubs the AfterSignUp observe point");
    return { point: Hooks.AfterSignUp, input: { userId: "u1", strategy: "password" } };
  };

  const vetoStub = (name: string) => {
    assert.equal(name, "BeforeSignUp", "this World stubs the BeforeSignUp veto point");
    return {
      point: Hooks.BeforeSignUp,
      input: { name: "Ada", email: "ada@example.com", strategy: "password" },
    };
  };

  Given(
    "a plugin {string} declaring a tap on the observe point {string} that completes normally",
    function* (id: string, point: string) {
      yield* setUp({
        make: () =>
          declaring(
            id,
            Hooks.AfterSignUp.declareTap(() => Effect.void),
          ),
        options: [{}],
        host: [],
        hooks: [observeStub(point)],
      });
    },
  );

  Given(
    "a plugin {string} declaring a tap on the observe point {string} that fails because its {string} is unavailable",
    function* (id: string, point: string, dependency: string) {
      yield* setUp({
        make: () =>
          declaring(
            id,
            Hooks.AfterSignUp.declareTap(() => Effect.fail(`${dependency} unavailable`)),
          ),
        options: [{}],
        host: [],
        hooks: [observeStub(point)],
      });
    },
  );

  Given(
    "a plugin {string} declaring a tap on the veto point {string} that aborts with code {string}",
    function* (id: string, point: string, code: string) {
      yield* setUp({
        make: () =>
          declaring(
            id,
            Hooks.BeforeSignUp.declareTap(() => Effect.fail(new HookPoint.HookAbort({ code }))),
          ),
        options: [{}],
        host: [],
        hooks: [vetoStub(point)],
      });
    },
  );

  Given(
    "a plugin {string} declaring a tap on the observe point {string} that attempts to abort with code {string}",
    function* (id: string, point: string, code: string) {
      yield* setUp({
        make: () =>
          declaring(
            id,
            Hooks.AfterSignUp.declareTap(() => Effect.fail(new HookPoint.HookAbort({ code }))),
          ),
        options: [{}],
        host: [],
        hooks: [observeStub(point)],
      });
    },
  );

  When(
    "{string} exercises the declared tap with a stub input for its point",
    function* (_runner: string) {
      const { outcomes } = yield* World;
      yield* outcomes.set("run", yield* runContractSuite(yield* contractSetup));
    },
  );

  /** The suite ran the plugin's own handler on a point of its kind, and every check passed. */
  const kindCheckPassed = Effect.gen(function* () {
    const { outcomes } = yield* World;
    const run = yield* outcomes.getAs("run", isContractRun);
    assert.deepEqual(run.failed, []);
    assert.ok(
      run.passed.some((name) => name.includes("obeys its point's kind")),
      `the hook-kind check did not run: ${run.passed.join(" | ")}`,
    );
    assert.ok(run.passed.some((name) => name.includes("registers this plugin's handler")));
  });

  Then("it asserts the sign-up operation is not aborted by the tap", function* () {
    yield* kindCheckPassed;
  });

  Then(
    "it asserts the sign-up operation still succeeds despite {string}'s failure",
    function* (_plugin: string) {
      yield* kindCheckPassed;
    },
  );

  Then(
    "it asserts the abort is accepted, because {string} is a veto point",
    function* (_point: string) {
      yield* kindCheckPassed;
    },
  );

  Then(
    "the failure names {string} as an observe point whose tap tried to abort",
    function* (_point: string) {
      const { outcomes } = yield* World;
      const run = yield* outcomes.getAs("run", isContractRun);
      assert.ok(
        run.failed.some(
          (message) =>
            message.includes("tried to abort") &&
            message.includes("observe point") &&
            message.includes("auth.user.signedUp"),
        ),
        run.failed.join(" | "),
      );
    },
  );
});
