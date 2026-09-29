// @awthaq/webhooks — WebhookRecords
//
// CWM-004: this plugin's own persistence, owned here so no webhook concept leaks into the core
// schema, built the way every plugin's `*Records.ts` is: directly against `SqlSchema`, one
// `layerMemory` and one `layerSql` behind one contract suite. Two tables:
//
// - `webhooks_endpoint` — a registered receiver: its URL, the event-tag filter, the secret (the
//   *sealed* envelope from the `Encryption` port, never plaintext) and, during a rotation's grace
//   window, the previous sealed secret; `disabledAt` when an administrator (or the failure
//   threshold) switched it off.
// - `webhooks_delivery` — the delivery queue *and* the delivery log in one table: one row per
//   (endpoint, event), unique on that pair, so the relay's at-least-once hand-off (a redelivered
//   batch) enqueues each pair once. `status` moves `pending` -> `succeeded` | `dead`; `attempts`,
//   `nextAttemptAt` and the last outcome (an HTTP status or an error *class*, never a response
//   body or an exception message — the receiver's reply is untrusted text) are the log.
//
// A delivery is claimed with a lease: `claimDue` moves `nextAttemptAt` forward, so a second worker
// (another process, a tick that overlaps) finds nothing due. A worker that dies mid-attempt leaves
// the row leased, and it becomes due again when the lease lapses — at-least-once, not exactly-once,
// which is why the receiver deduplicates on `webhook-id`.

import { Models as SqlModels } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export type DeliveryStatus = "pending" | "succeeded" | "dead";
export type DisabledReason = "manual" | "failing";

export interface EndpointRecord {
  readonly id: string;
  readonly url: string;
  readonly description: Option.Option<string>;
  /** Exact tags, `family.*` prefixes, or `*`. */
  readonly eventTags: ReadonlyArray<string>;
  /** The sealed envelope (`Encryption.encrypt`) — never the plaintext secret. */
  readonly secret: string;
  readonly previousSecret: Option.Option<string>;
  readonly previousSecretExpiresAt: Option.Option<DateTime.Utc>;
  readonly disabledAt: Option.Option<DateTime.Utc>;
  readonly disabledReason: Option.Option<DisabledReason>;
  /** Dead-lettered deliveries in a row, reset by a success or by re-enabling. */
  readonly consecutiveDead: number;
  /** The administrator's user id. */
  readonly createdBy: string;
  /**
   * BEH-EA-300: the tenant (organization id) the endpoint belongs to, stamped from the ambient `TenantContext`
   * when it is registered. `None` is the platform's own endpoint. An endpoint hears only its own tenant's events.
   */
  readonly tenantId: Option.Option<string>;
  /** BEH-EA-304: the sealed (`Encryption`) JSON object of custom request headers; `None` when there are none. */
  readonly headers: Option.Option<string>;
  /** The names in `headers` (not secret): what the API shows. */
  readonly headerNames: ReadonlyArray<string>;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}

export interface DeliveryRecord {
  readonly id: string;
  readonly endpointId: string;
  /** The event id: the pair (endpointId, eventId) is unique. */
  readonly eventId: string;
  readonly eventTag: string;
  /** The user the event is about, for erasure and export of the log. */
  readonly subjectUserId: Option.Option<string>;
  /** The exact JSON body that is sent. */
  readonly body: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: DateTime.Utc;
  readonly lastAttemptAt: Option.Option<DateTime.Utc>;
  readonly lastStatusCode: Option.Option<number>;
  /** An error class (`timeout`, `connect`, `blocked`, `status`, ...), never a message. */
  readonly lastError: Option.Option<string>;
  readonly createdAt: DateTime.Utc;
  readonly completedAt: Option.Option<DateTime.Utc>;
}

export class WebhookRecordNotFound extends Data.TaggedError("WebhookRecordNotFound")<{
  readonly id: string;
}> {}

export interface NewDelivery {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventTag: string;
  readonly subjectUserId?: string | undefined;
  readonly body: string;
  readonly nextAttemptAt: DateTime.Utc;
}

export interface Outcome {
  readonly at: DateTime.Utc;
  readonly statusCode?: number | undefined;
  readonly error?: string | undefined;
}

