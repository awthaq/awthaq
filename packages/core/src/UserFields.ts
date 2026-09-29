// @awthaq/core — UserFields
//
// SAM-004/BE-007 (BEH-EA-040, BEH-EA-048; decision A, ADR-EA-035): the user-field extension
// point. A plugin declares typed scalar fields on `users` in its `AuthPlugin.Service` options
// (`userFields: { plan: UserFields.serverOnly(Schema.Literals(["free", "pro"])) }`); everything
// else follows from that one declaration and needs no core source to change:
//
//   - storage: the linker generates the `ALTER TABLE users ADD COLUMN "<plugin id>_<field>"`
//     migration (`Auth.make`'s `migrations`), so a plugin never writes DDL against a shared
//     table (BEH-EA-040) and can only ever add nullable scalar columns under its own prefix;
//   - types: `Auth.UserFieldsOf<typeof auth>` is the composed, typed field set (keys
//     `<plugin id>_<field>`), and `Users.typedFields(auth.userFields)` reads and writes exactly
//     those with their decoded types;
//   - gating: a field is client-writable by default (BEH-EA-048) — the HTTP profile payload may
//     set it — unless its plugin declares it `clientWritable: false`, in which case only trusted
//     server code (`Users.setFields`, `source: "server"`) can write it. Anything a policy or an
//     authorization decision may rely on must be declared server-only; the base system provides
//     no protection for a field it did not define.
//
// A field's schema is any `Schema` whose *encoded* side is a scalar (a string, number or boolean,
// or a union of literals of one kind): that is what the column holds. The decoded side is free
// (`Schema.Literals`, `Schema.NumberFromString`, a branded string, ...).

import { AccountContract } from "@awthaq/api";
import { Defects } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Migration } from "./Migrations.ts";

/** What a declared field's column holds: the encoded side of its schema. */
export type Scalar = string | number | boolean;

/** The column type a declared field maps to (`text`, `real` = double precision, `boolean`). */
export type ColumnKind = "text" | "real" | "boolean";

/** A field's declaration: a schema whose encoded side is a scalar, optionally annotated `clientWritable`. */
export type Declaration = Schema.Codec<unknown, Scalar>;

/** What `AuthPlugin.Service`'s `userFields` option is: field name to declaration. */
export type Declarations = { readonly [field: string]: Declaration };

const CLIENT_WRITABLE = "awthaq/userField/clientWritable";

/**
 * Declares a user field. `clientWritable` defaults to `true` (BEH-EA-048); pass `false` for a field that
 * carries system authority (a billing tier, an elevation flag). The schema comes back unchanged in type,
 * so `Schema.Struct(userFields)` and the decoded types stay exact.
 */
export const field = <S extends Declaration>(
  schema: S,
  options?: { readonly clientWritable?: boolean },
): S["Rebuild"] => schema.annotate({ [CLIENT_WRITABLE]: options?.clientWritable ?? true });

/**
 * `field(schema, { clientWritable: false })`: writable by trusted server code only. The type carries an
 * optional, never-assigned `"~serverOnly"` marker so `ClientPatch` can leave the field out of what a
 * client may send at compile time (the runtime gate is `Users.setFields`' `source: "client"`).
 */
export const serverOnly = <S extends Declaration>(
  schema: S,
): S["Rebuild"] & { readonly "~serverOnly"?: true } => field(schema, { clientWritable: false });

/** A declaration is client-writable unless it says otherwise (BEH-EA-048). */
export const isClientWritable = (schema: Schema.Top): boolean =>
  Schema.resolveAnnotations(schema)?.[CLIENT_WRITABLE] !== false;

/** The plugin-authoring defect: a declaration that cannot be stored as one nullable scalar column. */
export class InvalidDeclaration extends Data.TaggedError("UserFields/InvalidDeclaration")<{
  readonly key: string;
  readonly message: string;
}> {}

