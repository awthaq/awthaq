// Plan 30 tickets 05, 07 and 10: the brand idiom the access proof and the grant ceiling rely on. These are
// compile-time checks (`tsc -p tsconfig.test.json` is the assertion) with token runtime tests so the file
// is a suite: the real `internal/access.ts` proofs and the real `OrganizationActor.Bound`.
import { Api } from "@awthaq/api";
import { Auth } from "@awthaq/core";
import { TestAuth } from "@awthaq/test";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as OrganizationAccess from "../src/internal/access.ts";
import { policy } from "../src/internal/policy.ts";
import * as Organization from "../src/Organization.ts";
import * as OrganizationActor from "../src/OrganizationActor.ts";
import * as OrganizationAuthority from "../src/OrganizationAuthority.ts";
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

// 3. `Bound.Ceiling` needs `CeilingStatements`, which only `OrganizationAuthority` brands (ticket 10): a plain
// `Statements` no longer builds one, while `Unbounded()` and `$match` still work.
// @ts-expect-error `{}` is a plain Statements, not CeilingStatements
export const plainCeiling = OrganizationActor.Bound.Ceiling({ statements: {} });
// A CeilingStatements still reads as Statements (internal/bound.ts needs no change).
export const readsAsStatements = (statements: OrganizationActor.CeilingStatements): Statements =>
  statements;

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

describe("access brands (plan 30 tickets 05, 07, 10)", () => {
  it("Unbounded and $match still work over the branded Ceiling", () => {
    const describeBound = (bound: OrganizationActor.Bound) =>
      OrganizationActor.Bound.$match(bound, {
        Unbounded: () => "unbounded",
        Ceiling: ({ statements }) => Object.keys(statements).join(","),
      });
    assert.strictEqual(describeBound(OrganizationActor.Bound.Unbounded()), "unbounded");
  });

  it.effect("OrganizationAuthority mints the Ceiling", () =>
    Effect.gen(function* () {
      const organization = yield* Organization.Organization;
      const authority = yield* OrganizationAuthority.OrganizationAuthority;
      const org = yield* organization.create({
        caller: new Api.UserPrincipal({
          ref: new Api.PrincipalRef({ type: "user", id: "owner" }),
          sessionId: "owner-session",
        }),
        name: "Acme",
        slug: "acme",
      });
      const bound = yield* authority.ceilingOf(org.id, ["member"]);
      assert.strictEqual(bound._tag, "Ceiling");
    }).pipe(Effect.provide(TestAuth.layer(Auth.make([Organization.Organization])))),
  );

  it("statement keeps its resource and action", () => {
    assert.deepStrictEqual(OrganizationAccess.statement("role", "create"), {
      resource: "role",
      action: "create",
    });
  });
});
