// REC-04: every plugin `*Records` module names its store failures through `StoreFailure.labelled("<Module>")`
// and keeps no per-module `orStoreUnavailable` closure. It reads the sources as text, so a module that reverts
// to a hand-written closure, or labels itself with another module's name, fails here. The modules are
// discovered by glob, not listed: a new `*Records.ts` is held to the same rule, and no count is pinned.
// What a label builds (`<store>.<operation>`) is `StoreFailure.test.ts`'s case, not this file's.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const packages = new URL("../../", import.meta.url);

const recordModules = readdirSync(packages, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/src/`, packages)))
  .flatMap((entry) => {
    const src = new URL(`${entry.name}/src/`, packages);
    return readdirSync(src)
      .filter((file) => file.endsWith("Records.ts"))
      .map((file) => ({
        name: file.slice(0, -".ts".length),
        path: `packages/${entry.name}/src/${file}`,
        text: readFileSync(new URL(file, src), "utf8"),
      }));
  });

const LABELLED = /const (?:unavailable|failing) = StoreFailure\.labelled\("(\w+)"\);/g;

describe("record-store scaffolding pins", () => {
  it("finds the record stores", () => {
    assert.isAbove(recordModules.length, 0);
  });

  for (const { name, path, text } of recordModules) {
    it(`${name} binds its one failure label to its own name`, () => {
      assert.deepStrictEqual(
        Array.from(text.matchAll(LABELLED), (match) => match[1]),
        [name],
        `${path}: exactly one \`StoreFailure.labelled("${name}")\``,
      );
      assert.isFalse(
        text.includes("orStoreUnavailable("),
        `${path}: no hand-written \`orStoreUnavailable\` closure`,
      );
    });
  }
});
