// The client half of authorization, driven without a DOM: qadi's atoms (`makeQadiAtoms`, which the
// `@qadi/react` header says "have no React dependency at all") in a real `AtomRegistry`, and the real
// `QadiProvider` + `Can`/`useProjected` rendered to a string with `react-dom/server` — a first paint is
// exactly what a server render is, so "what the first client render shows" is observable without
// `window`. Shared by 23-react.feature and 24-nextjs-ssr.feature.
//
// One `GateFixture` per scenario: an attribute resolver the scenario can hold (`blocked`: the
// evaluation never answers, i.e. is in flight) or steer (`tier`), and a count of how many times it was
// asked, so "the client did not re-decide" is a count of zero rather than an inference.
import {
  AttributeResolver,
  CustomPredicateNone,
  DecisionHistoryUnknown,
  EvaluationIdLive,
  RelationshipResolverNever,
  SignatureHistoryNone,
  eq,
  hasAttribute,
  hasPermission,
  literal,
  makeSubject,
  permission,
  permissionKey,
} from "@qadi/core";
import type { AuthSubject, Decision, Policy } from "@qadi/core";
import {
  Can,
  QadiProvider,
  currentDecision,
  dehydrateDecisions,
  hydrateDecisions,
  makeQadiAtoms,
  useProjected,
} from "@awthaq/react";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";

export type Gate = "open" | "blocked";

export interface GateFixture {
  readonly atoms: ReturnType<typeof gateAtoms>;
  readonly gate: Ref.Ref<Gate>;
  readonly tier: Ref.Ref<string>;
  readonly asked: Ref.Ref<number>;
}

const gateAtoms = (gate: Ref.Ref<Gate>, tier: Ref.Ref<string>, asked: Ref.Ref<number>) =>
  makeQadiAtoms(
    Layer.mergeAll(
      Layer.succeed(AttributeResolver, {
        resolve: () =>
          Ref.update(asked, (n) => n + 1).pipe(
            Effect.andThen(Ref.get(gate)),
            Effect.flatMap((state) => (state === "blocked" ? Effect.never : Ref.get(tier))),
          ),
      }),
      RelationshipResolverNever,
      DecisionHistoryUnknown,
      EvaluationIdLive,
      CustomPredicateNone,
      SignatureHistoryNone,
    ),
  );

export const makeGateFixture = (initial: { readonly tier?: string; readonly gate?: Gate } = {}) => {
  const gate = Ref.makeUnsafe<Gate>(initial.gate ?? "open");
  const tier = Ref.makeUnsafe(initial.tier ?? "silver");
  const asked = Ref.makeUnsafe(0);
  return { atoms: gateAtoms(gate, tier, asked), gate, tier, asked } satisfies GateFixture;
};

export const isGateFixture = (value: unknown): value is GateFixture =>
  typeof value === "object" && value !== null && "atoms" in value && "asked" in value;

/** "canDeleteProject": a policy that needs the attribute resolver, so it cannot settle without it. */
export const canDeleteProject = hasAttribute("tier", eq(literal("gold")));

const read = permission("doc", "read");
const write = permission("doc", "write");
const remove = permission("doc", "delete");

/** Policies that need no resolver: they settle from the subject alone. */
export const permissionPolicies: ReadonlyArray<Policy> = [
  hasPermission(read),
  hasPermission(write),
  hasPermission(remove),
];

export const aliceSubject: AuthSubject = makeSubject({
  id: "user:alice",
  permissions: [read, write, remove].map(permissionKey),
});

export const set = <A>(ref: Ref.Ref<A>, value: A) => Effect.runSync(Ref.set(ref, value));

export const count = (ref: Ref.Ref<number>) => Effect.runSync(Ref.get(ref));

export const sleep = (millis: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, millis)));

/** Polls `read` (real time, ~3s) until `done`; the atoms evaluate on real fibers. */
export const waitFor = <A>(what: string, read: () => A, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = read();
      if (done(value)) return value;
      yield* sleep(10);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });

/** A registry holding `subject` as the subject atom, as `QadiProvider` builds one. */
export const registryFor = (fixture: GateFixture, subject: AuthSubject | undefined) =>
  AtomRegistry.make({ initialValues: [[fixture.atoms.subject, subject]] });

/** The verdict a gate would act on: `undefined` unless there is a current, settled decision. */
export const verdictOf = (
  registry: AtomRegistry.AtomRegistry,
  fixture: GateFixture,
  policy: Policy,
) => currentDecision(registry.get(fixture.atoms.decision(policy)))?._tag;

/** What the first client render paints for `<Can>` around a policy, given any pre-seeded atom values. */
export const paintGate = (
  fixture: GateFixture,
  subject: AuthSubject,
  policy: Policy,
  initialValues: ReadonlyArray<readonly [Atom.Atom<unknown>, unknown]> = [],
) =>
  renderToString(
    createElement(QadiProvider, {
      atoms: fixture.atoms,
      subject,
      initialValues,
      children: createElement(Can, {
        policy,
        pending: createElement("span", null, "PENDING"),
        fallback: createElement("span", null, "DENIED"),
        children: createElement("span", null, "GRANTED"),
      }),
    }),
  );

/** What `useProjected` hands a component for `data`, as the JSON that component would render. */
export const paintProjected = (
  fixture: GateFixture,
  subject: AuthSubject,
  policy: Policy,
  data: Readonly<Record<string, string>>,
) => {
  const Projected = (): ReactNode =>
    createElement("pre", null, JSON.stringify(useProjected(policy, data)));
  return renderToString(
    createElement(QadiProvider, {
      atoms: fixture.atoms,
      subject,
      children: createElement(Projected),
    }),
  );
};

/** The server's side: decide `policy` for `subject` with a real evaluator, ready to dehydrate. */
export const decideOnServer = (fixture: GateFixture, subject: AuthSubject, policy: Policy) =>
  Effect.gen(function* () {
    const registry = registryFor(fixture, subject);
    registry.mount(fixture.atoms.decision(policy));
    const decision: Decision | undefined = yield* waitFor(
      "the server decision",
      () => currentDecision(registry.get(fixture.atoms.decision(policy))),
      (value) => value !== undefined,
    );
    if (decision === undefined) return yield* Effect.die(new Error("no server decision"));
    return decision;
  });

/** What the page sends the client and what the client turns it into (`initialValues` for the provider). */
export const seedFromServer = (
  fixture: GateFixture,
  subject: AuthSubject,
  entries: ReadonlyArray<{ readonly policy: Policy; readonly decision: Decision }>,
) => {
  const payload = JSON.parse(JSON.stringify(dehydrateDecisions(entries)));
  return Array.from(hydrateDecisions(fixture.atoms, payload, subject));
};