/** Two declarations that would share one column (`a` + `b_c` and `a_b` + `c`), found while composing. */
export class UserFieldConflict extends Data.TaggedError("UserFieldConflict")<{
  readonly key: string;
  readonly first: string;
  readonly second: string;
  readonly message: string;
}> {}

/** One declared field, ready for the linker (DDL), `Users` (validation, gating) and the registry. */
export interface Descriptor {
  /** `<plugin id>_<field>`: how the field is addressed everywhere (`getFields`, the HTTP `fields` bag). */
  readonly key: string;
  /** The `users` column: `key` with dots (a dotted plugin id) replaced, since a dot would split a quoted identifier. */
  readonly column: string;
  readonly kind: ColumnKind;
  readonly clientWritable: boolean;
  readonly schema: Declaration;
}

/** Postgres truncates identifiers at 63 bytes without complaint; refuse instead of colliding silently. */
const MAX_COLUMN_LENGTH = 63;

const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

const kindOf = (ast: SchemaAST.AST): Option.Option<ColumnKind> => {
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return Option.some("text");
    case "Number":
      return Option.some("real");
    case "Boolean":
      return Option.some("boolean");
    case "Literal":
      return typeof ast.literal === "string"
        ? Option.some("text")
        : typeof ast.literal === "number"
          ? Option.some("real")
          : typeof ast.literal === "boolean"
            ? Option.some("boolean")
            : Option.none();
    case "Union": {
      // `null`/`undefined` members only say "nullable", which every column already is.
      const kinds = ast.types
        .filter((member) => member._tag !== "Null" && member._tag !== "Undefined")
        .map(kindOf);
      const [first, ...rest] = kinds;
      if (first === undefined || Option.isNone(first)) return Option.none();
      return rest.every((kind) => Option.isSome(kind) && kind.value === first.value)
        ? first
        : Option.none();
    }
    default:
      return Option.none();
  }
};

/** The `users` column for a key: dots would be read as `table.column` by identifier quoting. */
export const columnOf = (key: string): string => key.replaceAll(".", "_");

/**
 * Validates one declaration and describes it. Throws `InvalidDeclaration` (a plugin-authoring defect,
 * raised where the plugin is defined, like `ConflictingDependsOn`) for a name that is not a plain
 * identifier, a column name Postgres would truncate, or a schema whose encoded side is not one scalar.
 */
export const describe = (key: string, schema: Declaration): Descriptor => {
  const name = key.slice(key.lastIndexOf("_") + 1);
  if (!FIELD_NAME.test(name) || key.lastIndexOf("_") <= 0) {
    throw new InvalidDeclaration({
      key,
      message: `awthaq: user field "${key}" must be named <plugin id>_<field>, with <field> a plain identifier (letters and digits)`,
    });
  }
  const column = columnOf(key);
  if (column.length > MAX_COLUMN_LENGTH) {
    throw new InvalidDeclaration({
      key,
      message: `awthaq: user field "${key}" makes a column name longer than ${MAX_COLUMN_LENGTH} characters`,
    });
  }
  const kind = kindOf(Schema.toEncoded(schema).ast);
  if (Option.isNone(kind)) {
    throw new InvalidDeclaration({
      key,
      message: `awthaq: user field "${key}" must encode to a string, a number or a boolean (or a union of literals of one kind): a shared table only accepts scalar columns`,
    });
  }
  return { key, column, kind: kind.value, clientWritable: isClientWritable(schema), schema };
};

/** A plugin's declarations as descriptors, keyed `<plugin id>_<field>`. Validates each one. */
export const describePlugin = (
  pluginId: string,
  declarations: Declarations,
): ReadonlyArray<Descriptor> =>
  Object.entries(declarations).map(([name, schema]) => describe(`${pluginId}_${name}`, schema));