export interface WebhookRecordsShape {
  // ---- endpoints
  readonly createEndpoint: (input: {
    readonly id: string;
    readonly url: string;
    readonly description?: string | undefined;
    readonly eventTags: ReadonlyArray<string>;
    readonly secret: string;
    readonly createdBy: string;
    readonly tenantId?: string | undefined;
    readonly headers?:
      | { readonly sealed: string; readonly names: ReadonlyArray<string> }
      | undefined;
  }) => Effect.Effect<EndpointRecord>;
  readonly findEndpoint: (id: string) => Effect.Effect<Option.Option<EndpointRecord>>;
  /** Oldest first. The set is bounded by `WebhooksConfig.maxEndpoints`. */
  readonly listEndpoints: Effect.Effect<ReadonlyArray<EndpointRecord>>;
  readonly updateEndpoint: (
    id: string,
    patch: {
      readonly url?: string | undefined;
      /** `null` clears it. */
      readonly description?: string | null | undefined;
      readonly eventTags?: ReadonlyArray<string> | undefined;
      /** `null` clears the custom headers; a value replaces them. */
      readonly headers?:
        | { readonly sealed: string; readonly names: ReadonlyArray<string> }
        | null
        | undefined;
    },
  ) => Effect.Effect<EndpointRecord, WebhookRecordNotFound>;
  readonly setSecrets: (
    id: string,
    secrets: {
      readonly secret: string;
      readonly previousSecret: string | null;
      readonly previousSecretExpiresAt: DateTime.Utc | null;
    },
  ) => Effect.Effect<EndpointRecord, WebhookRecordNotFound>;
  /** `null` re-enables (and resets `consecutiveDead`). */
  readonly setDisabled: (
    id: string,
    disabled: { readonly at: DateTime.Utc; readonly reason: DisabledReason } | null,
  ) => Effect.Effect<EndpointRecord, WebhookRecordNotFound>;
  /** Adds one to `consecutiveDead` and returns the new count. */
  readonly bumpDead: (id: string) => Effect.Effect<number>;
  readonly clearDead: (id: string) => Effect.Effect<void>;
  /** Removes the endpoint and every delivery row of it. */
  readonly deleteEndpoint: (id: string) => Effect.Effect<void, WebhookRecordNotFound>;
  // ---- deliveries
  /** Inserts the rows not already present for their (endpointId, eventId); returns how many were new. */
  readonly enqueue: (rows: ReadonlyArray<NewDelivery>) => Effect.Effect<number>;
  /** Pending rows due at `now` whose endpoint is enabled, oldest due first; each is leased until `now + lease`. */
  readonly claimDue: (input: {
    readonly now: DateTime.Utc;
    readonly limit: number;
    readonly lease: Duration.Duration;
  }) => Effect.Effect<ReadonlyArray<DeliveryRecord>>;
  readonly findDelivery: (id: string) => Effect.Effect<Option.Option<DeliveryRecord>>;
  readonly markSucceeded: (id: string, outcome: Outcome) => Effect.Effect<void>;
  /** A failed attempt that will be retried: counts the attempt and schedules the next. */
  readonly reschedule: (
    id: string,
    next: { readonly nextAttemptAt: DateTime.Utc } & Outcome,
  ) => Effect.Effect<void>;
  /** A postponement that is not an attempt (the endpoint's own outbound rate limit): nothing is counted. */
  readonly defer: (id: string, nextAttemptAt: DateTime.Utc) => Effect.Effect<void>;
  readonly markDead: (id: string, outcome: Outcome) => Effect.Effect<void>;
  /** A dead delivery goes back to `pending`, due now, with its attempts reset. */
  readonly redrive: (
    id: string,
    now: DateTime.Utc,
  ) => Effect.Effect<DeliveryRecord, WebhookRecordNotFound>;
  /** Newest first; `before` is an exclusive delivery id (a uuidv7, so time-ordered). */
  readonly listDeliveries: (input: {
    readonly endpointId: string;
    readonly status?: DeliveryStatus | undefined;
    readonly before?: string | undefined;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<DeliveryRecord>>;
  /** Removes finished (`succeeded`/`dead`) rows completed before `cutoff`; returns how many. */
  readonly pruneFinished: (cutoff: DateTime.Utc) => Effect.Effect<number>;
  readonly deleteBySubject: (userId: string) => Effect.Effect<void>;
  readonly listBySubject: (userId: string) => Effect.Effect<ReadonlyArray<DeliveryRecord>>;
}

export class WebhookRecords extends Context.Service<WebhookRecords, WebhookRecordsShape>()(
  "awthaq/webhooks/WebhookRecords",
) {}

const notFound = (id: string): WebhookRecordNotFound => new WebhookRecordNotFound({ id });

const byCreation = <A extends { readonly createdAt: DateTime.Utc; readonly id: string }>(
  rows: ReadonlyArray<A>,
): ReadonlyArray<A> =>
  [...rows].sort(
    (a, b) =>
      DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
      a.id.localeCompare(b.id),
  );

const millis = DateTime.toEpochMillis;

// ---- layerMemory ------------------------------------------------------------------------

interface State {
  readonly endpoints: ReadonlyArray<EndpointRecord>;
  readonly deliveries: ReadonlyArray<DeliveryRecord>;
}

export const layerMemory = Layer.effect(
  WebhookRecords,
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({ endpoints: [], deliveries: [] });

    /** Applies `change` to one endpoint; `NotFound` when there is none. */
    const modifyEndpoint = (
      id: string,
      change: (row: EndpointRecord, now: DateTime.Utc) => EndpointRecord,
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const outcome = yield* Ref.modify(
          state,
          (s): readonly [Result.Result<EndpointRecord, WebhookRecordNotFound>, State] => {
            const existing = s.endpoints.find((row) => row.id === id);
            if (existing === undefined) return [Result.fail(notFound(id)), s] as const;
            const updated = { ...change(existing, now), updatedAt: now };
            return [
              Result.succeed(updated),
              { ...s, endpoints: s.endpoints.map((row) => (row.id === id ? updated : row)) },
            ] as const;
          },
        );
        return yield* Effect.fromResult(outcome);
      });

    const modifyDelivery = (id: string, change: (row: DeliveryRecord) => DeliveryRecord) =>
      Ref.update(state, (s) => ({
        ...s,
        deliveries: s.deliveries.map((row) => (row.id === id ? change(row) : row)),
      }));

    const createEndpoint: WebhookRecordsShape["createEndpoint"] = (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const record: EndpointRecord = {
          id: input.id,
          url: input.url,
          description: Option.fromNullishOr(input.description),
          eventTags: input.eventTags,
          secret: input.secret,
          previousSecret: Option.none(),
          previousSecretExpiresAt: Option.none(),
          disabledAt: Option.none(),
          disabledReason: Option.none(),
          consecutiveDead: 0,
          createdBy: input.createdBy,
          tenantId: Option.fromNullishOr(input.tenantId),
          headers: Option.fromNullishOr(input.headers?.sealed),
          headerNames: input.headers?.names ?? [],
          createdAt: now,
          updatedAt: now,
        };
        yield* Ref.update(state, (s) => ({ ...s, endpoints: [...s.endpoints, record] }));
        return record;
      });

