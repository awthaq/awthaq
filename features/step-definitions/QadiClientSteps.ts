// BEH-EA-177..184 (23-react.feature) and BEH-EA-186/187/192 (24-nextjs-ssr.feature): the gates a
// page renders from qadi's decisions. Everything here runs the real `@qadi/react` atoms and
// components (see QadiClientHarness.ts for how, without a DOM); what awthaq contributes is the wiring
// the scenarios name — the subject atom `QadiProvider` is fed, the server-decided seed
// `hydrateDecisions` produces, and the one evaluation path (BEH-EA-184).
import { defineSteps } from "@effect-cucumber/vitest";
import { currentDecision } from "@awthaq/react";
import { hasPermission, hasRole, makeSubject, permission, permissionKey } from "@qadi/core";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import assert from "node:assert/strict";
import { World as NextWorld } from "./NextSsrWorld.ts";
import { World as ReactWorld } from "./ReactWorld.ts";
import {
  aliceSubject,
  canDeleteProject,
  count,
  decideOnServer,
  isGateFixture,
  makeGateFixture,
  paintGate,
  paintProjected,
  permissionPolicies,
  registryFor,
  seedFromServer,
  set,
  sleep,
  verdictOf,
  waitFor,
} from "./QadiClientHarness.ts";
import { isString } from "./shared/Outcomes.ts";

const isRegistry = (value: unknown): value is AtomRegistry.AtomRegistry =>
  typeof value === "object" &&
  value !== null &&
  "get" in value &&
  "mount" in value &&
  "set" in value;

