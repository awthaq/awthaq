// @awthaq/organization — InvitationRecords
//
// spec.md's "Invitations": persistence for the `organization_invitation`
// table, mirroring `MembershipRecords.ts`'s own shape. `role` is stored as
// an array (same JSON-serialized-`TEXT` convention under `layerSql`);
// `status` is a plain closed string union, never derived at read time — a
// caller (`Organization.ts`) transitions it explicitly via `updateStatus`.

import { Users } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export type InvitationStatus = "pending" | "accepted" | "rejected" | "canceled" | "expired";

export interface InvitationRecord {
  readonly id: string;
  readonly email: string;
  readonly inviterId: Users.UserId;
  readonly organizationId: string;
  readonly teamId: Option.Option<string>;
  readonly role: ReadonlyArray<string>;
  readonly status: InvitationStatus;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export class InvitationRecordNotFound extends Data.TaggedError("InvitationRecordNotFound")<{
  readonly id: string;
}> {}

export interface InvitationRecordsShape {
  readonly create: (input: {
    readonly email: string;
    readonly inviterId: Users.UserId;
    readonly organizationId: string;
    readonly teamId?: string | undefined;
    readonly role: ReadonlyArray<string>;
    readonly expiresAt: DateTime.Utc;
  }) => Effect.Effect<InvitationRecord>;
  readonly findById: (id: string) => Effect.Effect<Option.Option<InvitationRecord>>;
  readonly findPendingByEmailAndOrg: (
    email: string,
    organizationId: string,
  ) => Effect.Effect<Option.Option<InvitationRecord>>;
  readonly listByOrganization: (
    organizationId: string,
  ) => Effect.Effect<ReadonlyArray<InvitationRecord>>;
  readonly listByEmail: (email: string) => Effect.Effect<ReadonlyArray<InvitationRecord>>;
  readonly countPendingByInviter: (inviterId: Users.UserId) => Effect.Effect<number>;
  readonly updateStatus: (
    id: string,
    status: InvitationStatus,
  ) => Effect.Effect<InvitationRecord, InvitationRecordNotFound>;
  /** Deletes every invitation row for an organization — used by `Organization.delete`'s cascade. */
  readonly removeAllForOrganization: (organizationId: string) => Effect.Effect<void>;
}

export class InvitationRecords extends Context.Service<InvitationRecords, InvitationRecordsShape>()(
  "awthaq/organization/InvitationRecords",
) {}

const notFound = (id: string): InvitationRecordNotFound => new InvitationRecordNotFound({ id });

// ---- layerMemory ------------------------------------------------------------

type State = HashMap.HashMap<string, InvitationRecord>;

export const layerMemory = Layer.effect(
  InvitationRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>(HashMap.empty());
    const crypto = yield* Crypto.Crypto;

    const create: InvitationRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const record: InvitationRecord = {
        id,
        email: input.email.toLowerCase(),
        inviterId: input.inviterId,
        organizationId: input.organizationId,
        teamId: Option.fromNullishOr(input.teamId),
        role: input.role,
        status: "pending",
        createdAt: now,
        expiresAt: input.expiresAt,
      };
      yield* Ref.update(state, (s) => HashMap.set(s, id, record));
      return record;
    });

    const findById: InvitationRecordsShape["findById"] = (id) =>
      Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, id)));

    const findPendingByEmailAndOrg: InvitationRecordsShape["findPendingByEmailAndOrg"] = (
      email,
      organizationId,
    ) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Option.fromNullishOr(
            Array.from(HashMap.values(s)).find(
              (row) =>
                row.email === email.toLowerCase() &&
                row.organizationId === organizationId &&
                row.status === "pending",
            ),
          ),
        ),
      );

    const listByOrganization: InvitationRecordsShape["listByOrganization"] = (organizationId) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Array.from(HashMap.values(s)).filter((row) => row.organizationId === organizationId),
        ),
      );

    const listByEmail: InvitationRecordsShape["listByEmail"] = (email) =>
      Ref.get(state).pipe(
        Effect.map((s) =>
          Array.from(HashMap.values(s)).filter((row) => row.email === email.toLowerCase()),
        ),
      );

    const countPendingByInviter: InvitationRecordsShape["countPendingByInviter"] = (inviterId) =>
      Ref.get(state).pipe(
        Effect.map(
          (s) =>
            Array.from(HashMap.values(s)).filter(
              (row) => row.inviterId === inviterId && row.status === "pending",
            ).length,
        ),
      );

    const updateStatus: InvitationRecordsShape["updateStatus"] = (id, status) =>
      Ref.modify(
        state,
        (s): readonly [Result.Result<InvitationRecord, InvitationRecordNotFound>, State] => {
          const existing = HashMap.get(s, id);
          if (Option.isNone(existing)) return [Result.fail(notFound(id)), s] as const;
          const updated: InvitationRecord = { ...existing.value, status };
          return [Result.succeed(updated), HashMap.set(s, id, updated)] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const removeAllForOrganization: InvitationRecordsShape["removeAllForOrganization"] = (
      organizationId,
    ) =>
      Ref.update(state, (s) =>
        Array.from(HashMap.entries(s)).reduce(
          (acc, [key, row]) =>
            row.organizationId === organizationId ? HashMap.remove(acc, key) : acc,
          s,
        ),
      );

    return {
      create,
      findById,
      findPendingByEmailAndOrg,
      listByOrganization,
      listByEmail,
      countPendingByInviter,
      updateStatus,
      removeAllForOrganization,
    };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const InvitationRow = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  inviterId: Schema.String,
  organizationId: Schema.String,
  teamId: Schema.NullOr(Schema.String),
  role: Schema.String,
  status: Schema.Literals(["pending", "accepted", "rejected", "canceled", "expired"]),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});

