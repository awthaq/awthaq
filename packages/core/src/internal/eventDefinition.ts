// @awthaq/core — event definitions (plan 09)
//
// One constructor, `defineEvent(tag, fields, { actor, pii })`, declares an event's shape, who acted
// and which of its fields hold free text about a person (ADR-EA-029). The metadata is declarative
// data stamped on the returned schema under `"~awthaq/event"` (the `"~userFields"` precedent), so
// the compiler can refuse a registry member without it and `AuditLog`/`WebhookPayload` read it
// generically. A leaf module: it imports only `effect`.

import type * as Brand from "effect/Brand";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The property `defineEvent` stamps on a schema; the registry accepts nothing without it. */
export const MetaKey = "~awthaq/event";

// ---- the erased (runtime) shape: plain data, so it can be validated with a Schema -------------
export const ActorSpecSchema = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Field", { field: Schema.String }),
  Schema.TaggedStruct("Prefixed", { field: Schema.String, prefix: Schema.String }),
]);
export const EventMetaSchema = Schema.Struct({
  tag: Schema.String,
  actor: ActorSpecSchema,
  pii: Schema.Array(Schema.String),
});
export type EventMeta = typeof EventMetaSchema.Type;

/** What a registry member must carry: only `defineEvent` produces it. */
export interface Defined<Tag extends string = string> {
  readonly [MetaKey]: EventMeta & { readonly tag: Tag };
}

// ---- the typed (write-time) shape: field names checked against the event's own fields ---------
type Fields = Schema.Struct.Fields;

/** Keys whose decoded value is a user id (optional or not): the only legal actor fields. */
type UserIdKey<F extends Fields> = {
  [K in keyof F & string]: NonNullable<F[K]["Type"]> extends Brand.Brand<"UserId"> ? K : never;
}[keyof F & string];

/** Keys holding a plain string (for a prefixed actor such as qadi's `subjectId`). */
type StringKey<F extends Fields> = {
  [K in keyof F & string]: K extends "_tag" ? never : F[K]["Type"] extends string ? K : never;
}[keyof F & string];

/**
 * Keys that may be declared personal data: free text, i.e. not a branded id, and whose *encoded*
 * side accepts the blank `""` erasure writes (a literal or a number would make the scrubbed row
 * undecodable).
 */
type FreeTextKey<F extends Fields> = {
  [K in keyof F & string]: K extends "_tag"
    ? never
    : NonNullable<F[K]["Type"]> extends Brand.Brand<string>
      ? never
      : "" extends F[K]["Encoded"]
        ? K
        : never;
}[keyof F & string];

interface NoActor {
  readonly _tag: "None";
}
interface FieldActor<K extends string> {
  readonly _tag: "Field";
  readonly field: K;
}
interface PrefixedActor<K extends string> {
  readonly _tag: "Prefixed";
  readonly field: K;
  readonly prefix: string;
}

export const Actor = {
  /** No user acted (a directory, the CLI, an anonymous attempt, an org-level change). */
  none: { _tag: "None" } satisfies NoActor,
  /** The user id in `field` acted; an optional field that is absent means no actor. */
  field: <const K extends string>(field: K) => ({ _tag: "Field", field }) satisfies FieldActor<K>,
  /** `field` holds `<prefix><userId>` when a user acted (qadi's `user:<id>` subject); anything else is no actor. */
  prefixed: <const K extends string>(field: K, prefix: string) =>
    ({ _tag: "Prefixed", field, prefix }) satisfies PrefixedActor<K>,
};

interface Declaration<F extends Fields> {
  /** Required: every event decides who acted. */
  readonly actor: NoActor | FieldActor<UserIdKey<F>> | PrefixedActor<StringKey<F>>;
  /** Required, usually `[]`: the fields holding free text about a person (ADR-EA-029). */
  readonly pii: ReadonlyArray<FreeTextKey<F>>;
}

/** Drops the write-time key types so the stamped property names only plain data. */
const erase = <const Tag extends string>(
  tag: Tag,
  declaration: { readonly actor: EventMeta["actor"]; readonly pii: ReadonlyArray<string> },
) => ({ tag, actor: declaration.actor, pii: declaration.pii });

export const defineEvent = <const Tag extends string, const F extends Fields>(
  tag: Tag,
  fields: F,
  declaration: NoInfer<Declaration<F>>,
) =>
  Object.assign(Schema.TaggedStruct(tag, fields), {
    [MetaKey]: erase(tag, declaration),
  });

// ---- generic readers (the only implementation of "who acted" and "what to blank") --------------
const stringAt = (event: object, field: string) => {
  const value: unknown = Reflect.get(event, field);
  return typeof value === "string" ? Option.some(value) : Option.none<string>();
};

/** A present string is the actor, even `""`; only absence is `none`. */
export const actorValue = (meta: EventMeta, event: object) => {
  switch (meta.actor._tag) {
    case "None":
      return Option.none<string>();
    case "Field":
      return stringAt(event, meta.actor.field);
    case "Prefixed": {
      const { prefix } = meta.actor;
      return stringAt(event, meta.actor.field).pipe(
        Option.filter((value) => value.startsWith(prefix)),
        Option.map((value) => value.slice(prefix.length)),
      );
    }
  }
};

export const registry = <const Members extends ReadonlyArray<Schema.Constraint & Defined>>(
  members: Members,
) => {
  const byTag = new Map<string, EventMeta>(members.map((m) => [m[MetaKey].tag, m[MetaKey]]));
  /** True for exactly the tags of `members`, so a checked string narrows to the literal union. */
  const isTag = (tag: string): tag is Members[number][typeof MetaKey]["tag"] => byTag.has(tag);
  return {
    schema: Schema.Union(members),
    isTag,
    tags: members.map((m) => m[MetaKey].tag).filter(isTag),
    actorOf: (event: { readonly _tag: string }) => {
      const meta = byTag.get(event._tag);
      return meta === undefined ? Option.none<string>() : actorValue(meta, event);
    },
    piiFieldsOf: (tag: string): ReadonlyArray<string> => byTag.get(tag)?.pii ?? [],
  };
};
