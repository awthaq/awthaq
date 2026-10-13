// Temporary (plan 09 phases 1-2, deleted in phase 3): the generic reader over each event's declared
// metadata must agree with the pre-`defineEvent` actor switch and the `PII_FIELDS` table, for every
// event. The ratchet pins that every registry member was migrated.
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AuthEvents from "../src/AuthEvents.ts";
import { EventMetaSchema, MetaKey, actorValue } from "../src/internal/eventDefinition.ts";
import { legacyActorOf } from "../src/internal/legacyEventMeta.ts";
import { UserId } from "../src/Users.ts";
import { allSamples } from "./support/eventSamples.ts";

const MIGRATED = 92;

const metaOf = new Map(
  AuthEvents.AuthEventSchema.members.flatMap((member) => {
    const meta = Schema.decodeUnknownOption(EventMetaSchema)(Reflect.get(member, MetaKey));
    return Option.isSome(meta) ? [[meta.value.tag, meta.value] as const] : [];
  }),
);

const reading = (event: AuthEvents.AuthEvent) => {
  const meta = metaOf.get(event._tag);
  return meta === undefined ? Option.none<string>() : actorValue(meta, event);
};

describe("event definition parity", () => {
  it("every registry member is migrated (ratchet)", () => {
    assert.strictEqual(metaOf.size, MIGRATED);
    assert.strictEqual(metaOf.size, AuthEvents.AuthEventSchema.members.length);
  });

  it("the generic reader agrees with the legacy switch on every fixture", () => {
    for (const sample of allSamples) {
      assert.deepStrictEqual(
        Option.map(reading(sample), UserId),
        legacyActorOf(sample),
        sample._tag,
      );
    }
  });

  it("the declared pii equals PII_FIELDS for every tag", () => {
    for (const [tag, meta] of metaOf) {
      assert.deepStrictEqual([...meta.pii], [...(AuthEvents.PII_FIELDS[tag] ?? [])], tag);
    }
  });

  it.prop(
    "the generic reader agrees with the legacy switch for any generated event",
    { event: AuthEvents.AuthEventSchema },
    ({ event }) => {
      assert.deepStrictEqual(Option.map(reading(event), UserId), legacyActorOf(event));
    },
  );

  it.prop(
    "the prefix rule agrees with the legacy switch",
    { id: Schema.String, form: Schema.Literals(["user:", "apikey:", ""]) },
    ({ id, form }) => {
      const event: AuthEvents.AuthEvent = {
        _tag: "auth.authz.denied",
        subjectId: `${form}${id}`,
        evaluationId: "e",
        policyTag: "p",
        reason: "r",
      };
      assert.deepStrictEqual(Option.map(reading(event), UserId), legacyActorOf(event));
    },
  );
});
