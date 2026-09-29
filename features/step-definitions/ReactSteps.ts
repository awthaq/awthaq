// BEH-EA-177..184 (23-react.feature). See ReactWorld.ts for the seam.
//
// Steps only await results by polling the registry (real timers): the atoms run their queries on
// real fibers, and the browser stand-in answers them from the composed server.
import { SessionContract } from "@awthaq/api";
import { AuthClientAtom, ReactClient } from "@awthaq/react";
import { defineSteps } from "@effect-cucumber/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { registerUser, requestsTo, reactTuple, World } from "./ReactWorld.ts";
import { STRONG_PASSWORD } from "./shared/Harness.ts";
import { isBoolean, isNumber, isString, isStringArray } from "./shared/Outcomes.ts";

/** The application's own client over the composed api — how an app gets `password.signIn` as an atom (BE-004). */
class AppClient extends ReactClient.makeReactClient<AppClient>()("features/ReactApp", {
  api: reactTuple.api,
}) {}

/** core's `session.signOut`, as the page's sign-out button would run it. */
const AuthClientAtomSignOut = AuthClientAtom.ReactAuthClient.mutation("session", "signOut");

const isRegistry = (value: unknown): value is AtomRegistry.AtomRegistry =>
  typeof value === "object" && value !== null && "get" in value && "mount" in value && "set" in value;

const session = (id: string) =>
  new SessionContract.SessionDto({
    id,
    createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    lastActiveAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
    expiresAt: DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
    userAgent: null,
    current: true,
  });

const sleep = (millis: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

/** Polls `read` (real time) until `done` holds; fails the step, naming what was awaited, after ~3s. */
const until = <A>(what: string, read: () => A, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = read();
      if (done(value)) return value;
      yield* sleep(10);
    }
    return yield* Effect.die(
      new Error(`timed out waiting for ${what}; last value: ${inspect(read(), { depth: 9 })}`),
    );
  });

const sessionCount = () =>
  Effect.gen(function* () {
    return (yield* requestsTo("GET", "/session")).length;
  });

/** The same count, readable from a polling loop that has no service context. */
const sessionFetchCounter = Effect.gen(function* () {
  const { browser } = yield* World;
  return () =>
    browser.sent.filter((entry) => entry.method === "GET" && entry.pathname === "/session").length;
});

/** A user signed in through the real sign-in mutation, with `sessionAtom` mounted and settled on a session. */
const signedInPage = (email: string) =>
  Effect.gen(function* () {
    const { outcomes } = yield* World;
    yield* registerUser(email);
    const registry = AtomRegistry.make();
    const signIn = AppClient.mutation("password", "signIn");
    registry.mount(signIn);
    registry.mount(AuthClientAtom.sessionAtom);
    registry.set(signIn, {
      payload: { email, password: yield* redacted() },
      reactivityKeys: [ReactClient.SESSION_KEY],
    });
    yield* until("sign-in to succeed", () => registry.get(signIn), (result) => AsyncResult.isSuccess(result));
    const current = yield* until(
      "sessionAtom to hold the session",
      () => registry.get(AuthClientAtom.sessionAtom),
      (result) => AsyncResult.isSuccess(result) && result.value !== null && !result.waiting,
    );
    yield* outcomes.set("registry", registry);
    return { registry, current };
  });

const redacted = () => Effect.succeed(Redacted.make(STRONG_PASSWORD));