/** The three Then/Given phrasings the two features share, over whichever World's `outcomes` they run in. */
export const qadiClientReactSteps = defineSteps<ReactWorld>(({ Given, When, Then }) => {
  // ---- BEH-EA-179: gates close when the subject is gone ---------------------------------------

  Given(
    "several {string} gates mounted for {string}, each currently rendering an allowed action",
    function* (_gate: string, _name: string) {
      const { outcomes } = yield* ReactWorld;
      const fixture = makeGateFixture();
      const registry = registryFor(fixture, aliceSubject);
      for (const policy of permissionPolicies) registry.mount(fixture.atoms.decision(policy));
      yield* waitFor(
        "every gate to allow",
        () => permissionPolicies.map((policy) => verdictOf(registry, fixture, policy)),
        (verdicts) => verdicts.every((verdict) => verdict === "Allow"),
      );
      yield* outcomes.set("fixture", fixture);
      yield* outcomes.set("registry", registry);
    },
  );

  When(
    "{string} signs out and {string} becomes {string} in the same render",
    function* (_name: string, subject: string, value: string) {
      assert.deepEqual([subject, value], ["subject", "undefined"]);
      const { outcomes } = yield* ReactWorld;
      const fixture = yield* outcomes.getAs("fixture", isGateFixture);
      const registry = yield* outcomes.getAs("registry", isRegistry);
      registry.set(fixture.atoms.subject, undefined);
    },
  );

  Then("every one of those gates closes at once", function* () {
    const { outcomes } = yield* ReactWorld;
    const fixture = yield* outcomes.getAs("fixture", isGateFixture);
    const registry = yield* outcomes.getAs("registry", isRegistry);
    // Read synchronously after the write: no gate is granted by a decision that survived the subject.
    for (const policy of permissionPolicies) {
      assert.equal(verdictOf(registry, fixture, policy), undefined);
    }
  });

  Then(
    "no gate continues granting access on a stale, no-longer-current {string}",
    function* (_subject: string) {
      const { outcomes } = yield* ReactWorld;
      const fixture = yield* outcomes.getAs("fixture", isGateFixture);
      const registry = yield* outcomes.getAs("registry", isRegistry);
      yield* sleep(80);
      for (const policy of permissionPolicies) {
        assert.equal(verdictOf(registry, fixture, policy), undefined);
      }
    },
  );

  // ---- BEH-EA-180: a stale decision is not a decision -----------------------------------------

  Given(
    "qadi's evaluator is re-evaluating {string} for {string} against {string}",
    function* (_policy: string, _name: string, _resource: string) {
      const { outcomes } = yield* ReactWorld;
      // The attribute lookup never answers: the evaluation is in flight for as long as the scenario looks.
      const fixture = makeGateFixture({ gate: "blocked" });
      const registry = registryFor(fixture, aliceSubject);
      registry.mount(fixture.atoms.decision(canDeleteProject));
      yield* outcomes.set("fixture", fixture);
      yield* outcomes.set("registry", registry);
    },
  );

  When("{string} renders during that in-flight evaluation", function* (_gate: string) {
    const { outcomes } = yield* ReactWorld;
    const fixture = yield* outcomes.getAs("fixture", isGateFixture);
    yield* outcomes.set("html", paintGate(fixture, aliceSubject, canDeleteProject));
  });

  Then("the {string} state is rendered", function* (state: string) {
    assert.equal(state, "pending");
    const { outcomes } = yield* ReactWorld;
    assert.match(yield* outcomes.getAs("html", isString), /PENDING/);
  });

  Then("the previous verdict is not rendered in its place", function* () {
    const { outcomes } = yield* ReactWorld;
    const html = yield* outcomes.getAs("html", isString);
    assert.doesNotMatch(html, /GRANTED|DENIED/);
  });

  Given(
    "qadi's evaluator previously returned an Allow decision for {string} for {string}",
    function* (_policy: string, _name: string) {
      const { outcomes } = yield* ReactWorld;
      const fixture = makeGateFixture({ tier: "gold" });
      const registry = registryFor(fixture, aliceSubject);
      registry.mount(fixture.atoms.decision(canDeleteProject));
      yield* waitFor(
        "the first Allow",
        () => verdictOf(registry, fixture, canDeleteProject),
        (verdict) => verdict === "Allow",
      );
      yield* outcomes.set("fixture", fixture);
      yield* outcomes.set("registry", registry);
    },
  );

  Given(
    "{string}'s permission has just been revoked, triggering re-evaluation",
    function* (_name: string) {
      const { outcomes } = yield* ReactWorld;
      const fixture = yield* outcomes.getAs("fixture", isGateFixture);
      const registry = yield* outcomes.getAs("registry", isRegistry);
      // The grant is gone, and the re-check has not answered yet.
      set(fixture.gate, "blocked");
      registry.set(fixture.atoms.invalidate, undefined);
      yield* sleep(30);
    },
  );

  When(
    "{string} is gated by {string} during that re-evaluation",
    function* (_component: string, _gate: string) {
      const { outcomes } = yield* ReactWorld;
      const fixture = yield* outcomes.getAs("fixture", isGateFixture);
      const registry = yield* outcomes.getAs("registry", isRegistry);
      const raw = registry.get(fixture.atoms.decision(canDeleteProject));
      // The registry is holding the superseded Allow, flagged as waiting: exactly the state a gate must not act on.
      assert.ok(
        AsyncResult.isSuccess(raw) && raw.waiting,
        "the superseded decision is still held, waiting",
      );
      assert.equal(raw.value._tag, "Allow");
      yield* outcomes.set(
        "html",
        paintGate(fixture, aliceSubject, canDeleteProject, [
          [fixture.atoms.decision(canDeleteProject), raw],
        ]),
      );
    },
  );

  Then(
    "the {string} state is rendered instead of the stale Allow verdict",
    function* (state: string) {
      assert.equal(state, "pending");
      const { outcomes } = yield* ReactWorld;
      assert.match(yield* outcomes.getAs("html", isString), /PENDING/);
    },
  );

  Then(
    "{string} is not shown on the strength of the superseded decision",
    function* (_component: string) {
      const { outcomes } = yield* ReactWorld;
      assert.doesNotMatch(yield* outcomes.getAs("html", isString), /GRANTED/);
    },
  );

  Given("a policy re-evaluation in flight for {string}", function* (_name: string) {
    const { outcomes } = yield* ReactWorld;
    const fixture = makeGateFixture({ gate: "blocked" });
    const registry = registryFor(fixture, aliceSubject);
    registry.mount(fixture.atoms.decision(canDeleteProject));
    yield* outcomes.set("fixture", fixture);
    yield* outcomes.set("registry", registry);
  });

  When(
    "application code reads the decision via {string} instead of rendering {string} directly",
    function* (_reader: string, _gate: string) {
      const { outcomes } = yield* ReactWorld;
      const fixture = yield* outcomes.getAs("fixture", isGateFixture);
      const registry = yield* outcomes.getAs("registry", isRegistry);
      yield* outcomes.set(
        "current",
        currentDecision(registry.get(fixture.atoms.decision(canDeleteProject))) ?? "pending",
      );
    },
  );

  Then("{string} reflects the {string} state", function* (_reader: string, state: string) {
    assert.equal(state, "pending");
    const { outcomes } = yield* ReactWorld;
    assert.equal(yield* outcomes.getAs("current", isString), "pending");
  });

  Then(
    "application code never reads the raw async result of a manual query to determine authorization state",
    function* () {
      const { outcomes } = yield* ReactWorld;
      const fixture = yield* outcomes.getAs("fixture", isGateFixture);
      const registry = yield* outcomes.getAs("registry", isRegistry);
      // Why: the raw result is a Success-shaped value the moment anything has ever been decided, or an
      // Initial one now; only `currentDecision` collapses "not decided yet" into one answer.
      const raw = registry.get(fixture.atoms.decision(canDeleteProject));
      assert.ok(AsyncResult.isInitial(raw) || raw.waiting);
      assert.equal(currentDecision(raw), undefined);
    },
  );

  // ---- BEH-EA-181: useInvalidate re-decides every mounted gate --------------------------------

  Given(
    "a mounted {string} gate that previously decided {string} for {string}",
    function* (_gate: string, verdict: string, _name: string) {
      assert.equal(verdict, "Deny");
      const { outcomes } = yield* ReactWorld;
      const fixture = makeGateFixture({ tier: "silver" });
      const registry = registryFor(fixture, aliceSubject);
      registry.mount(fixture.atoms.decision(canDeleteProject));
      yield* waitFor(
        "the first Deny",
        () => verdictOf(registry, fixture, canDeleteProject),
        (value) => value === "Deny",
      );
      yield* outcomes.set("fixture", fixture);
      yield* outcomes.set("registry", registry);
    },
  );

  When("{string} completes and {string} is called", function* (_mutation: string, hook: string) {
    assert.equal(hook, "useInvalidate()");
    const { outcomes } = yield* ReactWorld;
    const fixture = yield* outcomes.getAs("fixture", isGateFixture);
    const registry = yield* outcomes.getAs("registry", isRegistry);
    // The grant happened elsewhere (the server); `useInvalidate()`'s callback is this one write.
    set(fixture.tier, "gold");
    registry.set(fixture.atoms.invalidate, undefined);
  });

  Then("the gate re-runs its decision against the refreshed subject", function* () {
    const { outcomes } = yield* ReactWorld;
    const fixture = yield* outcomes.getAs("fixture", isGateFixture);
    const registry = yield* outcomes.getAs("registry", isRegistry);
    yield* waitFor(
      "the gate to re-decide",
      () => verdictOf(registry, fixture, canDeleteProject),
      (verdict) => verdict === "Allow",
    );
  });

  When(
    "{string} accepts an invite that changes what she may do, and {string} is not called",
    function* (_name: string, _hook: string) {
      const { outcomes } = yield* ReactWorld;
      const fixture = yield* outcomes.getAs("fixture", isGateFixture);
      set(fixture.tier, "gold");
      yield* sleep(120);
    },
  );

  Then("the gate keeps showing its stale {string} decision", function* (verdict: string) {
    assert.equal(verdict, "Deny");
    const { outcomes } = yield* ReactWorld;
    const fixture = yield* outcomes.getAs("fixture", isGateFixture);
    const registry = yield* outcomes.getAs("registry", isRegistry);
    assert.equal(verdictOf(registry, fixture, canDeleteProject), "Deny");
  });

  Then("it only reflects the new grant if it happens to remount", function* () {
    const { outcomes } = yield* ReactWorld;
    const fixture = yield* outcomes.getAs("fixture", isGateFixture);
    // A remount is a fresh registry entry: the gate asks again and now sees the grant.
    const remounted = registryFor(fixture, aliceSubject);
    remounted.mount(fixture.atoms.decision(canDeleteProject));
    yield* waitFor(
      "the remounted gate to decide",
      () => verdictOf(remounted, fixture, canDeleteProject),
      (verdict) => verdict === "Allow",
    );
  });

  // ---- BEH-EA-182: useProjected trims what a component can render -----------------------------

  const DATA = { name: "Quarterly plan", email: "owner@example.com", budget: "1200000" };
  const granted = hasPermission(permission("project", "read"), { fields: ["name", "email"] });
  const reader = makeSubject({
    id: "user:alice",
    permissions: [permissionKey(permission("project", "read"))],
  });

  Given(
    "qadi's evaluator would return an Allow decision for {string} against {string}, granting a subset of its fields",
    function* (_policy: string, _resource: string) {
      const { outcomes } = yield* ReactWorld;
      yield* outcomes.set("fixture", makeGateFixture());
    },
  );

  When("a component reads {string}", function* (_call: string) {
    const { outcomes } = yield* ReactWorld;
    const fixture = yield* outcomes.getAs("fixture", isGateFixture);
    yield* outcomes.set("json", paintProjected(fixture, reader, granted, DATA));
  });

  Then("the returned view contains only the fields the decision grants", function* () {
    const { outcomes } = yield* ReactWorld;
    const html = yield* outcomes.getAs("json", isString);
    assert.match(html, /Quarterly plan/);
    assert.match(html, /owner@example.com/);
    assert.doesNotMatch(html, /budget|1200000/);
  });

  Given(
    "a field of {string} that the current decision does not grant",
    function* (_resource: string) {
      const { outcomes } = yield* ReactWorld;
      yield* outcomes.set("fixture", makeGateFixture());
    },
  );

  When("the component renders using {string}", function* (_call: string) {
    const { outcomes } = yield* ReactWorld;
    const fixture = yield* outcomes.getAs("fixture", isGateFixture);
    yield* outcomes.set("json", paintProjected(fixture, reader, granted, DATA));
  });

  Then("that field is absent from the returned data itself", function* () {
    const { outcomes } = yield* ReactWorld;
    // The component printed the data it was handed: the withheld field's name and value are not in it.
    assert.doesNotMatch(yield* outcomes.getAs("json", isString), /budget|1200000/);
  });

  Then(
    "it is never present in rendered component props merely hidden by conditional JSX",
    function* () {
      const { outcomes } = yield* ReactWorld;
      // Nothing to hide: the value never reached the component, so it is not in anything the page ships.
      assert.equal((yield* outcomes.getAs("json", isString)).includes("1200000"), false);
    },
  );

  // ---- BEH-EA-184: one evaluation path ---------------------------------------------------------

  Given(
    "qadi's evaluator would return a Deny decision for a policy checking {string} against subject {string}",
    function* (_policy: string, _name: string) {
      const { outcomes } = yield* ReactWorld;
      yield* outcomes.set("fixture", makeGateFixture());
    },
  );

  When("a React gate renders that policy for {string}", function* (_name: string) {
    const { outcomes } = yield* ReactWorld;
    const fixture = yield* outcomes.getAs("fixture", isGateFixture);
    yield* outcomes.set(
      "html",
      paintGate(fixture, makeSubject({ id: "user:alice" }), hasRole("admin")),
    );
    const registry = registryFor(fixture, makeSubject({ id: "user:alice" }));
    registry.mount(fixture.atoms.decision(hasRole("admin")));
    const decision = yield* waitFor(
      "the role decision",
      () => currentDecision(registry.get(fixture.atoms.decision(hasRole("admin")))),
      (value) => value !== undefined,
    );
    yield* outcomes.set("evaluationId", decision?.evaluationId ?? "");
    yield* outcomes.set("verdict", decision?._tag ?? "");
  });

  Then("the gate's rendered verdict reflects qadi's evaluator's Deny decision", function* () {
    const { outcomes } = yield* ReactWorld;
    assert.match(yield* outcomes.getAs("html", isString), /DENIED/);
    assert.equal(yield* outcomes.getAs("verdict", isString), "Deny");
  });

  Then(
    "no client-only shortcut bypasses that evaluator call to render an Allow verdict instead",
    function* () {
      const { outcomes } = yield* ReactWorld;
      // An evaluation id is minted by the evaluator alone: a role shortcut in the component would carry none.
      assert.notEqual(yield* outcomes.getAs("evaluationId", isString), "");
      assert.doesNotMatch(yield* outcomes.getAs("html", isString), /GRANTED/);
    },
  );
});

