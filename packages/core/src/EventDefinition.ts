// @awthaq/core — EventDefinition (plan 09, ADR-EA-049)
//
// One constructor, `define(tag, fields, { actor, pii, attempt? })`, declares an event's shape, who
// acted and which of its fields hold free text about a person (ADR-EA-029), wherever the event is
// published: core for its own events, a plugin package for the plugin's (ADR-EA-049). The metadata
// is declarative data stamped on the returned schema under `"~awthaq/event"` (the `"~userFields"`
// precedent), so the compiler can refuse a registry member without it and `AuditLog`/`WebhookPayload`
// read it generically. `make` builds a registry over a set of definitions (core's own, or the set
// `Auth.make` composes), and `problems` is the data-level well-formedness check core's tests and
// `runPluginContractTests` both run. A leaf module: it imports only `effect` and `@awthaq/ports`' ids.

import { Ids } from "@awthaq/ports";
import type * as Brand from "effect/Brand";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

/** The property `define` stamps on a schema; a registry accepts nothing without it. */
export const MetaKey = "~awthaq/event";

// ---- the erased (runtime) shape: plain data, so it can be validated with a Schema -------------
const ActorSpecSchema = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Field", { field: Schema.String }),
  Schema.TaggedStruct("Prefixed", { field: Schema.String, prefix: Schema.String }),
]);
export const EventMetaSchema = Schema.Struct({
  tag: Schema.String,
  actor: ActorSpecSchema,
  pii: Schema.Array(Schema.String),
  attempt: Schema.Boolean,
});
export type EventMeta = typeof EventMetaSchema.Type;

/** What a registry member must carry: only `define` produces it. */
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
  /**
   * ADR-EA-037: `true` for an event that records an *attempt* (a failed sign-in, a wrong second
   * factor, a replayed token, a denial): its audit row and its bus copy are released after the
   * enclosing unit of work ends, committed or not, so a rollback cannot erase the forensic
   * record. Omitted (the default) for an event that records a *state change*: its audit row is
   * written inside the transaction and its bus copy is released only if the transaction commits.
   */
  readonly attempt?: true;
}

/** Drops the write-time key types so the stamped property names only plain data. */
const erase = <const Tag extends string>(
  tag: Tag,
  declaration: {
    readonly actor: EventMeta["actor"];
    readonly pii: ReadonlyArray<string>;
    readonly attempt?: true;
  },
) => ({
  tag,
  actor: declaration.actor,
  pii: declaration.pii,
  attempt: declaration.attempt === true,
});

/** Re-exported so a plugin that does not depend on `@awthaq/ports` (roles) brands ids through core alone. */
export const UserId = Ids.UserId;
export const SessionId = Ids.SessionId;

/** Any event as core holds it without knowing its shape: a registered or stored event. */
export interface AnyEvent {
  readonly _tag: string;
}

/**
 * Any event definition: a schema `define` produced, whose value is a tagged event, encodable and
 * decodable with no services. The `never` pins are what let a generic `AuthEvents.emit` encode with
 * no requirement; `Type` is pinned so `TypeOf<D>` is always an event (plan 29 ticket 02).
 */
export type Any = Schema.Top &
  Defined & {
    readonly Type: AnyEvent;
    readonly EncodingServices: never;
    readonly DecodingServices: never;
  };

/** The decoded event a definition describes. */
export type TypeOf<D extends Any> = D["Type"];

/** What `AuthEvents.emit` takes: the event's fields. `_tag` is the constructor's default, so leave it out. */
export type Input<D extends Any> = D["~type.make.in"];

/** ADR-EA-049: the tag core reads an event it does not define as (`AuditLog`'s foreign event); no definition may use it. */
export const ForeignEventTag = "awthaq.foreignEvent";

