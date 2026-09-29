// @awthaq/core — AuditLog
//
// BEH-EA-100: "the record of record" — a durable table for security-relevant
// operations that MUST NOT depend on any `AuthEvents` subscriber. Wayfinder
// map (.scratch/resolve-ready-for-human-findings), ticket 01
// (ALF-001/ESA-001/ESS-002/CSG-004/EP-002): `AuthEvents.publish` itself
// writes through this service before ever touching the `PubSub` — see
// `AuthEvents.ts`'s own `publish` for the choke point this closes.
//
// Shaped like `@awthaq/admin`'s `ImpersonationRecords` (`layerMemory`/
// `layerSql` over one `Shapes` contract), but keyed by the closed `AuthEvent`
// union instead of one plugin's own row: `payload` is an opaque JSON envelope
// (the `verification_tokens.payload` precedent) rather than a 45-variant
// column explosion, so a new `AuthEvent` tag needs no migration to be
// durably recorded.
//
// ESA-007: the stored payload is `{ ...event, version, meta }` — the event as
// its `Schema` encodes it, the stored-shape `version`, and the envelope pieces
// that have no column (trace ids, ip, user agent). Reading decodes it through
// the `AuthEvent` union codec, so `AuditLogRecord.payload` is a typed
// `AuthEvent`, never `unknown`; a row that no longer decodes surfaces as the
// typed `AuditLogDecodeError` (one bad row must not be silently skipped by a
// consumer that means to see everything). `id` is the event's own `eventId`
// (ESA-002), so a subscriber's delivered event joins its row by equality.
//
// `record`'s return type is deliberately `Effect.Effect<void>` — no typed
// error. `layerSql`'s implementation `.orDie`s a SQL failure internally: a
// fail-closed choice (an audit-store outage now takes down whatever
// operation triggered it, not just audit visibility), because a
// "successful" security-relevant operation with no durable row is exactly
// what BEH-EA-100 exists to make impossible.
//
// ESA-005: `pseudonymizeActor` is the erasure primitive — the rows outlive a
// deleted user (a forensic timeline is worth keeping), but stop naming them.
//
// **Not built on `AuditChain`**: that primitive is for tamper-evidence of a
// table with no erasure story (`ImpersonationRecords`); this table is
// deliberately rewritable under GDPR Art. 17, which a hash chain would forbid.

import { Repositories as SqlRepositories } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  type AuthEvent,
  type AuthEventTag,
  EVENT_VERSION,
  PII_FIELDS,
  type Published,
  decodeEvent,
  encodeEvent,
  upcastPayload,
} from "./AuthEventSchemas.ts";
import { drainBatches } from "./internal/purgeBatches.ts";
import { UserId } from "./Users.ts";

/** ESA-007: a stored row that no longer decodes as an `AuthEvent` — a schema drift or a hand-edited row. */
export class AuditLogDecodeError extends Data.TaggedError("AuditLogDecodeError")<{
  readonly id: string;
  readonly eventTag: string;
  readonly message: string;
}> {}

export interface AuditLogRecord {
  /** The event's own `eventId` (ESA-002) — a time-ordered id, and `replay`'s cursor. */
  readonly id: string;
  readonly eventTag: AuthEventTag;
  readonly actorUserId: Option.Option<UserId>;
  readonly occurredAt: DateTime.Utc;
  readonly correlationId: Option.Option<string>;
  readonly traceId: Option.Option<string>;
  readonly spanId: Option.Option<string>;
  readonly ip: Option.Option<string>;
  readonly userAgent: Option.Option<string>;
  /** The decoded event (ESA-007). */
  readonly payload: AuthEvent;
}

/** The delivered-event view of a stored row: the same `eventId`/`occurredAt` a live subscriber saw. */
export const toPublished = (record: AuditLogRecord): Published => ({
  ...record.payload,
  eventId: record.id,
  occurredAt: record.occurredAt,
  correlationId: record.correlationId,
  traceId: record.traceId,
  spanId: record.spanId,
  ip: record.ip,
  userAgent: record.userAgent,
});

export interface AuditLogListInput {
  readonly eventTag?: AuthEventTag;
  readonly actorUserId?: UserId;
  readonly occurredAfter?: DateTime.Utc;
  readonly occurredBefore?: DateTime.Utc;
}

