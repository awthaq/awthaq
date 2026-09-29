// ETVS-002: property tests for the pure DAC guard. `canGrant` is the only thing standing
// between a dynamic-role author and self-escalation (ticket 15/RRM-001/RZS-005), so its
// algebra is stated as invariants over generated statement sets rather than hand-picked cases.
import { assert, describe, it } from "@effect/vitest";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import * as Schema from "effect/Schema";
import * as PermissionEngine from "../src/PermissionEngine.ts";

// A small alphabet so generated sets collide and overlap often; a wide alphabet would make
// "requested is a subset of held" vanishingly rare and the interesting branch never runs.
const Resource = Schema.Literals(["organization", "member", "invitation", "team", "role"]);
const Action = Schema.Literals(["create", "read", "update", "delete", "cancel"]);
const Entries = Schema.Array(Schema.Tuple([Resource, Schema.Array(Action)]));

const toStatements = (
  entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>,
): PermissionEngine.Statements => {
  const statements: Record<string, ReadonlyArray<string>> = {};
  for (const [resource, actions] of entries) {
    statements[resource] = [...(statements[resource] ?? []), ...actions];
  }
  return statements;
};

const StatementsArb = Arbitrary.map(Arbitrary.schema(Entries), toStatements);

/** The oracle: every (resource, action) pair the statements name. */
const pairs = (statements: PermissionEngine.Statements): ReadonlyArray<string> =>
  Object.entries(statements).flatMap(([resource, actions]) =>
    actions.map((action) => `${resource}:${action}`),
  );

