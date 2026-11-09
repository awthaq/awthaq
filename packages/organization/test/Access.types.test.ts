// Plan 30 tickets 05 and 07: the brand idiom the access proof and the grant ceiling rely on. These are
// compile-time checks (`tsc -p tsconfig.test.json` is the assertion) with token runtime tests so the file
// is a suite. The proofs are the real `internal/access.ts` ones; the Ceiling mirror below becomes the real
// `OrganizationActor.Bound` in ticket 10.
import type { Api } from "@awthaq/api";
import { assert, describe, it } from "@effect/vitest";
import * as Brand from "effect/Brand";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as OrganizationAccess from "../src/internal/access.ts";
import { policy } from "../src/internal/policy.ts";
import type { OrganizationShape } from "../src/OrganizationShape.ts";

type Statements = { readonly [resource: string]: ReadonlyArray<string> };
type Access = Effect.Success<typeof OrganizationAccess.make>;

// 1/2. An object literal without the brand is not a proof (the brand types emit with `tsc -b`, AdminGate's precedent).
// @ts-expect-error a bare object literal lacks the MemberAccess brand
export const forged: OrganizationAccess.MemberAccess = { organizationId: "org-1" };
export const forgedStatement = (
  access: OrganizationAccess.MemberAccess,
): OrganizationAccess.StatementAccess<"role", "create"> =>
  // @ts-expect-error a MemberAccess is not a StatementAccess
  access;

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

// 4. The generic entry points keep the statement's literals at the call site.
const roleCreate = (access: Access, caller: Api.UserPrincipal) =>
  access.requireRole(caller, "org-1", OrganizationAccess.statement("role", "create"));
type RoleCreate = Effect.Success<ReturnType<typeof roleCreate>>;
export const inferred = (proof: RoleCreate): OrganizationAccess.StatementAccess<"role", "create"> =>
  proof;
export const widened = (proof: RoleCreate): OrganizationAccess.StatementAccess<"role", "delete"> =>
  // @ts-expect-error the literal is kept, so another action does not fit
  proof;
const teamUpdate = (access: Access, caller: Api.UserPrincipal) =>
  access.requireOnTeam(caller, "org-1", OrganizationAccess.statement("team", "update"), "team-1");
export const teamInferred = (
  proof: Effect.Success<ReturnType<typeof teamUpdate>>,
): OrganizationAccess.StatementAccess<"team", "update"> => proof;
// A role entry point refuses a team statement.
export const wrongResource = (access: Access, caller: Api.UserPrincipal) =>
  // @ts-expect-error requireRole takes only a `role` statement
  access.requireRole(caller, "org-1", OrganizationAccess.statement("team", "update"));
// `member` cannot fail with a permission denial: its union is inferred from the steps it composes.
type MemberFailure = Effect.Error<ReturnType<Access["member"]>>;
export const memberNeverDenies: [
  Extract<MemberFailure, { _tag: "OrganizationPermissionDenied" }>,
] extends [never]
  ? true
  : false = true;

// The policy table names exactly the authorized interface's methods (its `satisfies` refuses a missing
// or an extra key; this pins the same from the outside).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const policyCoversTheShape: Same<keyof typeof policy, keyof OrganizationShape> = true;

describe("access brands (plan 30 tickets 05, 07)", () => {
  it("Unbounded and $match still work over the branded Ceiling", () => {
    const describeBound = (bound: Bound) =>
      Bound.$match(bound, {
        Unbounded: () => "unbounded",
        Ceiling: ({ statements }) => Object.keys(statements).join(","),
      });
    assert.strictEqual(describeBound(Bound.Unbounded()), "unbounded");
    assert.strictEqual(describeBound(ceiling), "team");
  });

  it("statement keeps its resource and action", () => {
    assert.deepStrictEqual(OrganizationAccess.statement("role", "create"), {
      resource: "role",
      action: "create",
    });
  });
});
