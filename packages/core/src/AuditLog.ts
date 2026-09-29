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
// union instead of one plugin's own row: `payload` is an opaque envelope
// (the `verification_tokens.payload` precedent) rather than a 25-plus-variant
// column explosion, so a new `AuthEvent` tag needs no migration to be
// durably recorded.
//
// `record`'s return type is deliberately `Effect.Effect<void>` — no typed
// error. `layerSql`'s implementation `.orDie`s a SQL failure internally: a
// fail-closed choice (an audit-store outage now takes down whatever
// operation triggered it, not just audit visibility), because a
// "successful" security-relevant operation with no durable row is exactly
// what BEH-EA-100 exists to make impossible.

import { Repositories as SqlRepositories } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { AuthEvent } from "./AuthEvents.ts";
import { UserId } from "./Users.ts";

export interface AuditLogRecord {
  readonly id: string;
  /**
   * `AuthEvent["_tag"]` at write time, but read back as a plain `string` —
   * the SQL column is an unvalidated `TEXT`, so treating a row read back
   * from storage as the closed union without re-validating it would be
   * dishonest. A caller that needs the narrow type can validate it itself.
   */
  readonly eventTag: string;
  readonly actorUserId: Option.Option<UserId>;
  readonly occurredAt: DateTime.Utc;
  /** Reserved for ALF-006 — no `AuthEvent` payload carries one yet. */
  readonly correlationId: Option.Option<string>;
  /** The full original event, opaque — interpret using `eventTag`. */
  readonly payload: unknown;
}

export interface AuditLogListInput {
  readonly eventTag?: AuthEvent["_tag"];
  readonly actorUserId?: UserId;
  readonly occurredAfter?: DateTime.Utc;
  readonly occurredBefore?: DateTime.Utc;
}

export interface AuditLogShape {
  /** Called by `AuthEvents.publish` for every event, before enqueueing. */
  readonly record: (event: AuthEvent) => Effect.Effect<void>;
  /** Newest-first; every filter is optional and combines with AND. */
  readonly list: (input?: AuditLogListInput) => Effect.Effect<ReadonlyArray<AuditLogRecord>>;
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
    case "auth.session.reuse":
    case "auth.session.issued":
    case "auth.session.revoked":
    case "auth.password.changed":
    case "auth.password.resetCompleted":
    case "auth.passkey.counterAnomaly":
    case "auth.organization.memberAdded":
    case "auth.organization.memberRemoved":
    case "auth.organization.memberRoleUpdated":
    case "auth.organization.invitationAccepted":
    case "auth.organization.teamMemberAdded":
    case "auth.organization.teamMemberRemoved":
      return Option.some(event.userId);
    case "auth.admin.impersonationStarted":
    case "auth.admin.impersonationDenied":
    case "auth.admin.actionDenied":
    case "auth.admin.userUpdated":
    case "auth.admin.sessionRevoked":
      return Option.some(event.adminUserId);
    case "auth.organization.created":
      return Option.some(event.creatorUserId);
    case "auth.token.replay":
    case "auth.rateLimit.exceeded":
    case "auth.user.signInFailed":
    case "auth.admin.impersonationStopped":
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
    case "auth.organization.teamDeleted":
      return Option.none();
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

const newestFirst = (records: ReadonlyArray<AuditLogRecord>): ReadonlyArray<AuditLogRecord> =>
  [...records].sort(
    (a, b) => DateTime.toEpochMillis(b.occurredAt) - DateTime.toEpochMillis(a.occurredAt),
  );

const matchesFilter = (record: AuditLogRecord, input?: AuditLogListInput): boolean =>
  (input?.eventTag === undefined || record.eventTag === input.eventTag) &&
  (input?.actorUserId === undefined ||
    (Option.isSome(record.actorUserId) && record.actorUserId.value === input.actorUserId)) &&
  (input?.occurredAfter === undefined ||
    DateTime.toEpochMillis(record.occurredAt) >= DateTime.toEpochMillis(input.occurredAfter)) &&
  (input?.occurredBefore === undefined ||
    DateTime.toEpochMillis(record.occurredAt) <= DateTime.toEpochMillis(input.occurredBefore));

// ---- layerMemory ------------------------------------------------------------

/**
 * Dev/test convenience — explicitly *not* durable (evaporates at process
 * exit, exactly the gap BEH-EA-100 exists to close). Deliberately has no
 * dependencies of its own — `AuthEvents.layer` now needs `AuditLog`
 * everywhere it's composed (every wire-level test in this repo, not just
 * one plugin's own), so a monotonic in-process counter stands in for
 * `Crypto.Crypto`'s `randomUUIDv7` here rather than pulling a real crypto
 * dependency into every one of those compositions for an id nothing
 * outside this process ever needs to be globally unique.
 */
export const layerMemory = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<AuditLogRecord>>([]);
    const nextId = yield* Ref.make(0);

    const record: AuditLogShape["record"] = (event) =>
      Effect.gen(function* () {
        const id = yield* Ref.updateAndGet(nextId, (n) => n + 1);
        const now = yield* DateTime.now;
        const entry: AuditLogRecord = {
          id: `mem-${id}`,
          eventTag: event._tag,
          actorUserId: actorOf(event),
          occurredAt: now,
          correlationId: Option.none(),
          payload: event,
        };
        yield* Ref.update(state, (records) => [...records, entry]);
      });

    const list: AuditLogShape["list"] = (input) =>
      Ref.get(state).pipe(
        Effect.map((records) => newestFirst(records.filter((r) => matchesFilter(r, input)))),
      );

    return { record, list };
  }),
);

// ---- layerSql -----------------------------------------------------------------

const toRecord = (row: SqlRepositories.AuditLogRow): AuditLogRecord => ({
  id: row.id,
  eventTag: row.eventTag,
  actorUserId: Option.fromNullishOr(row.actorUserId).pipe(Option.map(UserId)),
  occurredAt: row.occurredAt,
  correlationId: Option.fromNullishOr(row.correlationId),
  payload: row.payload,
});

export const layerSql = Layer.effect(
  AuditLog,
  Effect.gen(function* () {
    const repo = yield* SqlRepositories.AuditLogRepository;
    const crypto = yield* Crypto.Crypto;

    const record: AuditLogShape["record"] = (event) =>
      Effect.gen(function* () {
        const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
        const now = yield* DateTime.now;
        const actor = actorOf(event);
        yield* repo
          .insert({
            id,
            eventTag: event._tag,
            actorUserId: Option.getOrNull(actor),
            occurredAt: now,
            correlationId: null,
            payload: event,
          })
          .pipe(Effect.orDie);
      });

    const list: AuditLogShape["list"] = (input) =>
      repo
        .list({
          eventTag: input?.eventTag ?? null,
          actorUserId: input?.actorUserId ?? null,
          occurredAfter: input?.occurredAfter ?? null,
          occurredBefore: input?.occurredBefore ?? null,
        })
        .pipe(
          Effect.map((rows) => rows.map(toRecord)),
          Effect.orDie,
        );

    return { record, list };
  }),
);
