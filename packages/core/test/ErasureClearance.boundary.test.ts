// ADR-EA-031 (rev 1.2): the `ErasureClearance` is the only thing `UserRemoval.remove` accepts, so
// who may mint one is who may delete a user row. The class's private constructor and the package
// barrel keep every other package out; this static guard pins the inside of core: across
// `packages/*/src`, `Erasure.ts` is the single value importer of `internal/erasureClearance`,
// `Users.ts` imports it type-only, and no other file mentions it. (Modelled on
// `packages/organization/test/TenantScoping.test.ts`.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const packagesDir = new URL("../../", import.meta.url);

const sourceFiles = (dir: URL): ReadonlyArray<URL> =>
  readdirSync(dir).flatMap((name) => {
    const entry = new URL(name, dir);
    return statSync(entry).isDirectory()
      ? sourceFiles(new URL(`${name}/`, dir))
      : name.endsWith(".ts")
        ? [entry]
        : [];
  });

const allSources = readdirSync(packagesDir).flatMap((pkg) => {
  const src = new URL(`${pkg}/src/`, packagesDir);
  return statSync(src, { throwIfNoEntry: false })?.isDirectory() === true ? sourceFiles(src) : [];
});

const MENTION = /erasureClearance/;
const TYPE_ONLY = /^\s*(import|export)\s+type\b[^;]*from\s+"[^"]*internal\/erasureClearance\.ts"/m;

describe("ErasureClearance boundary (ADR-EA-031)", () => {
  it("only Erasure.ts imports the clearance as a value; Users.ts and Erasure.ts's re-export are type-only", () => {
    const mentioning = allSources
      .map((file) => ({ path: file.pathname, text: readFileSync(file, "utf8") }))
      .filter(({ text }) => MENTION.test(text));
    const names = mentioning.map(({ path }) => path.replace(/^.*\/packages\//, "")).sort();
    assert.deepStrictEqual(names, [
      "core/src/Erasure.ts",
      "core/src/Users.ts",
      "core/src/internal/erasureClearance.ts",
    ]);

    const text = (suffix: string) =>
      mentioning.find(({ path }) => path.endsWith(suffix))?.text ?? "";
    // Users.ts: type-only, so it cannot construct or mint a clearance.
    assert.match(text("core/src/Users.ts"), TYPE_ONLY);
    assert.notMatch(
      text("core/src/Users.ts"),
      /^import\s+\{[^}]*\}\s+from\s+"[^"]*erasureClearance/m,
    );
    // Erasure.ts: the one value import, plus a type-only re-export.
    assert.match(
      text("core/src/Erasure.ts"),
      /^import\s+\{\s*ErasureClearance\s*\}\s+from\s+"[^"]*erasureClearance\.ts"/m,
    );
    assert.match(text("core/src/Erasure.ts"), TYPE_ONLY);
  });

  it("the package barrel does not export the internal module", () => {
    const barrel = readFileSync(new URL("core/src/index.ts", packagesDir), "utf8");
    assert.notMatch(barrel, /erasureClearance/);
  });
});
