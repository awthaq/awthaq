// @awthaq/organization — ActiveContextRecords
//
// spec.md's "Active organization/team state": persistence for
// `organization_active_context`, a plugin-owned table keyed by `sessionId`
// rather than a new column on the shared core `Session` model (`Admin`
// already extended that once this cycle with `actingAs`). `setOrganization`
// and `setTeam` are independent partial upserts — each touches only its own
// column, so setting the active organization never clobbers an
// already-set active team and vice versa.
//
// **`sessionId` is the key on purpose (DRS-008).** The active organization is
// per-session — better-auth's `session.activeOrganizationId` semantics: two
// devices of one user may be working in two organizations. `userId` is the
// *index*, not the key: it is what lets a row be found for erasure
// (`deleteAllByUser`) and for membership revocation (`clearOrganizationForUser`),
// which the session key alone cannot answer. A row co-locates with the user's
// session, so under any future shard/tenant split (ticket 18) it lives with the
// session shard, never with an organization's. `userId` is nullable only for
// rows written before that column existed; `Organization.getActive` re-validates
// on read, so such a row can never name an organization the user has left.
//
// **The setters take a witness, not an id (MTI-001).** `setOrganization` needs
// a `MembershipRecord` and `setTeam` a `TeamMembershipRecord`: both are branded
// types only their records layers can produce, so pointing a session at an
// organization or team the user does not belong to is unrepresentable rather
// than a check every caller must remember.
//
// **Cleared on revocation (CWM-003), not left as an orphan.** A row whose
// organization/team disappears is nulled by `clearOrganization`/
// `clearOrganizationForUser`/`clearTeam` (called from `Organization`'s delete,
// remove-member, leave and remove-team paths, inside their transactions). A row
// whose *session* is revoked is still not cascade-deleted — that orphan is
// harmless (the next read simply finds no matching session).

import { Users } from "@awthaq/core";
import { Models as SqlModels } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { MembershipRecord } from "./MembershipRecords.ts";
import type { TeamMembershipRecord } from "./TeamRecords.ts";

export interface ActiveContextRecord {
  readonly sessionId: string;
  /** DRS-008: the session's user; `none` only for a row that predates the column. */
  readonly userId: Option.Option<string>;
  readonly activeOrganizationId: Option.Option<string>;
  readonly activeTeamId: Option.Option<string>;
  readonly updatedAt: DateTime.Utc;
}

export interface ActiveContextRecordsShape {
  /** Points the session at the organization `membership` belongs to; the witness proves the user is a member. */
  readonly setOrganization: (
    sessionId: string,
    membership: MembershipRecord,
  ) => Effect.Effect<ActiveContextRecord>;
  /** Unsets the session's active organization; the active team is left alone. */
  readonly unsetOrganization: (
    sessionId: string,
    userId: Users.UserId,
  ) => Effect.Effect<ActiveContextRecord>;
  /** Points the session at the team `membership` belongs to; the witness proves the user is on it. */
  readonly setTeam: (
    sessionId: string,
    membership: TeamMembershipRecord,
  ) => Effect.Effect<ActiveContextRecord>;
  /** Unsets the session's active team; the active organization is left alone. */
  readonly unsetTeam: (
    sessionId: string,
    userId: Users.UserId,
  ) => Effect.Effect<ActiveContextRecord>;
  /** RRC-003 (BEH-EA-162): a decision read — always the primary, never `ReadRouting`-eligible, so a removal is visible on the very next decision. */
  readonly findBySessionId: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<ActiveContextRecord>>;
  /** CWM-003: the organization is gone — null the active organization (and its team) of every session on it. */
  readonly clearOrganization: (organizationId: string) => Effect.Effect<void>;
  /** CWM-003: the user left/was removed from the organization — null it (and its team) for that user's sessions only. */
  readonly clearOrganizationForUser: (
    userId: Users.UserId,
    organizationId: string,
  ) => Effect.Effect<void>;
  /** CWM-003: the team is gone — null the active team of every session on it. */
  readonly clearTeam: (teamId: string) => Effect.Effect<void>;
  /** DRS-008: erasure — deletes every row for a user, across every session. */
  readonly deleteAllByUser: (userId: Users.UserId) => Effect.Effect<void>;
}

export class ActiveContextRecords extends Context.Service<
  ActiveContextRecords,
  ActiveContextRecordsShape
>()("awthaq/organization/ActiveContextRecords") {}

// ---- layerMemory ------------------------------------------------------------

type State = HashMap.HashMap<string, ActiveContextRecord>;

const emptyRecord = (
  sessionId: string,
  userId: string,
  now: DateTime.Utc,
): ActiveContextRecord => ({
  sessionId,
  userId: Option.some(userId),
  activeOrganizationId: Option.none(),
  activeTeamId: Option.none(),
  updatedAt: now,
});

