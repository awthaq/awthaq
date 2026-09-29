// ETVS-002: property tests for the SCIM `filter` parameter (BEH-EA-247..250, RFC 7644 §3.4.2.2).
// The filter is a query-string value an identity provider (or an attacker holding a leaked
// bearer token) fully controls, and only `attr eq "value"` is supported, so the parse is checked
// against arbitrary text: it answers with a list or a typed 400 `invalidFilter`, never a defect,
// and a quoted value survives the escape/unescape round trip exactly.
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scim from "../src/Scim.ts";
import { ScimLive, seedConnection } from "./support.ts";

const quote = (value: string): string => `"${value.replace(/[\\"]/g, "\\$&")}"`;

const noDefect = <A, E>(exit: Exit.Exit<A, E>): void => {
  if (Exit.isFailure(exit)) {
    assert.isFalse(Cause.hasDies(exit.cause), "a filter must never become a defect");
  }
};

/** A value that survives SCIM's own `trim()` unchanged and is non-empty. */
const Value = Schema.String.check(Schema.isPattern(/^\S(?:[\s\S]{0,30}\S)?$/));

describe("SCIM filter parsing properties", () => {
  it.effect.prop(
    "any filter text yields a ListResponse or a typed ScimBadRequest, never a defect",
    { filter: Schema.String },
    ({ filter }) =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        noDefect(yield* Effect.exit(scim.listUsers(connection, { filter })));
        noDefect(yield* Effect.exit(scim.listGroups(connection, { filter })));
      }).pipe(Effect.provide(ScimLive())),
  );

  it.effect.prop(
    'only `attr eq "value"` is supported: any other operator on a supported attribute is 400 invalidFilter',
    {
      attribute: Schema.Literals(["userName", "externalId"]),
      operator: Schema.Literals([
        "ne",
        "co",
        "sw",
        "ew",
        "gt",
        "ge",
        "lt",
        "le",
        "and",
        "or",
        "pr",
      ]),
      value: Value,
    },
    ({ attribute, operator, value }) =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const failure = yield* scim
          .listUsers(connection, { filter: `${attribute} ${operator} ${quote(value)}` })
          .pipe(Effect.catchTag("StoreUnavailable", Effect.die), Effect.flip);
        assert.strictEqual(failure._tag, "ScimBadRequest");
        assert.strictEqual(failure.scimType, "invalidFilter");
      }).pipe(Effect.provide(ScimLive())),
  );

  it.effect.prop(
    "an `externalId eq` filter finds exactly the user provisioned with that value, for any quoted/escaped text and any spacing/case of the keywords",
    {
      value: Value,
      attributeCase: Schema.Literals(["externalId", "EXTERNALID", "externalid"]),
      operatorCase: Schema.Literals(["eq", "EQ", "Eq"]),
      lead: Schema.Literals(["", " ", "  "]),
      gap: Schema.Literals([" ", "  ", "\t"]),
    },
    ({ value, attributeCase, operatorCase, lead, gap }) =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const created = yield* scim.createUser(connection, {
          userName: "someone@acme.example",
          externalId: value,
        });
        const decoy = yield* scim.createUser(connection, {
          userName: "decoy@acme.example",
          externalId: `${value}-decoy`,
        });
        const found = yield* scim.listUsers(connection, {
          filter: `${lead}${attributeCase}${gap}${operatorCase}${gap}${quote(value)}${lead}`,
        });
        assert.strictEqual(found.totalResults, 1);
        assert.strictEqual(found.Resources[0]?.id, created.id);
        assert.strictEqual(found.Resources[0]?.externalId, value);
        assert.notStrictEqual(found.Resources[0]?.id, decoy.id);
      }).pipe(Effect.provide(ScimLive())),
  );

  it.effect.prop(
    "an attribute the resource type does not support (userName on Groups, displayName on Users) is 400 invalidFilter, whatever the value",
    { value: Value },
    ({ value }) =>
      Effect.gen(function* () {
        const { connection } = yield* seedConnection();
        const scim = yield* Scim.Scim;
        const onUsers = yield* scim
          .listUsers(connection, { filter: `displayName eq ${quote(value)}` })
          .pipe(Effect.catchTag("StoreUnavailable", Effect.die), Effect.flip);
        assert.strictEqual(onUsers.scimType, "invalidFilter");
        const onGroups = yield* scim
          .listGroups(connection, { filter: `userName eq ${quote(value)}` })
          .pipe(Effect.catchTag("StoreUnavailable", Effect.die), Effect.flip);
        assert.strictEqual(onGroups.scimType, "invalidFilter");
      }).pipe(Effect.provide(ScimLive())),
  );
});
