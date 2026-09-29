// @awthaq/webhooks — Webhooks
//
// CWM-004/MAPS-010 (decision D2, ADR-EA-030 Decision 7; spec/behaviors/34-webhooks.md): the first-party,
// opt-in outbound webhooks plugin. `Auth.make([..., Webhooks])` adds the administrator's endpoint and
// delivery-log API; `Webhooks.background()` (or its two halves, `WebhookDelivery.relayLayer` and
// `workerLayer`) starts the delivery machinery over the event relay. Nothing here runs unless composed.
//
// The safety design, in one place (every rule has a test):
//
// - Signed like Standard Webhooks (`webhook-id`/`-timestamp`/`-signature`, HMAC-SHA256 over
//   `id.timestamp.body`), so a receiver that verifies svix/Clerk webhooks verifies these. Each attempt is
//   re-stamped, the id is the event id (idempotency key), and a rotation sends both signatures for a grace window.
// - One secret per endpoint, generated here, shown once, stored only as an `Encryption` envelope whose AAD
//   binds it to its endpoint and field.
// - Endpoint URLs are an SSRF surface: https only, no credentials, no private/loopback/link-local/reserved
//   address or internal name, and the name must *resolve* to public addresses only — checked when registered and
//   again on every attempt. Redirects are never followed and response bodies are never read or stored.
// - The payload is identifiers only (ADR-EA-029): free text about a person is dropped, the client address only
//   with `includeClientContext`, and a name-based guard removes credential- and contact-shaped fields.
// - At-least-once with retry, capped exponential backoff and a dead-letter state over the relay's cursor; per-
//   endpoint outbound rate limit; a failing endpoint is switched off after `disableAfterConsecutiveDead`.
// - Administration is fail-closed (`canManageWebhooks` denies by default), on the admin tier, rate limited per
//   administrator, and a caller who fails the gate learns nothing about which ids exist.
// - Account erasure removes the delivery rows about the erased user; the data export lists them (outcomes only).

import { Api } from "@awthaq/api";
import {
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  DataExport,
  Erasure,
  Migrations,
  RateLimits,
  Tenant,
  Users,
} from "@awthaq/core";
import { Defects, Encryption, HostResolver, OutboundUrl, RateLimiter } from "@awthaq/ports";
import { makeSubject } from "@qadi/core";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as WebhookDelivery from "./WebhookDelivery.ts";
import * as WebhookHeaders from "./WebhookHeaders.ts";
import * as WebhookPayload from "./WebhookPayload.ts";
import * as WebhookRecords from "./WebhookRecords.ts";
import * as WebhookSecrets from "./WebhookSecrets.ts";
import * as WebhookSignature from "./WebhookSignature.ts";
import * as WebhooksApi from "./WebhooksApi.ts";
import * as WebhooksConfig from "./WebhooksConfig.ts";

export { WebhooksConfig, config } from "./WebhooksConfig.ts";
export type { WebhooksConfigShape } from "./WebhooksConfig.ts";

// ---- shape -----------------------------------------------------------------------------------

type Gate = WebhooksApi.WebhooksActionDenied | Api.RateLimited;

