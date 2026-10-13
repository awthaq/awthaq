// BEH-EA-101 (plan 09): `defineEvent` and the registry refuse an undeclared or mis-declared event at
// compile time. Nothing here executes beyond building schemas: the assertions are the
// `@ts-expect-error` directives, checked by `tsc -p tsconfig.test.json`.
import { describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type * as AuthEvents from "../src/AuthEvents.ts";
import { eventTags } from "../src/AuthEventSchemas.ts";
import { Actor, defineEvent, registry } from "../src/internal/eventDefinition.ts";

const UserIdSchema = Schema.String.pipe(Schema.brand("UserId"));

describe("defineEvent types", () => {
  it("a plain TaggedStruct is not a registry member", () => {
    // Never called: the plain struct has no declaration to read.
    const refused = () =>
      // @ts-expect-error a registry member must come from `defineEvent`
      registry([Schema.TaggedStruct("x", {})]);
    void refused;
  });

  it("both the actor and the pii declaration are required", () => {
    // @ts-expect-error `actor` is missing
    defineEvent("x", { userId: UserIdSchema }, { pii: [] });
    // @ts-expect-error `pii` is missing
    defineEvent("x", { userId: UserIdSchema }, { actor: Actor.none });
  });

  it("an actor field must be a UserId-typed field of the event", () => {
    // @ts-expect-error `strategy` is a plain string, not a user id
    defineEvent("x", { strategy: Schema.String }, { actor: Actor.field("strategy"), pii: [] });
    // @ts-expect-error the event has no `nope` field
    defineEvent("x", { userId: UserIdSchema }, { actor: Actor.field("nope"), pii: [] });
    defineEvent(
      "x",
      { userId: Schema.optionalKey(UserIdSchema) },
      { actor: Actor.field("userId"), pii: [] },
    );
    defineEvent(
      "x",
      { userId: Schema.optional(UserIdSchema) },
      { actor: Actor.field("userId"), pii: [] },
    );
  });

  it("a pii field must be blankable free text of the event", () => {
    const fields = {
      userId: UserIdSchema,
      kind: Schema.Literals(["a", "b"]),
      count: Schema.Number,
      reason: Schema.NullOr(Schema.String),
    };
    // @ts-expect-error a branded id is not free text
    defineEvent("x", fields, { actor: Actor.none, pii: ["userId"] });
    // @ts-expect-error a literal cannot be blanked to ""
    defineEvent("x", fields, { actor: Actor.none, pii: ["kind"] });
    // @ts-expect-error a number cannot be blanked to ""
    defineEvent("x", fields, { actor: Actor.none, pii: ["count"] });
    // @ts-expect-error the tag is not a payload field
    defineEvent("x", fields, { actor: Actor.none, pii: ["_tag"] });
    defineEvent("x", fields, { actor: Actor.none, pii: ["reason"] });
  });

  it("eventTags narrows to AuthEventTag", () => {
    const tags: ReadonlyArray<AuthEvents.AuthEventTag> = eventTags;
    void tags;
  });
});
