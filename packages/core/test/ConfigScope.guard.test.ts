// BEH-EA-355 (ADR-EA-018 D8, plan 36): one rule, one accessor. No source file may name the old
// `Tenant.configInForce` helper, every file that defines a configuration key declares its scope in the
// same file, and every `ConfigDescriptor.make(` takes a declaration. (Modelled on
// `ErasureClearance.boundary.test.ts`.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const root = new URL("../../../", import.meta.url);

const sourceFiles = (dir: URL): ReadonlyArray<URL> =>
  readdirSync(dir).flatMap((name) => {
    const entry = new URL(name, dir);
    return statSync(entry).isDirectory()
      ? sourceFiles(new URL(`${name}/`, dir))
      : name.endsWith(".ts")
        ? [entry]
        : [];
  });

const sources = ["packages", "examples"].flatMap((group) =>
  readdirSync(new URL(`${group}/`, root)).flatMap((pkg) => {
    const src = new URL(`${group}/${pkg}/src/`, root);
    return statSync(src, { throwIfNoEntry: false })?.isDirectory() === true
      ? sourceFiles(src).map((file) => ({
          path: file.pathname.replace(/^.*\/(packages|examples)\//, "$1/"),
          text: readFileSync(file, "utf8"),
        }))
      : [];
  }),
);

// shortcut: two-factor and roles still read their keys raw (plan 36 ticket 18 waits on uncommitted work there);
// drop this list when it lands.
const PENDING_TICKET_18 = ["packages/two-factor/src/", "packages/roles/src/"];

// Plan 36 Q5/Q10: host-level keys that carry no descriptor and are never read per tenant.
const HOST_LEVEL = [
  "packages/core/src/AuthEvents.ts",
  "packages/passkey/src/ChallengeStore.ts",
  "packages/server/src/Csrf.ts",
];

describe("configuration scope guard (BEH-EA-355)", () => {
  it("no source file names the old Tenant.configInForce helper", () => {
    assert.deepStrictEqual(
      sources.filter(({ text }) => text.includes("configInForce")).map(({ path }) => path),
      [],
    );
  });

  it("every file defining a configuration key declares its scope", () => {
    const KEY =
      /Context\.(?:Reference|Service)[^"]{0,200}"awthaq\/[^"]*(?:Config|Policy|Overrides)"/;
    const undeclared = sources
      .filter(
        ({ path, text }) =>
          KEY.test(text) &&
          !/Tenant\.per(?:Tenant|Deployment)\(/.test(text) &&
          !HOST_LEVEL.includes(path) &&
          !PENDING_TICKET_18.some((prefix) => path.startsWith(prefix)),
      )
      .map(({ path }) => path);
    assert.deepStrictEqual(undeclared, []);
  });

  it("every ConfigDescriptor.make call takes a Scoped declaration", () => {
    const bare = sources
      .filter(
        ({ path, text }) =>
          !PENDING_TICKET_18.some((prefix) => path.startsWith(prefix)) &&
          [...text.matchAll(/ConfigDescriptor\.make\(\s*([\w.]+)/g)].some(
            ([, arg]) => !(arg ?? "").endsWith("Scoped") && !(arg ?? "").includes("Tenant.per"),
          ),
      )
      .map(({ path }) => path);
    assert.deepStrictEqual(bare, []);
  });
});
