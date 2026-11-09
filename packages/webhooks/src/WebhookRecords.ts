// @awthaq/webhooks — WebhookRecords
//
// CWM-004: this plugin's own persistence, owned here so no webhook concept leaks into the core
// schema, built the way every plugin's `*Records.ts` is: directly against `SqlSchema`, one
// `layerMemory` and one `layerSql` behind one contract suite. Two tables:
//
// - `webhooks_endpoint` — a registered receiver: its URL, the event-tag filter, the secret and,
//   during a rotation's grace window, the previous secret, and the custom headers. All three are
//   `SealedColumn`s (plan 05, ADR-EA-019 decision 6): the records accept plaintext `Redacted` values,
//   store an `Encryption` envelope, and hand out `Sealed` values whose `open` is the only place a
//   plaintext appears; `disabledAt` when an administrator (or the failure threshold) switched it off.
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
//
// Tenancy (plan 05, ADR-EA-018 decision 10, BEH-EA-309): `webhooks_endpoint` is Partitioned by
// `"tenantId"` and `webhooks_delivery` is Derived through its endpoint. The store itself stamps
// an endpoint with the ambient tenant and confines the administrative methods to it; the relay
// and the worker, which run with no tenant and serve every tenant's endpoints, present a
// `TenantScoped.CrossTenant` witness, so a method that spans tenants says so in its signature.

import { type Encryption, SqlTransaction } from "@awthaq/ports";
import {
  Models as SqlModels,
  SealedColumn,
  SqlStore,
  StoreFailure,
  TenantScoped,
} from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import type * as WebhookHeaders from "./WebhookHeaders.ts";

const headersSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

/** The three sealed columns of `webhooks_endpoint`. */
export const secretColumn = SealedColumn.column({
  table: "webhooks_endpoint",
  column: "secret",
  key: "id",
});
export const previousSecretColumn = SealedColumn.column({
  table: "webhooks_endpoint",
  column: "previousSecret",
  key: "id",
});
export const headersColumn = SealedColumn.column({
  table: "webhooks_endpoint",
  column: "headers",
  key: "id",
  schema: headersSchema,
});

export type DeliveryStatus = "pending" | "succeeded" | "dead";
export type DisabledReason = "manual" | "failing";