export const layerMemory = Layer.effect(
  ActiveContextRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>(HashMap.empty());

    const upsert = (
      sessionId: string,
      userId: string,
      patch: (existing: ActiveContextRecord, now: DateTime.Utc) => ActiveContextRecord,
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const updated = yield* Ref.updateAndGet(state, (s) => {
          const existing = HashMap.get(s, sessionId).pipe(
            Option.getOrElse(() => emptyRecord(sessionId, userId, now)),
          );
          const next = patch({ ...existing, userId: Option.some(userId) }, now);
          return HashMap.set(s, sessionId, next);
        });
        return HashMap.get(updated, sessionId).pipe(Option.getOrThrow);
      });

    const setOrganization: ActiveContextRecordsShape["setOrganization"] = (sessionId, membership) =>
      upsert(sessionId, membership.userId, (existing, now) => ({
        ...existing,
        activeOrganizationId: Option.some(membership.organizationId),
        updatedAt: now,
      }));

    const unsetOrganization: ActiveContextRecordsShape["unsetOrganization"] = (sessionId, userId) =>
      upsert(sessionId, userId, (existing, now) => ({
        ...existing,
        activeOrganizationId: Option.none(),
        updatedAt: now,
      }));

    const setTeam: ActiveContextRecordsShape["setTeam"] = (sessionId, membership) =>
      upsert(sessionId, membership.userId, (existing, now) => ({
        ...existing,
        activeTeamId: Option.some(membership.teamId),
        updatedAt: now,
      }));

    const unsetTeam: ActiveContextRecordsShape["unsetTeam"] = (sessionId, userId) =>
      upsert(sessionId, userId, (existing, now) => ({
        ...existing,
        activeTeamId: Option.none(),
        updatedAt: now,
      }));

    const findBySessionId: ActiveContextRecordsShape["findBySessionId"] = (sessionId) =>
      Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, sessionId)));

    const mapRows = (f: (row: ActiveContextRecord) => ActiveContextRecord) =>
      Ref.update(state, (s) => HashMap.map(s, f));

    const clearOrganization: ActiveContextRecordsShape["clearOrganization"] = (organizationId) =>
      mapRows((row) =>
        Option.exists(row.activeOrganizationId, (id) => id === organizationId)
          ? { ...row, activeOrganizationId: Option.none(), activeTeamId: Option.none() }
          : row,
      );

    const clearOrganizationForUser: ActiveContextRecordsShape["clearOrganizationForUser"] = (
      userId,
      organizationId,
    ) =>
      mapRows((row) =>
        Option.exists(row.userId, (id) => id === userId) &&
        Option.exists(row.activeOrganizationId, (id) => id === organizationId)
          ? { ...row, activeOrganizationId: Option.none(), activeTeamId: Option.none() }
          : row,
      );

    const clearTeam: ActiveContextRecordsShape["clearTeam"] = (teamId) =>
      mapRows((row) =>
        Option.exists(row.activeTeamId, (id) => id === teamId)
          ? { ...row, activeTeamId: Option.none() }
          : row,
      );

    const deleteAllByUser: ActiveContextRecordsShape["deleteAllByUser"] = (userId) =>
      Ref.update(state, (s) =>
        HashMap.filter(s, (row) => !Option.exists(row.userId, (id) => id === userId)),
      );

    return {
      setOrganization,
      unsetOrganization,
      setTeam,
      unsetTeam,
      findBySessionId,
      clearOrganization,
      clearOrganizationForUser,
      clearTeam,
      deleteAllByUser,
    };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const makeActiveContextRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    sessionId: Schema.String,
    userId: Schema.NullOr(Schema.String),
    activeOrganizationId: Schema.NullOr(Schema.String),
    activeTeamId: Schema.NullOr(Schema.String),
    updatedAt: wire.dateTime,
  });

type ActiveContextRow = ReturnType<typeof makeActiveContextRow>["Type"];

const toRecord = (row: ActiveContextRow): ActiveContextRecord => ({
  sessionId: row.sessionId,
  userId: Option.fromNullishOr(row.userId),
  activeOrganizationId: Option.fromNullishOr(row.activeOrganizationId),
  activeTeamId: Option.fromNullishOr(row.activeTeamId),
  updatedAt: row.updatedAt,
});

