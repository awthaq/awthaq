// @effect-auth/organization — ActiveContextRecords
//
// spec.md's "Active organization/team state": persistence for
// `organization_active_context`, a plugin-owned table keyed by `sessionId`
// rather than a new column on the shared core `Session` model (`Admin`
// already extended that once this cycle with `actingAs`). `setOrganization`
// and `setTeam` are independent partial upserts — each touches only its own
// column, so setting the active organization never clobbers an
// already-set active team and vice versa (ticket 16 wires `setTeam` for
// real; this ticket only needs the column to exist and round-trip).
//
// Deliberately not cascade-deleted when its underlying session is revoked
// — an orphaned row is harmless (the next read simply finds no matching
// session), the same "declare the gap rather than build unrequested
// session-lifecycle plumbing" precedent `@effect-auth/admin`'s own
// `endedBy: "expired"` gap already sets for this codebase.

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { SqlClient, SqlSchema } from "effect/unstable/sql";

export interface ActiveContextRecord {
  readonly sessionId: string;
  readonly activeOrganizationId: Option.Option<string>;
  readonly activeTeamId: Option.Option<string>;
  readonly updatedAt: DateTime.Utc;
}

export interface ActiveContextRecordsShape {
  readonly setOrganization: (
    sessionId: string,
    organizationId: string | null,
  ) => Effect.Effect<ActiveContextRecord>;
  readonly setTeam: (
    sessionId: string,
    teamId: string | null,
  ) => Effect.Effect<ActiveContextRecord>;
  readonly findBySessionId: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<ActiveContextRecord>>;
}

export class ActiveContextRecords extends Context.Service<
  ActiveContextRecords,
  ActiveContextRecordsShape
>()("effect-auth/organization/ActiveContextRecords") {}

// ---- layerMemory ------------------------------------------------------------

type State = HashMap.HashMap<string, ActiveContextRecord>;

const emptyRecord = (sessionId: string, now: DateTime.Utc): ActiveContextRecord => ({
  sessionId,
  activeOrganizationId: Option.none(),
  activeTeamId: Option.none(),
  updatedAt: now,
});

export const layerMemory = Layer.effect(
  ActiveContextRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>(HashMap.empty());

    const setOrganization: ActiveContextRecordsShape["setOrganization"] = (
      sessionId,
      organizationId,
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const updated = yield* Ref.updateAndGet(state, (s) => {
          const existing = HashMap.get(s, sessionId).pipe(
            Option.getOrElse(() => emptyRecord(sessionId, now)),
          );
          const next: ActiveContextRecord = {
            ...existing,
            activeOrganizationId: Option.fromNullishOr(organizationId),
            updatedAt: now,
          };
          return HashMap.set(s, sessionId, next);
        });
        return HashMap.get(updated, sessionId).pipe(Option.getOrThrow);
      });

    const setTeam: ActiveContextRecordsShape["setTeam"] = (sessionId, teamId) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const updated = yield* Ref.updateAndGet(state, (s) => {
          const existing = HashMap.get(s, sessionId).pipe(
            Option.getOrElse(() => emptyRecord(sessionId, now)),
          );
          const next: ActiveContextRecord = {
            ...existing,
            activeTeamId: Option.fromNullishOr(teamId),
            updatedAt: now,
          };
          return HashMap.set(s, sessionId, next);
        });
        return HashMap.get(updated, sessionId).pipe(Option.getOrThrow);
      });

    const findBySessionId: ActiveContextRecordsShape["findBySessionId"] = (sessionId) =>
      Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, sessionId)));

    return { setOrganization, setTeam, findBySessionId };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const ActiveContextRow = Schema.Struct({
  sessionId: Schema.String,
  activeOrganizationId: Schema.NullOr(Schema.String),
  activeTeamId: Schema.NullOr(Schema.String),
  updatedAt: Schema.DateTimeUtcFromString,
});