export interface WebhooksShape {
  /** Registers a receiver. The returned secret is the only time it is ever shown. */
  readonly createEndpoint: (
    caller: Api.UserPrincipal,
    input: WebhooksApi.CreateEndpointPayload,
  ) => Effect.Effect<
    WebhooksApi.EndpointWithSecretDto,
    Gate | WebhooksApi.InvalidWebhookEndpoint | WebhooksApi.WebhookEndpointLimitReached
  >;
  readonly listEndpoints: (
    caller: Api.UserPrincipal,
  ) => Effect.Effect<ReadonlyArray<WebhooksApi.EndpointDto>, Gate>;
  readonly getEndpoint: (
    caller: Api.UserPrincipal,
    endpointId: string,
  ) => Effect.Effect<WebhooksApi.EndpointDto, Gate | WebhooksApi.WebhookEndpointNotFound>;
  readonly updateEndpoint: (
    caller: Api.UserPrincipal,
    endpointId: string,
    input: WebhooksApi.UpdateEndpointPayload,
  ) => Effect.Effect<
    WebhooksApi.EndpointDto,
    Gate | WebhooksApi.WebhookEndpointNotFound | WebhooksApi.InvalidWebhookEndpoint
  >;
  /** Removes the endpoint and its delivery log. */
  readonly deleteEndpoint: (
    caller: Api.UserPrincipal,
    endpointId: string,
  ) => Effect.Effect<void, Gate | WebhooksApi.WebhookEndpointNotFound>;
  /** New secret now; the old one keeps signing alongside it for `secretGrace`. */
  readonly rotateSecret: (
    caller: Api.UserPrincipal,
    endpointId: string,
  ) => Effect.Effect<WebhooksApi.EndpointWithSecretDto, Gate | WebhooksApi.WebhookEndpointNotFound>;
  readonly listDeliveries: (
    caller: Api.UserPrincipal,
    endpointId: string,
    query: WebhooksApi.ListDeliveriesQuery,
  ) => Effect.Effect<
    ReadonlyArray<WebhooksApi.DeliveryDto>,
    Gate | WebhooksApi.WebhookEndpointNotFound
  >;
  /** Sends a dead-lettered delivery again (attempts reset). */
  readonly retryDelivery: (
    caller: Api.UserPrincipal,
    deliveryId: string,
  ) => Effect.Effect<
    WebhooksApi.DeliveryDto,
    Gate | WebhooksApi.WebhookDeliveryNotFound | WebhooksApi.WebhookDeliveryNotRetryable
  >;
  /**
   * BEH-EA-310: queues a signed synthetic `webhook.test` event for the endpoint and returns its (pending) delivery
   * row; the worker sends it like any other delivery, once, and the outcome is read from the delivery log.
   */
  readonly testEndpoint: (
    caller: Api.UserPrincipal,
    endpointId: string,
  ) => Effect.Effect<
    WebhooksApi.DeliveryDto,
    Gate | WebhooksApi.WebhookEndpointNotFound | WebhooksApi.InvalidWebhookEndpoint
  >;
}

const iso = (instant: DateTime.Utc): string => DateTime.formatIso(instant);
const isoOrNull = (instant: Option.Option<DateTime.Utc>): string | null =>
  Option.match(instant, { onNone: () => null, onSome: iso });

export const toEndpointDto = (record: WebhookRecords.EndpointRecord) =>
  new WebhooksApi.EndpointDto({
    id: record.id,
    url: record.url,
    description: Option.getOrNull(record.description),
    eventTags: [...record.eventTags],
    enabled: Option.isNone(record.disabledAt),
    disabledReason: Option.getOrNull(record.disabledReason),
    consecutiveDead: record.consecutiveDead,
    headerNames: [...record.headerNames],
    tenantId: Option.getOrNull(record.tenantId),
    previousSecretExpiresAt: isoOrNull(record.previousSecretExpiresAt),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  });

export const toDeliveryDto = (record: WebhookRecords.DeliveryRecord) =>
  new WebhooksApi.DeliveryDto({
    id: record.id,
    endpointId: record.endpointId,
    eventId: record.eventId,
    eventTag: record.eventTag,
    status: record.status,
    attempts: record.attempts,
    nextAttemptAt: iso(record.nextAttemptAt),
    lastAttemptAt: isoOrNull(record.lastAttemptAt),
    lastStatusCode: Option.getOrNull(record.lastStatusCode),
    lastError: Option.getOrNull(record.lastError),
    createdAt: iso(record.createdAt),
    completedAt: isoOrNull(record.completedAt),
  });

const DEFAULT_PAGE = 50;

/** The fields an update can change, in the order the audit event names them. */
const UPDATE_FIELDS: ReadonlyArray<keyof WebhooksApi.UpdateEndpointPayload> = [
  "url",
  "description",
  "eventTags",
  "headers",
  "enabled",
];