export interface AuditLogReplayInput {
  /** Exclusive cursor: an `eventId`/row `id` the consumer has already handled. Omit to start at the beginning. */
  readonly after?: string;
  readonly eventTag?: AuthEventTag;
  /** Rows fetched per round trip; default 500. */
  readonly batchSize?: number;
}

export interface AuditLogShape {
  /** Called by `AuthEvents.publish` for every event, after it is stamped, before it is enqueued. */
  readonly record: (event: Published) => Effect.Effect<void>;
  /** Newest-first (ties broken by id); every filter is optional and combines with AND. */
  readonly list: (
    input?: AuditLogListInput,
  ) => Effect.Effect<ReadonlyArray<AuditLogRecord>, AuditLogDecodeError>;
  /**
   * ESA-003: the recovery path for the at-most-once bus. An ascending,
   * cursor-based read over the whole log — a consumer keeps the last `id` it
   * handled as a checkpoint, `replay({ after })`s to backfill, then tails the
   * live stream (deduplicating on `eventId`). Pages internally; ordering is
   * publish order within one process and millisecond-granular across processes.
   */
  readonly replay: (
    input?: AuditLogReplayInput,
  ) => Stream.Stream<AuditLogRecord, AuditLogDecodeError>;
  /**
   * ESA-005: erasure. Rewrites every row that names `userId` (as actor, or
   * anywhere in its payload): the id becomes a fresh random alias — the same
   * alias across all of that user's rows, so "one actor did these things"
   * survives, and unrelated to the id — and the declared free-text fields
   * (`PII_FIELDS`) are blanked. Row id, tag, timestamp and correlation are kept.
   * Idempotent; resolves to how many rows were rewritten.
   */
  readonly pseudonymizeActor: (userId: UserId) => Effect.Effect<number>;
  /**
   * ALF-010: retention. Deletes every row that occurred before `before` — only rows
   * whose tag is in `eventTags` when given, never rows whose tag is in `exceptTags` —
   * and resolves to how many went. Nothing calls it unless an operator configures a
   * window (`Retention`'s `auditLog`): the default keeps the trail forever.
   */
  readonly purge: (input: {
    readonly before: DateTime.Utc;
    readonly eventTags?: ReadonlyArray<AuthEventTag>;
    readonly exceptTags?: ReadonlyArray<AuthEventTag>;
  }) => Effect.Effect<number>;
}

export class AuditLog extends Context.Service<AuditLog, AuditLogShape>()("awthaq/core/AuditLog") {}

/**
 * Exhaustive by construction: TypeScript forces this to be updated whenever
 * `AuthEvent`'s union grows, so audit-actor coverage can never silently lag
 * the registry the way BEH-EA-101 already worries about for subscribers.
 */