describe("PermissionEngine.canGrant (DAC escalation guard) properties", () => {
  it.prop(
    "RZS-005: canGrant(requested, held) holds exactly when every requested pair is held",
    { requested: StatementsArb, held: StatementsArb },
    ({ requested, held }) => {
      const heldPairs = new Set(pairs(held));
      const expected = pairs(requested).every((pair) => heldPairs.has(pair));
      assert.strictEqual(PermissionEngine.canGrant(requested, held), expected);
    },
  );

  it.prop(
    "a caller can always grant exactly what it holds (reflexive)",
    { held: StatementsArb },
    ({ held }) => {
      assert.isTrue(PermissionEngine.canGrant(held, held));
    },
  );

  it.prop(
    "nothing requested is always grantable, even by a holder of nothing",
    {
      held: StatementsArb,
    },
    ({ held }) => {
      assert.isTrue(PermissionEngine.canGrant({}, held));
      assert.isTrue(PermissionEngine.canGrant({}, {}));
    },
  );

  it.prop(
    "a holder of nothing can grant only the empty request",
    { requested: StatementsArb },
    ({ requested }) => {
      assert.strictEqual(PermissionEngine.canGrant(requested, {}), pairs(requested).length === 0);
    },
  );

  it.prop(
    "OHS-004: widening what the granter holds (mergeStatements) never revokes a grant it could already make",
    { requested: StatementsArb, held: StatementsArb, extra: StatementsArb },
    ({ requested, held, extra }) => {
      if (!PermissionEngine.canGrant(requested, held)) return;
      assert.isTrue(
        PermissionEngine.canGrant(requested, PermissionEngine.mergeStatements(held, extra)),
      );
    },
  );

  it.prop(
    "grants compose: a grantable-by-b request that b can get from a is grantable by a (transitive)",
    { a: StatementsArb, b: StatementsArb, c: StatementsArb },
    ({ a, b, c }) => {
      if (PermissionEngine.canGrant(a, b) && PermissionEngine.canGrant(b, c)) {
        assert.isTrue(PermissionEngine.canGrant(a, c));
      }
    },
  );

  it.prop(
    "no escalation: whatever canGrant admits, the granter itself holds (hasPermission)",
    { requested: StatementsArb, held: StatementsArb },
    ({ requested, held }) => {
      if (!PermissionEngine.canGrant(requested, held)) return;
      for (const [resource, actions] of Object.entries(requested)) {
        for (const action of actions) {
          assert.isTrue(PermissionEngine.hasPermission(held, resource, action));
        }
      }
    },
  );

  it.prop(
    "mergeStatements is the union: it holds a pair iff either side does, and both sides stay grantable from it",
    { a: StatementsArb, b: StatementsArb },
    ({ a, b }) => {
      const merged = PermissionEngine.mergeStatements(a, b);
      assert.isTrue(PermissionEngine.canGrant(a, merged));
      assert.isTrue(PermissionEngine.canGrant(b, merged));
      const union = new Set([...pairs(a), ...pairs(b)]);
      assert.deepStrictEqual(new Set(pairs(merged)), union);
    },
  );

  it.prop(
    "OHS-005: an admin can never confer an owner-only statement, however the request is padded",
    { padding: StatementsArb },
    ({ padding }) => {
      const request = PermissionEngine.mergeStatements(padding, { organization: ["delete"] });
      const admin = PermissionEngine.effectivePermissions(
        ["admin"],
        PermissionEngine.statementsByRoleFrom({}),
      );
      assert.isFalse(PermissionEngine.canGrant(request, admin));
      const owner = PermissionEngine.effectivePermissions(
        ["owner"],
        PermissionEngine.statementsByRoleFrom({}),
      );
      // The owner holds organization:delete, so the padding is the only thing that could stop it.
      assert.isTrue(PermissionEngine.canGrant({ organization: ["delete"] }, owner));
    },
  );

  it.prop(
    "effectivePermissions is the union of the held roles: it can grant each role's statements and nothing outside them",
    {
      roles: Schema.Array(Schema.Literals(["owner", "admin", "member", "ghost"])),
      request: StatementsArb,
    },
    ({ roles, request }) => {
      const byRole = PermissionEngine.statementsByRoleFrom({});
      const effective = PermissionEngine.effectivePermissions(roles, byRole);
      // An unrecognized role ("ghost", a deleted dynamic role) contributes nothing.
      const heldPairs = new Set(
        roles.flatMap((role) =>
          pairs(PermissionEngine.defaultStatements[role === "ghost" ? "member" : role]),
        ),
      );
      assert.strictEqual(
        PermissionEngine.canGrant(request, effective),
        pairs(request).every((pair) => heldPairs.has(pair)),
      );
    },
  );

  // PV-310: resource names come from a role-creation payload, so they are attacker-chosen
  // strings — including ones that name an inherited Object.prototype member. The guard must
  // answer (grant or deny) for every one of them, never throw.
  const HostileResource = Schema.Union([
    Schema.Literals(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]),
    Schema.String,
  ]);
  const ownStatements = (entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>) => {
    const statements: Record<string, ReadonlyArray<string>> = {};
    for (const [resource, actions] of entries) {
      Object.defineProperty(statements, resource, {
        value: [
          ...(Object.hasOwn(statements, resource) ? (statements[resource] ?? []) : []),
          ...actions,
        ],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return statements;
  };
  const HostileArb = Arbitrary.map(
    Arbitrary.schema(Schema.Array(Schema.Tuple([HostileResource, Schema.Array(Action)]))),
    ownStatements,
  );

  it.prop(
    "PV-310: canGrant/hasPermission/mergeStatements never throw for any resource name, and an empty granter still grants nothing",
    { requested: HostileArb, held: HostileArb, resource: HostileResource },
    ({ requested, held, resource }) => {
      assert.strictEqual(PermissionEngine.canGrant(requested, {}), pairs(requested).length === 0);
      const merged = PermissionEngine.mergeStatements(held, requested);
      assert.isTrue(PermissionEngine.canGrant(requested, merged));
      assert.isBoolean(PermissionEngine.hasPermission(held, resource, "create"));
      // An inherited member is never a held permission.
      assert.isFalse(PermissionEngine.hasPermission({}, resource, "create"));
    },
  );
});
