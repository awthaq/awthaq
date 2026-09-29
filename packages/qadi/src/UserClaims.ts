// @awthaq/qadi — UserClaims (FAMS-004, decision: ship the opt-in store)
//
// Firebase's `setCustomUserClaims(uid, {...})` has no awthaq equivalent for anything that is
// not a role: `Roles` (BAM-006) is the home for `role: admin`-style claims, and this is the home
// for the rest — `plan`, `tenantTier`, feature flags — as one JSON record per user, readable by a
// qadi policy through the `claims` attribute (`hasAttribute("claims", fieldMatch("plan",
// eq(literal("pro"))))`), no redeploy needed.
//
// It is a plugin (id `claims`, table `claims_user`) exactly like `Roles`: no HTTP contract of its
// own, but `Auth.make` aggregates its migration, and `UserClaims.layer` (memory) /
// `UserClaims.layerSql` mirror `Roles.layer` / `Roles.layerSql`. Like `Roles` it is a trusted
// primitive: the gate on *who may change claims* is the caller's.
//
// - `merge` is shallow; a `null` value deletes that key (Firebase's own `null` = "remove").
// - A real change publishes `auth.user.claimsUpdated` (keys only, never values: claims may be
//   sensitive) and announces `Hooks.AfterUserAttributesChanged` for `claims`, so an app-scoped
//   `DecisionCache` wired with `DecisionCacheInvalidation` drops a stale decision at once.
// - Claims are read on every policy evaluation that names them: keep them small. There is no
//   size cap here; an application that needs one validates before calling.
// - JWT: nothing here mints tokens. A `definePayload` callback that wants a claim copies it from
//   `UserClaims.get` when it builds the payload.
//
// Firebase import mapping: `role`-shaped claims -> `Roles.assign`; every other custom claim ->
// `UserClaims.merge`/`set`. See `packages/qadi/README.md`.

import { AuthEvents, AuthPlugin, Defects, Hooks, Migrations, Users } from "@awthaq/core";
import { AttributeResolveError, AttributeResolver } from "@qadi/core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const USER_SUBJECT_PREFIX = "user:";

/** One user's claims: a JSON object. */
export type Claims = typeof Schema.JsonObject.Type;

/** Who is making the change, recorded on `auth.user.claimsUpdated`. */
export interface ClaimsChangeOptions {
  readonly actorId?: Users.UserId | undefined;
}

export interface UserClaimsShape {
  /** A user with no claims reads as `{}`. */
  readonly get: (userId: Users.UserId) => Effect.Effect<Claims>;
  /** Replaces every claim. */
  readonly set: (
    userId: Users.UserId,
    claims: Claims,
    options?: ClaimsChangeOptions,
  ) => Effect.Effect<void>;
  /** Shallow-merges `patch`; a `null` value deletes that key. Returns the resulting claims. */
  readonly merge: (
    userId: Users.UserId,
    patch: Claims,
    options?: ClaimsChangeOptions,
  ) => Effect.Effect<Claims>;
  /** Removes every claim. */
  readonly delete: (userId: Users.UserId, options?: ClaimsChangeOptions) => Effect.Effect<void>;
}

const emptyClaims: Claims = {};

const applyPatch = (current: Claims, patch: Claims): Claims => {
  const next: Record<string, Claims[string]> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
};

/** The keys whose value differs between `before` and `after`, including added and removed ones. */
const changedKeys = (before: Claims, after: Claims): ReadonlyArray<string> =>
  Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();

/** What a backing store must do: atomically rewrite one user's claims, returning both sides. */
interface ClaimsStore {
  readonly read: (userId: Users.UserId) => Effect.Effect<Claims>;
  readonly modify: (
    userId: Users.UserId,
    change: (current: Claims) => Claims,
  ) => Effect.Effect<{ readonly before: Claims; readonly after: Claims }>;
}

/** The shared behavior over either store: events, the hook announcement, and the three writes. */
const serviceOver = (store: ClaimsStore) =>
  Effect.gen(function* () {
    const events = yield* AuthEvents.AuthEvents;
    // Optional by construction, like `Users`: a composition that does not provide the point announces nothing.
    const hook = yield* Effect.serviceOption(Hooks.AfterUserAttributesChanged);

    const apply = (
      userId: Users.UserId,
      change: (current: Claims) => Claims,
      options: ClaimsChangeOptions | undefined,
    ) =>
      Effect.gen(function* () {
        const { before, after } = yield* store.modify(userId, change);
        const keys = changedKeys(before, after);
        if (keys.length > 0) {
          yield* events.publish({
            _tag: "auth.user.claimsUpdated",
            userId,
            keys,
            actorUserId: options?.actorId,
          });
          if (Option.isSome(hook)) {
            yield* hook.value.run({ userId, attributes: ["claims"] });
          }
        }
        return after;
      });

    const shape: UserClaimsShape = {
      get: store.read,
      set: (userId, claims, options) => apply(userId, () => claims, options).pipe(Effect.asVoid),
      merge: (userId, patch, options) =>
        apply(userId, (current) => applyPatch(current, patch), options),
      delete: (userId, options) => apply(userId, () => emptyClaims, options).pipe(Effect.asVoid),
    };
    return shape;
  });