const actorOf = (event: AuthEvent): Option.Option<UserId> => {
  switch (event._tag) {
    case "auth.user.created":
    case "auth.user.signedIn":
    case "auth.user.emailVerified":
    case "auth.user.deleted":
    case "auth.user.dataExported":
    case "auth.session.reuse":
    case "auth.session.issued":
    case "auth.session.rotated":
    case "auth.session.superseded":
    case "auth.session.revoked":
    case "auth.session.expired":
    case "auth.password.changed":
    case "auth.password.resetRequested":
    case "auth.password.resetCompleted":
    case "auth.passkey.counterAnomaly":
    case "auth.organization.memberAdded":
    case "auth.organization.memberRemoved":
    case "auth.organization.memberRoleUpdated":
    case "auth.organization.invitationAccepted":
    case "auth.organization.teamMemberAdded":
    case "auth.organization.teamMemberRoleUpdated":
    case "auth.organization.teamMemberRemoved":
    case "auth.organization.permissionDenied":
    case "auth.apiKey.created":
    case "auth.apiKey.revoked":
    case "auth.apiKey.rotated":
    case "auth.apiKey.clientRegistered":
    case "auth.apiKey.clientRevoked":
    case "auth.apiKey.clientSecretRotated":
      return Option.some(UserId(event.userId));
    case "auth.admin.impersonationStarted":
    case "auth.admin.impersonationStopped":
    case "auth.admin.impersonationDenied":
    case "auth.admin.actionDenied":
    case "auth.admin.userUpdated":
    case "auth.admin.userBanned":
    case "auth.admin.userUnbanned":
    case "auth.admin.sessionRevoked":
    case "auth.admin.organizationSuspended":
    case "auth.admin.organizationUnsuspended":
      return Option.some(UserId(event.adminUserId));
    case "auth.mail.failed":
      return Option.fromNullishOr(event.userId).pipe(Option.map(UserId));
    case "auth.roles.assigned":
    case "auth.roles.revoked":
    case "auth.user.claimsUpdated":
      // The actor is who *changed* the roles, not whose roles changed.
      return Option.fromNullishOr(event.actorUserId).pipe(Option.map(UserId));
    case "auth.authz.denied":
      // qadi's own subject id: only a `user:` subject names an awthaq user.
      return event.subjectId.startsWith("user:")
        ? Option.some(UserId(event.subjectId.slice("user:".length)))
        : Option.none();
    case "auth.organization.created":
      return Option.some(UserId(event.creatorUserId));
    case "auth.token.replay":
    case "auth.rateLimit.exceeded":
    case "auth.user.signInFailed":
    // CWM-002: a directory acts, not a user — the connection id rides in the payload.
    case "auth.scim.userProvisioned":
    case "auth.scim.userDeactivated":
    case "auth.scim.userReactivated":
    case "auth.scim.userDeleted":
    case "auth.scim.groupChanged":
    // ECS-006/ECS-002: a CLI run has no session, so no actor; the seeded target is in the payload.
    case "auth.admin.seeded":
    case "auth.admin.seedRefused":
    case "auth.import.completed":
    case "auth.import.failed":
    case "auth.organization.updated":
    case "auth.organization.deleted":
    case "auth.organization.invitationCreated":
    case "auth.organization.invitationRejected":
    case "auth.organization.invitationCanceled":
    case "auth.organization.roleCreated":
    case "auth.organization.roleUpdated":
    case "auth.organization.roleDeleted":
    case "auth.organization.teamCreated":
    case "auth.organization.teamUpdated":
    case "auth.organization.teamMoved":
    case "auth.organization.teamDeleted":
      return Option.none();
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

// ---- the stored row -----------------------------------------------------------

/** A row as either layer keeps it: envelope columns plus the JSON payload. */
interface StoredRow {
  readonly id: string;
  readonly eventTag: string;
  readonly actorUserId: string | null;
  readonly occurredAt: DateTime.Utc;
  readonly correlationId: string | null;
  readonly payload: unknown;
}

/** The pieces of the stored envelope that have no column of their own. */
const StoredMeta = Schema.Struct({
  version: Schema.optional(Schema.Number),
  meta: Schema.optional(
    Schema.Struct({
      traceId: Schema.optional(Schema.String),
      spanId: Schema.optional(Schema.String),
      ip: Schema.optional(Schema.String),
      userAgent: Schema.optional(Schema.String),
    }),
  ),
});
const decodeStoredMeta = Schema.decodeUnknownEffect(StoredMeta);

/** Event → the row `record` persists. `Schema.encodeEffect` keeps only the event's own fields, so the envelope keys never leak into the payload. */
const toStoredRow = (published: Published): Effect.Effect<StoredRow> =>
  Effect.map(Effect.orDie(encodeEvent(published)), (encoded) => ({
    id: published.eventId,
    eventTag: published._tag,
    actorUserId: Option.getOrNull(actorOf(published)),
    occurredAt: published.occurredAt,
    correlationId: Option.getOrNull(published.correlationId),
    payload: {
      ...encoded,
      version: EVENT_VERSION,
      meta: {
        ...Option.match(published.traceId, {
          onNone: () => ({}),
          onSome: (traceId) => ({ traceId }),
        }),
        ...Option.match(published.spanId, { onNone: () => ({}), onSome: (spanId) => ({ spanId }) }),
        ...Option.match(published.ip, { onNone: () => ({}), onSome: (ip) => ({ ip }) }),
        ...Option.match(published.userAgent, {
          onNone: () => ({}),
          onSome: (userAgent) => ({ userAgent }),
        }),
      },
    },
  }));

const decodeRow = (row: StoredRow): Effect.Effect<AuditLogRecord, AuditLogDecodeError> =>
  Effect.gen(function* () {
    const failed = (error: unknown) =>
      new AuditLogDecodeError({
        id: row.id,
        eventTag: row.eventTag,
        message: `awthaq: audit row ${row.id} ("${row.eventTag}") does not decode as an AuthEvent: ${String(error)}`,
      });
    const stored = yield* decodeStoredMeta(row.payload).pipe(Effect.mapError(failed));
    const payload = yield* decodeEvent(upcastPayload(stored.version ?? 1, row.payload)).pipe(
      Effect.mapError(failed),
    );
    return {
      id: row.id,
      eventTag: payload._tag,
      actorUserId: Option.fromNullishOr(row.actorUserId).pipe(Option.map(UserId)),
      occurredAt: row.occurredAt,
      correlationId: Option.fromNullishOr(row.correlationId),
      traceId: Option.fromNullishOr(stored.meta?.traceId),
      spanId: Option.fromNullishOr(stored.meta?.spanId),
      ip: Option.fromNullishOr(stored.meta?.ip),
      userAgent: Option.fromNullishOr(stored.meta?.userAgent),
      payload,
    };
  });

/** Replaces `from` with `to` inside every string of a JSON value (ids appear both bare and as `prefix:<id>` substrings). */
const replaceDeep = (value: unknown, from: string, to: string): unknown => {
  if (typeof value === "string") return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, from, to));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceDeep(item, from, to)]),
    );
  }
  return value;
};

