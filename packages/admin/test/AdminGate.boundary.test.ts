// Plan 13 (ADR-EA-018 Decision 8): the admin configuration reference and the denial events live only
// in `internal/AdminGate.ts`, so no admin operation can read a build-time value or deny on its own.
// Modelled on `core/test/ErasureClearance.boundary.test.ts`: a static scan of `packages/admin/src`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const srcDir = new URL("../src/", import.meta.url);

const sourceFiles = (dir: URL): ReadonlyArray<URL> =>
  readdirSync(dir).flatMap((name) => {
    const entry = new URL(name, dir);
    return statSync(entry).isDirectory()
      ? sourceFiles(new URL(`${name}/`, dir))
      : name.endsWith(".ts")
        ? [entry]
        : [];
  });

const sources = sourceFiles(srcDir).map((file) => ({
  name: file.pathname.replace(/^.*\/admin\/src\//, ""),
  text: readFileSync(file, "utf8"),
}));

const filesMatching = (pattern: RegExp) =>
  sources
    .filter(({ text }) => pattern.test(text))
    .map(({ name }) => name)
    .sort();

describe("AdminGate boundary (plan 13)", () => {
  it("the configuration reference's key and its Tenant.inForce read appear only in the gate", () => {
    assert.deepStrictEqual(filesMatching(/"awthaq\/admin\/Config"/), [
      "internal/AdminGate.ts",
    ]);
    assert.deepStrictEqual(filesMatching(/Tenant\.inForce\(AdminConfigScoped/), [
      "internal/AdminGate.ts",
    ]);
  });

  it("the gate is the only denier", () => {
    assert.deepStrictEqual(filesMatching(/"auth\.admin\.actionDenied"/), [
      "internal/AdminGate.ts",
    ]);
    assert.deepStrictEqual(
      filesMatching(/"auth\.admin\.impersonationDenied"/),
      ["internal/AdminGate.ts"],
    );
  });

  it("the gate is internal: the package barrel does not mention it", () => {
    const index = sources.find(({ name }) => name === "index.ts");
    assert.isFalse(/internal\/AdminGate/.test(index?.text ?? ""));
  });

  it("each plugin imports the gate, and no other admin source does", () => {
    assert.deepStrictEqual(
      filesMatching(/from "\.{1,2}\/(internal\/)?AdminGate\.ts"/),
      ["Admin.ts", "AdminAccounts.ts", "AdminTenants.ts"],
    );
  });
});