const memoryMake = Effect.gen(function* () {
  const state = yield* Ref.make(HashMap.empty<Users.UserId, Claims>());
  return yield* serviceOver({
    read: (userId) =>
      Ref.get(state).pipe(
        Effect.map((map) => Option.getOrElse(HashMap.get(map, userId), () => emptyClaims)),
      ),
    modify: (userId, change) =>
      Ref.modify(state, (map) => {
        const before = Option.getOrElse(HashMap.get(map, userId), () => emptyClaims);
        const after = change(before);
        const next =
          Object.keys(after).length === 0
            ? HashMap.remove(map, userId)
            : HashMap.set(map, userId, after);
        return [{ before, after }, next] as const;
      }),
  });
});

// ---- layerSql -----------------------------------------------------------------

const decodeClaims = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));

const ClaimsRow = Schema.Struct({ subject: Schema.String, claims: Schema.String });

/**
 * Single-word lowercase columns so the same statements decode on SQLite and Postgres (Postgres
 * folds unquoted identifiers to lowercase). One row per user; a user with no claims has no row.
 */
const userClaimsMigrations: Migrations.Migrations = [
  {
    name: "create_claims_user",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE claims_user (
            subject TEXT PRIMARY KEY,
            claims TEXT NOT NULL,
            updated TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE claims_user (
            subject TEXT PRIMARY KEY,
            claims TEXT NOT NULL,
            updated TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
];

const sqlMake = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findQuery = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ClaimsRow,
    execute: (subject) => sql`SELECT subject, claims FROM claims_user WHERE subject = ${subject}`,
  });

  const read = (userId: Users.UserId): Effect.Effect<Claims> =>
    findQuery(userId).pipe(
      Effect.map((row) => (Option.isSome(row) ? decodeClaims(row.value.claims) : emptyClaims)),
      Effect.orDie,
    );

  const modify: ClaimsStore["modify"] = (userId, change) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const before = yield* read(userId);
          const after = change(before);
          if (Object.keys(after).length === 0) {
            yield* sql`DELETE FROM claims_user WHERE subject = ${userId}`;
          } else {
            const updated = DateTime.formatIso(yield* DateTime.now);
            yield* sql`
              INSERT INTO claims_user (subject, claims, updated)
              VALUES (${userId}, ${JSON.stringify(after)}, ${updated})
              ON CONFLICT (subject) DO UPDATE SET claims = excluded.claims, updated = excluded.updated`;
          }
          return { before, after };
        }),
      )
      .pipe(Effect.orDie);

  return yield* serviceOver({ read, modify });
});

export class UserClaims extends AuthPlugin.Service<UserClaims, UserClaimsShape>()("claims", {
  apiVersion: 1,
  // Like `Roles`: no HTTP contract of its own, so `Auth.make([UserClaims])` alone has zero groups.
  contract: HttpApi.make("auth"),
  tables: ["claims_user"],
  migrations: userClaimsMigrations,
}) {
  static readonly layer = AuthPlugin.layer(UserClaims, { make: memoryMake });

  /** The same service over the `claims_user` table (run `UserClaims.migrations`, or `Auth.make`'s aggregate). */
  static readonly layerSql = AuthPlugin.layer(UserClaims, { make: sqlMake });
}

// ---- the qadi attribute --------------------------------------------------------

/**
 * AAPS-003 style: the one declaration of what `UserClaimsAttributes` answers. A single name,
 * `claims`, resolving to the user's whole JSON record; a policy reads a field of it with qadi's
 * `fieldMatch` (`hasAttribute(claimsAttr("claims"), fieldMatch("plan", eq(literal("pro"))))`).
 */
export const UserClaimsAttributeSchemas = { claims: Schema.JsonObject };

export type UserClaimsAttributeName = keyof typeof UserClaimsAttributeSchemas;

/** The registry's declared list — pass it as `names` next to `UserClaimsAttributes` in `attributeResolverRegistry`. */
export const UserClaimsAttributeNames: ReadonlyArray<string> = Object.keys(
  UserClaimsAttributeSchemas,
);

/** A policy author's typed attribute name: a typo is a compile error, not a silent "no value". */
export const claimsAttr = <const N extends UserClaimsAttributeName>(name: N): N => name;

/**
 * Answers `claims` for a `user:` subject; every other subject or attribute name is `undefined`
 * ("no opinion"). A store outage (a defect) becomes `AttributeResolveError`, so "source down" is
 * told apart from "no claims" (which is a real, empty record).
 */
export const UserClaimsAttributes: Layer.Layer<AttributeResolver, never, UserClaims> = Layer.effect(
  AttributeResolver,
  Effect.gen(function* () {
    const claims = yield* UserClaims;
    return {
      name: "awthaq/UserClaimsAttributes",
      resolve: (subjectId, attribute) => {
        if (attribute !== "claims" || !subjectId.startsWith(USER_SUBJECT_PREFIX)) {
          return Effect.succeed(undefined);
        }
        return claims.get(Users.UserId(subjectId.slice(USER_SUBJECT_PREFIX.length))).pipe(
          Effect.map((record): unknown => record),
          Effect.catchDefect((cause) =>
            Effect.fail(new AttributeResolveError({ attribute, cause })),
          ),
        );
      },
    };
  }),
);
