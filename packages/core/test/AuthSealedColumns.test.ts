// Plan 17 (ADR-EA-019 decision 6): a plugin declares its sealed columns, `Auth.make` validates them, and
// `auth.sealedColumns` is the `also` of a post-rotation `SealedColumn.sweepDeployed`.
import { SealedColumn } from "@awthaq/sql";
import { assert, describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Auth from "../src/Auth.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";

const plugin = <const Id extends string>(
  id: Id,
  tables: ReadonlyArray<string>,
  sealedColumns: ReadonlyArray<SealedColumn.Sweepable>,
): AuthPlugin.Any & { readonly id: Id } => ({
  id,
  apiVersion: 1,
  contract: { identifier: "auth", groups: {} },
  tables,
  tenancy: Object.fromEntries(tables.map((table) => [table, AuthPlugin.Table.global("test")])),
  sealedColumns,
  migrations: [],
  dependsOn: [],
  layer: Layer.empty,
});

const refusal = (...plugins: readonly [AuthPlugin.Any, ...ReadonlyArray<AuthPlugin.Any>]) => {
  try {
    Auth.make(plugins);
  } catch (error) {
    return error instanceof Auth.SealedColumnDeclarationInvalid ? error : undefined;
  }
  return undefined;
};

const column = (table: string, name: string) =>
  SealedColumn.column({ table, column: name, key: "id" });

describe("Auth.make validates sealed column declarations (plan 17)", () => {
  it("exposes every plugin's sealed columns in plugin order, and none when nothing is declared", () => {
    const first = plugin("first", ["first_a"], [column("first_a", "secret")]);
    const second = plugin(
      "second",
      ["second_b"],
      [column("second_b", "key"), column("second_b", "pin")],
    );
    const bare = plugin("bare", ["bare_c"], []);
    const auth = Auth.make([first, second, bare]);
    assert.deepStrictEqual(
      auth.sealedColumns.map((declared) => `${declared.table}.${declared.column}`),
      ["first_a.secret", "second_b.key", "second_b.pin"],
    );
    assert.deepStrictEqual(Auth.make([bare]).sealedColumns, []);
  });

  it("refuses a column on a table the plugin does not own", () => {
    const mine = plugin("mine", ["mine_a"], [column("other_a", "secret")]);
    const error = refusal(mine);
    assert.strictEqual(error?.cause, "UnknownTable");
    assert.strictEqual(error?.pluginId, "mine");
    assert.include(error?.message ?? "", "other_a.secret");
  });

  it("refuses the same table.column declared twice in the composition", () => {
    const twice = plugin(
      "twice",
      ["twice_a"],
      [column("twice_a", "secret"), column("twice_a", "secret")],
    );
    assert.strictEqual(refusal(twice)?.cause, "Duplicate");
  });
});
