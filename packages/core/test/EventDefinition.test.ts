// BEH-EA-101 (plan 09, ADR-EA-049): an event's actor and personal-data fields are declared with its schema.
// T1: the constructor and the generic readers. Registry readers. `problems`: the well-formedness check
// core's set and every plugin's declared events pass, one failing definition per check. T3: properties
// sampled over core's set.
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AuthEvents from "../src/AuthEvents.ts";
import {
  Actor,
  type Any,
  EventMetaSchema,
  MetaKey,
  UserId as UserIdSchema,
  actorValue,
  define,
  make,
  problems,
} from "../src/EventDefinition.ts";

const Throwaway = define(
  "test.x",
  { userId: UserIdSchema, note: Schema.String },
  { actor: Actor.field("userId"), pii: ["note"] },
);

describe("define (T1)", () => {
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
      attempt: false,
    });
    const attempt = define("test.y", {}, { actor: Actor.none, pii: [], attempt: true });
    assert.isTrue(attempt[MetaKey].attempt);
  });

  it("a rebuilt schema drops the declaration (so the registry refuses it at compile time)", () => {
    const rebuilt = Throwaway.annotate({});
    assert.isFalse(MetaKey in rebuilt);
  });

  const meta = (actor: typeof EventMetaSchema.Type.actor) => ({
    tag: "t",
    actor,
    pii: [],
    attempt: false,
  });

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

// ---- registry readers ------------------------------------------------------------------------
const LocalDef = define(
  "auth.local.happened",
  { userId: UserIdSchema, note: Schema.String },
  { actor: Actor.field("userId"), pii: ["note"], attempt: true },
);

describe("make (registry readers)", () => {
  const registry = make([LocalDef], "composition");

  it("knows its origin, definitions and tags", () => {
    assert.strictEqual(registry.origin, "composition");
    assert.deepStrictEqual(registry.tags, ["auth.local.happened"]);
    assert.strictEqual(registry.definitions[0], LocalDef);
    assert.isTrue(registry.isTag("auth.local.happened"));
    assert.isFalse(registry.isTag("auth.user.created"));
  });

  it("definitionOf finds a registered tag only", () => {
    assert.deepStrictEqual(registry.definitionOf("auth.local.happened"), Option.some(LocalDef));
    assert.isTrue(Option.isNone(registry.definitionOf("auth.user.created")));
  });

  it("reads actor, pii and attempt from the definition; an unknown tag has none", () => {
    const local = { _tag: "auth.local.happened", userId: "u-1", note: "n" };
    const unknown = { _tag: "auth.nope.x", userId: "u-1" };
    const partial = { _tag: "auth.local.happened", userId: "u-1" };
    const core = { _tag: "auth.user.created", userId: "u-1" };
    assert.deepStrictEqual(registry.actorOf(local), Option.some("u-1"));
    assert.deepStrictEqual(registry.piiFieldsOf("auth.local.happened"), ["note"]);
    assert.isTrue(registry.isAttempt("auth.local.happened"));
    assert.deepStrictEqual(registry.actorOf(unknown), Option.none());
    assert.deepStrictEqual(registry.piiFieldsOf("auth.nope.x"), []);
    assert.isFalse(registry.isAttempt("auth.nope.x"));
    // `is` validates: a registered tag whose shape does not decode is refused.
    assert.isTrue(registry.is(local));
    assert.isFalse(registry.is(partial));
    assert.isFalse(registry.is(core));
  });

  it("core's registry holds core's own events, not the moved plugin events", () => {
    assert.strictEqual(AuthEvents.CoreRegistry.origin, "core");
    assert.strictEqual(AuthEvents.eventTags.length, 24);
    assert.strictEqual(AuthEvents.coreDefinitions.length, 24);
  });
});