/** BEH-EA-186/187/192 over NextSsrWorld: the server-decided seed the client paints from. */
export const qadiClientNextSteps = defineSteps<NextWorld>(({ Given, When, Then }) => {
  /** Server side: decide `canDeleteProject` for alice with a real evaluator (the tier is "gold"), dehydrate it. */
  const serverDecided = Effect.gen(function* () {
    const { outcomes } = yield* NextWorld;
    const server = makeGateFixture({ tier: "gold" });
    const decision = yield* decideOnServer(server, aliceSubject, canDeleteProject);
    // The client's own atoms are a different set (a browser) whose resolver never answers: any verdict
    // the first paint shows can only have come from the server's seed, not from a fresh evaluation.
    const client = makeGateFixture({ tier: "gold", gate: "blocked" });
    yield* outcomes.set("client", client);
    yield* outcomes.set(
      "seed",
      seedFromServer(client, aliceSubject, [{ policy: canDeleteProject, decision }]),
    );
  });

  Given("a page whose gates were already decided server-side and dehydrated", function* () {
    yield* serverDecided;
  });

  Given(
    "a policy the server already decided during page render, included in the dehydrated {string} payload",
    function* (_payload: string) {
      yield* serverDecided;
    },
  );

  const paintFromSeed = Effect.gen(function* () {
    const { outcomes } = yield* NextWorld;
    const client = yield* outcomes.getAs("client", isGateFixture);
    const seed = yield* outcomes.getAs("seed", isSeed);
    yield* outcomes.set("html", paintGate(client, aliceSubject, canDeleteProject, seed));
  });

  When(
    "the client renders those gates before {string} has hydrated the atom store",
    function* (_hydrate: string) {
      yield* paintFromSeed;
    },
  );

  When(
    "the client renders the {string} gate for that policy on first paint",
    function* (_gate: string) {
      yield* paintFromSeed;
    },
  );

  Then("the client does not re-decide those same policies from scratch", function* () {
    const { outcomes } = yield* NextWorld;
    // Its own evaluation cannot answer (the resolver is held), yet the gate is not pending: the seed is
    // what is on screen. (qadi does re-check a seeded decision once mounted, and reports a mismatch;
    // "from scratch" would have meant starting with nothing.)
    assert.match(yield* outcomes.getAs("html", isString), /GRANTED/);
  });

  Then(
    "the first client paint shows the correct gate states rather than a pending spinner for every gate",
    function* () {
      const { outcomes } = yield* NextWorld;
      const html = yield* outcomes.getAs("html", isString);
      assert.match(html, /GRANTED/);
      assert.doesNotMatch(html, /PENDING/);
    },
  );

  Then("it renders the server's real verdict immediately", function* () {
    const { outcomes } = yield* NextWorld;
    assert.match(yield* outcomes.getAs("html", isString), /GRANTED/);
  });

  Then(
    "it does not render {string} merely because the client has not yet run its own evaluation",
    function* (state: string) {
      assert.equal(state, "pending");
      const { outcomes } = yield* NextWorld;
      assert.doesNotMatch(yield* outcomes.getAs("html", isString), /PENDING/);
    },
  );

  Given(
    "a policy whose attribute resolver can only run in the browser and was not evaluated server-side",
    function* () {
      const { outcomes } = yield* NextWorld;
      // Nothing was decided on the server for it; in the browser the lookup is slow to answer.
      const client = makeGateFixture({ tier: "gold", gate: "blocked" });
      yield* outcomes.set("client", client);
      yield* outcomes.set("seed", seedFromServer(client, aliceSubject, []));
    },
  );

  When(
    "the client hydrates decisions via {string} and renders the gate for that policy",
    function* (_hydrate: string) {
      yield* paintFromSeed;
    },
  );

  Then(
    "the gate correctly stays {string} until the client's own evaluation completes",
    function* (state: string) {
      assert.equal(state, "pending");
      const { outcomes } = yield* NextWorld;
      assert.match(yield* outcomes.getAs("html", isString), /PENDING/);
      // ...and it is the client's own evaluation that settles it, once the browser-only lookup answers.
      const client = yield* outcomes.getAs("client", isGateFixture);
      set(client.gate, "open");
      const registry = registryFor(client, aliceSubject);
      registry.mount(client.atoms.decision(canDeleteProject));
      yield* waitFor(
        "the client's own evaluation",
        () => verdictOf(registry, client, canDeleteProject),
        (verdict) => verdict === "Allow",
      );
      assert.ok(count(client.asked) >= 1);
    },
  );
});

const isSeed = (value: unknown): value is ReadonlyArray<readonly [Atom.Atom<unknown>, unknown]> =>
  Array.isArray(value);
