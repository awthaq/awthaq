// PV-013: the root README's quickstart must type-check against the current API.
//
// `fixtures/readme-quickstart.ts` is the code block, verbatim. This file imports it as a
// type-only module, which is enough to put it in `tsconfig.test.json`'s program, so
// `pnpm typecheck` compiles it: an API change that breaks the quickstart fails the build
// instead of shipping a README nobody can copy. It is never executed (it binds a socket
// and reads `DATABASE_URL`); the test below only proves the README and the compiled
// fixture are the same text, so the README cannot drift from what was compiled.
import type {} from "./fixtures/readme-quickstart.ts";
import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const readText = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const FENCE = "```";

describe("README quickstart (PV-013)", () => {
  it("is exactly the type-checked fixture", () => {
    const readme = readText("../../../README.md");
    const opening = `${FENCE}ts\nimport { createServer }`;
    const start = readme.indexOf(opening);
    assert.isAbove(start, -1, "README.md no longer has the quickstart code block");
    const body = readme.slice(start + `${FENCE}ts\n`.length);
    const block = body.slice(0, body.indexOf(`\n${FENCE}\n`));
    assert.strictEqual(block, readText("./fixtures/readme-quickstart.ts").trimEnd());
  });
});