    const enqueue: WebhookRecordsShape["enqueue"] = (rows) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(state, (s) => {
          const added: Array<DeliveryRecord> = [];
          for (const row of rows) {
            const taken =
              s.deliveries.some(
                (existing) =>
                  existing.endpointId === row.endpointId && existing.eventId === row.eventId,
              ) ||
              added.some(
                (existing) =>
                  existing.endpointId === row.endpointId && existing.eventId === row.eventId,
              );
            if (taken) continue;
            added.push({
              id: row.id,
              endpointId: row.endpointId,
              eventId: row.eventId,
              eventTag: row.eventTag,
              subjectUserId: Option.fromNullishOr(row.subjectUserId),
              body: row.body,
              status: "pending",
              attempts: 0,
              nextAttemptAt: row.nextAttemptAt,
              lastAttemptAt: Option.none(),
              lastStatusCode: Option.none(),
              lastError: Option.none(),
              createdAt: now,
              completedAt: Option.none(),
            });
          }
          return [added.length, { ...s, deliveries: [...s.deliveries, ...added] }] as const;
        });
      });

    const claimDue: WebhookRecordsShape["claimDue"] = ({ now, limit, lease }) =>
      Ref.modify(state, (s) => {
        const enabled = new Set(
          s.endpoints.filter((row) => Option.isNone(row.disabledAt)).map((row) => row.id),
        );
        const due = s.deliveries
          .filter(
            (row) =>
              row.status === "pending" &&
              enabled.has(row.endpointId) &&
              millis(row.nextAttemptAt) <= millis(now),
          )
          .sort(
            (a, b) => millis(a.nextAttemptAt) - millis(b.nextAttemptAt) || a.id.localeCompare(b.id),
          )
          .slice(0, limit);
        const leasedUntil = DateTime.addDuration(now, lease);
        const claimed = new Set(due.map((row) => row.id));
        return [
          due,
          {
            ...s,
            deliveries: s.deliveries.map((row) =>
              claimed.has(row.id) ? { ...row, nextAttemptAt: leasedUntil } : row,
            ),
          },
        ] as const;
      });

    return {
      createEndpoint,
      findEndpoint: (id) =>
        Ref.get(state).pipe(
          Effect.map((s) => Option.fromNullishOr(s.endpoints.find((row) => row.id === id))),
        ),
      listEndpoints: Ref.get(state).pipe(Effect.map((s) => byCreation(s.endpoints))),
      updateEndpoint: (id, patch) =>
        modifyEndpoint(id, (row) => ({
          ...row,
          ...(patch.url === undefined ? {} : { url: patch.url }),
          ...(patch.description === undefined
            ? {}
            : { description: Option.fromNullOr(patch.description) }),
          ...(patch.eventTags === undefined ? {} : { eventTags: patch.eventTags }),
          ...(patch.headers === undefined
            ? {}
            : {
                headers: Option.fromNullOr(patch.headers?.sealed ?? null),
                headerNames: patch.headers?.names ?? [],
              }),
        })),
      setSecrets: (id, secrets) =>
        modifyEndpoint(id, (row) => ({
          ...row,
          secret: secrets.secret,
          previousSecret: Option.fromNullOr(secrets.previousSecret),
          previousSecretExpiresAt: Option.fromNullOr(secrets.previousSecretExpiresAt),
        })),
      setDisabled: (id, disabled) =>
        modifyEndpoint(id, (row) => ({
          ...row,
          disabledAt: Option.fromNullOr(disabled?.at ?? null),
          disabledReason: Option.fromNullOr(disabled?.reason ?? null),
          consecutiveDead: disabled === null ? 0 : row.consecutiveDead,
        })),
      bumpDead: (id) =>
        Ref.modify(state, (s) => {
          const existing = s.endpoints.find((row) => row.id === id);
          if (existing === undefined) return [0, s] as const;
          const count = existing.consecutiveDead + 1;
          return [
            count,
            {
              ...s,
              endpoints: s.endpoints.map((row) =>
                row.id === id ? { ...row, consecutiveDead: count } : row,
              ),
            },
          ] as const;
        }),
      clearDead: (id) =>
        Ref.update(state, (s) => ({
          ...s,
          endpoints: s.endpoints.map((row) =>
            row.id === id ? { ...row, consecutiveDead: 0 } : row,
          ),
        })),
      deleteEndpoint: (id) =>
        Effect.gen(function* () {
          const removed = yield* Ref.modify(state, (s) => {
            if (!s.endpoints.some((row) => row.id === id)) return [false, s] as const;
            return [
              true,
              {
                endpoints: s.endpoints.filter((row) => row.id !== id),
                deliveries: s.deliveries.filter((row) => row.endpointId !== id),
              },
            ] as const;
          });
          if (!removed) return yield* Effect.fail(notFound(id));
        }),
      enqueue,
      claimDue,
      findDelivery: (id) =>
        Ref.get(state).pipe(
          Effect.map((s) => Option.fromNullishOr(s.deliveries.find((row) => row.id === id))),
        ),
      markSucceeded: (id, outcome) =>
        modifyDelivery(id, (row) => ({
          ...row,
          status: "succeeded",
          attempts: row.attempts + 1,
          lastAttemptAt: Option.some(outcome.at),
          lastStatusCode: Option.fromNullishOr(outcome.statusCode),
          lastError: Option.none(),
          completedAt: Option.some(outcome.at),
        })),
      reschedule: (id, next) =>
        modifyDelivery(id, (row) => ({
          ...row,
          attempts: row.attempts + 1,
          nextAttemptAt: next.nextAttemptAt,
          lastAttemptAt: Option.some(next.at),
          lastStatusCode: Option.fromNullishOr(next.statusCode),
          lastError: Option.fromNullishOr(next.error),
        })),
      defer: (id, nextAttemptAt) => modifyDelivery(id, (row) => ({ ...row, nextAttemptAt })),
      markDead: (id, outcome) =>
        modifyDelivery(id, (row) => ({
          ...row,
          status: "dead",
          attempts: row.attempts + 1,
          lastAttemptAt: Option.some(outcome.at),
          lastStatusCode: Option.fromNullishOr(outcome.statusCode),
          lastError: Option.fromNullishOr(outcome.error),
          completedAt: Option.some(outcome.at),
        })),
      redrive: (id, now) =>
        Effect.gen(function* () {
          const outcome = yield* Ref.modify(
            state,
            (s): readonly [Result.Result<DeliveryRecord, WebhookRecordNotFound>, State] => {
              const existing = s.deliveries.find((row) => row.id === id && row.status === "dead");
              if (existing === undefined) return [Result.fail(notFound(id)), s] as const;
              const revived: DeliveryRecord = {
                ...existing,
                status: "pending",
                attempts: 0,
                nextAttemptAt: now,
                completedAt: Option.none(),
              };
              return [
                Result.succeed(revived),
                { ...s, deliveries: s.deliveries.map((row) => (row.id === id ? revived : row)) },
              ] as const;
            },
          );
          return yield* Effect.fromResult(outcome);
        }),
      listDeliveries: ({ endpointId, status, before, limit }) =>
        Ref.get(state).pipe(
          Effect.map((s) =>
            s.deliveries
              .filter(
                (row) =>
                  row.endpointId === endpointId &&
                  (status === undefined || row.status === status) &&
                  (before === undefined || row.id < before),
              )
              .sort((a, b) => b.id.localeCompare(a.id))
              .slice(0, limit),
          ),
        ),
      pruneFinished: (cutoff) =>
        Ref.modify(state, (s) => {
          const keep = s.deliveries.filter(
            (row) =>
              row.status === "pending" ||
              Option.isNone(row.completedAt) ||
              millis(row.completedAt.value) >= millis(cutoff),
          );
          return [s.deliveries.length - keep.length, { ...s, deliveries: keep }] as const;
        }),
      deleteBySubject: (userId) =>
        Ref.update(state, (s) => ({
          ...s,
          deliveries: s.deliveries.filter((row) => Option.getOrNull(row.subjectUserId) !== userId),
        })),
      listBySubject: (userId) =>
        Ref.get(state).pipe(
          Effect.map((s) =>
            byCreation(
              s.deliveries.filter((row) => Option.getOrNull(row.subjectUserId) === userId),
            ),
          ),
        ),
    } satisfies WebhookRecordsShape;
  }),
);

