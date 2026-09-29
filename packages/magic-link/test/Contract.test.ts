// The shared plugin-contract harness (docs/plugin-authoring.md checklist item 6) over both plugins:
// manifest legality, group ids, table prefixes (neither owns a table), migration determinism.
import { TestAuth } from "@awthaq/test";
import { describe, it } from "@effect/vitest";
import * as EmailOtp from "../src/EmailOtp.ts";
import * as MagicLink from "../src/MagicLink.ts";

const framework = {
  describe: (name: string, body: () => void) => describe(name, body),
  it: (name: string, body: () => void) => it(name, body),
  fail: (message: string): never => {
    throw new Error(message);
  },
};

TestAuth.runPluginContractTests(framework, () => MagicLink.MagicLink, { options: [{}] });
TestAuth.runPluginContractTests(framework, () => EmailOtp.EmailOtp, { options: [{}] });
