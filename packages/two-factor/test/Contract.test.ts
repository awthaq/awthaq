// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6): manifest legality,
// group ids, table prefixes, migration determinism — and here, that migrations apply identically on
// two fresh databases.
import { TestAuth } from "@awthaq/test";
import { describe, it } from "@effect/vitest";
import * as TwoFactor from "../src/TwoFactor.ts";

TestAuth.runPluginContractTests(
  {
    describe: (name, body) => describe(name, body),
    it: (name, body) => it(name, body),
    fail: (message) => {
      throw new Error(message);
    },
  },
  () => TwoFactor.TwoFactor,
  { options: [{}] },
);