// ---- layerSql -----------------------------------------------------------------------------

const makeEndpointRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    url: Schema.String,
    description: Schema.NullOr(Schema.String),
    eventTags: Schema.fromJsonString(Schema.Array(Schema.String)),
    secret: Schema.String,
    previousSecret: Schema.NullOr(Schema.String),
    previousSecretExpiresAt: wire.nullableDateTime,
    disabledAt: wire.nullableDateTime,
    disabledReason: Schema.NullOr(Schema.Literals(["manual", "failing"])),
    consecutiveDead: Schema.Number,
    createdBy: Schema.String,
    tenantId: Schema.NullOr(Schema.String),
    headers: Schema.NullOr(Schema.String),
    headerNames: Schema.fromJsonString(Schema.Array(Schema.String)),
    createdAt: wire.dateTime,
    updatedAt: wire.dateTime,
  });

const makeDeliveryRow = (wire: SqlModels.DialectWire) =>
  Schema.Struct({
    id: Schema.String,
    endpointId: Schema.String,
    eventId: Schema.String,
    eventTag: Schema.String,
    subjectUserId: Schema.NullOr(Schema.String),
    body: Schema.String,
    status: Schema.Literals(["pending", "succeeded", "dead"]),
    attempts: Schema.Number,
    nextAttemptAt: wire.dateTime,
    lastAttemptAt: wire.nullableDateTime,
    lastStatusCode: Schema.NullOr(Schema.Number),
    lastError: Schema.NullOr(Schema.String),
    createdAt: wire.dateTime,
    completedAt: wire.nullableDateTime,
  });