// ---- migrations --------------------------------------------------------------------------------

const webhooksMigrations: Migrations.Migrations = [
  {
    name: "create_webhooks_endpoint",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE webhooks_endpoint (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            description TEXT,
            "eventTags" TEXT NOT NULL,
            secret TEXT NOT NULL,
            "previousSecret" TEXT,
            "previousSecretExpiresAt" TIMESTAMPTZ,
            "disabledAt" TIMESTAMPTZ,
            "disabledReason" TEXT,
            "consecutiveDead" INTEGER NOT NULL DEFAULT 0,
            "createdBy" TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "updatedAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE webhooks_endpoint (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            description TEXT,
            "eventTags" TEXT NOT NULL,
            secret TEXT NOT NULL,
            "previousSecret" TEXT,
            "previousSecretExpiresAt" TEXT,
            "disabledAt" TEXT,
            "disabledReason" TEXT,
            "consecutiveDead" INTEGER NOT NULL DEFAULT 0,
            "createdBy" TEXT NOT NULL,
            "createdAt" TEXT NOT NULL,
            "updatedAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    // One row per (endpoint, event): the unique index is what makes the relay's at-least-once hand-off idempotent.
    name: "create_webhooks_delivery",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE webhooks_delivery (
            id TEXT PRIMARY KEY,
            "endpointId" TEXT NOT NULL,
            "eventId" TEXT NOT NULL,
            "eventTag" TEXT NOT NULL,
            "subjectUserId" TEXT,
            body TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            "nextAttemptAt" TIMESTAMPTZ NOT NULL,
            "lastAttemptAt" TIMESTAMPTZ,
            "lastStatusCode" INTEGER,
            "lastError" TEXT,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "completedAt" TIMESTAMPTZ
          )`,
        sqlite: () => sql`
          CREATE TABLE webhooks_delivery (
            id TEXT PRIMARY KEY,
            "endpointId" TEXT NOT NULL,
            "eventId" TEXT NOT NULL,
            "eventTag" TEXT NOT NULL,
            "subjectUserId" TEXT,
            body TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            "nextAttemptAt" TEXT NOT NULL,
            "lastAttemptAt" TEXT,
            "lastStatusCode" INTEGER,
            "lastError" TEXT,
            "createdAt" TEXT NOT NULL,
            "completedAt" TEXT
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
      yield* sql`CREATE UNIQUE INDEX webhooks_delivery_event_unique ON webhooks_delivery("endpointId", "eventId")`;
      yield* sql`CREATE INDEX webhooks_delivery_due ON webhooks_delivery(status, "nextAttemptAt")`;
      yield* sql`CREATE INDEX webhooks_delivery_subject ON webhooks_delivery("subjectUserId")`;
    }),
  },
  {
    // BEH-EA-309: an endpoint belongs to a tenant (the organization the ambient `TenantContext` named when it was
    // registered); NULL is the platform's own. Existing rows are platform endpoints, which is what they always were.
    name: "add_webhooks_endpoint_tenant",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE webhooks_endpoint ADD COLUMN "tenantId" TEXT`;
      yield* sql`CREATE INDEX webhooks_endpoint_tenant ON webhooks_endpoint("tenantId")`;
    }),
  },
  {
    // BEH-EA-313: the sealed custom-header object, and its (not secret) names for the API to show.
    name: "add_webhooks_endpoint_headers",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE webhooks_endpoint ADD COLUMN headers TEXT`;
      yield* sql`ALTER TABLE webhooks_endpoint ADD COLUMN "headerNames" TEXT NOT NULL DEFAULT '[]'`;
    }),
  },
];

// ---- erasure and export ------------------------------------------------------------------------

/** ADR-EA-031: the delivery rows about an erased user go with them (the delivery of `auth.user.deleted` itself is queued afterwards and is the consumer's cue to erase). */
export const webhooksErasure = Erasure.contribute({
  id: "webhooks",
  make: Effect.gen(function* () {
    const records = yield* WebhookRecords.WebhookRecords;
    return (subject: Erasure.ErasureSubject) => records.deleteBySubject(subject.userId);
  }),
});

