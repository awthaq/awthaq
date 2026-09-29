// AH-003 tier 3: the steps of 12-hooks.feature (BEH-EA-089 through BEH-EA-096), driving the
// real hook points through the real sign-up/sign-in/delete flows, and the real `Auth.make`
// manifest for the static claims. The names the Gherkin uses for things that do not exist under
// that name in the shipped API (`HookAbort` as the caller-visible failure, `HookAbort.fail`,
// "the two-factor plugin's step-up tap") are mapped by the step that receives them, with a comment.
import { AuditLog, type AuthPlugin, HookPoint, Hooks, Users } from "@awthaq/core";
import { Mailer } from "@awthaq/ports";
import { Password } from "@awthaq/password";
import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import {
  AcmeAudit,
  AcmeGate,
  AcmeInvite,
  AcmeNormalize,
  addTap,
  attemptSignIn,
  attemptSignUp,
  fixtureManifest,
  fixturePlugins,
  fixtureTapRuns,
  InviteClaimingUsersTable,
  lastOutcome,
  noteTo,
  PRE,
  resolvedBeforeSignUp,
  runContract,
  seenBy,
  userExists,
  World,
} from "./HooksWorld.ts";
import { STRONG_PASSWORD } from "./shared/Harness.ts";

const SIGN_UP_POINT = "awthaq/hook/auth.user.signUp";
const SIGNED_UP_POINT = "awthaq/hook/auth.user.signedUp";

/** `kind: "veto"` (how the Gherkin spells a hook point's declared kind) -> `veto`. */
const kindOf = (literal: string) => {
  const kind = /^kind: "(veto|observe|divert)"$/.exec(literal)?.[1];
  assert.ok(kind !== undefined, `not a hook point kind literal: ${literal}`);
  return kind;
};

const pointNamed = (name: string) => {
  switch (name) {
    case "BeforeSignUp":
      return Hooks.BeforeSignUp;
    case "AfterSignUp":
      return Hooks.AfterSignUp;
    case "BeforeSessionIssue":
      return Hooks.BeforeSessionIssue;
    case "BeforeUserDelete":
      return Hooks.BeforeUserDelete;
    default:
      throw new Error(`no hook point named "${name}" in @awthaq/core's Hooks`);
  }
};

const pluginNamed = (id: string) => {
  switch (id) {
    case "acme.audit":
      return AcmeAudit;
    case "acme.normalize":
      return AcmeNormalize;
    case "acme.gate":
      return AcmeGate;
    default:
      throw new Error(`no fixture plugin "${id}"`);
  }
};

/** BEH-EA-093/091: "pre" is the feature's word for "before the default order"; anything else is a typo. */
const orderOf = (word: string) => {
  assert.equal(word, "pre", `unknown declared order "${word}"`);
  return PRE;
};

/** An independent recomputation of the run order from nothing but `dependsOn`, declared `order` and `id` (BEH-EA-096). */
const depthOf = (plugin: { readonly dependsOn: ReadonlyArray<AuthPlugin.Any> }): number =>
  plugin.dependsOn.reduce((deepest, dependency) => Math.max(deepest, 1 + depthOf(dependency)), 0);

const failingMailer: Mailer.MailerShape = {
  send: (message) =>
    Effect.fail(
      new Mailer.MailDeliveryFailed({
        template: message.template,
        reason: "the mail provider is unavailable",
        retryable: true,
      }),
    ),
  sent: Effect.succeed([]),
};

const installWelcome = Effect.gen(function* () {
  const { seen } = yield* World;
  const note = noteTo(seen);
  yield* addTap(
    Hooks.AfterSignUp.tap((input) =>
      note("Welcome", "attempted").pipe(
        Effect.andThen(failingMailer.send({ to: input.email ?? "", template: "welcome" })),
      ),
    ),
  );
});

/** The stand-in for the two-factor plugin's step-up tap on `BeforeSessionIssue` (`@awthaq/two-factor` is a placeholder): diverts a sign-in for any user recorded as enrolled. */
const installStepUpTap = Effect.gen(function* () {
  const { twoFactorEnabled } = yield* World;
  yield* addTap(
    Hooks.BeforeSessionIssue.tap((input) =>
      Effect.map(Ref.get(twoFactorEnabled), (enrolled) =>
        enrolled.includes(input.userId)
          ? Option.some(
              new Hooks.TwoFactorRequired({ userId: input.userId, challengeId: "challenge-1" }),
            )
          : Option.none(),
      ),
    ),
  );
});