const blankFields = (value: unknown, fields: ReadonlyArray<string>): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, fields.includes(key) ? "" : item]),
      )
    : value;

/** ESA-005: what erasing `userId` does to one row — the alias substituted everywhere, free-text fields blanked. */
const scrubRow = (row: StoredRow, userId: string, alias: string): StoredRow => ({
  ...row,
  actorUserId: row.actorUserId === null ? null : row.actorUserId.replaceAll(userId, alias),
  payload: blankFields(replaceDeep(row.payload, userId, alias), PII_FIELDS[row.eventTag] ?? []),
});

const newestFirst = (records: ReadonlyArray<AuditLogRecord>): ReadonlyArray<AuditLogRecord> =>
  [...records].sort(
    (a, b) =>
      DateTime.toEpochMillis(b.occurredAt) - DateTime.toEpochMillis(a.occurredAt) ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );

const matchesFilter = (record: AuditLogRecord, input?: AuditLogListInput): boolean =>
  (input?.eventTag === undefined || record.eventTag === input.eventTag) &&
  (input?.actorUserId === undefined ||
    (Option.isSome(record.actorUserId) && record.actorUserId.value === input.actorUserId)) &&
  (input?.occurredAfter === undefined ||
    DateTime.toEpochMillis(record.occurredAt) >= DateTime.toEpochMillis(input.occurredAfter)) &&
  (input?.occurredBefore === undefined ||
    DateTime.toEpochMillis(record.occurredAt) <= DateTime.toEpochMillis(input.occurredBefore));

const DEFAULT_BATCH = 500;

/** A fresh alias, unrelated to the id it replaces — so nothing can be derived back from it. */
const newAlias = Effect.map(
  Effect.all([Random.nextIntBetween(0, 0xffffffff), Random.nextIntBetween(0, 0xffffffff)]),
  ([a, b]) => `erased-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`,
);

// ---- layerMemory ------------------------------------------------------------

/**
 * Dev/test convenience — explicitly *not* durable (evaporates at process
 * exit, exactly the gap BEH-EA-100 exists to close). Deliberately has no
 * dependencies of its own — `AuthEvents.layer` needs `AuditLog` everywhere
 * it's composed (every wire-level test in this repo, not just one plugin's
 * own), so it must not pull a real crypto dependency into every one of those
 * compositions; the row id is the event's own `eventId`.
 */
