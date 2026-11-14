// Plan 04 phase 8 (ADR-EA-040, G4): no plugin reaches another plugin's records. The `*Records` stores and the
// `DomainClaims` claim store live behind `@awthaq/organization/records`; `packages/*/src` outside the
// organization package may import neither that sub-path (in any import form: the specifier is refused wherever
// it appears) nor a `*Records` or `DomainClaims` name from the root, because every write to an
// `organization_*` table goes through one system module (BEH-EA-330). The claim store is reached only through
// `OrganizationConnectionLifecycle`. Tests, `features/` and `examples/` arrange state through the sub-path and
// are not scanned.
import * as Fs from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

const packagesDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sourcesOf = (dir: string): ReadonlyArray<string> =>
  Fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => Path.join(dir, file));

/** Any mention of the records sub-path as a module specifier, whatever the import form (import, `import * as`, `export … from`, `import()`, `require`). */
const RECORDS_SPECIFIER = /["'`]@awthaq\/organization\/records["'`]/;

/** A named import or re-export of a records namespace from the package root. */
const ROOT_RECORDS_NAMES =
  /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'`]@awthaq\/organization["'`]/g;

/** Whether `text` (a source file outside the organization package) reaches the records. */
const reachesRecords = (text: string): boolean =>
  RECORDS_SPECIFIER.test(text) ||
  Array.from(text.matchAll(ROOT_RECORDS_NAMES)).some((found) =>
    (found[1] ?? "")
      .split(",")
      .some((entry) => /\w*Records$|^(?:type\s+)?DomainClaims\b/.test(entry.trim())),
  );

describe("organization records boundary", () => {
  it("the scanner refuses every import form of the records sub-path and of a records name from the root", () => {
    for (const refused of [
      'import { DomainClaims } from "@awthaq/organization/records";',
      'import * as Records from "@awthaq/organization/records";',
      'import type { OrganizationRecords } from "@awthaq/organization/records";',
      'export { ConnectionRecords } from "@awthaq/organization/records";',
      'export * from "@awthaq/organization/records";',
      'import "@awthaq/organization/records";',
      'const records = await import("@awthaq/organization/records");',
      'const records = require("@awthaq/organization/records");',
      "const records = await import(`@awthaq/organization/records`);",
      'import { TeamRecords, Organization } from "@awthaq/organization";',
      'export { DomainClaims } from "@awthaq/organization";',
    ]) {
      assert.isTrue(reachesRecords(refused), refused);
    }
    for (const allowed of [
      'import { Organization, OrganizationConnectionLifecycle } from "@awthaq/organization";',
      'import * as Organization from "@awthaq/organization";',
      'import { Records } from "@awthaq/other/records";',
    ]) {
      assert.isFalse(reachesRecords(allowed), allowed);
    }
  });

  it("no other package's src imports the organization records", () => {
    const offenders: Array<string> = [];
    for (const name of Fs.readdirSync(packagesDir)) {
      if (name === "organization") continue;
      const srcDir = Path.join(packagesDir, name, "src");
      if (!Fs.existsSync(srcDir)) continue;
      for (const file of sourcesOf(srcDir)) {
        if (reachesRecords(Fs.readFileSync(file, "utf8"))) {
          offenders.push(Path.relative(packagesDir, file));
        }
      }
    }
    assert.deepStrictEqual(offenders, []);
  });

  it("the root export no longer carries a records namespace", () => {
    const index = Fs.readFileSync(
      Path.join(packagesDir, "organization", "src", "index.ts"),
      "utf8",
    );
    assert.notMatch(index, /export \* as \w*Records\b/);
    assert.notMatch(index, /export \* as DomainClaims\b/);
    const records = Fs.readFileSync(
      Path.join(packagesDir, "organization", "src", "records.ts"),
      "utf8",
    );
    for (const name of [
      "ActiveContextRecords",
      "ConnectionRecords",
      "DomainClaims",
      "InvitationRecords",
      "MembershipRecords",
      "OrganizationRecords",
      "OrgRoleRecords",
      "TeamRecords",
    ]) {
      assert.include(records, `export * as ${name} from`);
    }
  });
});
