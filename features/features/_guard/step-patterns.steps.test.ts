// AH-007: not a Gherkin feature — a repository guard that lives beside the suite (the
// `*.steps.test.ts` name is what the runner and both tsconfigs already pick up).
//
// A step whose entire pattern is a bare `{string}` matches every quoted line in every feature,
// and its body can only dispatch on the string's content (the shape AH-007 removed from the
// password steps): an unrecognised literal silently takes a fall-through branch instead of
// failing. Steps that need to read a quoted expression must declare a named parameter type
// (`ParameterTypeStore.layer`, see `PasswordParameterTypes.ts`) that resolves exact literals.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stepDefinitions = fileURLToPath(new URL("../../step-definitions/", import.meta.url));

// `\s*` after the paren: a wrapped call puts the pattern on the next line.
const BARE_STRING_STEP = /\b(Given|When|Then)\(\s*(["'`])\{string\}\2/;

describe("step definitions", () => {
  it("never register a bare {string} catch-all pattern", () => {
    const offenders: Array<string> = [];
    for (const entry of readdirSync(stepDefinitions, { recursive: true })) {
      if (typeof entry !== "string" || !entry.endsWith(".ts")) continue;
      // Comment lines may quote the pattern while explaining why it was removed.
      const code = readFileSync(`${stepDefinitions}${entry}`, "utf8").replace(/^\s*\/\/.*$/gm, "");
      if (BARE_STRING_STEP.test(code)) offenders.push(entry);
    }
    expect(
      offenders,
      "files registering a bare {string} step (use a named parameter type)",
    ).toEqual([]);
  });
});