// ---- problems: the well-formedness check ----------------------------------------------------
describe("problems", () => {
  it("core's own definitions are well formed", () => {
    assert.deepStrictEqual(
      problems(AuthEvents.coreDefinitions, {
        // qadi's denial sentence names attributes, never their values.
        notPersonal: ["auth.authz.denied.reason"],
      }),
      [],
    );
  });

  it("P1: a declared tag that is not the schema's _tag literal", () => {
    const relabeled = Object.assign(Schema.TaggedStruct("auth.local.other", {}), {
      [MetaKey]: LocalDef[MetaKey],
    });
    assert.deepStrictEqual(problems([relabeled]), [
      "auth.local.happened: the declared tag is not the schema's _tag literal (P1)",
      'auth.local.happened: the actor field "userId" is not a field of the event (P2)',
      'auth.local.happened: the pii field "note" is not a field of the event (P3)',
    ]);
  });

  // P2 and P3 are compile errors at `define`; a hand-built declaration reaches `problems` only as data.
  const handBuilt = (meta: typeof EventMetaSchema.Type): Any =>
    Object.assign(Schema.TaggedStruct(meta.tag, { userId: UserIdSchema }), { [MetaKey]: meta });

  it("P2: an actor field the event does not carry", () => {
    const definition = handBuilt({
      tag: "auth.local.happened",
      actor: { _tag: "Field", field: "actorId" },
      pii: [],
      attempt: false,
    });
    assert.deepStrictEqual(problems([definition]), [
      'auth.local.happened: the actor field "actorId" is not a field of the event (P2)',
    ]);
  });

  it("P3: a pii entry the event does not carry", () => {
    const definition = handBuilt({
      tag: "auth.local.happened",
      actor: { _tag: "None" },
      pii: ["reason"],
      attempt: false,
    });
    assert.deepStrictEqual(problems([definition]), [
      'auth.local.happened: the pii field "reason" is not a field of the event (P3)',
    ]);
  });

  it("P6: an undeclared free-text field fails, naming tag.field, unless listed as not personal", () => {
    const Noted = define(
      "auth.local.noted",
      { userId: UserIdSchema, reason: Schema.String, code: Schema.Literals(["a", "b"]) },
      { actor: Actor.field("userId"), pii: [] },
    );
    assert.deepStrictEqual(problems([Noted]), [
      "auth.local.noted.reason: a free-text field is neither declared pii nor listed as not personal (P6)",
    ]);
    assert.deepStrictEqual(problems([Noted], { notPersonal: ["auth.local.noted.reason"] }), []);
    const Declared = define(
      "auth.local.declared",
      { message: Schema.optional(Schema.NullOr(Schema.String)) },
      { actor: Actor.none, pii: ["message"] },
    );
    assert.deepStrictEqual(problems([Declared]), []);
    // An identifier named like free text (`noteId`, `messageIds`) is an id by convention, not free text.
    const Identified = define(
      "auth.local.identified",
      { noteId: Schema.String, messageIds: Schema.Array(Schema.String) },
      { actor: Actor.none, pii: [] },
    );
    assert.deepStrictEqual(problems([Identified]), []);
  });

  it("N: a tag that is not auth.<namespace>.<event>", () => {
    const definition = define("notes.created", {}, { actor: Actor.none, pii: [] });
    assert.deepStrictEqual(problems([definition]), [
      "notes.created: a tag is named auth.<namespace>.<event>, camelCase segments (N)",
    ]);
  });

  it("R: the reserved foreign-event tag", () => {
    const definition = define("awthaq.foreignEvent", {}, { actor: Actor.none, pii: [] });
    assert.deepStrictEqual(problems([definition]), [
      "awthaq.foreignEvent: the tag is reserved for events core does not define (R)",
    ]);
  });

  it("U: a tag listed twice", () => {
    assert.deepStrictEqual(problems([LocalDef, LocalDef]), [
      "auth.local.happened: the tag is listed twice (U)",
    ]);
  });

  it("a definition without a valid declaration (a JavaScript author's)", () => {
    const bare = define("auth.local.bare", {}, { actor: Actor.none, pii: [] });
    Reflect.set(bare, MetaKey, { tag: "auth.local.bare", actor: { _tag: "Somebody" } });
    assert.deepStrictEqual(problems([bare]), [
      "an event definition carries no valid declaration: make it with EventDefinition.define",
    ]);
  });
});

// ---- T3: properties sampled over core's set ---------------------------------------------------
// ADR-EA-049: core's 24 only. A plugin's declared events get the same P3/P4 sampling from
// `runPluginContractTests` ("every declared event is well-formed"), in that plugin's own suite.
describe("the event registry (T3)", () => {
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
});

describe("attempt events (ADR-EA-037)", () => {
  // ADR-EA-037 Q8: these record an attempt, so they are recorded and delivered even when the
  // surrounding unit of work rolls back. Every other event is a state change.
  const attemptTags = [
    "auth.user.signInFailed",
    "auth.token.replay",
    "auth.rateLimit.exceeded",
    "auth.admin.actionDenied",
    "auth.admin.impersonationDenied",
    "auth.authz.denied",
  ];

  // Core's six; the composed set of every first-party plugin (ten) is asserted in BDD (13-events.feature).
  it("classifies exactly the documented attempt set; every other registered event is a state change", () => {
    assert.deepStrictEqual(
      AuthEvents.eventTags.filter((tag) => AuthEvents.isAttemptEvent(tag)).toSorted(),
      attemptTags.toSorted(),
    );
  });

  it("an unregistered tag is not an attempt", () => {
    assert.isFalse(AuthEvents.isAttemptEvent("auth.nonexistent"));
  });
});
