// Plan 30 ticket 05 (spike): the brand idiom the access proof and the grant ceiling rely on. These are
// compile-time checks (`tsc -p tsconfig.test.json` is the assertion) with token runtime tests so the file
// is a suite. The shapes below mirror the planned `internal/access.ts` and `OrganizationActor.Bound`;
// tickets 07 and 10 point them at the real module.
import { assert, describe, it } from "@effect/vitest";
import * as Brand from "effect/Brand";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

type Statements = { readonly [resource: string]: ReadonlyArray<string> };

// 2. An object literal without the brand is not a proof.
type MemberAccess = { readonly organizationId: string } & Brand.Brand<"spike/MemberAccess">;
const memberAccessOf = Brand.nominal<MemberAccess>();
// @ts-expect-error a bare object literal lacks the brand
export const forged: MemberAccess = { organizationId: "org-1" };
export const minted: MemberAccess = memberAccessOf({ organizationId: "org-1" });

// 3. `Data.taggedEnum` over a branded field: a plain `Statements` no longer builds a `Ceiling`.
type CeilingStatements = Statements & Brand.Brand<"spike/CeilingStatements">;
type Bound = Data.TaggedEnum<{
  Unbounded: {};
  Ceiling: { readonly statements: CeilingStatements };
}>;
const Bound = Data.taggedEnum<Bound>();
const ceilingStatements = Brand.nominal<CeilingStatements>();
// @ts-expect-error `{}` is a plain Statements, not CeilingStatements
export const plainCeiling = Bound.Ceiling({ statements: {} });
const ceiling = Bound.Ceiling({ statements: ceilingStatements({ team: ["update"] }) });
// A CeilingStatements still reads as Statements (internal/bound.ts needs no change).
export const readsAsStatements: Statements = ceiling.statements;

// 4. A generic `Effect.fnUntraced` keeps the literals of its type parameters at the call site.
type StatementAccess<R extends string, A extends string> = {
  readonly statement: { readonly resource: R; readonly action: A };
} & Brand.Brand<"spike/StatementAccess">;
const statementAccessOf = <R extends string, A extends string>() =>
  Brand.nominal<StatementAccess<R, A>>();
const granted = Effect.fnUntraced(function* <const R extends string, const A extends string>(
  resource: R,
  action: A,
) {
  yield* Effect.void;
  return statementAccessOf<R, A>()({ statement: { resource, action } });
});
const roleCreate = granted("role", "create");
export const inferred: Effect.Effect<StatementAccess<"role", "create">> = roleCreate;
// @ts-expect-error the literal is kept, so another action does not fit
export const widened: Effect.Effect<StatementAccess<"role", "delete">> = roleCreate;

describe("access brands (plan 30 ticket 05)", () => {
  it("Unbounded and $match still work over the branded Ceiling", () => {
    const describeBound = (bound: Bound) =>
      Bound.$match(bound, {
        Unbounded: () => "unbounded",
        Ceiling: ({ statements }) => Object.keys(statements).join(","),
      });
    assert.strictEqual(describeBound(Bound.Unbounded()), "unbounded");
    assert.strictEqual(describeBound(ceiling), "team");
  });

  it.effect("the generic entry point mints a proof carrying its statement", () =>
    Effect.gen(function* () {
      const proof = yield* roleCreate;
      assert.deepStrictEqual(proof.statement, { resource: "role", action: "create" });
    }),
  );
});
