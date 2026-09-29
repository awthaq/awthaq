// BO-006 acceptance: the `@awthaq/next/edge` entry's runtime import graph never
// reaches `@awthaq/core` or `@awthaq/server` — a `proxy.ts` bundle must stay
// free of SQL drivers, services and the HTTP stratum. Walks the source files a
// bundler would follow (type-only imports are erased and ignored).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";

const packagesDir = resolve(import.meta.dirname, "..", "..");

const resolveSpecifier = (from: string, specifier: string): string | undefined => {
  if (specifier.startsWith(".")) return resolve(dirname(from), specifier);
  if (specifier === "@awthaq/jwt/verify") return join(packagesDir, "jwt", "src", "verify.ts");
  if (specifier === "@awthaq/web/cookies") return join(packagesDir, "web", "src", "cookies.ts");
  return undefined;
};

/** Every module specifier a file imports at runtime (`import type` and inline type-only lists excluded). */
const runtimeImports = (file: string): ReadonlyArray<string> =>
  Array.from(
    readFileSync(file, "utf8").matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm),
    (match) => match[1] ?? "",
  );

const walk = (entry: string) => {
  const seenFiles = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (seenFiles.has(file) || !existsSync(file)) return;
    seenFiles.add(file);
    for (const specifier of runtimeImports(file)) {
      const local = resolveSpecifier(file, specifier);
      if (local === undefined) packages.add(specifier);
      else visit(local);
    }
  };
  visit(entry);
  return { files: seenFiles, packages };
};

describe("@awthaq/next/edge import graph (BO-006)", () => {
  it("never reaches @awthaq/core or @awthaq/server, nor this package's own server modules", () => {
    const { files, packages } = walk(join(packagesDir, "next", "src", "edge.ts"));
    assert.isAbove(files.size, 2, "the walker should have followed edge.ts into the verifier");
    for (const forbidden of ["@awthaq/core", "@awthaq/server", "@awthaq/client", "@awthaq/react"]) {
      assert.notInclude(Array.from(packages), forbidden);
    }
    const names = Array.from(files, (file) => file.slice(packagesDir.length));
    for (const forbidden of [
      "GetSession.ts",
      "Session.ts",
      "InProcessClient.ts",
      "ServerActionClient.ts",
      "Seed.ts",
      "Jwt.ts",
      "KeyRing.ts",
    ]) {
      assert.isFalse(
        names.some((name) => name.endsWith(`/${forbidden}`)),
        `${forbidden} is in the edge import graph`,
      );
    }
  });
});
