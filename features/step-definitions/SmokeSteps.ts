import { defineSteps } from "@effect-cucumber/vitest";
import assert from "node:assert/strict";
import { addToCount, readCount, setCount, World } from "./SmokeWorld.ts";

export const smokeSteps = defineSteps<World>(({ Given, When, Then }) => {
  Given("a counter starting at {int}", function* (start: number) {
    yield* setCount(start);
  });

  When("{int} is added to the counter", function* (amount: number) {
    yield* addToCount(amount);
  });

  Then("the counter is {int}", function* (expected: number) {
    const actual = yield* readCount();
    assert.equal(actual, expected, `expected counter to be ${expected}, got ${actual}`);
  });
});
