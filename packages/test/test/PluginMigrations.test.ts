// Plan 22 (ADR-EA-004 rev 1.3, SSMS-006): every plugin index is created through `SqlDdl.index`, which renders
// `CREATE [UNIQUE] INDEX IF NOT EXISTS` by construction, so an operator may build it `CONCURRENTLY` out of band
// first (`packages/sql/README.md`, "Migrating a populated database"). A source scan in the shape of
// `packages/sql/test/CoreMigrations.test.ts`: no `CREATE INDEX` text outside `SqlDdl.ts` and core's own ledger.
import { assert, describe, it } from "@effect/vitest";
import { glob } from "glob";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("plugin migrations (SSMS-006)", () => {
  // it.fails until phase 7 routes the last plugin index through SqlDdl.index.
  it.fails("every plugin index is created IF NOT EXISTS (through SqlDdl.index)", async () => {
    const files = await glob(["packages/*/src/**/*.ts", "examples/plugin-template/src/**/*.ts"], {
      cwd: root,
      ignore: ["packages/sql/src/SqlDdl.ts", "packages/sql/src/CoreMigrations.ts"],
    });
    const offenders: Array<string> = [];
    for (const file of files.sort()) {
      const source = await readFile(`${root}/${file}`, "utf8");
      source.split("\n").forEach((line, index) => {
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
        if (/CREATE (UNIQUE )?INDEX/i.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    assert.deepStrictEqual(offenders, []);
  });
});