export interface EndpointRecord {
  readonly id: string;
  readonly url: string;
  readonly description: Option.Option<string>;
  /** Exact tags, `family.*` prefixes, or `*`. */
  readonly eventTags: ReadonlyArray<string>;
  /** Sealed: `open` it where the secret is needed (signing). */
  readonly secret: SealedColumn.Sealed<string>;
  readonly previousSecret: Option.Option<SealedColumn.Sealed<string>>;
  readonly previousSecretExpiresAt: Option.Option<DateTime.Utc>;
  readonly disabledAt: Option.Option<DateTime.Utc>;
  readonly disabledReason: Option.Option<DisabledReason>;
  /** Dead-lettered deliveries in a row, reset by a success or by re-enabling. */
  readonly consecutiveDead: number;
  /** The administrator's user id. */
  readonly createdBy: string;
  /**
   * BEH-EA-309: the tenant (organization id) the endpoint belongs to, stamped from the ambient `TenantContext`
   * when it is registered. `None` is the platform's own endpoint. An endpoint hears only its own tenant's events.
   */
  readonly tenantId: Option.Option<string>;
  /** BEH-EA-313: the sealed JSON object of custom request headers; `None` when there are none. */
  readonly headers: Option.Option<SealedColumn.Sealed<WebhookHeaders.CustomHeaders>>;
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

/** `createEndpoint`'s `within`: the tenant already has that many endpoints (`WebhooksConfig.maxEndpoints`). */
export class WebhookRecordLimitReached extends Data.TaggedError("WebhookRecords/LimitReached")<{
  readonly limit: number;
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
  /**
   * Atomic (plan 25, BEH-EA-281): with `within`, refuses with `WebhookRecordLimitReached` when the ambient tenant
   * already has that many endpoints; the count and the insert are one step (SQL: under the tenant's endpoint lock).
   */
  readonly createEndpoint: (
    input: {
      readonly id: string;
      readonly url: string;
      readonly description?: string | undefined;
      readonly eventTags: ReadonlyArray<string>;
      readonly secret: Redacted.Redacted<string>;
      readonly createdBy: string;
      readonly headers?:
        | { readonly value: WebhookHeaders.CustomHeaders; readonly names: ReadonlyArray<string> }
        | undefined;
    },
    options?: { readonly within?: number | undefined },
  ) => Effect.Effect<EndpointRecord, WebhookRecordLimitReached | StoreFailure.StoreUnavailable>;
  /** The ambient tenant's endpoint (`None` for another tenant's, exactly like an unknown id). */
  readonly findEndpoint: (
    id: string,
  ) => Effect.Effect<Option.Option<EndpointRecord>, StoreFailure.StoreUnavailable>;
  /** The ambient tenant's endpoints, oldest first. The set is bounded by `WebhooksConfig.maxEndpoints`. */
  readonly listEndpoints: Effect.Effect<
    ReadonlyArray<EndpointRecord>,
    StoreFailure.StoreUnavailable
  >;
  /** Relay: every tenant's enabled endpoints, oldest first. */
  readonly listEnabledEndpoints: (
    grant: TenantScoped.CrossTenant,
  ) => Effect.Effect<ReadonlyArray<EndpointRecord>, StoreFailure.StoreUnavailable>;
  /** Worker: an endpoint of any tenant, by id, for a delivery being attempted. */
  readonly findEndpointForDelivery: (
    grant: TenantScoped.CrossTenant,
    id: string,
  ) => Effect.Effect<Option.Option<EndpointRecord>, StoreFailure.StoreUnavailable>;
  /** Writes only the patched columns (one statement), so a concurrent write of other columns is kept. */
  readonly updateEndpoint: (
    id: string,
    patch: {
      readonly url?: string | undefined;
      /** `null` clears it. */
      readonly description?: string | null | undefined;
      readonly eventTags?: ReadonlyArray<string> | undefined;
      /** `null` clears the custom headers; a value replaces them. */
      readonly headers?:
        | { readonly value: WebhookHeaders.CustomHeaders; readonly names: ReadonlyArray<string> }
        | null
        | undefined;
    },
  ) => Effect.Effect<EndpointRecord, WebhookRecordNotFound | StoreFailure.StoreUnavailable>;
  readonly setSecrets: (
    id: string,
    secrets: {
      readonly secret: Redacted.Redacted<string>;
      readonly previousSecret: Redacted.Redacted<string> | null;
      readonly previousSecretExpiresAt: DateTime.Utc | null;
    },
  ) => Effect.Effect<EndpointRecord, WebhookRecordNotFound | StoreFailure.StoreUnavailable>;
  /** `null` re-enables (and resets `consecutiveDead`); disabling leaves `consecutiveDead` to the worker. One statement. */
  readonly setDisabled: (
    id: string,
    disabled: { readonly at: DateTime.Utc; readonly reason: DisabledReason } | null,
  ) => Effect.Effect<EndpointRecord, WebhookRecordNotFound | StoreFailure.StoreUnavailable>;
  /** Worker: switches an endpoint of any tenant off after too many dead-lettered deliveries in a row. */
  readonly disableFailing: (
    grant: TenantScoped.CrossTenant,
    id: string,
    at: DateTime.Utc,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  /** Adds one to `consecutiveDead` and returns the new count. */
  readonly bumpDead: (
    grant: TenantScoped.CrossTenant,
    id: string,
  ) => Effect.Effect<number, StoreFailure.StoreUnavailable>;
  readonly clearDead: (
    grant: TenantScoped.CrossTenant,
    id: string,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  /** Removes the endpoint and every delivery row of it, in one transaction. */
  readonly deleteEndpoint: (
    id: string,
  ) => Effect.Effect<void, WebhookRecordNotFound | StoreFailure.StoreUnavailable>;
  // ---- deliveries
  /**
   * Inserts the rows not already present for their (endpointId, eventId) whose endpoint still exists (one deleted
   * since the relay listed it gets none, even racing the delete); returns how many were new.
   */
  readonly enqueue: (
    rows: ReadonlyArray<NewDelivery>,
  ) => Effect.Effect<number, StoreFailure.StoreUnavailable>;
  /**
   * Pending rows due at `now` whose endpoint is enabled, oldest due first; each is leased until `now + lease`
   * and handed out as leased (`nextAttemptAt` is the lease's end).
   */
  readonly claimDue: (
    grant: TenantScoped.CrossTenant,
    input: {
      readonly now: DateTime.Utc;
      readonly limit: number;
      readonly lease: Duration.Duration;
    },
  ) => Effect.Effect<ReadonlyArray<DeliveryRecord>, StoreFailure.StoreUnavailable>;
  /** A delivery of the ambient tenant's endpoint. */
  readonly findDelivery: (
    id: string,
  ) => Effect.Effect<Option.Option<DeliveryRecord>, StoreFailure.StoreUnavailable>;
  readonly markSucceeded: (
    grant: TenantScoped.CrossTenant,
    id: string,
    outcome: Outcome,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  /** A failed attempt that will be retried: counts the attempt and schedules the next. */
  readonly reschedule: (
    grant: TenantScoped.CrossTenant,
    id: string,
    next: { readonly nextAttemptAt: DateTime.Utc } & Outcome,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  /** A postponement that is not an attempt (the endpoint's own outbound rate limit): nothing is counted. */
  readonly defer: (
    grant: TenantScoped.CrossTenant,
    id: string,
    nextAttemptAt: DateTime.Utc,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  readonly markDead: (
    grant: TenantScoped.CrossTenant,
    id: string,
    outcome: Outcome,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  /** A dead delivery goes back to `pending`, due now, with its attempts reset. */
  readonly redrive: (
    id: string,
    now: DateTime.Utc,
  ) => Effect.Effect<DeliveryRecord, WebhookRecordNotFound | StoreFailure.StoreUnavailable>;
  /** Newest first; `before` is an exclusive delivery id (a uuidv7, so time-ordered). */
  readonly listDeliveries: (input: {
    readonly endpointId: string;
    readonly status?: DeliveryStatus | undefined;
    readonly before?: string | undefined;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<DeliveryRecord>, StoreFailure.StoreUnavailable>;
  /** Removes finished (`succeeded`/`dead`) rows completed before `cutoff`; returns how many. */
  readonly pruneFinished: (
    grant: TenantScoped.CrossTenant,
    cutoff: DateTime.Utc,
  ) => Effect.Effect<number, StoreFailure.StoreUnavailable>;
  readonly deleteBySubject: (
    grant: TenantScoped.CrossTenant,
    userId: string,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  readonly listBySubject: (
    grant: TenantScoped.CrossTenant,
    userId: string,
  ) => Effect.Effect<ReadonlyArray<DeliveryRecord>, StoreFailure.StoreUnavailable>;
}

export class WebhookRecords extends Context.Service<WebhookRecords, WebhookRecordsShape>()(
  "awthaq/webhooks/records/WebhookRecords",
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

/**
 * A test seam of `layerMemory`: the stored envelope of one sealed column, and a way to overwrite it. The
 * conformance suite for sealed columns (`TestAuth.runSealedColumnTests`) needs to look at, and plant, what
 * is at rest; over SQL that is a statement, over memory it is this.
 */
export class MemoryEnvelopes extends Context.Service<
  MemoryEnvelopes,
  {
    readonly stored: (
      id: string,
      field: "secret" | "previousSecret" | "headers",
    ) => Effect.Effect<string>;
    readonly plant: (
      id: string,
      field: "secret" | "previousSecret" | "headers",
      stored: string,
    ) => Effect.Effect<void>;
  }
>()("awthaq/webhooks/WebhookRecords/MemoryEnvelopes") {}

/** An endpoint as the memory adapter keeps it: the three sealed columns are envelope strings, like a SQL row. */
interface StoredEndpoint extends Omit<EndpointRecord, "secret" | "previousSecret" | "headers"> {
  readonly secret: string;
  readonly previousSecret: Option.Option<string>;
  readonly headers: Option.Option<string>;
}

interface State {
  readonly endpoints: ReadonlyArray<StoredEndpoint>;
  readonly deliveries: ReadonlyArray<DeliveryRecord>;
}

// The explicit type is the narrow exception the plugins document (TS2883): declaration emit cannot name
// `Encryption` through the inferred requirement of the sealed-column codecs.
export const layerMemory: Layer.Layer<
  WebhookRecords | MemoryEnvelopes,
  never,
  Encryption.Encryption
> = Layer.effectContext(
  Effect.gen(function* () {
    const state = yield* Ref.make<State>({ endpoints: [], deliveries: [] });

    /** Persists a re-seal only while the row still holds the envelope that was read (the substrate's compare-and-swap). */
    const swapOf =
      (field: "secret" | "previousSecret" | "headers"): SealedColumn.Swap =>
      (rowKey, stored, fresh) =>
        Ref.modify(state, (s) => {
          const row = s.endpoints.find((candidate) => candidate.id === rowKey);
          const held =
            row === undefined
              ? undefined
              : field === "secret"
                ? row.secret
                : Option.getOrUndefined(row[field]);
          if (row === undefined || held !== stored) return [false, s] as const;
          const next: StoredEndpoint =
            field === "secret"
              ? { ...row, secret: fresh }
              : field === "previousSecret"
                ? { ...row, previousSecret: Option.some(fresh) }
                : { ...row, headers: Option.some(fresh) };
          return [
            true,
            {
              ...s,
              endpoints: s.endpoints.map((candidate) =>
                candidate.id === rowKey ? next : candidate,
              ),
            },
          ] as const;
        });
    const secretCodec = yield* SealedColumn.codec(secretColumn, swapOf("secret"));
    const previousSecretCodec = yield* SealedColumn.codec(
      previousSecretColumn,
      swapOf("previousSecret"),
    );
    const headersCodec = yield* SealedColumn.codec(headersColumn, swapOf("headers"));
    const toRecord = (row: StoredEndpoint): EndpointRecord => ({
      ...row,
      secret: secretCodec.sealed(row.id, row.secret),
      previousSecret: Option.map(row.previousSecret, (stored) =>
        previousSecretCodec.sealed(row.id, stored),
      ),
      headers: Option.map(row.headers, (stored) => headersCodec.sealed(row.id, stored)),
    });

    const seenTenant = (row: StoredEndpoint, seen: TenantScoped.Visibility) =>
      TenantScoped.matches(Option.getOrNull(row.tenantId), seen);

    /** Whether the ambient tenant sees the endpoint `endpointId` (a delivery is visible through its endpoint). */
    const endpointVisible = (s: State, endpointId: string, seen: TenantScoped.Visibility) => {
      const endpoint = s.endpoints.find((row) => row.id === endpointId);
      return endpoint !== undefined && seenTenant(endpoint, seen);
    };

    /** Applies `change` to one of the ambient tenant's endpoints; `NotFound` when there is none. */
    const modifyEndpoint = (
      id: string,
      change: (row: StoredEndpoint, now: DateTime.Utc) => StoredEndpoint,
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const seen = yield* TenantScoped.visibility();
        const outcome = yield* Ref.modify(
          state,
          (s): readonly [Result.Result<StoredEndpoint, WebhookRecordNotFound>, State] => {
            const existing = s.endpoints.find((row) => row.id === id && seenTenant(row, seen));
            if (existing === undefined) return [Result.fail(notFound(id)), s] as const;
            const updated = { ...change(existing, now), updatedAt: now };
            return [
              Result.succeed(updated),
              { ...s, endpoints: s.endpoints.map((row) => (row.id === id ? updated : row)) },
            ] as const;
          },
        );
        return toRecord(yield* Effect.fromResult(outcome));
      });

    /** A relay/worker write to one delivery of any tenant: the witness is the signature's proof. */
    const witnessed = (
      grant: TenantScoped.CrossTenant,
      id: string,
      change: (row: DeliveryRecord) => DeliveryRecord,
    ) =>
      Effect.andThen(
        TenantScoped.visibility(grant),
        Ref.update(state, (s) => ({
          ...s,
          deliveries: s.deliveries.map((row) => (row.id === id ? change(row) : row)),
        })),
      );

    const createEndpoint: WebhookRecordsShape["createEndpoint"] = (input, options) =>
      Effect.gen(function* () {
        const within = options?.within;
        const now = yield* DateTime.now;
        const { tenantId } = yield* TenantScoped.stamp({ tenantId: null });
        const sameTenant = TenantScoped.Visibility.Tenant({ tenant: Option.fromNullOr(tenantId) });
        const record: StoredEndpoint = {
          id: input.id,
          url: input.url,
          description: Option.fromNullishOr(input.description),
          eventTags: input.eventTags,
          secret: yield* secretCodec.seal(input.id, input.secret),
          previousSecret: Option.none(),
          previousSecretExpiresAt: Option.none(),
          disabledAt: Option.none(),
          disabledReason: Option.none(),
          consecutiveDead: 0,
          createdBy: input.createdBy,
          tenantId: Option.fromNullishOr(tenantId),
          headers:
            input.headers === undefined
              ? Option.none()
              : Option.some(yield* headersCodec.seal(input.id, Redacted.make(input.headers.value))),
          headerNames: input.headers?.names ?? [],
          createdAt: now,
          updatedAt: now,
        };
        // Plan 25: the tenant's endpoint count and the insert in one step.
        const outcome = yield* Ref.modify(
          state,
          (s): [Result.Result<StoredEndpoint, WebhookRecordLimitReached>, State] => {
            if (
              within !== undefined &&
              s.endpoints.filter((row) => seenTenant(row, sameTenant)).length >= within
            ) {
              return [Result.fail(new WebhookRecordLimitReached({ limit: within })), s];
            }
            return [Result.succeed(record), { ...s, endpoints: [...s.endpoints, record] }];
          },
        );
        return toRecord(yield* Effect.fromResult(outcome));
      });

    const enqueue: WebhookRecordsShape["enqueue"] = (rows) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(state, (s) => {
          const added: Array<DeliveryRecord> = [];
          for (const row of rows) {
            // An endpoint deleted since the relay listed it gets no delivery (the delete removed its log).
            if (!s.endpoints.some((endpoint) => endpoint.id === row.endpointId)) continue;
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

    const claimDue: WebhookRecordsShape["claimDue"] = (grant, { now, limit, lease }) =>
      Effect.andThen(
        TenantScoped.visibility(grant),
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
              (a, b) =>
                millis(a.nextAttemptAt) - millis(b.nextAttemptAt) || a.id.localeCompare(b.id),
            )
            .slice(0, limit);
          const leasedUntil = DateTime.addDuration(now, lease);
          // Plan 24 W-1: the rows are handed out as leased, like SQL's `RETURNING *`.
          const leased = due.map((row): DeliveryRecord => ({ ...row, nextAttemptAt: leasedUntil }));
          const claimed = new Map(leased.map((row) => [row.id, row]));
          return [
            leased,
            {
              ...s,
              deliveries: s.deliveries.map((row) => claimed.get(row.id) ?? row),
            },
          ];
        }),
      );

    const records = {
      createEndpoint,
      findEndpoint: (id) =>
        Effect.gen(function* () {
          const seen = yield* TenantScoped.visibility();
          const s = yield* Ref.get(state);
          return Option.map(
            Option.fromNullishOr(s.endpoints.find((row) => row.id === id && seenTenant(row, seen))),
            toRecord,
          );
        }),
      listEndpoints: Effect.gen(function* () {
        const seen = yield* TenantScoped.visibility();
        const s = yield* Ref.get(state);
        return byCreation(s.endpoints.filter((row) => seenTenant(row, seen))).map(toRecord);
      }),
      listEnabledEndpoints: (grant) =>
        Effect.andThen(
          TenantScoped.visibility(grant),
          Ref.get(state).pipe(
            Effect.map((s) =>
              byCreation(s.endpoints.filter((row) => Option.isNone(row.disabledAt))).map(toRecord),
            ),
          ),
        ),
      findEndpointForDelivery: (grant, id) =>
        Effect.andThen(
          TenantScoped.visibility(grant),
          Ref.get(state).pipe(
            Effect.map((s) =>
              Option.map(Option.fromNullishOr(s.endpoints.find((row) => row.id === id)), toRecord),
            ),
          ),
        ),
      disableFailing: (grant, id, at) =>
        Effect.andThen(
          TenantScoped.visibility(grant),
          Ref.update(state, (s) => ({
            ...s,
            endpoints: s.endpoints.map((row) =>
              row.id === id
                ? {
                    ...row,
                    disabledAt: Option.some(at),
                    disabledReason: Option.some<DisabledReason>("failing"),
                    updatedAt: at,
                  }
                : row,
            ),
          })),
        ),
      updateEndpoint: (id, patch) =>
        (patch.headers === undefined || patch.headers === null
          ? Effect.succeed(Option.none<string>())
          : Effect.map(headersCodec.seal(id, Redacted.make(patch.headers.value)), Option.some)
        ).pipe(
          Effect.flatMap((sealedHeaders) =>
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
                    headers: sealedHeaders,
                    headerNames: patch.headers?.names ?? [],
                  }),
            })),
          ),
        ),
      setSecrets: (id, secrets) =>
        Effect.all({
          secret: secretCodec.seal(id, secrets.secret),
          previous:
            secrets.previousSecret === null
              ? Effect.succeed(Option.none<string>())
              : Effect.map(previousSecretCodec.seal(id, secrets.previousSecret), Option.some),
        }).pipe(
          Effect.flatMap(({ secret, previous }) =>
            modifyEndpoint(id, (row) => ({
              ...row,
              secret,
              previousSecret: previous,
              previousSecretExpiresAt: Option.fromNullOr(secrets.previousSecretExpiresAt),
            })),
          ),
        ),
      setDisabled: (id, disabled) =>
        modifyEndpoint(id, (row) => ({
          ...row,
          disabledAt: Option.fromNullOr(disabled?.at ?? null),
          disabledReason: Option.fromNullOr(disabled?.reason ?? null),
          consecutiveDead: disabled === null ? 0 : row.consecutiveDead,
        })),
      bumpDead: (grant, id) =>
        Effect.andThen(
          TenantScoped.visibility(grant),
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
        ),
      clearDead: (grant, id) =>
        Effect.andThen(
          TenantScoped.visibility(grant),
          Ref.update(state, (s) => ({
            ...s,
            endpoints: s.endpoints.map((row) =>
              row.id === id ? { ...row, consecutiveDead: 0 } : row,
            ),
          })),
        ),
      deleteEndpoint: (id) =>
        Effect.gen(function* () {
          const seen = yield* TenantScoped.visibility();
          const removed = yield* Ref.modify(state, (s) => {
            if (!s.endpoints.some((row) => row.id === id && seenTenant(row, seen)))
              return [false, s] as const;
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
        Effect.gen(function* () {
          const seen = yield* TenantScoped.visibility();
          const s = yield* Ref.get(state);
          return Option.fromNullishOr(
            s.deliveries.find((row) => row.id === id && endpointVisible(s, row.endpointId, seen)),
          );
        }),
      markSucceeded: (grant, id, outcome) =>
        witnessed(grant, id, (row) => ({
          ...row,
          status: "succeeded",
          attempts: row.attempts + 1,
          lastAttemptAt: Option.some(outcome.at),
          lastStatusCode: Option.fromNullishOr(outcome.statusCode),
          lastError: Option.none(),
          completedAt: Option.some(outcome.at),
        })),
      reschedule: (grant, id, next) =>
        witnessed(grant, id, (row) => ({
          ...row,
          attempts: row.attempts + 1,
          nextAttemptAt: next.nextAttemptAt,
          lastAttemptAt: Option.some(next.at),
          lastStatusCode: Option.fromNullishOr(next.statusCode),
          lastError: Option.fromNullishOr(next.error),
        })),
      defer: (grant, id, nextAttemptAt) =>
        witnessed(grant, id, (row) => ({ ...row, nextAttemptAt })),
      markDead: (grant, id, outcome) =>
        witnessed(grant, id, (row) => ({
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
          const seen = yield* TenantScoped.visibility();
          const outcome = yield* Ref.modify(
            state,
            (s): readonly [Result.Result<DeliveryRecord, WebhookRecordNotFound>, State] => {
              const existing = s.deliveries.find(
                (row) =>
                  row.id === id &&
                  row.status === "dead" &&
                  endpointVisible(s, row.endpointId, seen),
              );
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
        Effect.gen(function* () {
          const seen = yield* TenantScoped.visibility();
          const s = yield* Ref.get(state);
          return s.deliveries
            .filter(
              (row) =>
                row.endpointId === endpointId &&
                endpointVisible(s, row.endpointId, seen) &&
                (status === undefined || row.status === status) &&
                (before === undefined || row.id < before),
            )
            .sort((a, b) => b.id.localeCompare(a.id))
            .slice(0, limit);
        }),
      pruneFinished: (grant, cutoff) =>
        Effect.andThen(
          TenantScoped.visibility(grant),
          Ref.modify(state, (s) => {
            const keep = s.deliveries.filter(
              (row) =>
                row.status === "pending" ||
                Option.isNone(row.completedAt) ||
                millis(row.completedAt.value) >= millis(cutoff),
            );
            return [s.deliveries.length - keep.length, { ...s, deliveries: keep }] as const;
          }),
        ),
      deleteBySubject: (grant, userId) =>
        Effect.andThen(
          TenantScoped.visibility(grant),
          Ref.update(state, (s) => ({
            ...s,
            deliveries: s.deliveries.filter(
              (row) => Option.getOrNull(row.subjectUserId) !== userId,
            ),
          })),
        ),
      listBySubject: (grant, userId) =>
        Effect.andThen(
          TenantScoped.visibility(grant),
          Ref.get(state).pipe(
            Effect.map((s) =>
              byCreation(
                s.deliveries.filter((row) => Option.getOrNull(row.subjectUserId) === userId),
              ),
            ),
          ),
        ),
    } satisfies WebhookRecordsShape;
    const envelopes = MemoryEnvelopes.of({
      stored: (id, field) =>
        Effect.map(Ref.get(state), (s) => {
          const row = s.endpoints.find((candidate) => candidate.id === id);
          return row === undefined
            ? ""
            : field === "secret"
              ? row.secret
              : Option.getOrElse(row[field], () => "");
        }),
      plant: (id, field, stored) =>
        Ref.update(state, (s) => ({
          ...s,
          endpoints: s.endpoints.map((row) =>
            row.id !== id
              ? row
              : field === "secret"
                ? { ...row, secret: stored }
                : field === "previousSecret"
                  ? { ...row, previousSecret: Option.some(stored) }
                  : { ...row, headers: Option.some(stored) },
          ),
        })),
    });
    return Context.make(WebhookRecords, records).pipe(Context.add(MemoryEnvelopes, envelopes));
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

export const layerSql: Layer.Layer<
  WebhookRecords,
  never,
  SqlClient.SqlClient | Encryption.Encryption
> = Layer.effect(
  WebhookRecords,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // TS-001: the row codecs follow the ambient client's dialect (Date on pg, ISO string on SQLite).
    const dialect = yield* SqlModels.resolveDialect(sql);
    const wire = SqlModels.dialectFields(dialect);
    /** An instant as a raw statement parameter (the schemas above do this for the typed ones). */
    const wireDate = (instant: DateTime.Utc) =>
      dialect === "pg" ? DateTime.toDate(instant) : DateTime.formatIso(instant);
    /** A relay/worker statement over every tenant: the witness annotates the span and lifts RLS. */
    const witnessed =
      (grant: TenantScoped.CrossTenant) =>
      <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.andThen(TenantScoped.visibility(grant), effect).pipe(
          TenantScoped.lift(grant),
          Effect.provideService(SqlClient.SqlClient, sql),
        );
    /** The ambient tenant's rows of `webhooks_endpoint` (alias `qualifier` for joins). */
    const endpointScope = (qualifier?: string) =>
      Effect.map(TenantScoped.visibility(), (seen) =>
        TenantScoped.predicate(sql, "tenantId", seen, qualifier),
      );
    /** A delivery belongs to the tenant of its endpoint. */
    const deliveryScope = Effect.map(
      endpointScope("e"),
      (scope) =>
        sql`EXISTS (SELECT 1 FROM webhooks_endpoint e WHERE e.id = webhooks_delivery."endpointId" AND ${scope})`,
    );
    const EndpointRow = makeEndpointRow(wire);
    const DeliveryRow = makeDeliveryRow(wire);
    const decodeEndpoints = Schema.decodeUnknownEffect(Schema.Array(EndpointRow));
    const secretCodec = yield* SealedColumn.codec(
      secretColumn,
      yield* SealedColumn.sqlSwap(secretColumn),
    );
    const previousSecretCodec = yield* SealedColumn.codec(
      previousSecretColumn,
      yield* SealedColumn.sqlSwap(previousSecretColumn),
    );
    const headersCodec = yield* SealedColumn.codec(
      headersColumn,
      yield* SealedColumn.sqlSwap(headersColumn),
    );

    const toEndpoint = (row: typeof EndpointRow.Type): EndpointRecord => ({
      id: row.id,
      url: row.url,
      description: Option.fromNullOr(row.description),
      eventTags: row.eventTags,
      secret: secretCodec.sealed(row.id, row.secret),
      previousSecret: Option.map(Option.fromNullOr(row.previousSecret), (stored) =>
        previousSecretCodec.sealed(row.id, stored),
      ),
      previousSecretExpiresAt: Option.fromNullOr(row.previousSecretExpiresAt),
      disabledAt: Option.fromNullOr(row.disabledAt),
      disabledReason: Option.fromNullOr(row.disabledReason),
      consecutiveDead: row.consecutiveDead,
      createdBy: row.createdBy,
      tenantId: Option.fromNullOr(row.tenantId),
      headers: Option.map(Option.fromNullOr(row.headers), (stored) =>
        headersCodec.sealed(row.id, stored),
      ),
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
      execute: (id) =>
        Effect.flatMap(
          endpointScope(),
          (scope) => sql`SELECT * FROM webhooks_endpoint WHERE id = ${id} AND ${scope}`,
        ),
    });
    const endpointByIdAnyTenant = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: EndpointRow,
      execute: (id) => sql`SELECT * FROM webhooks_endpoint WHERE id = ${id}`,
    });
    const allEndpoints = SqlSchema.findAll({
      Request: Schema.Struct({}),
      Result: EndpointRow,
      execute: () =>
        Effect.flatMap(
          endpointScope(),
          (scope) => sql`SELECT * FROM webhooks_endpoint WHERE ${scope} ORDER BY "createdAt", id`,
        ),
    });
    const enabledEndpoints = SqlSchema.findAll({
      Request: Schema.Struct({}),
      Result: EndpointRow,
      execute: () =>
        sql`SELECT * FROM webhooks_endpoint WHERE "disabledAt" IS NULL ORDER BY "createdAt", id`,
    });
    /** The endpoints of one tenant (`NULL` for the platform's), counted under that tenant's endpoint lock. */
    const countForTenant = SqlSchema.findOne({
      Request: Schema.NullOr(Schema.String),
      Result: Schema.Struct({ count: Schema.Number }),
      execute: (tenantId) =>
        sql`SELECT CAST(COUNT(*) AS INTEGER) AS count FROM webhooks_endpoint WHERE ${TenantScoped.predicate(
          sql,
          "tenantId",
          TenantScoped.Visibility.Tenant({ tenant: Option.fromNullOr(tenantId) }),
        )}`,
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
      execute: (r) =>
        Effect.flatMap(
          endpointScope(),
          (scope) => sql`
        UPDATE webhooks_endpoint SET secret = ${r.secret}, "previousSecret" = ${r.previousSecret},
          "previousSecretExpiresAt" = ${r.previousSecretExpiresAt}, "updatedAt" = ${r.updatedAt}
        WHERE id = ${r.id} AND ${scope}
        RETURNING *`,
        ),
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
      execute: (id) =>
        Effect.flatMap(
          deliveryScope,
          (scope) => sql`SELECT * FROM webhooks_delivery WHERE id = ${id} AND ${scope}`,
        ),
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
      execute: (r) =>
        Effect.flatMap(
          deliveryScope,
          (scope) => sql`
        SELECT * FROM webhooks_delivery
        WHERE "endpointId" = ${r.endpointId} AND ${scope}
          ${r.status === null ? sql`` : sql`AND status = ${r.status}`}
          ${r.before === null ? sql`` : sql`AND id < ${r.before}`}
        ORDER BY id DESC
        LIMIT ${r.limit}`,
        ),
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
      execute: (r) =>
        Effect.flatMap(
          deliveryScope,
          (scope) => sql`
        UPDATE webhooks_delivery SET status = 'pending', attempts = 0, "nextAttemptAt" = ${r.now}, "completedAt" = NULL
        WHERE id = ${r.id} AND status = 'dead' AND ${scope}
        RETURNING *`,
        ),
    });

    /** `StoreUnavailable` for a store outage, a defect for a row that no longer decodes (ADR-EA-028). */
    const failing = (method: string) => StoreFailure.orStoreUnavailable(`WebhookRecords.${method}`);
    const requireRow =
      <A>(id: string) =>
      (row: Option.Option<A>): Effect.Effect<A, WebhookRecordNotFound> =>
        Option.isSome(row) ? Effect.succeed(row.value) : Effect.fail(notFound(id));

    return {
      createEndpoint: (input, options) =>
        Effect.gen(function* () {
          const within = options?.within;
          const now = yield* DateTime.now;
          const stamped = yield* TenantScoped.stamp({ tenantId: null });
          const secret = yield* secretCodec.seal(input.id, input.secret);
          const headers =
            input.headers === undefined
              ? null
              : yield* headersCodec.seal(input.id, Redacted.make(input.headers.value));
          const write = insertEndpoint({
            id: input.id,
            url: input.url,
            description: input.description ?? null,
            eventTags: input.eventTags,
            secret,
            previousSecret: null,
            previousSecretExpiresAt: null,
            disabledAt: null,
            disabledReason: null,
            consecutiveDead: 0,
            createdBy: input.createdBy,
            tenantId: stamped.tenantId,
            headers,
            headerNames: input.headers?.names ?? [],
            createdAt: now,
            updatedAt: now,
          });
          // Plan 25: the tenant's endpoint count under its lock, in the transaction that inserts.
          const guarded =
            within === undefined
              ? write
              : SqlStore.atomically(
                  sql,
                  `webhooks_endpoint:tenant:${stamped.tenantId ?? "-"}`,
                )(
                  Effect.gen(function* () {
                    if ((yield* countForTenant(stamped.tenantId)).count >= within) {
                      return yield* Effect.fail(new WebhookRecordLimitReached({ limit: within }));
                    }
                    return yield* write;
                  }),
                );
          // `INSERT ... RETURNING` always returns the row it wrote.
          return yield* guarded.pipe(
            Effect.catchTag("NoSuchElementError", Effect.die),
            failing("createEndpoint"),
          );
        }).pipe(Effect.map(toEndpoint)),
      findEndpoint: (id) =>
        endpointById(id).pipe(failing("findEndpoint"), Effect.map(Option.map(toEndpoint))),
      listEndpoints: allEndpoints({}).pipe(
        failing("listEndpoints"),
        Effect.map((rows) => rows.map(toEndpoint)),
      ),
      listEnabledEndpoints: (grant) =>
        enabledEndpoints({}).pipe(
          witnessed(grant),
          failing("listEnabledEndpoints"),
          Effect.map((rows) => rows.map(toEndpoint)),
        ),
      findEndpointForDelivery: (grant, id) =>
        endpointByIdAnyTenant(id).pipe(
          witnessed(grant),
          failing("findEndpointForDelivery"),
          Effect.map(Option.map(toEndpoint)),
        ),
      disableFailing: (grant, id, at) =>
        witnessed(grant)(
          sql`UPDATE webhooks_endpoint SET "disabledAt" = ${wireDate(at)}, "disabledReason" = 'failing',
            "updatedAt" = ${wireDate(at)} WHERE id = ${id}`,
        ).pipe(failing("disableFailing"), Effect.asVoid),
      // Plan 24 C8 (plan 25): one `UPDATE` of only the patched columns, `RETURNING *`. No read-before-write, so a
      // concurrent write of another column (another PATCH, the worker's `bumpDead`) keeps its change.
      updateEndpoint: (id, patch) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const columns: Record<string, string | Date | null> = { updatedAt: wireDate(now) };
          if (patch.url !== undefined) columns["url"] = patch.url;
          if (patch.description !== undefined) columns["description"] = patch.description;
          if (patch.eventTags !== undefined) columns["eventTags"] = JSON.stringify(patch.eventTags);
          if (patch.headers !== undefined) {
            columns["headers"] =
              patch.headers === null
                ? null
                : yield* headersCodec.seal(id, Redacted.make(patch.headers.value));
            columns["headerNames"] = JSON.stringify(patch.headers?.names ?? []);
          }
          const scope = yield* endpointScope();
          const rows =
            yield* sql`UPDATE webhooks_endpoint SET ${sql.update(columns)} WHERE id = ${id} AND ${scope} RETURNING *`.pipe(
              Effect.flatMap(decodeEndpoints),
              failing("updateEndpoint"),
            );
          const [row] = rows;
          if (row === undefined) return yield* Effect.fail(notFound(id));
          return toEndpoint(row);
        }),
      setSecrets: (id, secrets) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const secret = yield* secretCodec.seal(id, secrets.secret);
          const previousSecret =
            secrets.previousSecret === null
              ? null
              : yield* previousSecretCodec.seal(id, secrets.previousSecret);
          return yield* writeSecrets({
            id,
            secret,
            previousSecret,
            previousSecretExpiresAt: secrets.previousSecretExpiresAt,
            updatedAt: now,
          }).pipe(failing("setSecrets"));
        }).pipe(Effect.flatMap(requireRow(id)), Effect.map(toEndpoint)),
      // Plan 24 C8 (plan 25): one statement. Disabling leaves `consecutiveDead` alone (the worker's `bumpDead` may
      // be adding to it right now); re-enabling resets it in the same statement.
      setDisabled: (id, disabled) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const scope = yield* endpointScope();
          const rows = yield* (
            disabled === null
              ? sql`UPDATE webhooks_endpoint SET "disabledAt" = NULL, "disabledReason" = NULL,
                  "consecutiveDead" = 0, "updatedAt" = ${wireDate(now)}
                WHERE id = ${id} AND ${scope} RETURNING *`
              : sql`UPDATE webhooks_endpoint SET "disabledAt" = ${wireDate(disabled.at)},
                  "disabledReason" = ${disabled.reason}, "updatedAt" = ${wireDate(now)}
                WHERE id = ${id} AND ${scope} RETURNING *`
          ).pipe(Effect.flatMap(decodeEndpoints), failing("setDisabled"));
          const [row] = rows;
          if (row === undefined) return yield* Effect.fail(notFound(id));
          return toEndpoint(row);
        }),
      bumpDead: (grant, id) =>
        bump(id).pipe(
          Effect.map((row) => (Option.isSome(row) ? row.value.consecutiveDead : 0)),
          witnessed(grant),
          failing("bumpDead"),
        ),
      clearDead: (grant, id) =>
        witnessed(grant)(
          sql`UPDATE webhooks_endpoint SET "consecutiveDead" = 0 WHERE id = ${id}`,
        ).pipe(failing("clearDead"), Effect.asVoid),
      // Plan 24 C9 (plan 25): both DELETEs in one transaction, the endpoint's row first. Every other write takes one
      // row lock in one statement (the endpoint's or a delivery's), so none can wait on this in a cycle.
      deleteEndpoint: (id) =>
        Effect.gen(function* () {
          const scope = yield* endpointScope();
          const removed =
            yield* sql`DELETE FROM webhooks_endpoint WHERE id = ${id} AND ${scope} RETURNING id`;
          if (removed.length === 0) return yield* Effect.fail(notFound(id));
          yield* sql`DELETE FROM webhooks_delivery WHERE "endpointId" = ${id}`;
        }).pipe(SqlTransaction.transactional(sql), failing("deleteEndpoint")),
      // A row is stored only while its endpoint exists, so an enqueue racing `deleteEndpoint` never leaves a
      // delivery whose endpoint is gone (there is no foreign key). Each row is one transaction that first takes
      // the endpoint row's key-share lock (Postgres `FOR KEY SHARE`, which the delete's row lock conflicts with):
      // a delete that got there first has committed when the lock is granted, and the row reads as gone; a delete
      // that comes second waits for this insert to commit, and its delivery DELETE then removes it. Same lock
      // order as `deleteEndpoint` (the endpoint's row, then a delivery's), so neither waits on the other in a
      // cycle. SQLite runs one write transaction at a time and needs no lock.
      enqueue: (rows) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          let inserted = 0;
          for (const row of rows) {
            const wrote = yield* Effect.gen(function* () {
              const live =
                dialect === "pg"
                  ? yield* sql`SELECT id FROM webhooks_endpoint WHERE id = ${row.endpointId} FOR KEY SHARE`
                  : yield* sql`SELECT id FROM webhooks_endpoint WHERE id = ${row.endpointId}`;
              if (live.length === 0) return 0;
              const stored = yield* sql`
                INSERT INTO webhooks_delivery (id, "endpointId", "eventId", "eventTag", "subjectUserId", body,
                  status, attempts, "nextAttemptAt", "createdAt")
                VALUES (${row.id}, ${row.endpointId}, ${row.eventId}, ${row.eventTag}, ${row.subjectUserId ?? null},
                  ${row.body}, 'pending', 0, ${wireDate(row.nextAttemptAt)}, ${wireDate(now)})
                ON CONFLICT ("endpointId", "eventId") DO NOTHING
                RETURNING id`;
              return stored.length;
            }).pipe(SqlTransaction.transactional(sql), failing("enqueue"));
            inserted += wrote;
          }
          return inserted;
        }),
      claimDue: (grant, { now, limit, lease }) =>
        Effect.gen(function* () {
          const ids = yield* dueIds({ now, limit });
          const leasedUntil = DateTime.addDuration(now, lease);
          const claimed: Array<DeliveryRecord> = [];
          for (const { id } of ids) {
            const row = yield* leaseOne({ id, now, leasedUntil });
            if (Option.isSome(row)) claimed.push(toDelivery(row.value));
          }
          return claimed;
        }).pipe(witnessed(grant), failing("claimDue")),
      findDelivery: (id) =>
        deliveryById(id).pipe(failing("findDelivery"), Effect.map(Option.map(toDelivery))),
      markSucceeded: (grant, id, outcome) =>
        witnessed(grant)(sql`
          UPDATE webhooks_delivery SET status = 'succeeded', attempts = attempts + 1,
            "lastAttemptAt" = ${wireDate(outcome.at)}, "lastStatusCode" = ${outcome.statusCode ?? null},
            "lastError" = NULL, "completedAt" = ${wireDate(outcome.at)}
          WHERE id = ${id}`).pipe(failing("markSucceeded"), Effect.asVoid),
      reschedule: (grant, id, next) =>
        witnessed(grant)(sql`
          UPDATE webhooks_delivery SET attempts = attempts + 1, "nextAttemptAt" = ${wireDate(next.nextAttemptAt)},
            "lastAttemptAt" = ${wireDate(next.at)}, "lastStatusCode" = ${next.statusCode ?? null},
            "lastError" = ${next.error ?? null}
          WHERE id = ${id}`).pipe(failing("reschedule"), Effect.asVoid),
      defer: (grant, id, nextAttemptAt) =>
        witnessed(grant)(
          sql`UPDATE webhooks_delivery SET "nextAttemptAt" = ${wireDate(nextAttemptAt)} WHERE id = ${id}`,
        ).pipe(failing("defer"), Effect.asVoid),
      markDead: (grant, id, outcome) =>
        witnessed(grant)(sql`
          UPDATE webhooks_delivery SET status = 'dead', attempts = attempts + 1,
            "lastAttemptAt" = ${wireDate(outcome.at)}, "lastStatusCode" = ${outcome.statusCode ?? null},
            "lastError" = ${outcome.error ?? null}, "completedAt" = ${wireDate(outcome.at)}
          WHERE id = ${id}`).pipe(failing("markDead"), Effect.asVoid),
      redrive: (id, now) =>
        redriveOne({ id, now }).pipe(
          failing("redrive"),
          Effect.flatMap(requireRow(id)),
          Effect.map(toDelivery),
        ),
      listDeliveries: ({ endpointId, status, before, limit }) =>
        listDeliveries({ endpointId, status: status ?? null, before: before ?? null, limit }).pipe(
          failing("listDeliveries"),
          Effect.map((rows) => rows.map(toDelivery)),
        ),
      pruneFinished: (grant, cutoff) =>
        witnessed(grant)(sql`
          DELETE FROM webhooks_delivery
          WHERE status IN ('succeeded', 'dead') AND "completedAt" < ${wireDate(cutoff)}
          RETURNING id`).pipe(
          failing("pruneFinished"),
          Effect.map((rows) => rows.length),
        ),
      deleteBySubject: (grant, userId) =>
        witnessed(grant)(sql`DELETE FROM webhooks_delivery WHERE "subjectUserId" = ${userId}`).pipe(
          failing("deleteBySubject"),
          Effect.asVoid,
        ),
      listBySubject: (grant, userId) =>
        bySubject(userId).pipe(
          witnessed(grant),
          failing("listBySubject"),
          Effect.map((rows) => rows.map(toDelivery)),
        ),
    } satisfies WebhookRecordsShape;
  }),
);

/**
 * Plan 08 (BEH-EA-T4): the plugin's record store as two matched layers, `Webhooks.records`. `layerMemory` also
 * provides `MemoryEnvelopes`, a test seam that is not a store; a bundle provides record stores only, so it is
 * projected away (a suite that plants envelopes uses `layerMemory` directly).
 */
const memoryStore = Layer.effect(WebhookRecords, Effect.service(WebhookRecords)).pipe(
  Layer.provide(layerMemory),
);

export const records = { memory: memoryStore, sql: layerSql };
