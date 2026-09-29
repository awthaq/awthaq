// P20a/AH-003: shared World for the foundations, contract-stratum and persistence-stratum
// features (decision 36 Tier 4). These scenarios need no HTTP app of their own — a scenario's
// Given/When leaves its result in a per-scenario scratch cell that the Then reads back, so the
// three steps genuinely form a chain instead of each re-deriving the answer.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface WorldShape {
  readonly scratch: Ref.Ref<Readonly<Record<string, unknown>>>;
}

export class World extends Context.Service<World, WorldShape>()("features/FoundationsWorld") {}

/** Built fresh per Scenario — nothing survives between Scenarios. */
export const WorldLive = Layer.effect(
  World,
  Effect.gen(function* () {
    return World.of({ scratch: yield* Ref.make<Readonly<Record<string, unknown>>>({}) });
  }),
);

export const remember = Effect.fn("features.foundations.remember")(function* (
  key: string,
  value: unknown,
) {
  const { scratch } = yield* World;
  yield* Ref.update(scratch, (existing) => ({ ...existing, [key]: value }));
});

/** Reads a remembered value back, narrowed by `is` — a scenario that never set it (or set something else) fails loudly instead of asserting on `undefined`. */
export const recall = Effect.fn("features.foundations.recall")(function* <A>(
  key: string,
  is: (value: unknown) => value is A,
) {
  const { scratch } = yield* World;
  const value = (yield* Ref.get(scratch))[key];
  if (!is(value)) throw new Error(`nothing of the expected shape was remembered under "${key}"`);
  return value;
});

/** A typed slot in the scratch: the guard is what makes reading it back type-safe without an assertion. */
export interface Cell<A> {
  readonly name: string;
  readonly is: (value: unknown) => value is A;
}

export const cell = <A>(name: string, is: (value: unknown) => value is A): Cell<A> => ({
  name,
  is,
});

export const put = <A>(target: Cell<A>, value: A) => remember(target.name, value);

export const take = <A>(target: Cell<A>) => recall(target.name, target.is);

export const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

const gatesSource =(file: string) =>
  readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

/**
 * The scenarios in these features whose enforcing mechanism is the TypeScript compiler
 * (INV-EA-001..006) are proven in `PluginTypeGates.ts`, which the typecheck gate compiles.
 * This asserts the named gate still exists there and still carries its enforcing construct
 * (`@ts-expect-error`, an exact-diagnostic annotation or an inferred-type check), so deleting
 * or gutting a gate fails its scenario. It does not run the compiler — it is the runtime
 * tripwire for the compile-time proof.
 */
export const assertTypeGate = (
  name: string,
  file: string,
  mustContain: ReadonlyArray<string>,
  mustNotContain: ReadonlyArray<string> = [],
): void => {
  const source = gatesSource(file);
  const marker = `// type-gate: ${name}`;
  const start = source.indexOf(`${marker}\n`);
  assert.notEqual(start, -1, `${file} has no "${marker}" gate`);
  const rest = source.slice(start + marker.length + 1);
  const end = rest.search(/\n\n/);
  const block = end === -1 ? rest : rest.slice(0, end);
  for (const fragment of mustContain) {
    assert.ok(
      block.includes(fragment),
      `type gate "${name}" in ${file} no longer contains ${JSON.stringify(fragment)}`,
    );
  }
  for (const fragment of mustNotContain) {
    assert.ok(
      !block.includes(fragment),
      `type gate "${name}" in ${file} must not contain ${JSON.stringify(fragment)}`,
    );
  }
};