/** The composed set, refusing two keys that would share a column. */
export const describeAll = (
  fields: Readonly<Record<string, Declaration>>,
): ReadonlyArray<Descriptor> => {
  const seen = new Map<string, string>();
  return Object.entries(fields).map(([key, schema]) => {
    const descriptor = describe(key, schema);
    const first = seen.get(descriptor.column);
    if (first !== undefined) {
      throw new UserFieldConflict({
        key,
        first,
        second: key,
        message: `awthaq: user fields "${first}" and "${key}" would share the column "${descriptor.column}"`,
      });
    }
    seen.set(descriptor.column, key);
    return descriptor;
  });
};

/** The values a user holds, keyed `<plugin id>_<field>`, as the columns store them; unset fields are absent. */
export type Values = Readonly<Record<string, Scalar>>;

/** A write: `null` clears a field. */
export type Patch = Readonly<Record<string, Scalar | null>>;

/** The decoded values a typed accessor reads back: every declared field, optional (unset means absent). */
export type Decoded<F extends Declarations> = { readonly [K in keyof F]?: F[K]["Type"] };

/** What a typed accessor accepts: decoded values, or `null` to clear. */
export type DecodedPatch<F extends Declarations> = {
  readonly [K in keyof F]?: F[K]["Type"] | null;
};

/** The keys of the declarations that were not declared `serverOnly` — the ones a client may write (BEH-EA-048). */
export type ClientWritableKeys<F extends Declarations> = {
  [K in keyof F]: F[K] extends { readonly "~serverOnly"?: infer Marker }
    ? [Marker] extends [true]
      ? never
      : K
    : K;
}[keyof F];

/** What a client may send for `fields`: decoded values (or `null` to clear) of the client-writable fields only. */
export type ClientPatch<F extends Declarations> = {
  readonly [K in ClientWritableKeys<F>]?: F[K]["Type"] | null;
};

/**
 * The client side of the extension point: encodes a typed patch of the client-writable fields into the
 * wire `fields` bag `PATCH /user` takes, and decodes the `fields` of an `AccountDto` (every declared field,
 * server-only ones included: a user may read what they may not write). Give it the composition's
 * `auth.userFields` (the *type* is all a browser bundle needs of the composition; the value can be the
 * same record or a copy of the plugin's declarations).
 *
 * ```ts
 * const profile = UserFields.client(auth.userFields);
 * const fields = yield* profile.encode({ billing_nickname: "Ada" });   // billing_plan does not compile
 * const { billing_plan } = yield* profile.decode(dto.fields);
 * ```
 */
export const client = <const F extends Declarations>(declarations: F) => {
  const partial = Schema.Struct(declarations).mapFields(Struct.map(Schema.optionalKey));
  const decode = Schema.decodeUnknownEffect(partial);
  const encode = Schema.encodeUnknownEffect(partial);
  return {
    encode: (patch: ClientPatch<F>) =>
      Effect.gen(function* () {
        const cleared: Record<string, null> = {};
        const written: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) cleared[key] = null;
          else if (value !== undefined) written[key] = value;
        }
        const encoded = yield* encode(written);
        // The wire `fields` bag: encoded scalars, with `null` for a field being cleared.
        const wire: Patch = { ...encoded, ...cleared };
        return wire;
      }),
    decode: (fields: Readonly<Record<string, Scalar>>) => decode(fields),
  };
};

/**
 * The migration for one declared field: `ALTER TABLE users ADD COLUMN`, nullable and unbackfilled (every
 * user starts with the field unset), the only DDL a plugin ever gets against a shared table (BEH-EA-040).
 * Dialect-neutral through `sql.onDialectOrElse`: `text`/`real`/`boolean` are `TEXT`/`DOUBLE PRECISION`/
 * `BOOLEAN` on Postgres and `TEXT`/`REAL`/`INTEGER` (0/1) on SQLite. `Auth.make` adds one per field to
 * `migrations`, named `add_user_field_<field>` under the owning plugin.
 */