export const layerSql = Layer.effect(
  WebhookRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const dialect = yield* SqlModels.resolveDialect(sql);
    const wire = SqlModels.dialectFields(dialect);
    /** An instant as a raw statement parameter (the schemas above do this for the typed ones). */
    const wireDate = (instant: DateTime.Utc) =>
      dialect === "pg" ? DateTime.toDate(instant) : DateTime.formatIso(instant);
    const EndpointRow = makeEndpointRow(wire);
    const DeliveryRow = makeDeliveryRow(wire);

    const toEndpoint = (row: typeof EndpointRow.Type): EndpointRecord => ({
      id: row.id,
      url: row.url,
      description: Option.fromNullOr(row.description),
      eventTags: row.eventTags,
      secret: row.secret,
      previousSecret: Option.fromNullOr(row.previousSecret),
      previousSecretExpiresAt: Option.fromNullOr(row.previousSecretExpiresAt),
      disabledAt: Option.fromNullOr(row.disabledAt),
      disabledReason: Option.fromNullOr(row.disabledReason),
      consecutiveDead: row.consecutiveDead,
      createdBy: row.createdBy,
      tenantId: Option.fromNullOr(row.tenantId),
      headers: Option.fromNullOr(row.headers),
      headerNames: row.headerNames,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    const toDelivery = (row: typeof DeliveryRow.Type): DeliveryRecord => ({
      id: row.id,
      endpointId: row.endpointId,
      eventId: row.eventId,
      eventTag: row.eventTag,
      subjectUserId: Option.fromNullOr(row.subjectUserId),
      body: row.body,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      lastAttemptAt: Option.fromNullOr(row.lastAttemptAt),
      lastStatusCode: Option.fromNullOr(row.lastStatusCode),
      lastError: Option.fromNullOr(row.lastError),
      createdAt: row.createdAt,
      completedAt: Option.fromNullOr(row.completedAt),
    });

    // ---- endpoints
    const insertEndpoint = SqlSchema.findOne({
      Request: EndpointRow,
      Result: EndpointRow,
      execute: (r) => sql`
        INSERT INTO webhooks_endpoint (id, url, description, "eventTags", secret, "previousSecret",
          "previousSecretExpiresAt", "disabledAt", "disabledReason", "consecutiveDead", "createdBy", "tenantId", headers, "headerNames", "createdAt", "updatedAt")
        VALUES (${r.id}, ${r.url}, ${r.description}, ${r.eventTags}, ${r.secret}, NULL, NULL, NULL, NULL, 0,
          ${r.createdBy}, ${r.tenantId}, ${r.headers}, ${r.headerNames}, ${r.createdAt}, ${r.updatedAt})
        RETURNING *`,
    });
    const endpointById = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: EndpointRow,
      execute: (id) => sql`SELECT * FROM webhooks_endpoint WHERE id = ${id}`,
    });
    const allEndpoints = SqlSchema.findAll({
      Request: Schema.Struct({}),
      Result: EndpointRow,
      execute: () => sql`SELECT * FROM webhooks_endpoint ORDER BY "createdAt", id`,
    });
    // Read-modify-write over the mutable columns: an administrator's edit, not a hot path.
    const writeMutable = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: Schema.String,
        url: Schema.String,
        description: Schema.NullOr(Schema.String),
        eventTags: Schema.fromJsonString(Schema.Array(Schema.String)),
        headers: Schema.NullOr(Schema.String),
        headerNames: Schema.fromJsonString(Schema.Array(Schema.String)),
        updatedAt: wire.dateTime,
      }),
      Result: EndpointRow,
      execute: (r) => sql`
        UPDATE webhooks_endpoint SET url = ${r.url}, description = ${r.description},
          "eventTags" = ${r.eventTags}, headers = ${r.headers}, "headerNames" = ${r.headerNames},
          "updatedAt" = ${r.updatedAt}
        WHERE id = ${r.id}
        RETURNING *`,
    });
    const writeSecrets = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: Schema.String,
        secret: Schema.String,
        previousSecret: Schema.NullOr(Schema.String),
        previousSecretExpiresAt: wire.nullableDateTime,
        updatedAt: wire.dateTime,
      }),
      Result: EndpointRow,
      execute: (r) => sql`
        UPDATE webhooks_endpoint SET secret = ${r.secret}, "previousSecret" = ${r.previousSecret},
          "previousSecretExpiresAt" = ${r.previousSecretExpiresAt}, "updatedAt" = ${r.updatedAt}
        WHERE id = ${r.id}
        RETURNING *`,
    });
    const writeDisabled = SqlSchema.findOneOption({
      Request: Schema.Struct({
        id: Schema.String,
        disabledAt: wire.nullableDateTime,
        disabledReason: Schema.NullOr(Schema.String),
        consecutiveDead: Schema.Number,
        updatedAt: wire.dateTime,
      }),
      Result: EndpointRow,
      execute: (r) => sql`
        UPDATE webhooks_endpoint SET "disabledAt" = ${r.disabledAt}, "disabledReason" = ${r.disabledReason},
          "consecutiveDead" = ${r.consecutiveDead}, "updatedAt" = ${r.updatedAt}
        WHERE id = ${r.id}
        RETURNING *`,
    });
    const bump = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ consecutiveDead: Schema.Number }),
      execute: (id) =>
        sql`UPDATE webhooks_endpoint SET "consecutiveDead" = "consecutiveDead" + 1 WHERE id = ${id} RETURNING "consecutiveDead"`,
    });

    // ---- deliveries
    const deliveryById = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: DeliveryRow,
      execute: (id) => sql`SELECT * FROM webhooks_delivery WHERE id = ${id}`,
    });
    const dueIds = SqlSchema.findAll({
      Request: Schema.Struct({ now: wire.dateTime, limit: Schema.Int }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) => sql`
        SELECT d.id FROM webhooks_delivery d
        WHERE d.status = 'pending' AND d."nextAttemptAt" <= ${r.now}
          AND d."endpointId" IN (SELECT id FROM webhooks_endpoint WHERE "disabledAt" IS NULL)
        ORDER BY d."nextAttemptAt", d.id
        LIMIT ${r.limit}`,
    });
    const leaseOne = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, now: wire.dateTime, leasedUntil: wire.dateTime }),
      Result: DeliveryRow,
      // The row is taken only while it is still due: a competing worker that leased it first has
      // already moved `nextAttemptAt` past `now`, so this matches nothing for the loser.
      execute: (r) => sql`
        UPDATE webhooks_delivery SET "nextAttemptAt" = ${r.leasedUntil}
        WHERE id = ${r.id} AND status = 'pending' AND "nextAttemptAt" <= ${r.now}
        RETURNING *`,
    });
    const listDeliveries = SqlSchema.findAll({
      Request: Schema.Struct({
        endpointId: Schema.String,
        status: Schema.NullOr(Schema.String),
        before: Schema.NullOr(Schema.String),
        limit: Schema.Int,
      }),
      Result: DeliveryRow,
      execute: (r) => sql`
        SELECT * FROM webhooks_delivery
        WHERE "endpointId" = ${r.endpointId}
          ${r.status === null ? sql`` : sql`AND status = ${r.status}`}
          ${r.before === null ? sql`` : sql`AND id < ${r.before}`}
        ORDER BY id DESC
        LIMIT ${r.limit}`,
    });
    const bySubject = SqlSchema.findAll({
      Request: Schema.String,
      Result: DeliveryRow,
      execute: (userId) =>
        sql`SELECT * FROM webhooks_delivery WHERE "subjectUserId" = ${userId} ORDER BY "createdAt", id`,
    });
    const redriveOne = SqlSchema.findOneOption({
      Request: Schema.Struct({ id: Schema.String, now: wire.dateTime }),
      Result: DeliveryRow,
      execute: (r) => sql`
        UPDATE webhooks_delivery SET status = 'pending', attempts = 0, "nextAttemptAt" = ${r.now}, "completedAt" = NULL
        WHERE id = ${r.id} AND status = 'dead'
        RETURNING *`,
    });

    const sealed = <A, E>(effect: Effect.Effect<A, E>) => Effect.orDie(effect);
    const requireRow =
      <A>(id: string) =>
      (row: Option.Option<A>): Effect.Effect<A, WebhookRecordNotFound> =>
        Option.isSome(row) ? Effect.succeed(row.value) : Effect.fail(notFound(id));

    return {
      createEndpoint: (input) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            insertEndpoint({
              id: input.id,
              url: input.url,
              description: input.description ?? null,
              eventTags: input.eventTags,
              secret: input.secret,
              previousSecret: null,
              previousSecretExpiresAt: null,
              disabledAt: null,
              disabledReason: null,
              consecutiveDead: 0,
              createdBy: input.createdBy,
              tenantId: input.tenantId ?? null,
              headers: input.headers?.sealed ?? null,
              headerNames: input.headers?.names ?? [],
              createdAt: now,
              updatedAt: now,
            }),
          ),
          Effect.map(toEndpoint),
          sealed,
        ),
      findEndpoint: (id) => endpointById(id).pipe(Effect.map(Option.map(toEndpoint)), sealed),
      listEndpoints: allEndpoints({}).pipe(
        Effect.map((rows) => rows.map(toEndpoint)),
        sealed,
      ),
      updateEndpoint: (id, patch) =>
        Effect.gen(function* () {
          const current = yield* sealed(endpointById(id)).pipe(Effect.flatMap(requireRow(id)));
          const now = yield* DateTime.now;
          const updated = yield* sealed(
            writeMutable({
              id,
              url: patch.url ?? current.url,
              description:
                patch.description === undefined ? current.description : patch.description,
              eventTags: patch.eventTags ?? current.eventTags,
              headers:
                patch.headers === undefined ? current.headers : (patch.headers?.sealed ?? null),
              headerNames:
                patch.headers === undefined ? current.headerNames : (patch.headers?.names ?? []),
              updatedAt: now,
            }),
          ).pipe(Effect.flatMap(requireRow(id)));
          return toEndpoint(updated);
        }),
      setSecrets: (id, secrets) =>
        DateTime.now.pipe(
          Effect.flatMap((now) => writeSecrets({ id, ...secrets, updatedAt: now })),
          sealed,
          Effect.flatMap(requireRow(id)),
          Effect.map(toEndpoint),
        ),
      setDisabled: (id, disabled) =>
        Effect.gen(function* () {
          const current = yield* sealed(endpointById(id)).pipe(Effect.flatMap(requireRow(id)));
          const now = yield* DateTime.now;
          const updated = yield* sealed(
            writeDisabled({
              id,
              disabledAt: disabled?.at ?? null,
              disabledReason: disabled?.reason ?? null,
              consecutiveDead: disabled === null ? 0 : current.consecutiveDead,
              updatedAt: now,
            }),
          ).pipe(Effect.flatMap(requireRow(id)));
          return toEndpoint(updated);
        }),
      bumpDead: (id) =>
        bump(id).pipe(
          Effect.map((row) => (Option.isSome(row) ? row.value.consecutiveDead : 0)),
          sealed,
        ),
      clearDead: (id) =>
        sealed(sql`UPDATE webhooks_endpoint SET "consecutiveDead" = 0 WHERE id = ${id}`).pipe(
          Effect.asVoid,
        ),
      deleteEndpoint: (id) =>
        Effect.gen(function* () {
          const removed = yield* sealed(
            sql`DELETE FROM webhooks_endpoint WHERE id = ${id} RETURNING id`,
          );
          if (removed.length === 0) return yield* Effect.fail(notFound(id));
          yield* sealed(sql`DELETE FROM webhooks_delivery WHERE "endpointId" = ${id}`);
        }),
      enqueue: (rows) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          let inserted = 0;
          for (const row of rows) {
            const wrote = yield* sealed(sql`
              INSERT INTO webhooks_delivery (id, "endpointId", "eventId", "eventTag", "subjectUserId", body, status,
                attempts, "nextAttemptAt", "createdAt")
              VALUES (${row.id}, ${row.endpointId}, ${row.eventId}, ${row.eventTag}, ${row.subjectUserId ?? null},
                ${row.body}, 'pending', 0, ${wireDate(row.nextAttemptAt)}, ${wireDate(now)})
              ON CONFLICT ("endpointId", "eventId") DO NOTHING
              RETURNING id`);
            inserted += wrote.length;
          }
          return inserted;
        }),
      claimDue: ({ now, limit, lease }) =>
        Effect.gen(function* () {
          const ids = yield* sealed(dueIds({ now, limit }));
          const leasedUntil = DateTime.addDuration(now, lease);
          const claimed: Array<DeliveryRecord> = [];
          for (const { id } of ids) {
            const row = yield* sealed(leaseOne({ id, now, leasedUntil }));
            if (Option.isSome(row)) claimed.push(toDelivery(row.value));
          }
          return claimed;
        }),
      findDelivery: (id) => deliveryById(id).pipe(Effect.map(Option.map(toDelivery)), sealed),
      markSucceeded: (id, outcome) =>
        sealed(sql`
          UPDATE webhooks_delivery SET status = 'succeeded', attempts = attempts + 1,
            "lastAttemptAt" = ${wireDate(outcome.at)}, "lastStatusCode" = ${outcome.statusCode ?? null},
            "lastError" = NULL, "completedAt" = ${wireDate(outcome.at)}
          WHERE id = ${id}`).pipe(Effect.asVoid),
      reschedule: (id, next) =>
        sealed(sql`
          UPDATE webhooks_delivery SET attempts = attempts + 1, "nextAttemptAt" = ${wireDate(next.nextAttemptAt)},
            "lastAttemptAt" = ${wireDate(next.at)}, "lastStatusCode" = ${next.statusCode ?? null},
            "lastError" = ${next.error ?? null}
          WHERE id = ${id}`).pipe(Effect.asVoid),
      defer: (id, nextAttemptAt) =>
        sealed(
          sql`UPDATE webhooks_delivery SET "nextAttemptAt" = ${wireDate(nextAttemptAt)} WHERE id = ${id}`,
        ).pipe(Effect.asVoid),
      markDead: (id, outcome) =>
        sealed(sql`
          UPDATE webhooks_delivery SET status = 'dead', attempts = attempts + 1,
            "lastAttemptAt" = ${wireDate(outcome.at)}, "lastStatusCode" = ${outcome.statusCode ?? null},
            "lastError" = ${outcome.error ?? null}, "completedAt" = ${wireDate(outcome.at)}
          WHERE id = ${id}`).pipe(Effect.asVoid),
      redrive: (id, now) =>
        redriveOne({ id, now }).pipe(
          sealed,
          Effect.flatMap(requireRow(id)),
          Effect.map(toDelivery),
        ),
      listDeliveries: ({ endpointId, status, before, limit }) =>
        listDeliveries({ endpointId, status: status ?? null, before: before ?? null, limit }).pipe(
          Effect.map((rows) => rows.map(toDelivery)),
          sealed,
        ),
      pruneFinished: (cutoff) =>
        sealed(sql`
          DELETE FROM webhooks_delivery
          WHERE status IN ('succeeded', 'dead') AND "completedAt" < ${wireDate(cutoff)}
          RETURNING id`).pipe(Effect.map((rows) => rows.length)),
      deleteBySubject: (userId) =>
        sealed(sql`DELETE FROM webhooks_delivery WHERE "subjectUserId" = ${userId}`).pipe(
          Effect.asVoid,
        ),
      listBySubject: (userId) =>
        bySubject(userId).pipe(
          Effect.map((rows) => rows.map(toDelivery)),
          sealed,
        ),
    } satisfies WebhookRecordsShape;
  }),
);