export const layerSql = Layer.effect(
  ActiveContextRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const wire = SqlModels.dialectFields(yield* SqlModels.resolveDialect(sql));
    const ActiveContextRow = makeActiveContextRow(wire);

    const findBySessionIdQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ActiveContextRow,
      execute: (sessionId) =>
        sql`SELECT * FROM organization_active_context WHERE "sessionId" = ${sessionId}`,
    });

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        sessionId: Schema.String,
        userId: Schema.String,
        activeOrganizationId: Schema.NullOr(Schema.String),
        activeTeamId: Schema.NullOr(Schema.String),
        updatedAt: wire.dateTime,
      }),
      Result: ActiveContextRow,
      execute: (r) => sql`
          INSERT INTO organization_active_context ("sessionId", "userId", "activeOrganizationId", "activeTeamId", "updatedAt")
          VALUES (${r.sessionId}, ${r.userId}, ${r.activeOrganizationId}, ${r.activeTeamId}, ${r.updatedAt})
          RETURNING *
        `,
    });

    const updateOrganizationQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        sessionId: Schema.String,
        userId: Schema.String,
        activeOrganizationId: Schema.NullOr(Schema.String),
        updatedAt: wire.dateTime,
      }),
      Result: ActiveContextRow,
      execute: (r) => sql`
          UPDATE organization_active_context
          SET "activeOrganizationId" = ${r.activeOrganizationId}, "userId" = ${r.userId}, "updatedAt" = ${r.updatedAt}
          WHERE "sessionId" = ${r.sessionId}
          RETURNING *
        `,
    });

    const updateTeamQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        sessionId: Schema.String,
        userId: Schema.String,
        activeTeamId: Schema.NullOr(Schema.String),
        updatedAt: wire.dateTime,
      }),
      Result: ActiveContextRow,
      execute: (r) => sql`
          UPDATE organization_active_context
          SET "activeTeamId" = ${r.activeTeamId}, "userId" = ${r.userId}, "updatedAt" = ${r.updatedAt}
          WHERE "sessionId" = ${r.sessionId}
          RETURNING *
        `,
    });

    const writeOrganization = Effect.fnUntraced(function* (
      sessionId: string,
      userId: string,
      activeOrganizationId: string | null,
    ) {
      const now = yield* DateTime.now;
      const existing = yield* findBySessionIdQuery(sessionId).pipe(Effect.orDie);
      if (Option.isNone(existing)) {
        const row = yield* insert({
          sessionId,
          userId,
          activeOrganizationId,
          activeTeamId: null,
          updatedAt: now,
        }).pipe(Effect.orDie);
        return toRecord(row);
      }
      const row = yield* updateOrganizationQuery({
        sessionId,
        userId,
        activeOrganizationId,
        updatedAt: now,
      }).pipe(Effect.orDie, Effect.map(Option.getOrThrow));
      return toRecord(row);
    });

    const writeTeam = Effect.fnUntraced(function* (
      sessionId: string,
      userId: string,
      activeTeamId: string | null,
    ) {
      const now = yield* DateTime.now;
      const existing = yield* findBySessionIdQuery(sessionId).pipe(Effect.orDie);
      if (Option.isNone(existing)) {
        const row = yield* insert({
          sessionId,
          userId,
          activeOrganizationId: null,
          activeTeamId,
          updatedAt: now,
        }).pipe(Effect.orDie);
        return toRecord(row);
      }
      const row = yield* updateTeamQuery({ sessionId, userId, activeTeamId, updatedAt: now }).pipe(
        Effect.orDie,
        Effect.map(Option.getOrThrow),
      );
      return toRecord(row);
    });

    const setOrganization: ActiveContextRecordsShape["setOrganization"] = (sessionId, membership) =>
      writeOrganization(sessionId, membership.userId, membership.organizationId);

    const unsetOrganization: ActiveContextRecordsShape["unsetOrganization"] = (sessionId, userId) =>
      writeOrganization(sessionId, userId, null);

    const setTeam: ActiveContextRecordsShape["setTeam"] = (sessionId, membership) =>
      writeTeam(sessionId, membership.userId, membership.teamId);

    const unsetTeam: ActiveContextRecordsShape["unsetTeam"] = (sessionId, userId) =>
      writeTeam(sessionId, userId, null);

    const findBySessionId: ActiveContextRecordsShape["findBySessionId"] = (sessionId) =>
      findBySessionIdQuery(sessionId).pipe(Effect.map(Option.map(toRecord)), Effect.orDie);

    const clearOrganization: ActiveContextRecordsShape["clearOrganization"] = (organizationId) =>
      sql`UPDATE organization_active_context SET "activeOrganizationId" = NULL, "activeTeamId" = NULL WHERE "activeOrganizationId" = ${organizationId}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );

    const clearOrganizationForUser: ActiveContextRecordsShape["clearOrganizationForUser"] = (
      userId,
      organizationId,
    ) =>
      sql`UPDATE organization_active_context SET "activeOrganizationId" = NULL, "activeTeamId" = NULL WHERE "userId" = ${userId} AND "activeOrganizationId" = ${organizationId}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );

    const clearTeam: ActiveContextRecordsShape["clearTeam"] = (teamId) =>
      sql`UPDATE organization_active_context SET "activeTeamId" = NULL WHERE "activeTeamId" = ${teamId}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );

    const deleteAllByUser: ActiveContextRecordsShape["deleteAllByUser"] = (userId) =>
      sql`DELETE FROM organization_active_context WHERE "userId" = ${userId}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );

    return {
      setOrganization,
      unsetOrganization,
      setTeam,
      unsetTeam,
      findBySessionId,
      clearOrganization,
      clearOrganizationForUser,
      clearTeam,
      deleteAllByUser,
    };
  }),
);