/** Plan 09's `defineEvent`, renamed (ADR-EA-049): the one constructor of an event, wherever it is defined. */
export const define = <const Tag extends string, const F extends Fields>(
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

/** A set of definitions with plan 09's readers and a validating guard. */
export interface Registry<E extends AnyEvent> {
  /** `"core"` for core's own set; `"composition"` for the set `Auth.make` composed (core's plus every plugin's). */
  readonly origin: "core" | "composition";
  readonly definitions: ReadonlyArray<Any>;
  readonly tags: ReadonlyArray<E["_tag"]>;
  /** True for exactly the registered tags, so a checked string narrows to the tag union. */
  readonly isTag: (tag: string) => tag is E["_tag"];
  readonly definitionOf: (tag: string) => Option.Option<Any>;
  /** Who acted, as the raw id the audit row's actor column records (`none` when no user acted, or the tag is unknown). */
  readonly actorOf: (event: AnyEvent) => Option.Option<string>;
  /** ADR-EA-029: the fields of `tag` that hold free text about a person (none for an unknown tag). */
  readonly piiFieldsOf: (tag: string) => ReadonlyArray<string>;
  /** ADR-EA-037: true for an attempt event (false for an unknown tag). */
  readonly isAttempt: (tag: string) => boolean;
  /** Validates, it does not trust: the tag is registered AND that definition's schema accepts the value. */
  readonly is: (value: AnyEvent) => value is E;
}

/** Plan 09's `registry`, renamed and extended (ADR-EA-049). Core calls it for its own set; `Auth.make` for the composed set. */
export const make = <const Members extends ReadonlyArray<Any>>(
  members: Members,
  origin: "core" | "composition",
) => {
  const byTag = new Map<string, Any>(members.map((m) => [m[MetaKey].tag, m]));
  const isTag = (tag: string): tag is Members[number][typeof MetaKey]["tag"] => byTag.has(tag);
  const is = (value: AnyEvent): value is Members[number]["Type"] => {
    const definition = byTag.get(value._tag);
    return definition !== undefined && Schema.is(definition)(value);
  };
  return {
    origin,
    definitions: members,
    schema: Schema.Union(members),
    tags: members.map((m) => m[MetaKey].tag).filter(isTag),
    isTag,
    is,
    definitionOf: (tag: string) => Option.fromNullishOr(byTag.get(tag)),
    actorOf: (event: AnyEvent) => {
      const definition = byTag.get(event._tag);
      return definition === undefined
        ? Option.none<string>()
        : actorValue(definition[MetaKey], event);
    },
    piiFieldsOf: (tag: string): ReadonlyArray<string> => byTag.get(tag)?.[MetaKey].pii ?? [],
    isAttempt: (tag: string) => byTag.get(tag)?.[MetaKey].attempt === true,
  };
};

// ---- problems: the data-level well-formedness check ------------------------------------------

/**
 * A field name that suggests operator or user free text (plan 09 T3 P6). A name ending in `Id`/`Ids` is an
 * identifier by convention (`noteId`, `messageIds`), never free text.
 */
const looksLikeFreeText = (name: string) =>
  /reason|note|justification|description|comment|message|text/i.test(name) && !/Ids?$/.test(name);

/** A third-party-safe tag: `auth.<namespace>.<event>`, camelCase segments (every shipped tag matches). */
const tagPattern = /^auth\.[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/;

const unbranded = (ast: SchemaAST.AST) => ast.annotations?.["brands"] === undefined;

/** A non-literal, unbranded string (optionally nullable or optional): what P6 treats as free text. */
const isFreeText = (ast: SchemaAST.AST): boolean => {
  if (SchemaAST.isString(ast)) return unbranded(ast);
  if (SchemaAST.isUnion(ast)) {
    return (
      ast.types.every((type) => !SchemaAST.isLiteral(type)) &&
      ast.types.some((type) => SchemaAST.isString(type) && unbranded(type))
    );
  }
  return false;
};

const propertiesOf = (definition: Any): ReadonlyArray<SchemaAST.PropertySignature> =>
  SchemaAST.isObjects(definition.ast) ? definition.ast.propertySignatures : [];

const literalTagOf = (properties: ReadonlyArray<SchemaAST.PropertySignature>) => {
  const tag = properties.find((property) => property.name === "_tag");
  return tag !== undefined && SchemaAST.isLiteral(tag.type)
    ? Option.some(tag.type.literal)
    : Option.none();
};

/** The declaration decoded, not trusted: a hand-built or JavaScript definition may carry anything. */
const declaredMeta = (definition: Any) =>
  Schema.decodeUnknownOption(EventMetaSchema)(definition[MetaKey]);

const problemsOf = (definition: Any, notPersonal: ReadonlySet<string>): ReadonlyArray<string> => {
  const decoded = declaredMeta(definition);
  if (Option.isNone(decoded)) {
    return [
      "an event definition carries no valid declaration: make it with EventDefinition.define",
    ];
  }
  const meta = decoded.value;
  const properties = propertiesOf(definition);
  const keys = properties.map((property) => String(property.name)).filter((key) => key !== "_tag");
  const found: Array<string> = [];
  const literal = literalTagOf(properties);
  if (Option.isNone(literal) || literal.value !== meta.tag) {
    found.push(`${meta.tag}: the declared tag is not the schema's _tag literal (P1)`);
  }
  if (meta.tag === ForeignEventTag) {
    found.push(`${meta.tag}: the tag is reserved for events core does not define (R)`);
  } else if (!tagPattern.test(meta.tag)) {
    found.push(`${meta.tag}: a tag is named auth.<namespace>.<event>, camelCase segments (N)`);
  }
  if (meta.actor._tag !== "None" && !keys.includes(meta.actor.field)) {
    found.push(
      `${meta.tag}: the actor field "${meta.actor.field}" is not a field of the event (P2)`,
    );
  }
  for (const field of meta.pii) {
    if (!keys.includes(field)) {
      found.push(`${meta.tag}: the pii field "${field}" is not a field of the event (P3)`);
    }
  }
  for (const property of properties) {
    const name = String(property.name);
    if (name === "_tag" || !looksLikeFreeText(name) || !isFreeText(property.type)) continue;
    if (meta.pii.includes(name) || notPersonal.has(`${meta.tag}.${name}`)) continue;
    found.push(
      `${meta.tag}.${name}: a free-text field is neither declared pii nor listed as not personal (P6)`,
    );
  }
  return found;
};

/**
 * The data-level well-formedness checks of a set of definitions, as messages (none when well formed):
 * P1 the declared tag is the schema's `_tag` literal, P2 an actor field is a field of the event, P3
 * every `pii` entry is, P6 a free-text-looking string field is in `pii` or in `notPersonal`
 * (`"<tag>.<field>"`), N the tag is `auth.<namespace>.<event>`, R it is not the reserved foreign-event
 * tag, U no tag is listed twice. The type system enforces P2 and P3 at `define`; repeating them as data
 * checks a hand-built or JavaScript-authored definition too. Core's tests run it over core's set;
 * `runPluginContractTests` over every plugin's declared `events`.
 */
export const problems = (
  definitions: ReadonlyArray<Any>,
  options?: { readonly notPersonal?: ReadonlyArray<string> },
): ReadonlyArray<string> => {
  const notPersonal = new Set(options?.notPersonal ?? []);
  const seen = new Set<string>();
  const found: Array<string> = [];
  for (const definition of definitions) {
    found.push(...problemsOf(definition, notPersonal));
    const meta = declaredMeta(definition);
    if (Option.isNone(meta)) continue;
    const { tag } = meta.value;
    if (seen.has(tag)) found.push(`${tag}: the tag is listed twice (U)`);
    seen.add(tag);
  }
  return found;
};
