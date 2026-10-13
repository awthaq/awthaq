// Plan 05 (BEH-EA-328): every plugin table declares its tenancy and `Auth.make` validates it.
import { assert, describe, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Auth from "../src/Auth.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";

const plugin = (
  id: string,
  tables: Readonly<Record<string, ReturnType<typeof AuthPlugin.Table.global>>>,
  dependsOn: ReadonlyArray<AuthPlugin.Any> = [],
): AuthPlugin.Any => ({
  id,
  apiVersion: 1,
  contract: { identifier: "auth", groups: {} },
  tables: Object.keys(tables),
  tenancy: tables,
  migrations: [],
  dependsOn,
  layer: Layer.empty,
});

const refusal = (plugins: ReadonlyArray<AuthPlugin.Any>) => {
  try {
    Auth.make(plugins as never);
  } catch (error) {
    return error instanceof Auth.TenancyDeclarationInvalid ? error : undefined;
  }
  return undefined;
};

describe("Auth.make validates tenancy declarations (BEH-EA-328)", () => {
  const T = AuthPlugin.Table;

  it("exposes every table's declaration in plugin order, and in the manifest", () => {
    const base = plugin("base", { base_a: T.partitioned(), base_b: T.global("why") });
    const top = plugin("top", { top_c: T.derived("base_a", "aId") }, [base]);
    const auth = Auth.make([base, top] as never);
    assert.deepStrictEqual(
      auth.tenancy.map((entry) => `${entry.plugin}:${entry.table}:${entry.tenancy._tag}`),
      ["base:base_a:Partitioned", "base:base_b:Global", "top:top_c:Derived"],
    );
    assert.deepStrictEqual(Object.keys(auth.manifest.plugins[1]?.tenancy ?? {}), ["top_c"]);
  });

  it("accepts a core table as a Derived parent", () => {
    const p = plugin("ctx", { ctx_a: T.derived("sessions", "sessionId") });
    assert.strictEqual(Auth.make([p] as never).tenancy.length, 1);
  });

  it("refuses an identifier that is not a plain SQL identifier", () => {
    const error = refusal([plugin("bad", { bad_x: T.partitioned('tenant"; DROP') })]);
    assert.strictEqual(error?.cause, "Identifier");
  });

  it("refuses a Derived parent outside the plugin, its dependsOn and the core tables", () => {
    const stranger = plugin("stranger", { stranger_a: T.partitioned() });
    const p = plugin("lone", { lone_a: T.derived("stranger_a", "aId") });
    assert.strictEqual(refusal([stranger, p])?.cause, "UnknownParent");
  });

  it("refuses a Derived table beneath a Global one", () => {
    const p = plugin("g", { g_a: T.global("x"), g_b: T.derived("g_a", "aId") });
    assert.strictEqual(refusal([p])?.cause, "GlobalParent");
  });

  it("refuses a Derived chain that loops", () => {
    const p = plugin("loop", {
      loop_a: T.derived("loop_b", "bId"),
      loop_b: T.derived("loop_a", "aId"),
    });
    assert.strictEqual(refusal([p])?.cause, "Cycle");
  });
});