const toRecord = (row: typeof ActiveContextRow.Type): ActiveContextRecord => ({
  sessionId: row.sessionId,
  activeOrganizationId: Option.fromNullishOr(row.activeOrganizationId),
  activeTeamId: Option.fromNullishOr(row.activeTeamId),
  updatedAt: row.updatedAt,
});

export const layerSql = Layer.effect(
  ActiveContextRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const findBySessionIdQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ActiveContextRow,
      execute: (sessionId) =>
        sql`SELECT * FROM organization_active_context WHERE sessionId = ${sessionId}`,
    });

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        sessionId: Schema.String,
        activeOrganizationId: Schema.NullOr(Schema.String),
        activeTeamId: Schema.NullOr(Schema.String),
        updatedAt: Schema.DateTimeUtcFromString,
      }),
      Result: ActiveContextRow,
      execute: (r) => sql`
          INSERT INTO organization_active_context (sessionId, activeOrganizationId, activeTeamId, updatedAt)
          VALUES (${r.sessionId}, ${r.activeOrganizationId}, ${r.activeTeamId}, ${r.updatedAt})
          RETURNING *
        `,
    });

    const updateOrganizationQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        sessionId: Schema.String,
        activeOrganizationId: Schema.NullOr(Schema.String),
        updatedAt: Schema.DateTimeUtcFromString,
      }),
      Result: ActiveContextRow,
      execute: (r) => sql`
          UPDATE organization_active_context SET activeOrganizationId = ${r.activeOrganizationId}, updatedAt = ${r.updatedAt}
          WHERE sessionId = ${r.sessionId}
          RETURNING *
        `,
    });

    const updateTeamQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({
        sessionId: Schema.String,
        activeTeamId: Schema.NullOr(Schema.String),
        updatedAt: Schema.DateTimeUtcFromString,
      }),
      Result: ActiveContextRow,
      execute: (r) => sql`
          UPDATE organization_active_context SET activeTeamId = ${r.activeTeamId}, updatedAt = ${r.updatedAt}
          WHERE sessionId = ${r.sessionId}
          RETURNING *
        `,
    });

    const setOrganization: ActiveContextRecordsShape["setOrganization"] = Effect.fnUntraced(
      function* (sessionId, organizationId) {
        const now = yield* DateTime.now;
        const existing = yield* findBySessionIdQuery(sessionId).pipe(Effect.orDie);
        if (Option.isNone(existing)) {
          const row = yield* insert({
            sessionId,
            activeOrganizationId: organizationId,
            activeTeamId: null,
            updatedAt: now,
          }).pipe(Effect.orDie);
          return toRecord(row);
        }
        const row = yield* updateOrganizationQuery({
          sessionId,
          activeOrganizationId: organizationId,
          updatedAt: now,
        }).pipe(Effect.orDie, Effect.map(Option.getOrThrow));
        return toRecord(row);
      },
    );

    const setTeam: ActiveContextRecordsShape["setTeam"] = Effect.fnUntraced(
      function* (sessionId, teamId) {
        const now = yield* DateTime.now;
        const existing = yield* findBySessionIdQuery(sessionId).pipe(Effect.orDie);
        if (Option.isNone(existing)) {
          const row = yield* insert({
            sessionId,
            activeOrganizationId: null,
            activeTeamId: teamId,
            updatedAt: now,
          }).pipe(Effect.orDie);
          return toRecord(row);
        }
        const row = yield* updateTeamQuery({
          sessionId,
          activeTeamId: teamId,
          updatedAt: now,
        }).pipe(Effect.orDie, Effect.map(Option.getOrThrow));
        return toRecord(row);
      },
    );

    const findBySessionId: ActiveContextRecordsShape["findBySessionId"] = (sessionId) =>
      findBySessionIdQuery(sessionId).pipe(Effect.map(Option.map(toRecord)), Effect.orDie);

    return { setOrganization, setTeam, findBySessionId };
  }),
);