/** The data-subject export: which of their events were queued to which endpoint and how it went — outcomes only, never a body. */
export const webhooksExport = DataExport.contribute({
  id: "webhooks",
  make: Effect.gen(function* () {
    const records = yield* WebhookRecords.WebhookRecords;
    return (subject: DataExport.DataExportSubject) =>
      records.listBySubject(subject.userId).pipe(
        Effect.map((rows) => ({
          deliveries: rows.map((row) => ({
            eventId: row.eventId,
            eventTag: row.eventTag,
            endpointId: row.endpointId,
            status: row.status,
            attempts: row.attempts,
            createdAt: iso(row.createdAt),
          })),
        })),
      );
  }),
});

// ---- the plugin ---------------------------------------------------------------------------------

/** Same forward-reference pattern `@awthaq/admin` documents: a handler reached without a `User` principal is a wiring defect. */
const currentUserPrincipal = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Defects.invariantViolation(
      "NonUserPrincipal",
      `awthaq: webhooks admin group reached with a non-User principal: ${principal._tag}`,
    );
  }
  return principal;
});

export class Webhooks extends AuthPlugin.Service<Webhooks, WebhooksShape>()("webhooks", {
  apiVersion: 1,
  contract: WebhooksApi.WebhooksApi,
  tables: ["webhooks_endpoint", "webhooks_delivery"],
  migrations: webhooksMigrations,
  config: [ConfigDescriptor.make(WebhooksConfig.WebhooksConfig)],
}) {
  static readonly layer = AuthPlugin.layer(Webhooks, {
    ports: [Encryption.Encryption, HostResolver.HostResolver, RateLimiter.RateLimiter],
    handlers: HttpApiBuilder.group(
      WebhooksApi.WebhooksApi,
      "webhooks.admin",
      Effect.fnUntraced(function* (handlers) {
        const webhooks = yield* Webhooks;
        return handlers.handleAll({
          createEndpoint: Effect.fnUntraced(function* ({
            payload,
          }: {
            payload: WebhooksApi.CreateEndpointPayload;
          }) {
            return yield* webhooks.createEndpoint(yield* currentUserPrincipal, payload);
          }),
          listEndpoints: Effect.fnUntraced(function* () {
            return yield* webhooks.listEndpoints(yield* currentUserPrincipal);
          }),
          getEndpoint: Effect.fnUntraced(function* ({
            params,
          }: {
            params: WebhooksApi.EndpointIdParams;
          }) {
            return yield* webhooks.getEndpoint(yield* currentUserPrincipal, params.endpointId);
          }),
          updateEndpoint: Effect.fnUntraced(function* ({
            params,
            payload,
          }: {
            params: WebhooksApi.EndpointIdParams;
            payload: WebhooksApi.UpdateEndpointPayload;
          }) {
            return yield* webhooks.updateEndpoint(
              yield* currentUserPrincipal,
              params.endpointId,
              payload,
            );
          }),
          deleteEndpoint: Effect.fnUntraced(function* ({
            params,
          }: {
            params: WebhooksApi.EndpointIdParams;
          }) {
            yield* webhooks.deleteEndpoint(yield* currentUserPrincipal, params.endpointId);
          }),
          rotateSecret: Effect.fnUntraced(function* ({
            params,
          }: {
            params: WebhooksApi.EndpointIdParams;
          }) {
            return yield* webhooks.rotateSecret(yield* currentUserPrincipal, params.endpointId);
          }),
          listDeliveries: Effect.fnUntraced(function* ({
            params,
            query,
          }: {
            params: WebhooksApi.EndpointIdParams;
            query: WebhooksApi.ListDeliveriesQuery;
          }) {
            return yield* webhooks.listDeliveries(
              yield* currentUserPrincipal,
              params.endpointId,
              query,
            );
          }),
          retryDelivery: Effect.fnUntraced(function* ({
            params,
          }: {
            params: WebhooksApi.DeliveryIdParams;
          }) {
            return yield* webhooks.retryDelivery(yield* currentUserPrincipal, params.deliveryId);
          }),
          testEndpoint: Effect.fnUntraced(function* ({
            params,
          }: {
            params: WebhooksApi.EndpointIdParams;
          }) {
            return yield* webhooks.testEndpoint(yield* currentUserPrincipal, params.endpointId);
          }),
        });
      }),
    ),
    contributes: Layer.mergeAll(webhooksErasure, webhooksExport),
    make: Effect.gen(function* () {
      const records = yield* WebhookRecords.WebhookRecords;
      const encryption = yield* Encryption.Encryption;
      const crypto = yield* Crypto.Crypto;
      const events = yield* AuthEvents.AuthEvents;
      const limiter = yield* RateLimiter.RateLimiter;
      const resolver = yield* HostResolver.HostResolver;
      // EP-007: the knobs are decided per operation, so a tenant's `Webhooks.config(...)` in the calling
      // fiber applies; with none, the build-time value does. (The background worker is deployment-wide
      // and reads the build-time value.)
      const builtSettings = yield* WebhooksConfig.WebhooksConfig;
      const configNow = Tenant.configInForce(WebhooksConfig.WebhooksConfig, builtSettings);

      /**
       * Gate first (fail-closed), then the administrator's own rate limit: a caller who fails the
       * gate learns nothing else, and one who passes cannot hammer the write path.
       */
      const authorize = Effect.fnUntraced(function* (caller: Api.UserPrincipal, action: string) {
        const settings = yield* configNow;
        const allowed = yield* settings.canManageWebhooks({
          admin: makeSubject({ id: caller.ref.id }),
          action,
        });
        if (!allowed) {
          yield* events.publish({
            _tag: "auth.admin.actionDenied",
            adminUserId: Users.UserId(caller.ref.id),
            action: `webhooks.${action}`,
          });
          return yield* Effect.fail(new WebhooksApi.WebhooksActionDenied());
        }
        yield* RateLimits.enforce({
          key: `webhooks:admin:${caller.ref.id}`,
          limit: settings.adminRate.limit,
          window: settings.adminRate.window,
          meta: {
            group: "webhooks.admin",
            endpoint: action,
            rule: "admin",
            dimension: "principal",
          },
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );
        return settings;
      });

      /**
       * BEH-EA-309: administration is scoped to the ambient tenant. An endpoint of another tenant (or of the
       * platform, from inside a tenant, and the reverse) is answered exactly like an id that does not exist.
       */
      const inScope = (record: WebhookRecords.EndpointRecord) =>
        Effect.map(
          Tenant.TenantContext,
          (tenant) => Option.getOrNull(record.tenantId) === Option.getOrNull(tenant),
        );

      const existing = (endpointId: string) =>
        records.findEndpoint(endpointId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new WebhooksApi.WebhookEndpointNotFound()),
              onSome: (record) =>
                Effect.flatMap(inScope(record), (visible) =>
                  visible
                    ? Effect.succeed(record)
                    : Effect.fail(new WebhooksApi.WebhookEndpointNotFound()),
                ),
            }),
          ),
        );

      /** The endpoints the ambient tenant may administer. */
      const scopedEndpoints = Effect.gen(function* () {
        const tenant = yield* Tenant.TenantContext;
        const all = yield* records.listEndpoints;
        return all.filter((row) => Option.getOrNull(row.tenantId) === Option.getOrNull(tenant));
      });

      const adminId = (caller: Api.UserPrincipal) => Users.UserId(caller.ref.id);

      /** The SSRF floor and the filter check: `InvalidWebhookEndpoint` with the rule that failed. */
      const validateTarget = Effect.fnUntraced(function* (
        url: string,
        settings: WebhooksConfig.WebhooksConfigShape,
      ) {
        const syntactic = OutboundUrl.problem("url", url, {
          allowPrivate: settings.allowPrivateTargets,
        });
        if (Option.isSome(syntactic)) {
          return yield* Effect.fail(
            new WebhooksApi.InvalidWebhookEndpoint({ reason: syntactic.value }),
          );
        }
        if (settings.allowPrivateTargets) return;
        const resolved = yield* HostResolver.refusal(url).pipe(
          Effect.provideService(HostResolver.HostResolver, resolver),
        );
        if (Option.isSome(resolved)) {
          return yield* Effect.fail(
            new WebhooksApi.InvalidWebhookEndpoint({ reason: `url ${resolved.value}` }),
          );
        }
      });
      /** BEH-EA-313: the rules for custom headers, answered like the URL's. */
      const validateHeaders = (headers: Readonly<Record<string, string>>) => {
        const refused = WebhookHeaders.problem(headers);
        return Option.isSome(refused)
          ? Effect.fail(new WebhooksApi.InvalidWebhookEndpoint({ reason: refused.value }))
          : Effect.void;
      };
      const sealedHeaders = Effect.fnUntraced(function* (
        endpointId: string,
        headers: Readonly<Record<string, string>>,
      ) {
        const normalized = WebhookHeaders.normalize(headers);
        return {
          sealed: yield* WebhookSecrets.sealHeaders(encryption, endpointId, normalized),
          names: WebhookHeaders.namesOf(normalized),
        };
      });
      const validateTags = (tags: ReadonlyArray<string>) => {
        const unknown = WebhookPayload.unknownPattern(tags);
        return unknown === undefined
          ? Effect.void
          : Effect.fail(
              new WebhooksApi.InvalidWebhookEndpoint({
                reason: `eventTags: "${unknown}" matches no event the library publishes`,
              }),
            );
      };

      const createEndpoint: WebhooksShape["createEndpoint"] = Effect.fnUntraced(
        function* (caller, input) {
          const settings = yield* authorize(caller, "createEndpoint");
          const tenant = yield* Tenant.TenantContext;
          const current = yield* scopedEndpoints;
          if (current.length >= settings.maxEndpoints) {
            return yield* Effect.fail(
              new WebhooksApi.WebhookEndpointLimitReached({ limit: settings.maxEndpoints }),
            );
          }
          yield* validateTarget(input.url, settings);
          yield* validateTags(input.eventTags);
          if (input.headers !== undefined) yield* validateHeaders(input.headers);
          const id = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
          const secret = yield* WebhookSignature.generateSecret.pipe(
            Effect.provideService(Crypto.Crypto, crypto),
          );
          const sealed = yield* WebhookSecrets.seal(encryption, id, "secret", secret);
          const record = yield* records.createEndpoint({
            id,
            url: input.url,
            description: input.description?.trim(),
            eventTags: input.eventTags,
            secret: sealed,
            createdBy: caller.ref.id,
            tenantId: Option.getOrUndefined(tenant),
            headers:
              input.headers === undefined || Object.keys(input.headers).length === 0
                ? undefined
                : yield* sealedHeaders(id, input.headers),
          });
          yield* Effect.logInfo("awthaq/webhooks: endpoint created", { endpointId: id });
          yield* events.publish({
            _tag: "auth.webhooks.endpointCreated",
            adminUserId: adminId(caller),
            endpointId: id,
          });
          return new WebhooksApi.EndpointWithSecretDto({
            endpoint: toEndpointDto(record),
            secret: Redacted.value(secret),
          });
        },
      );

      const listEndpoints: WebhooksShape["listEndpoints"] = Effect.fnUntraced(function* (caller) {
        yield* authorize(caller, "listEndpoints");
        return (yield* scopedEndpoints).map(toEndpointDto);
      });

      const getEndpoint: WebhooksShape["getEndpoint"] = Effect.fnUntraced(
        function* (caller, endpointId) {
          yield* authorize(caller, "getEndpoint");
          return toEndpointDto(yield* existing(endpointId));
        },
      );

      const updateEndpoint: WebhooksShape["updateEndpoint"] = Effect.fnUntraced(
        function* (caller, endpointId, input) {
          const settings = yield* authorize(caller, "updateEndpoint");
          yield* existing(endpointId);
          if (input.url !== undefined) yield* validateTarget(input.url, settings);
          if (input.eventTags !== undefined) yield* validateTags(input.eventTags);
          if (input.headers !== undefined && input.headers !== null) {
            yield* validateHeaders(input.headers);
          }
          const notFound = <A>(effect: Effect.Effect<A, WebhookRecords.WebhookRecordNotFound>) =>
            effect.pipe(
              Effect.catchTag("WebhookRecordNotFound", () =>
                Effect.fail(new WebhooksApi.WebhookEndpointNotFound()),
              ),
            );
          let record = yield* notFound(
            records.updateEndpoint(endpointId, {
              url: input.url,
              description:
                input.description === undefined ? undefined : (input.description?.trim() ?? null),
              eventTags: input.eventTags,
              headers:
                input.headers === undefined
                  ? undefined
                  : input.headers === null || Object.keys(input.headers).length === 0
                    ? null
                    : yield* sealedHeaders(endpointId, input.headers),
            }),
          );
          if (input.enabled !== undefined) {
            const now = yield* DateTime.now;
            record = yield* notFound(
              records.setDisabled(endpointId, input.enabled ? null : { at: now, reason: "manual" }),
            );
          }
          yield* events.publish({
            _tag: "auth.webhooks.endpointUpdated",
            adminUserId: adminId(caller),
            endpointId,
            // Names only: a URL or a description never enters the audit trail.
            fields: UPDATE_FIELDS.filter((field) => input[field] !== undefined),
          });
          return toEndpointDto(record);
        },
      );

      const deleteEndpoint: WebhooksShape["deleteEndpoint"] = Effect.fnUntraced(
        function* (caller, endpointId) {
          yield* authorize(caller, "deleteEndpoint");
          yield* existing(endpointId);
          yield* records
            .deleteEndpoint(endpointId)
            .pipe(
              Effect.catchTag("WebhookRecordNotFound", () =>
                Effect.fail(new WebhooksApi.WebhookEndpointNotFound()),
              ),
            );
          yield* Effect.logInfo("awthaq/webhooks: endpoint deleted", { endpointId });
          yield* events.publish({
            _tag: "auth.webhooks.endpointDeleted",
            adminUserId: adminId(caller),
            endpointId,
          });
        },
      );

      const rotateSecret: WebhooksShape["rotateSecret"] = Effect.fnUntraced(
        function* (caller, endpointId) {
          const settings = yield* authorize(caller, "rotateSecret");
          const endpoint = yield* existing(endpointId);
          const now = yield* DateTime.now;
          // The current secret becomes the previous one — re-sealed, because its AAD names the field.
          const previous = yield* encryption
            .decrypt(endpoint.secret, WebhookSecrets.aad(endpointId, "secret"))
            .pipe(
              Effect.flatMap((decrypted) =>
                WebhookSecrets.seal(encryption, endpointId, "previousSecret", decrypted.plaintext),
              ),
              Effect.option,
            );
          const secret = yield* WebhookSignature.generateSecret.pipe(
            Effect.provideService(Crypto.Crypto, crypto),
          );
          const sealed = yield* WebhookSecrets.seal(encryption, endpointId, "secret", secret);
          const record = yield* records
            .setSecrets(endpointId, {
              secret: sealed,
              previousSecret: Option.getOrNull(previous),
              previousSecretExpiresAt: Option.isSome(previous)
                ? DateTime.addDuration(now, settings.secretGrace)
                : null,
            })
            .pipe(
              Effect.catchTag("WebhookRecordNotFound", () =>
                Effect.fail(new WebhooksApi.WebhookEndpointNotFound()),
              ),
            );
          yield* Effect.logInfo("awthaq/webhooks: endpoint secret rotated", { endpointId });
          yield* events.publish({
            _tag: "auth.webhooks.secretRotated",
            adminUserId: adminId(caller),
            endpointId,
          });
          return new WebhooksApi.EndpointWithSecretDto({
            endpoint: toEndpointDto(record),
            secret: Redacted.value(secret),
          });
        },
      );

      const listDeliveries: WebhooksShape["listDeliveries"] = Effect.fnUntraced(
        function* (caller, endpointId, query) {
          yield* authorize(caller, "listDeliveries");
          yield* existing(endpointId);
          const rows = yield* records.listDeliveries({
            endpointId,
            status: query.status,
            before: query.before,
            limit: query.limit ?? DEFAULT_PAGE,
          });
          return rows.map(toDeliveryDto);
        },
      );

      const retryDelivery: WebhooksShape["retryDelivery"] = Effect.fnUntraced(
        function* (caller, deliveryId) {
          yield* authorize(caller, "retryDelivery");
          const found = yield* records.findDelivery(deliveryId);
          if (Option.isNone(found))
            return yield* Effect.fail(new WebhooksApi.WebhookDeliveryNotFound());
          // BEH-EA-309: a delivery is visible through its endpoint's tenant only.
          yield* existing(found.value.endpointId).pipe(
            Effect.catchTag("WebhookEndpointNotFound", () =>
              Effect.fail(new WebhooksApi.WebhookDeliveryNotFound()),
            ),
          );
          if (found.value.status !== "dead") {
            return yield* Effect.fail(new WebhooksApi.WebhookDeliveryNotRetryable());
          }
          const now = yield* DateTime.now;
          const revived = yield* records
            .redrive(deliveryId, now)
            .pipe(
              Effect.catchTag("WebhookRecordNotFound", () =>
                Effect.fail(new WebhooksApi.WebhookDeliveryNotRetryable()),
              ),
            );
          return toDeliveryDto(revived);
        },
      );

      const testEndpoint: WebhooksShape["testEndpoint"] = Effect.fnUntraced(
        function* (caller, endpointId) {
          yield* authorize(caller, "testEndpoint");
          const endpoint = yield* existing(endpointId);
          if (Option.isSome(endpoint.disabledAt)) {
            return yield* Effect.fail(
              new WebhooksApi.InvalidWebhookEndpoint({
                reason: "the endpoint is disabled: enable it before sending a test",
              }),
            );
          }
          const now = yield* DateTime.now;
          const eventId = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
          const deliveryId = yield* crypto.randomUUIDv7.pipe(Effect.orDie);
          yield* records.enqueue([
            {
              id: deliveryId,
              endpointId,
              eventId,
              eventTag: WebhookPayload.TEST_EVENT_TAG,
              body: JSON.stringify(
                WebhookPayload.testBody({
                  eventId,
                  at: now,
                  endpointId,
                  tenantId: endpoint.tenantId,
                }),
              ),
              nextAttemptAt: now,
            },
          ]);
          yield* events.publish({
            _tag: "auth.webhooks.testQueued",
            adminUserId: adminId(caller),
            endpointId,
          });
          const queued = yield* records.findDelivery(deliveryId);
          if (Option.isNone(queued)) {
            return yield* Defects.invariantViolation(
              "RowVanished",
              "awthaq: the test delivery vanished right after it was queued",
            );
          }
          return toDeliveryDto(queued.value);
        },
      );

      return Webhooks.of({
        createEndpoint,
        listEndpoints,
        getEndpoint,
        updateEndpoint,
        deleteEndpoint,
        rotateSecret,
        listDeliveries,
        retryDelivery,
        testEndpoint,
      });
    }),
  });

  /**
   * Opt-in delivery machinery: the relay that tails the audit log into the delivery queue, and the worker
   * that sends what is queued. Requires `AuditLog`, a `RelayCursorStore`, the records, `Encryption`,
   * `RateLimiter`, `HostResolver`, a `WebhookTransport` (`WebhookTransport.layerNodePinned` connects to the
   * address the host was pinned to; `layerHttpClient` wraps any `HttpClient` and cannot pin) and `Crypto`;
   * run one per deployment.
   */
  static readonly background = WebhookDelivery.backgroundLayer;
}
