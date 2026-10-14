// The framework the conformance suites run under.
import type { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";

export const vitestFramework: TestAuth.TestFramework = {
  describe: (name, body) => describe(name, body),
  it: (name, body) => it(name, body),
  fail: (message) => assert.fail(message),
};
