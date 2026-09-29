// BCR-010/P20a: helpers the two-factor step modules share (narrowing of unknown outcomes, the
// "current person" convention, the last-answer cell). Kept apart from the World so the World stays
// about composition.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { failureTag, getPerson, World } from "./TwoFactorWorld.ts";

export const ascii = (text: string) => new TextEncoder().encode(text);

/** A property of an unknown value, when it is an object that has it. */
export const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;

/** The value of a successful outcome; anything else fails the step with the failure's tag. */
export const successValue = (exit: Exit.Exit<unknown, unknown>): unknown => {
  assert.ok(Exit.isSuccess(exit), `expected success, got ${String(failureTag(exit))}`);
  return exit.value;
};

/** The person "her"/"she" refers to: the one a step named last. */
export const current = Effect.gen(function* () {
  const { people } = yield* World;
  return yield* getPerson(yield* people.current);
});

export const setAnswer = (exit: Exit.Exit<unknown, unknown>) =>
  Effect.gen(function* () {
    const { exits } = yield* World;
    yield* exits.set("answer", exit);
  });

export const answer = Effect.gen(function* () {
  const { exits } = yield* World;
  return yield* exits.get("answer");
});

/** All the text a value contains — for "carries no secret" checks. */
export const textOf = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