const enrollInTwoFactor = (name: string) =>
  Effect.gen(function* () {
    const { twoFactorEnabled, userIds } = yield* World;
    const userId = (yield* Ref.get(userIds))[name];
    assert.ok(userId !== undefined, `"${name}" has not signed up`);
    yield* Ref.update(twoFactorEnabled, (existing) => [...existing, userId]);
  });

export const hooksSteps = defineSteps<World>(({ Given, When, Then }) => {
  // ---- BEH-EA-089: a point's failure semantics are its own definition's ----

  Given("a {string} hook point {string} defined by core", function* (kind: string, name: string) {
    assert.equal(pointNamed(name).kind, kindOf(kind));
  });

  When("an unrelated plugin later taps {string}", function* (name: string) {
    assert.equal(name, "BeforeSignUp");
    // A tap from a plugin that has nothing to do with the point, failing the way only a veto
    // tap's failure has meaning.
    yield* addTap(
      Hooks.BeforeSignUp.tap(() => Effect.fail(new HookPoint.HookAbort({ code: "UNRELATED_VETO" })), {
        owner: { id: "acme.unrelated", dependsOn: [] },
      }),
    );
  });

  Then(
    "the tap cannot change {string}'s {string} away from {string}",
    function* (name: string, field: string, kind: string) {
      assert.equal(field, "kind");
      const { host } = yield* World;
      assert.equal(name, "BeforeSignUp");
      const service = yield* host.run(Effect.map(Hooks.BeforeSignUp, (built) => built.kind));
      assert.equal(Hooks.BeforeSignUp.kind, kind);
      assert.equal(service, kind);
    },
  );

  Then("the point's failure semantics remain exactly as core defined them", function* () {
    // A veto's failure aborts the operation — where an observe point would have caught and
    // logged the very same failure and let the sign-up through.
    const outcome = yield* attemptSignUp("carol@example.com");
    assert.equal(outcome._tag, "Failure");
    assert.ok(outcome._tag === "Failure" && outcome.error === "HookAborted");
    assert.ok(outcome._tag === "Failure" && outcome.code === "UNRELATED_VETO");
    assert.equal(yield* userExists("carol@example.com"), false);
  });

  // ---- BEH-EA-090: a veto tap aborts with a typed HookAbort ----

  Given(
    "a {string} hook point {string} tapped by {string}, which rejects any email outside {string}",
    function* (kind: string, name: string, tapName: string, domain: string) {
      assert.equal(pointNamed(name).kind, kindOf(kind));
      assert.equal(tapName, "CompanyEmail");
      yield* addTap(
        Hooks.BeforeSignUp.tap((input) =>
          input.email?.endsWith(domain) === true
            ? Effect.succeed(input)
            : Effect.fail(
                new HookPoint.HookAbort({
                  code: "EMAIL_DOMAIN_NOT_ALLOWED",
                  message: `sign-ups are limited to ${domain} addresses`,
                }),
              ),
        ),
      );
    },
  );

  When("a sign-up is attempted with an email outside {string}", function* (_domain: string) {
    yield* attemptSignUp("alice@other.example");
  });

  Then("the sign-up operation is stopped", function* () {
    const outcome = yield* lastOutcome();
    assert.equal(outcome._tag, "Failure");
    assert.equal(yield* userExists("alice@other.example"), false);
  });

  Then(
    "the caller receives a {string} failure whose code is {string}",
    function* (failure: string, code: string) {
      // The tap fails with `HookAbort`; the flow translates it at the point it runs into the
      // wire-typed `HookAborted` (NAM-002), which is what a caller receives.
      assert.equal(failure, "HookAbort");
      const outcome = yield* lastOutcome();
      assert.ok(outcome._tag === "Failure");
      assert.equal(outcome.error, "HookAborted");
      assert.equal(outcome.code, code);
    },
  );

  Given(
    "{string} rejects a sign-up attempt with {string}",
    function* (tapName: string, expression: string) {
      assert.equal(tapName, "CompanyEmail");
      // `HookAbort.fail({ code })` is the spec's spelling; the shipped value is a `HookAbort`
      // constructed with its `code` (and an optional `message`).
      const code = /^HookAbort\.fail\(\{ code: "([^"]+)" \}\)$/.exec(expression)?.[1];
      assert.ok(code !== undefined, `not a HookAbort.fail expression: ${expression}`);
      yield* addTap(
        Hooks.BeforeSignUp.tap(() =>
          Effect.fail(new HookPoint.HookAbort({ code, message: "that email domain is not allowed" })),
        ),
      );
    },
  );

  When("the caller receives the failure", function* () {
    yield* attemptSignUp("mallory@other.example");
  });

  Then("the failure is a structured value carrying {string} and {string}", function* (a: string, b: string) {
    assert.deepEqual([a, b], ["code", "message"]);
    const outcome = yield* lastOutcome();
    assert.ok(outcome._tag === "Failure");
    assert.equal(outcome.code, "EMAIL_DOMAIN_NOT_ALLOWED");
    assert.equal(outcome.message, "that email domain is not allowed");
  });

  Then("the failure is not a generic or untyped error", function* () {
    const outcome = yield* lastOutcome();
    assert.ok(outcome._tag === "Failure");
    // A tagged, wire-typed failure naming the point that fired it.
    assert.equal(outcome.error, "HookAborted");
    assert.equal(outcome.point, "auth.user.signUp");
  });

  // ---- BEH-EA-091: amended values flow on; taps run in dependency order ----

  Given(
    "{string} is tapped by {string}, which lowercases the input email, with declared order {string}",
    function* (name: string, tapName: string, order: string) {
      assert.equal(name, "BeforeSignUp");
      assert.equal(tapName, "Normalize");
      yield* addTap(
        Hooks.BeforeSignUp.tap(
          (input) =>
            Effect.succeed(
              input.email === undefined ? input : { ...input, email: input.email.toLowerCase() },
            ),
          { order: orderOf(order) },
        ),
      );
    },
  );

  Given(
    "{string} is also tapped by {string}, which checks the domain of the email it receives",
    function* (name: string, tapName: string) {
      assert.equal(name, "BeforeSignUp");
      assert.equal(tapName, "CompanyEmail");
      const { seen } = yield* World;
      const note = noteTo(seen);
      yield* addTap(
        Hooks.BeforeSignUp.tap((input) =>
          note("CompanyEmail", input.email ?? "").pipe(
            Effect.andThen(
              // Case-sensitive on purpose: only the normalized email passes.
              input.email?.endsWith("@acme.com") === true
                ? Effect.succeed(input)
                : Effect.fail(new HookPoint.HookAbort({ code: "EMAIL_DOMAIN_NOT_ALLOWED" })),
            ),
          ),
        ),
      );
    },
  );

  When("a sign-up is attempted with email {string}", function* (email: string) {
    const { seen } = yield* World;
    const note = noteTo(seen);
    // What the operation itself received is what `AfterSignUp` is handed — the post-veto value.
    yield* addTap(Hooks.AfterSignUp.tap((input) => note("operation", input.email ?? "")));
    yield* attemptSignUp(email);
  });

  Then(
    "{string} observes the lowercased email {string} in place of the original",
    function* (tapName: string, expected: string) {
      assert.equal(tapName, "CompanyEmail");
      assert.deepEqual(yield* seenBy("CompanyEmail"), [expected]);
      assert.equal((yield* lastOutcome())._tag, "Success");
    },
  );

  Then("the sign-up operation itself observes the lowercased email", function* () {
    assert.deepEqual(yield* seenBy("operation"), ["alice@acme.com"]);
    const { host } = yield* World;
    const created = yield* host.run(
      Effect.flatMap(Users.Users, (users) => users.findByEmail("alice@acme.com")).pipe(Effect.orDie),
    );
    assert.ok(Option.isSome(created));
    assert.deepEqual(Users.emailOf(created.value), Option.some("alice@acme.com"));
  });

  Given(
    "three taps registered on {string} by plugins {string}, {string}, and {string}",
    function* (name: string, a: string, b: string, c: string) {
      assert.equal(name, "BeforeSignUp");
      const declared = (fixtureManifest()[SIGN_UP_POINT] ?? []).map((entry) => entry.plugin).sort();
      assert.deepEqual(declared, [a, b, c].sort());
      fixtureTapRuns.count = 0;
    },
  );

  Given("{string} depends on {string}", function* (dependent: string, dependency: string) {
    assert.deepEqual(
      pluginNamed(dependent).dependsOn.map((plugin) => plugin.id),
      [dependency],
    );
  });

  Given("{string} declares order {string}", function* (plugin: string, order: string) {
    const declared = pluginNamed(plugin).taps.find((tap) => tap.point === SIGN_UP_POINT);
    assert.equal(declared?.order, orderOf(order));
  });

  When("the tap chain for {string} is resolved", function* (name: string) {
    assert.equal(name, "BeforeSignUp");
    const { seen } = yield* World;
    const chain = yield* resolvedBeforeSignUp;
    yield* Ref.update(seen, (existing) => ({ ...existing, chain: chain.map((tap) => tap.owner) }));
  });

  Then(
    "{string} runs before {string} because of the dependency relationship",
    function* (first: string, second: string) {
      const chain = yield* seenBy("chain");
      assert.ok(chain.indexOf(first) !== -1 && chain.indexOf(first) < chain.indexOf(second));
      // Because of the dependency, not the declared order: a dependent that declared the lowest
      // order of all still sorts after what it depends on.
      assert.ok(
        HookPoint.compareTaps(
          { owner: pluginNamed(second), order: -1000 },
          { owner: pluginNamed(first), order: 1000 },
        ) > 0,
      );
    },
  );

  Then(
    "taps with no dependency relationship between them are ordered next by declared {string}",
    function* (word: string) {
      assert.equal(word, "order");
      const chain = yield* seenBy("chain");
      assert.ok(chain.indexOf("acme.normalize") < chain.indexOf("acme.audit"));
      // Flip the declared orders and the two swap: it is the order that decided it.
      assert.ok(
        HookPoint.compareTaps({ owner: AcmeNormalize, order: PRE }, { owner: AcmeAudit, order: 0 }) < 0,
      );
      assert.ok(
        HookPoint.compareTaps({ owner: AcmeNormalize, order: 5 }, { owner: AcmeAudit, order: 0 }) > 0,
      );
    },
  );

  Then("any remaining tie is broken by plugin id", function* () {
    const a = { id: "acme.a", dependsOn: [] };
    const b = { id: "acme.b", dependsOn: [] };
    assert.ok(HookPoint.compareTaps({ owner: a, order: 0 }, { owner: b, order: 0 }) < 0);
    assert.ok(HookPoint.compareTaps({ owner: b, order: 0 }, { owner: a, order: 0 }) > 0);
  });

  // ---- BEH-EA-092: an observe tap cannot fail what it observes ----

  Given(
    "a {string} hook point {string} tapped by {string}, which fails while sending its welcome email because its {string} is unavailable",
    function* (kind: string, name: string, tapName: string, dependency: string) {
      assert.equal(pointNamed(name).kind, kindOf(kind));
      assert.equal(tapName, "Welcome");
      assert.equal(dependency, "Mailer");
      yield* installWelcome;
    },
  );

  When("a sign-up completes and {string} fails while handling it", function* (tapName: string) {
    assert.equal(tapName, "Welcome");
    yield* attemptSignUp("dana@example.com");
  });

  Then("the sign-up operation itself succeeds", function* () {
    assert.equal((yield* lastOutcome())._tag, "Success");
    assert.equal(yield* userExists("dana@example.com"), true);
  });

  Then("{string}'s failure does not propagate to the sign-up operation", function* (tapName: string) {
    assert.equal(tapName, "Welcome");
    // It did run, and did fail — and the operation is none the wiser.
    assert.deepEqual(yield* seenBy("Welcome"), ["attempted"]);
    assert.equal((yield* lastOutcome())._tag, "Success");
  });

  Given(
    "the same {string} tap fails while handling {string}",
    function* (tapName: string, name: string) {
      assert.equal(tapName, "Welcome");
      assert.equal(pointNamed(name).kind, "observe");
      yield* installWelcome;
    },
  );

  When("its failure occurs", function* () {
    yield* attemptSignUp("erin@example.com");
  });

  Then("the failure is caught", function* () {
    assert.equal((yield* lastOutcome())._tag, "Success");
    assert.deepEqual(yield* seenBy("Welcome"), ["attempted"]);
  });

  Then("the failure is logged", function* () {
    const { host } = yield* World;
    const entries = (yield* host.logs).filter(
      (record) => record.level === "Error" && record.text.includes("auth.hook.observer.error"),
    );
    assert.equal(entries.length, 1);
    assert.ok(entries[0]?.text.includes(SIGNED_UP_POINT));
  });

  // ---- BEH-EA-093: a divert tap returns a typed alternative outcome ----

  Given(
    "the {string} hook point {string} is tapped by the two-factor plugin's step-up tap",
    function* (kind: string, name: string) {
      assert.equal(pointNamed(name).kind, kindOf(kind));
      // `@awthaq/two-factor` is a placeholder package (P15 builds it); this is the same tap it
      // will register on this point, so what the scenario proves — a divert tap redirecting a
      // sign-in to a typed outcome — is the hook mechanism itself, not the second factor.
      yield* installStepUpTap;
    },
  );

  Given("a signed-in user {string} has two-factor enabled", function* (name: string) {
    yield* attemptSignUp(`${name}@example.com`);
    yield* enrollInTwoFactor(`${name}@example.com`);
  });

  When("{string} signs in with a valid password", function* (name: string) {
    yield* attemptSignIn(`${name}@example.com`);
  });

  Then("the sign-in call resolves to a {string} outcome", function* (tag: string) {
    const outcome = yield* lastOutcome();
    assert.ok(outcome._tag === "Failure");
    assert.equal(outcome.error, tag);
  });

  Then(
    "this outcome is neither the sign-in operation's ordinary success value nor an ordinary failure",
    function* () {
      const outcome = yield* lastOutcome();
      assert.ok(outcome._tag === "Failure");
      // Not a credential failure...
      assert.notEqual(outcome.error, "InvalidCredentials");
      assert.notEqual(outcome.error, "HookAborted");
      // ...and not a success: the sign-in did not complete — no `auth.user.signedIn` was published...
      const { host } = yield* World;
      const signedIn = yield* host.run(
        Effect.flatMap(AuditLog.AuditLog, (log) => log.list({ eventTag: "auth.user.signedIn" })).pipe(
          Effect.orDie,
        ),
      );
      assert.equal(signedIn.length, 0);
      // ...whereas the same call for a user with no second factor is an ordinary success.
      yield* attemptSignUp("bob@example.com");
      assert.equal((yield* attemptSignIn("bob@example.com"))._tag, "Success");
    },
  );

  Given(
    "a {string} diverted outcome from {string}'s sign-in attempt",
    function* (tag: string, name: string) {
      yield* installStepUpTap;
      yield* attemptSignUp(`${name}@example.com`);
      yield* enrollInTwoFactor(`${name}@example.com`);
      const outcome = yield* attemptSignIn(`${name}@example.com`);
      assert.ok(outcome._tag === "Failure" && outcome.error === tag);
    },
  );

  When(
    "the caller handles the sign-in call's result with {string}",
    function* (expression: string) {
      assert.equal(expression, 'Effect.catchTag("TwoFactorRequired", ...)');
      const { host, seen } = yield* World;
      const note = noteTo(seen);
      const email = "alice@example.com";
      // The caller's own code: an ordinary `catchTag`, answering the diverted outcome with a
      // follow-up (here, the challenge to present next) instead of a success or a failure.
      yield* host.run(
        Effect.flatMap(Password.Password, (password) =>
          password.signIn({ email, password: Redacted.make(STRONG_PASSWORD) }),
        ).pipe(
          Effect.map(() => "success"),
          Effect.catchTag("TwoFactorRequired", (required) =>
            note("followUp", required.challengeId).pipe(Effect.as("follow-up")),
          ),
          Effect.catchTag("InvalidCredentials", () => Effect.succeed("failure")),
          Effect.orDie,
        ),
      );
      // The same call handled with a tag it does not carry leaves the diverted failure uncaught.
      const other = yield* host.run(
        Effect.flatMap(Password.Password, (password) =>
          password.signIn({ email, password: Redacted.make(STRONG_PASSWORD) }),
        ).pipe(
          Effect.map(() => "success"),
          Effect.catchTag("InvalidCredentials", () => Effect.succeed("caught-as-invalid")),
          Effect.match({ onFailure: (error) => `uncaught:${error._tag}`, onSuccess: (value) => value }),
        ),
      );
      yield* note("otherTag", other);
    },
  );

  Then(
    "the caller catches {string} by tag exactly as it would catch any other tagged result",
    function* (tag: string) {
      assert.equal(tag, "TwoFactorRequired");
      assert.deepEqual(yield* seenBy("followUp"), ["challenge-1"]);
      assert.deepEqual(yield* seenBy("otherTag"), ["uncaught:TwoFactorRequired"]);
    },
  );

  Then(
    "the caller answers it with a follow-up call rather than treating it as success or failure",
    function* () {
      // The follow-up carries the challenge to answer next; the sign-in it answers never issued a session.
      assert.deepEqual(yield* seenBy("followUp"), ["challenge-1"]);
      const { host } = yield* World;
      const issued = yield* host.run(
        Effect.flatMap(AuditLog.AuditLog, (log) => log.list({ eventTag: "auth.session.issued" })).pipe(
          Effect.orDie,
        ),
      );
      // Only alice's sign-up session: the two diverted sign-ins issued none.
      assert.equal(issued.length, 1);
    },
  );

  // ---- BEH-EA-095: reacting to core data only through the hook point ----

  Given("{string} needs to purge its own invitations when a user is deleted", function* (plugin: string) {
    assert.equal(plugin, "Invite");
    // The sanctioned mechanism exists: core exposes a veto point on user deletion.
    assert.equal(Hooks.BeforeUserDelete.kind, "veto");
  });

  When(
    "{string} taps {string} to purge its own {string} rows for that user",
    function* (plugin: string, name: string, table: string) {
      assert.equal(plugin, "Invite");
      assert.equal(name, "BeforeUserDelete");
      assert.ok(table.startsWith("acme.invite_"), `"${table}" is not Invite's own prefixed table`);
      const { invitations, seen } = yield* World;
      const note = noteTo(seen);
      yield* addTap(
        Hooks.BeforeUserDelete.tap(
          (input) =>
            note("Invite", input.id).pipe(
              Effect.andThen(
                Ref.update(invitations, (rows) => rows.filter((row) => row.userId !== input.id)),
              ),
              Effect.as(input),
            ),
          { owner: AcmeInvite },
        ),
      );
      const alice = yield* attemptSignUp("alice@example.com");
      const bob = yield* attemptSignUp("bob@example.com");
      assert.ok(alice._tag === "Success" && bob._tag === "Success");
      yield* Ref.set(invitations, [
        { id: "inv-1", userId: alice.userId },
        { id: "inv-2", userId: alice.userId },
        { id: "inv-3", userId: bob.userId },
      ]);
      const host = (yield* World).host;
      yield* host.run(
        Effect.flatMap(Users.Users, (users) => users.delete(Users.UserId(alice.userId))).pipe(
          Effect.orDie,
        ),
      );
    },
  );

  Then("{string}'s reaction runs entirely through the tap on {string}", function* (plugin: string, name: string) {
    assert.equal(plugin, "Invite");
    assert.equal(name, "BeforeUserDelete");
    const { invitations, userIds } = yield* World;
    const ids = yield* Ref.get(userIds);
    assert.deepEqual(yield* seenBy("Invite"), [ids["alice@example.com"]]);
    // Alice's rows are gone, Bob's untouched.
    assert.deepEqual(
      (yield* Ref.get(invitations)).map((row) => row.id),
      ["inv-3"],
    );
  });

  Then("no foreign key or database-level cascade into a core table is required", function* () {
    // The user really is gone, and the plugin's table has no link into core: it declares no
    // migration and reads no core table — the tap was the whole mechanism.
    assert.equal(yield* userExists("alice@example.com"), false);
    assert.equal(yield* userExists("bob@example.com"), true);
    assert.deepEqual(AcmeInvite.migrations, []);
    assert.deepEqual(AcmeInvite.readsTables, []);
    assert.ok(AcmeInvite.tables.every((table) => table.startsWith("acme.invite_")));
  });

  Given(
    "{string}'s migration attempts to alter the {string} table directly instead of tapping {string}",
    function* (plugin: string, table: string, name: string) {
      assert.equal(plugin, "Invite");
      assert.equal(name, "BeforeUserDelete");
      assert.deepEqual(InviteClaimingUsersTable.tables, [table]);
    },
  );

  When("migration ownership is checked", function* () {
    const { seen } = yield* World;
    const rejected = yield* runContract(() => InviteClaimingUsersTable);
    const sanctioned = yield* runContract(() => AcmeInvite);
    yield* Ref.update(seen, (existing) => ({
      ...existing,
      rejected: rejected.failures,
      sanctioned: sanctioned.failures,
      sanctionedTotal: [String(sanctioned.total)],
    }));
  });

  Then(
    "the migration is rejected as touching a table outside {string}'s own prefix",
    function* (plugin: string) {
      assert.equal(plugin, "Invite");
      const rejected = yield* seenBy("rejected");
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0]?.includes('table "users" does not carry plugin "acme.invite"'));
    },
  );

  Then(
    "{string}'s only sanctioned path to react to a user deletion remains tapping {string}",
    function* (plugin: string, name: string) {
      assert.equal(plugin, "Invite");
      // The plugin that stays inside its own prefix passes the whole suite (nothing rejected)...
      assert.deepEqual(yield* seenBy("sanctioned"), []);
      assert.ok(Number((yield* seenBy("sanctionedTotal"))[0]) > 0);
      // ...and declares its reaction as a tap on the point core exposes.
      assert.equal(pointNamed(name).kind, "veto");
      assert.ok(AcmeInvite.taps.some((tap) => tap.point === "awthaq/hook/auth.user.beforeDelete"));
    },
  );

  // ---- BEH-EA-096: the resolved order is introspectable without running anything ----

  Given(
    "an application composed from a plugin tuple with taps registered on multiple hook points",
    function* () {
      fixtureTapRuns.count = 0;
      assert.ok(Object.keys(fixtureManifest()).length >= 2);
    },
  );

  Given("the same composed application", function* () {
    fixtureTapRuns.count = 0;
    assert.ok(Object.keys(fixtureManifest()).length >= 2);
  });

  When("the composed application's manifest is read for its resolved hook order", function* () {
    // The manifest `Auth.make` computes is the static introspection surface; no layer is built.
    const { manifest } = yield* World;
    yield* Ref.set(manifest, fixtureManifest());
  });

  Then("it reports the fully resolved tap order for each hook point", function* () {
    const { manifest } = yield* World;
    const hooks = yield* Ref.get(manifest);
    assert.ok(hooks !== undefined);
    assert.deepEqual(
      (hooks[SIGN_UP_POINT] ?? []).map((tap) => tap.plugin),
      ["acme.normalize", "acme.audit", "acme.gate"],
    );
    assert.deepEqual(
      (hooks[SIGNED_UP_POINT] ?? []).map((tap) => tap.plugin),
      ["acme.audit"],
    );
  });

  Then("no tap is executed to produce that report", function* () {
    assert.equal(fixtureTapRuns.count, 0);
  });

  When("the resolved tap order is computed", function* () {
    const { manifest } = yield* World;
    yield* Ref.set(manifest, fixtureManifest());
  });

  Then(
    "it uses only each plugin's declared {string}, each tap's declared {string}, and each plugin's {string}",
    function* (dependsOn: string, order: string, id: string) {
      assert.deepEqual([dependsOn, order, id], ["dependsOn", "order", "id"]);
      const { manifest } = yield* World;
      const hooks = yield* Ref.get(manifest);
      assert.ok(hooks !== undefined);
      // Recomputed here from those three facts and nothing else — depth in the `dependsOn`
      // graph, then the tap's declared order, then the id — and compared with what was reported.
      const recomputed = fixturePlugins.manifest.plugins
        .map((entry) => pluginNamed(entry.id))
        .flatMap((plugin) =>
          plugin.taps
            .filter((tap) => tap.point === SIGN_UP_POINT)
            .map((tap) => ({ id: plugin.id, depth: depthOf(plugin), order: tap.order })),
        )
        .sort((a, b) => a.depth - b.depth || a.order - b.order || a.id.localeCompare(b.id))
        .map((tap) => tap.id);
      assert.deepEqual(
        (hooks[SIGN_UP_POINT] ?? []).map((tap) => tap.plugin),
        recomputed,
      );
    },
  );

  Then("no running application is needed to observe it", function* () {
    // Nothing ran: no tap executed, and this World's app was never even built (`configure`
    // refuses once it is).
    assert.equal(fixtureTapRuns.count, 0);
    const { host } = yield* World;
    yield* host.configure((spec) => spec);
  });
});
