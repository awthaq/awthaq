// P20a: a per-scenario scratch pad for Worlds that need to carry a fact from a When to a Then
// without a purpose-built Ref per fact. Reads go through a type guard, so a step narrows what it
// stored instead of asserting it (no casts), and reading a fact nothing recorded is a defect that
// names the key — never a silent `undefined` a Then could vacuously accept.
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

export const makeOutcomes = Effect.gen(function* () {
  const cells = yield* Ref.make<Readonly<Record<string, unknown>>>({});
  const set = (key: string, value: unknown) =>
    Ref.update(cells, (existing) => ({ ...existing, [key]: value }));
  const getAs = <A>(key: string, guard: (value: unknown) => value is A) =>
    Ref.get(cells).pipe(
      Effect.flatMap((all) => {
        const found = all[key];
        return guard(found)
          ? Effect.succeed(found)
          : Effect.die(new Error(`outcome "${key}" is missing or not the expected shape`));
      }),
    );
  return { set, getAs };
});

export type Outcomes = Effect.Success<typeof makeOutcomes>;

export const isString = (value: unknown): value is string => typeof value === "string";
export const isNumber = (value: unknown): value is number => typeof value === "number";
export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every(isString);
