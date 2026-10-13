// BEH-EA-101 (plan 09): an event's actor and personal-data fields are declared with its schema.
// T1: the constructor and the generic readers. T3: properties over every registry member.
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AuthEvents from "../src/AuthEvents.ts";
import {
  Actor,
  EventMetaSchema,
  MetaKey,
  actorValue,
  defineEvent,
} from "../src/internal/eventDefinition.ts";

const UserIdSchema = Schema.String.pipe(Schema.brand("UserId"));

const Throwaway = defineEvent(
  "test.x",
  { userId: UserIdSchema, note: Schema.String },
  { actor: Actor.field("userId"), pii: ["note"] },
);

describe("defineEvent (T1)", () => {
  it("returns a working TaggedStruct that carries its declaration", () => {
    const decoded = Schema.decodeUnknownSync(Throwaway)({ _tag: "test.x", userId: "u", note: "n" });
    assert.deepStrictEqual(decoded, { _tag: "test.x", userId: "u", note: "n" });
    assert.deepStrictEqual(Schema.encodeSync(Throwaway)(decoded), {
      _tag: "test.x",
      userId: "u",
      note: "n",
    });
    assert.strictEqual(Throwaway.fields._tag.ast.literal, "test.x");
    assert.deepStrictEqual(Throwaway[MetaKey], {
      tag: "test.x",
      actor: { _tag: "Field", field: "userId" },
      pii: ["note"],
    });
  });

  it("a rebuilt schema drops the declaration (so the registry refuses it at compile time)", () => {
    const rebuilt = Throwaway.annotate({});
    assert.isFalse(MetaKey in rebuilt);
  });

  const meta = (actor: typeof EventMetaSchema.Type.actor) => ({ tag: "t", actor, pii: [] });

  it("a required actor field is the actor even when empty; an absent optional one is none", () => {
    const field = meta(Actor.field("userId"));
    assert.deepStrictEqual(actorValue(field, { userId: "" }), Option.some(""));
    assert.deepStrictEqual(actorValue(field, { userId: "u" }), Option.some("u"));
    assert.deepStrictEqual(actorValue(field, {}), Option.none());
    assert.deepStrictEqual(actorValue(field, { userId: undefined }), Option.none());
    assert.deepStrictEqual(actorValue(meta(Actor.none), { userId: "u" }), Option.none());
  });

  it("a prefixed actor is the id after the prefix, and nothing otherwise", () => {
    const prefixed = meta(Actor.prefixed("subjectId", "user:"));
    assert.deepStrictEqual(actorValue(prefixed, { subjectId: "user:abc" }), Option.some("abc"));
    assert.deepStrictEqual(actorValue(prefixed, { subjectId: "user:" }), Option.some(""));
    assert.deepStrictEqual(actorValue(prefixed, { subjectId: "apikey:abc" }), Option.none());
    assert.deepStrictEqual(actorValue(prefixed, { subjectId: "abc" }), Option.none());
  });
});

// ---- T3: every registry member -------------------------------------------------------------
const members = AuthEvents.AuthEventSchema.members;

const decodeMeta = (member: object) =>
  Schema.decodeUnknownSync(EventMetaSchema)(Reflect.get(member, MetaKey));

const fieldNames = (member: { readonly fields: object }) => Object.keys(member.fields);

describe("the event registry (T3)", () => {
  it("P1: every member carries metadata naming its own tag, and tags are unique", () => {
    for (const member of members) {
      assert.strictEqual(decodeMeta(member).tag, member.fields._tag.ast.literal);
    }
    assert.strictEqual(new Set(AuthEvents.eventTags).size, members.length);
    assert.strictEqual(AuthEvents.eventTags.length, members.length);
  });

  it("P2: every Field/Prefixed actor names a key of its event", () => {
    for (const member of members) {
      const { actor } = decodeMeta(member);
      if (actor._tag !== "None") assert.include(fieldNames(member), actor.field);
    }
  });

  it("P3: every pii entry is a key of its event", () => {
    for (const member of members) {
      for (const field of decodeMeta(member).pii) assert.include(fieldNames(member), field);
    }
  });

  it.prop(
    "P3: blanking every declared pii field still decodes (erasure never makes a row undecodable)",
    { event: AuthEvents.AuthEventSchema },
    ({ event }) => {
      const encoded = Schema.encodeSync(AuthEvents.AuthEventSchema)(event);
      const blanked = Object.fromEntries(
        Object.entries(encoded).map(([key, value]) => [
          key,
          AuthEvents.piiFieldsOf(event._tag).includes(key) ? "" : value,
        ]),
      );
      Schema.decodeUnknownSync(AuthEvents.AuthEventSchema)(blanked);
    },
  );

  it.prop(
    "P4: the actor is none, or a value the event carries",
    { event: AuthEvents.AuthEventSchema },
    ({ event }) => {
      const actor = AuthEvents.actorOf(event);
      if (Option.isSome(actor)) {
        const carried = Object.values(event).some(
          (value) => typeof value === "string" && value.endsWith(actor.value),
        );
        assert.isTrue(carried);
      }
    },
  );

  it.prop(
    "P5: piiFieldsOf is a subset of the event's declared fields",
    { event: AuthEvents.AuthEventSchema },
    ({ event }) => {
      const member = members.find((m) => m.fields._tag.ast.literal === event._tag);
      assert.isDefined(member);
      if (member === undefined) return;
      for (const field of AuthEvents.piiFieldsOf(event._tag)) {
        assert.include(fieldNames(member), field);
      }
    },
  );

  // P6, the classification guard F1 would have tripped: a field that looks like operator or
  // user free text must be declared `pii`, or sit in this commented allowlist.
  const looksLikeFreeText = /reason|note|justification|description|comment|message|text/i;
  const NOT_PERSONAL: ReadonlySet<string> = new Set([
    // qadi's denial sentence names attributes, never their values.
    "auth.authz.denied.reason",
  ]);

  const isFreeTextSchema = (field: unknown): boolean => {
    if (!Schema.isSchema(field)) return false;
    const ast = field.ast;
    if (ast._tag === "String") return ast.annotations?.["brands"] === undefined;
    if (ast._tag === "Union") {
      return (
        ast.types.every((type) => type._tag !== "Literal") &&
        ast.types.some(
          (type) => type._tag === "String" && type.annotations?.["brands"] === undefined,
        )
      );
    }
    return false;
  };

  it("P6: free-text-looking string fields are declared pii or explicitly allowlisted", () => {
    const undeclared: Array<string> = [];
    for (const member of members) {
      const tag = decodeMeta(member).tag;
      for (const name of fieldNames(member)) {
        if (!looksLikeFreeText.test(name)) continue;
        if (!isFreeTextSchema(Reflect.get(member.fields, name))) continue;
        if (AuthEvents.piiFieldsOf(tag).includes(name)) continue;
        if (NOT_PERSONAL.has(`${tag}.${name}`)) continue;
        undeclared.push(`${tag}.${name}`);
      }
    }
    assert.deepStrictEqual(undeclared, []);
  });
});