const parseRoleArray = (json: string): ReadonlyArray<string> => JSON.parse(json);

const toRecord = (row: typeof InvitationRow.Type): InvitationRecord => ({
  id: row.id,
  email: row.email,
  inviterId: Users.UserId(row.inviterId),
  organizationId: row.organizationId,
  teamId: Option.fromNullishOr(row.teamId),
  role: parseRoleArray(row.role),
  status: row.status,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
});

export const layerSql = Layer.effect(
  InvitationRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;

    const insert = SqlSchema.findOne({
      Request: Schema.Struct({
        id: Schema.String,
        email: Schema.String,
        inviterId: Schema.String,
        organizationId: Schema.String,
        teamId: Schema.NullOr(Schema.String),
        role: Schema.String,
        status: Schema.String,
        createdAt: Schema.DateTimeUtcFromString,
        expiresAt: Schema.DateTimeUtcFromString,
      }),
      Result: InvitationRow,
      execute: (r) => sql`
          INSERT INTO organization_invitation (id, email, inviterId, organizationId, teamId, role, status, createdAt, expiresAt)
          VALUES (${r.id}, ${r.email}, ${r.inviterId}, ${r.organizationId}, ${r.teamId}, ${r.role}, ${r.status}, ${r.createdAt}, ${r.expiresAt})
          RETURNING *
        `,
    });

    const findByIdQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: InvitationRow,
      execute: (id) => sql`SELECT * FROM organization_invitation WHERE id = ${id}`,
    });

    const findPendingByEmailAndOrgQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ email: Schema.String, organizationId: Schema.String }),
      Result: InvitationRow,
      execute: (r) =>
        sql`SELECT * FROM organization_invitation WHERE email = ${r.email} AND organizationId = ${r.organizationId} AND status = 'pending'`,
    });

    const listByOrganizationQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: InvitationRow,
      execute: (organizationId) =>
        sql`SELECT * FROM organization_invitation WHERE organizationId = ${organizationId}`,
    });

    const listByEmailQuery = SqlSchema.findAll({
      Request: Schema.String,
      Result: InvitationRow,
      execute: (email) => sql`SELECT * FROM organization_invitation WHERE email = ${email}`,
    });

    // MTI-005: a COUNT(*), never a full-row materialization.
    const countPendingByInviterQuery = SqlSchema.findOne({
      Request: Schema.String,
      Result: Schema.Struct({ count: Schema.Number }),
      execute: (inviterId) =>
        sql`SELECT CAST(COUNT(*) AS INTEGER) AS count FROM organization_invitation WHERE inviterId = ${inviterId} AND status = 'pending'`,
    });

    const updateStatusQuery = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, status: Schema.String }),
      Result: InvitationRow,
      execute: (r) => sql`
          UPDATE organization_invitation SET status = ${r.status}
          WHERE id = ${r.id}
          RETURNING *
        `,
    });

    const create: InvitationRecordsShape["create"] = Effect.fnUntraced(function* (input) {
      const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const row = yield* insert({
        id,
        email: input.email.toLowerCase(),
        inviterId: input.inviterId,
        organizationId: input.organizationId,
        teamId: input.teamId ?? null,
        role: JSON.stringify(input.role),
        status: "pending",
        createdAt: now,
        expiresAt: input.expiresAt,
      }).pipe(Effect.orDie);
      return toRecord(row);
    });

    const findById: InvitationRecordsShape["findById"] = (id) =>
      findByIdQuery(id).pipe(Effect.map(Option.map(toRecord)), Effect.orDie);

    const findPendingByEmailAndOrg: InvitationRecordsShape["findPendingByEmailAndOrg"] = (
      email,
      organizationId,
    ) =>
      findPendingByEmailAndOrgQuery({ email: email.toLowerCase(), organizationId }).pipe(
        Effect.map(Option.map(toRecord)),
        Effect.orDie,
      );

    const listByOrganization: InvitationRecordsShape["listByOrganization"] = (organizationId) =>
      listByOrganizationQuery(organizationId).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      );

    const listByEmail: InvitationRecordsShape["listByEmail"] = (email) =>
      listByEmailQuery(email.toLowerCase()).pipe(
        Effect.map((rows) => rows.map(toRecord)),
        Effect.orDie,
      );

    const countPendingByInviter: InvitationRecordsShape["countPendingByInviter"] = (inviterId) =>
      countPendingByInviterQuery(inviterId).pipe(
        Effect.map((row) => row.count),
        Effect.orDie,
      );

    const updateStatus: InvitationRecordsShape["updateStatus"] = Effect.fnUntraced(
      function* (id, status) {
        const row = yield* updateStatusQuery({ id, status }).pipe(Effect.orDie);
        if (Option.isNone(row)) return yield* Effect.fail(notFound(id));
        return toRecord(row.value);
      },
    );

    const removeAllForOrganization: InvitationRecordsShape["removeAllForOrganization"] = (
      organizationId,
    ) =>
      sql`DELETE FROM organization_invitation WHERE organizationId = ${organizationId}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );

    return {
      create,
      findById,
      findPendingByEmailAndOrg,
      listByOrganization,
      listByEmail,
      countPendingByInviter,
      updateStatus,
      removeAllForOrganization,
    };
  }),
);