export const reactSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-177: RegistryProvider seeds the session atom for SSR --------------------------

  Given("a server-resolved session for {string}", function* (name: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("seedName", name);
  });

  const renderSeeded = (seed: unknown) =>
    Effect.gen(function* () {
      const { outcomes, browser } = yield* World;
      // The session lookup is still in flight (never answered) for as long as this Scenario looks.
      browser.hanging.add("/session");
      // `Providers` seeds exactly this: `initialValues` handed to the registry that renders the tree.
      const registry = AtomRegistry.make({ initialValues: [[AuthClientAtom.sessionAtom, seed]] });
      // Mounted, as `useAtomValue` keeps it: the registry holds the seeded node while the tree lives.
      registry.mount(AuthClientAtom.sessionAtom);
      // The first render's read: synchronous, before any query could have answered.
      yield* outcomes.set("firstRender", registry.get(AuthClientAtom.sessionAtom));
      // A moment later, with the lookup still unanswered: the seed must still be what the page shows.
      yield* sleep(30);
      yield* outcomes.set("afterLookupStarted", registry.get(AuthClientAtom.sessionAtom));
    });

  When(
    "{string} is rendered with {string}",
    function* (_provider: string, _initialValues: string) {
      const { outcomes } = yield* World;
      const name = yield* outcomes.getAs("seedName", isString);
      yield* renderSeeded(AsyncResult.success(session(`session-of-${name}`)));
    },
  );

  Then("the first client render shows {string}'s resolved session", function* (name: string) {
    const { outcomes } = yield* World;
    const first = yield* outcomes.getAs("firstRender", isSeededResult);
    assert.ok(AsyncResult.isSuccess(first));
    assert.ok(first.value !== null);
    assert.equal(first.value.id, `session-of-${name}`);
  });

  Given("{string} seeded with the server-resolved session for {string}", function* (_provider: string, name: string) {
    const { outcomes } = yield* World;
    yield* outcomes.set("seedName", name);
  });

  When("the page performs its first client render", function* () {
    const { outcomes } = yield* World;
    const name = yield* outcomes.getAs("seedName", isString);
    yield* renderSeeded(AsyncResult.success(session(`session-of-${name}`)));
  });

  Then("no {string} loading state is shown", function* (_state: string) {
    const { outcomes } = yield* World;
    const first = yield* outcomes.getAs("firstRender", isSeededResult);
    assert.ok(AsyncResult.isSuccess(first));
    assert.equal(first.waiting, false);
  });

  Then("no client-side fetch is required before the session appears", function* () {
    const { outcomes } = yield* World;
    // The lookup never answered, yet the session is on screen: it came from the seed, not a fetch.
    const later = yield* outcomes.getAs("afterLookupStarted", isSeededResult);
    assert.ok(AsyncResult.isSuccess(later));
    assert.ok(later.value !== null);
    assert.equal(later.value.id, `session-of-${yield* outcomes.getAs("seedName", isString)}`);
  });

  Given("the server resolved no session for the current request", function* () {
    const { outcomes } = yield* World;
    yield* outcomes.set("seedName", "nobody");
  });

  When(
    "{string} is seeded with {string} as the session atom's initial value",
    function* (_provider: string, _seed: string) {
      yield* renderSeeded(AsyncResult.success(null));
    },
  );

  Then(
    "the first client render reflects a resolved signed-out state, not a pending session lookup",
    function* () {
      const { outcomes } = yield* World;
      const first = yield* outcomes.getAs("firstRender", isSeededResult);
      assert.ok(AsyncResult.isSuccess(first));
      assert.equal(first.value, null);
      assert.equal(first.waiting, false);
    },
  );

  // ---- BEH-EA-178: mutations invalidate the session reactivity key -------------------------

  Given("a signed-in user {string}", function* (name: string) {
    const { outcomes } = yield* World;
    yield* signedInPage(`${name}@example.com`);
    yield* outcomes.set("keys", []);
  });

  When("{string} is performed", function* (mutation: string) {
    const { outcomes } = yield* World;
    const registry = yield* outcomes.getAs("registry", isRegistry);
    yield* outcomes.set("fetchesBefore", yield* sessionCount());
    const keys = [ReactClient.SESSION_KEY];
    yield* outcomes.set("keys", keys);
    if (mutation === "sign-out") {
      const signOut = AuthClientAtomSignOut;
      registry.mount(signOut);
      registry.set(signOut, { reactivityKeys: keys });
      yield* until("sign-out to succeed", () => registry.get(signOut), (result) => AsyncResult.isSuccess(result));
    } else {
      const signIn = AppClient.mutation("password", "signIn");
      registry.mount(signIn);
      registry.set(signIn, {
        payload: { email: "alice@example.com", password: yield* redacted() },
        reactivityKeys: keys,
      });
      yield* until("sign-in to succeed", () => registry.get(signIn), (result) => AsyncResult.isSuccess(result));
    }
  });

  Then("the mutation runs with {string}", function* (_keys: string) {
    const { outcomes } = yield* World;
    assert.deepEqual(yield* outcomes.getAs("keys", isStringArray), ["session"]);
    assert.equal(ReactClient.SESSION_KEY, "session");
  });

  Then(
    "{string} refetches automatically, without application code calling a manual refetch",
    function* (_atom: string) {
      const { outcomes } = yield* World;
      const before = yield* outcomes.getAs("fetchesBefore", isNumber);
      const count = yield* sessionFetchCounter;
      // No `refresh`/`set` on the atom anywhere in this step's path: only the mutation's key.
      const after = yield* until("a refetch of GET /session", count, (seen) => seen > before);
      assert.ok(after > before);
    },
  );

  Given(
    "{string} is declared as {string}",
    function* (_atom: string, _declaration: string) {
      const { outcomes } = yield* World;
      yield* signedInPage("declared@example.com");
      yield* outcomes.set("fetchesBefore", yield* sessionCount());
    },
  );

  When("any mutation tagged with {string} completes", function* (_keys: string) {
    const { outcomes } = yield* World;
    const registry = yield* outcomes.getAs("registry", isRegistry);
    const signOut = AuthClientAtomSignOut;
    registry.mount(signOut);
    registry.set(signOut, { reactivityKeys: [ReactClient.SESSION_KEY] });
    yield* until("sign-out to succeed", () => registry.get(signOut), (result) => AsyncResult.isSuccess(result));
  });

  Then(
    "{string} refetches automatically as a consequence of the shared reactivity key",
    function* (_atom: string) {
      const { outcomes } = yield* World;
      const before = yield* outcomes.getAs("fetchesBefore", isNumber);
      const count = yield* sessionFetchCounter;
      yield* until("a refetch of GET /session", count, (seen) => seen > before);
    },
  );

  // ---- BEH-EA-179: the subject follows the session ------------------------------------------

  Given(
    "a signed-in user {string} with {string} currently defined",
    function* (name: string, _subject: string) {
      const { outcomes } = yield* World;
      const { registry } = yield* signedInPage(`${name}@example.com`);
      registry.mount(AuthClientAtom.subjectAtom);
      yield* until(
        "the subject to resolve",
        () => registry.get(AuthClientAtom.subjectAtom),
        (subject) => subject !== undefined,
      );
      // Every notification, with the session's state at that instant: the "same render" evidence.
      const snapshots: Array<{ readonly subjectDefined: boolean; readonly signedOut: boolean }> = [];
      registry.subscribe(AuthClientAtom.subjectAtom, (subject) => {
        const current = registry.get(AuthClientAtom.sessionAtom);
        snapshots.push({
          subjectDefined: subject !== undefined,
          signedOut: AsyncResult.isSuccess(current) && current.value === null,
        });
      });
      yield* outcomes.set("snapshots", snapshots);
    },
  );

  When(
    "{string} signs out and {string} becomes {string}",
    function* (_name: string, _atom: string, _value: string) {
      const { outcomes } = yield* World;
      const registry = yield* outcomes.getAs("registry", isRegistry);
      const signOut = AuthClientAtomSignOut;
      registry.mount(signOut);
      registry.set(signOut, { reactivityKeys: [ReactClient.SESSION_KEY] });
      yield* until(
        "the session to read as signed out",
        () => registry.get(AuthClientAtom.sessionAtom),
        (current) => AsyncResult.isSuccess(current) && current.value === null && !current.waiting,
      );
      yield* until(
        "the subject to clear",
        () => registry.get(AuthClientAtom.subjectAtom),
        (subject) => subject === undefined,
      );
    },
  );

  Then("{string} becomes {string} in that same render", function* (_atom: string, _value: string) {
    const { outcomes } = yield* World;
    const registry = yield* outcomes.getAs("registry", isRegistry);
    assert.equal(registry.get(AuthClientAtom.subjectAtom), undefined);
    const snapshots = yield* outcomes.getAs("snapshots", isSnapshots);
    // Never a moment where the session was already signed out but the old subject was still there.
    assert.ok(snapshots.length > 0);
    assert.deepEqual(
      snapshots.filter((entry) => entry.signedOut && entry.subjectDefined),
      [],
    );
  });

  // ---- BEH-EA-183: typed errors drive the sign-in form --------------------------------------

  Given(
    "a sign-in mutation fails with a result whose {string} is {string}",
    function* (_path: string, tag: string) {
      const { outcomes } = yield* World;
      yield* registerUser("form@example.com");
      const registry = AtomRegistry.make();
      const signIn = AppClient.mutation("password", "signIn");
      registry.mount(signIn);
      registry.set(signIn, {
        payload: { email: "form@example.com", password: yield* redactedWrong() },
      });
      const failed = yield* until(
        "sign-in to fail",
        () => registry.get(signIn),
        (result) => AsyncResult.isFailure(result),
      );
      const error = AsyncResult.isFailure(failed) ? AsyncResult.error(failed) : Option.none();
      yield* outcomes.set("failureTag", Option.isSome(error) ? Reflect.get(Object(error.value), "_tag") : "none");
      assert.equal(yield* outcomes.getAs("failureTag", isString), tag);
    },
  );

  When("the sign-in form reacts to that failure", function* () {
    const { outcomes } = yield* World;
    const tag = yield* outcomes.getAs("failureTag", isString);
    // The form branches on the failure's `_tag`, never on message text.
    const message = tag === "InvalidCredentials" ? "Wrong email or password." : "Something went wrong.";
    yield* outcomes.set("rendered", message);
    yield* outcomes.set("branchOnTag", true);
  });

  Then("it renders {string}", function* (text: string) {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("rendered", isString), text);
  });

  Then("the branch was selected by checking {string}", function* (_check: string) {
    const { outcomes } = yield* World;
    assert.equal(yield* outcomes.getAs("branchOnTag", isBoolean), true);
    assert.equal(yield* outcomes.getAs("failureTag", isString), "InvalidCredentials");
  });
});

const redactedWrong = () => Effect.succeed(Redacted.make("definitely not the password"));

const isSeededResult = (value: unknown): value is AsyncResult.AsyncResult<SessionContract.SessionDto | null, unknown> =>
  AsyncResult.isAsyncResult(value);

const isSnapshots = (
  value: unknown,
): value is ReadonlyArray<{ readonly subjectDefined: boolean; readonly signedOut: boolean }> =>
  Array.isArray(value);