export const layerMemory = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<StoredRow>>([]);

    const record: AuditLogShape["record"] = (event) =>
      toStoredRow(event).pipe(Effect.flatMap((row) => Ref.update(state, (rows) => [...rows, row])));

    const decodeAll = (rows: ReadonlyArray<StoredRow>) => Effect.forEach(rows, decodeRow);

    const list: AuditLogShape["list"] = (input) =>
      Ref.get(state).pipe(
        Effect.flatMap(decodeAll),
        Effect.map((records) => newestFirst(records.filter((r) => matchesFilter(r, input)))),
      );

    const replay: AuditLogShape["replay"] = (input) =>
      Stream.paginate(input?.after ?? null, (after: string | null) =>
        Ref.get(state).pipe(
          Effect.flatMap((rows) => {
            const batch = [...rows]
              .filter(
                (row) =>
                  (after === null || row.id > after) &&
                  (input?.eventTag === undefined || row.eventTag === input.eventTag),
              )
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              .slice(0, input?.batchSize ?? DEFAULT_BATCH);
            const last = batch.at(-1);
            return decodeAll(batch).pipe(
              Effect.map((records) => [
                records,
                last === undefined ? Option.none<string | null>() : Option.some(last.id),
              ]),
            );
          }),
        ),
      );

    const pseudonymizeActor: AuditLogShape["pseudonymizeActor"] = (userId) =>
      Effect.gen(function* () {
        const alias = yield* newAlias;
        return yield* Ref.modify(state, (rows) => {
          let rewritten = 0;
          const next = rows.map((row) => {
            const scrubbed = scrubRow(row, userId, alias);
            if (JSON.stringify(scrubbed) === JSON.stringify(row)) return row;
            rewritten += 1;
            return scrubbed;
          });
          return [rewritten, next];
        });
      });

    const purge: AuditLogShape["purge"] = (input) =>
      Ref.modify(state, (rows) => {
        const cutoff = DateTime.toEpochMillis(input.before);
        const doomed = (row: StoredRow): boolean =>
          DateTime.toEpochMillis(row.occurredAt) < cutoff &&
          (input.eventTags === undefined || input.eventTags.some((tag) => tag === row.eventTag)) &&
          !(input.exceptTags ?? []).some((tag) => tag === row.eventTag);
        const kept = rows.filter((row) => !doomed(row));
        return [rows.length - kept.length, kept] as const;
      });

    return AuditLog.of({ record, list, replay, pseudonymizeActor, purge });
  }),
);

// ---- layerSql -----------------------------------------------------------------

const toStored = (row: SqlRepositories.AuditLogRow): StoredRow => row;

export const layerSql = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const repo = yield* SqlRepositories.AuditLogRepository;
    // The row id is the event's own `eventId`, minted in `publish` — no `Crypto` needed here.
    const record: AuditLogShape["record"] = (event) =>
      toStoredRow(event).pipe(
        Effect.flatMap((row) => repo.insert(row)),
        Effect.orDie,
      );

    const list: AuditLogShape["list"] = (input) =>
      repo
        .list({
          eventTag: input?.eventTag ?? null,
          actorUserId: input?.actorUserId ?? null,
          occurredAfter: input?.occurredAfter ?? null,
          occurredBefore: input?.occurredBefore ?? null,
        })
        .pipe(
          Effect.orDie,
          Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRow(toStored(row)))),
        );

    const replay: AuditLogShape["replay"] = (input) =>
      Stream.paginate(input?.after ?? null, (after: string | null) =>
        repo
          .page({
            after,
            eventTag: input?.eventTag ?? null,
            limit: input?.batchSize ?? DEFAULT_BATCH,
          })
          .pipe(
            Effect.orDie,
            Effect.flatMap((rows) => {
              const last = rows.at(-1);
              return Effect.forEach(rows, (row) => decodeRow(toStored(row))).pipe(
                Effect.map((records) => [
                  records,
                  last === undefined ? Option.none<string | null>() : Option.some(last.id),
                ]),
              );
            }),
          ),
      );

    const pseudonymizeActor: AuditLogShape["pseudonymizeActor"] = (userId) =>
      Effect.gen(function* () {
        const alias = yield* newAlias;
        const rows = yield* repo.listReferencing(userId).pipe(Effect.orDie);
        let rewritten = 0;
        for (const row of rows) {
          const scrubbed = scrubRow(toStored(row), userId, alias);
          if (JSON.stringify(scrubbed) === JSON.stringify(toStored(row))) continue;
          yield* repo
            .rewrite({ id: row.id, actorUserId: scrubbed.actorUserId, payload: scrubbed.payload })
            .pipe(Effect.orDie);
          rewritten += 1;
        }
        return rewritten;
      });

    const purge: AuditLogShape["purge"] = (input) =>
      drainBatches((limit) =>
        repo
          .deleteOccurredBefore({
            cutoff: input.before,
            eventTags: input.eventTags ?? null,
            exceptTags: input.exceptTags ?? [],
            limit,
          })
          .pipe(Effect.orDie),
      );

    return AuditLog.of({ record, list, replay, pseudonymizeActor, purge });
  }),
);
