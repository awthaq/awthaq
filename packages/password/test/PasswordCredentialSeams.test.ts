// ADR-EA-048 (BEH-EA-345): `PasswordCredential` is the only code that reads or writes the password
// credential or runs the `PasswordHasher` on it. The brands keep every write behind the one policy,
// but nothing in the type system stops another module from calling `Accounts.findCredentialHash`,
// `updateCredentialHash` or the hasher directly, so pin it: every other site is a named, counted
// exception with its reason, and a new one fails CI instead of shipping as a second, drifting copy
// of "find the account, check the policy, hash, update or link".
//
// Reads `packages/*/src/**/*.ts` from the filesystem, comment lines removed, in the style of
// `core/test/SignInSeams.test.ts`.
import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

const packagesDir = new URL("../../", import.meta.url);

/** Library source, comment lines removed (a header that names `hasher.hash(` is not a call). */
const sources = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const src = new URL(`${entry.name}/src/`, packagesDir);
    try {
      return readdirSync(src, { recursive: true })
        .filter((name) => /\.(ts|tsx)$/.test(String(name)))
        .map((name) => {
          const path = fileURLToPath(new URL(String(name), src));
          const code = readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join("\n");
          return { file: relative(fileURLToPath(packagesDir), path), code };
        });
    } catch {
      return [];
    }
  });

const countOf = (pattern: RegExp) =>
  Object.fromEntries(
    sources
      .map(({ file, code }): [string, number] => [file, Array.from(code.matchAll(pattern)).length])
      .filter(([, count]) => count > 0),
  );

interface Allowed {
  readonly file: string;
  readonly count: number;
  readonly why: string;
}

const assertExactly = (found: Record<string, number>, allowed: ReadonlyArray<Allowed>) => {
  const expected = Object.fromEntries(allowed.map(({ file, count }) => [file, count]));
  assert.deepStrictEqual(
    found,
    expected,
    `found ${JSON.stringify(found)}; each allowed entry is: ${allowed
      .map(({ file, why }) => `${file} (${why})`)
      .join("; ")}`,
  );
};

const theModule = "password/src/PasswordCredential.ts";

/** ADR-EA-038 §3, ADR-EA-048 §6: an operator import stores a foreign hash; it sets no password. */
const importer = (file: string): Allowed => ({
  file,
  count: 1,
  why: "an operator import stores a foreign hash, ADR-EA-038 §3",
});

describe("the password credential seam (ADR-EA-048)", () => {
  it("the password account key is spelled only by Accounts, the module and the importers", () => {
    assertExactly(countOf(/\bPASSWORD_PROVIDER_ID\b/g), [
      { file: "core/src/Accounts.ts", count: 1, why: "the definition (BEH-EA-044)" },
      { file: theModule, count: 5, why: "the module: read, linkFor, write (find, link), has" },
      importer("migrate-auth0/src/ImportAuth0User.ts"),
      importer("migrate-better-auth/src/BetterAuthSource.ts"),
      importer("migrate-firebase/src/ImportFirebaseUser.ts"),
    ]);
  });

  it("the stored hash is read and rewritten only by the module", () => {
    assertExactly(countOf(/\.\s*(findCredentialHash|updateCredentialHash)\(/g), [
      { file: theModule, count: 3, why: "verify reads it; rehashIfStale and the write rewrite it" },
    ]);
  });

  it("the hasher runs only in the module, and on recovery codes", () => {
    assertExactly(countOf(/\bhasher\s*\.\s*(verify|hash|needsRehash)\(/g), [
      { file: theModule, count: 7, why: "the dummy, its calibration, verify, rehash, link, write" },
      {
        file: "two-factor/src/SecondFactor.ts",
        count: 2,
        why: "recovery codes, not the password credential",
      },
    ]);
  });

  it("no source spells the password provider as a literal", () => {
    assertExactly(countOf(/providerId:\s*"password"/g), []);
  });
});
