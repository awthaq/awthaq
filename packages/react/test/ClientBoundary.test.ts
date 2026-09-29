// RSC-002 / EAR-003: every hook-bearing module of @awthaq/react is a client
// module. A Server Component importing `{ Providers }` (or any barrel export)
// must get a client reference; without the directive Next evaluates the module
// on the server and the first hook call throws. New component modules cannot
// regress this — the test enumerates `src/`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";

const srcDir = join(import.meta.dirname, "..", "src");
const firstStatement = (file: string): string =>
  readFileSync(join(srcDir, file), "utf8")
    .split("\n")
    .find((line) => line.trim() !== "" && !line.startsWith("//"))
    ?.trim() ?? "";

describe("client boundary (RSC-002)", () => {
  it("the barrel, every .tsx module and the hooks module start with the use client directive", () => {
    const modules = readdirSync(srcDir).filter(
      (file) => file.endsWith(".tsx") || file === "index.ts" || file === "Hooks.ts",
    );
    assert.include(modules, "Providers.tsx");
    assert.include(modules, "index.ts");
    for (const file of modules) {
      assert.strictEqual(firstStatement(file), '"use client";', `${file} lacks "use client"`);
    }
  });

  it("the directive is the very first line of Providers.tsx and index.ts, before any comment", () => {
    for (const file of ["Providers.tsx", "index.ts"]) {
      assert.strictEqual(readFileSync(join(srcDir, file), "utf8").split("\n")[0], '"use client";');
    }
  });
});
