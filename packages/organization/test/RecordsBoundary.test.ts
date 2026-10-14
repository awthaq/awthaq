// Plan 04 phase 8 (ADR-EA-040, G4): no plugin reaches another plugin's records. The seven `*Records`
// stores live behind `@awthaq/organization/records`; `packages/*/src` outside the organization package may
// import neither that sub-path nor a `*Records` name from the root, because every write to an
// `organization_*` table goes through one system module (BEH-EA-330). Tests, `features/` and `examples/`
// arrange state through the sub-path and are not scanned.
import * as Fs from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";

const packagesDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const sourcesOf = (dir: string): ReadonlyArray<string> =>
  Fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => Path.join(dir, file));

describe("organization records boundary", () => {
  it("no other package's src imports the organization records", () => {
    const offenders: Array<string> = [];
    for (const name of Fs.readdirSync(packagesDir)) {
      if (name === "organization") continue;
      const srcDir = Path.join(packagesDir, name, "src");
      if (!Fs.existsSync(srcDir)) continue;
      for (const file of sourcesOf(srcDir)) {
        const text = Fs.readFileSync(file, "utf8");
        const imports = text.matchAll(
          /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@awthaq\/organization(\/records)?"/g,
        );
        for (const found of imports) {
          const names = (found[1] ?? "").split(",").map((entry) => entry.trim());
          if (found[2] !== undefined || names.some((entry) => /\w*Records$/.test(entry))) {
            offenders.push(Path.relative(packagesDir, file));
          }
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
    const records = Fs.readFileSync(
      Path.join(packagesDir, "organization", "src", "records.ts"),
      "utf8",
    );
    for (const name of [
      "ActiveContextRecords",
      "ConnectionRecords",
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