export const migrationFor = (descriptor: Descriptor): Migration => ({
  name: `add_user_field_${descriptor.key.slice(descriptor.key.lastIndexOf("_") + 1)}`,
  up: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const column = sql(descriptor.column);
    yield* sql.onDialectOrElse({
      pg: () =>
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${column} ${sql.literal(PG_TYPES[descriptor.kind])}`,
      sqlite: () =>
        sql`ALTER TABLE users ADD COLUMN ${column} ${sql.literal(SQLITE_TYPES[descriptor.kind])}`,
      orElse: () => Defects.unsupportedDialect("migrations"),
    });
  }),
});

const PG_TYPES: Readonly<Record<ColumnKind, string>> = {
  text: "TEXT",
  real: "DOUBLE PRECISION",
  boolean: "BOOLEAN",
};

const SQLITE_TYPES: Readonly<Record<ColumnKind, string>> = {
  text: "TEXT",
  real: "REAL",
  boolean: "INTEGER",
};

/**
 * The registry `Users` validates and gates against: every declared field by key. Empty by default, so a
 * composition that declares no user field pays nothing; `layer(auth.userFields)` provides the composed one
 * (`TestAuth` does it for you). Asking `Users` for a key the registry does not hold is `UnknownUserField`.
 */
export const UserFieldRegistry = Context.Reference<ReadonlyMap<string, Descriptor>>(
  "awthaq/core/UserFieldRegistry",
  { defaultValue: (): ReadonlyMap<string, Descriptor> => new Map() },
);

/** Provides the registry for a composition's `auth.userFields` (or any key-to-declaration record). */
export const layer = (fields: Readonly<Record<string, Declaration>>) =>
  Layer.succeed(
    UserFieldRegistry,
    new Map(describeAll(fields).map((descriptor) => [descriptor.key, descriptor])),
  );

// The wire errors `@awthaq/api`'s account contract declares are the errors the services fail with (no
// `Data` twin to keep in step, ESS-008), like `Errors.StoreUnavailable`.
export import UnknownUserField = AccountContract.UnknownUserField;
export import UserFieldNotWritable = AccountContract.UserFieldNotWritable;
export import InvalidUserFieldValue = AccountContract.InvalidUserField;

/** Who is writing: trusted server code may write any declared field; a request may write only `clientWritable` ones (BEH-EA-048). */
export type Source = "server" | "client";

/** The declared fields among `keys` (every declared field when omitted), or `UnknownUserField` for a key nobody declared. */
export const resolve = (
  registry: ReadonlyMap<string, Descriptor>,
  keys: ReadonlyArray<string> | undefined,
): Effect.Effect<ReadonlyArray<Descriptor>, UnknownUserField> =>
  Effect.forEach(keys ?? [...registry.keys()], (key) => {
    const descriptor = registry.get(key);
    return descriptor === undefined
      ? Effect.fail(new UnknownUserField({ field: key }))
      : Effect.succeed(descriptor);
  });

/**
 * Validates a write against the registry before anything is stored: every key declared, every key writable
 * by `source`, every non-null value acceptable to its field's own schema. `null` (clear) is always valid.
 * Resolves to the descriptors paired with their values, in patch order.
 */
export const check = (
  registry: ReadonlyMap<string, Descriptor>,
  patch: Patch,
  source: Source,
): Effect.Effect<
  ReadonlyArray<readonly [Descriptor, Scalar | null]>,
  UnknownUserField | UserFieldNotWritable | InvalidUserFieldValue
> =>
  Effect.forEach(Object.entries(patch), ([key, value]) =>
    Effect.gen(function* () {
      const descriptor = registry.get(key);
      if (descriptor === undefined) return yield* Effect.fail(new UnknownUserField({ field: key }));
      if (source === "client" && !descriptor.clientWritable) {
        return yield* Effect.fail(new UserFieldNotWritable({ field: key }));
      }
      if (value !== null) {
        yield* Schema.decodeUnknownEffect(descriptor.schema)(value).pipe(
          Effect.mapError(() => new InvalidUserFieldValue({ field: key })),
        );
      }
      const checked: readonly [Descriptor, Scalar | null] = [descriptor, value];
      return checked;
    }),
  );
