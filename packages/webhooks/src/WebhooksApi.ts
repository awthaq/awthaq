// @awthaq/webhooks — WebhooksApi
//
// CWM-004 (ADR-EA-030 Decision 7): the administrator's contract for registering receivers and reading
// the delivery log. One group, `webhooks.admin` — a dotted sub-id of the plugin id whose segment
// `admin` puts it in the admin tier by construction (AR-003), so it rides `Api.AdminAuthentication`
// and can be firewalled to its own listener like the rest of the admin surface. Every endpoint is
// behind `WebhooksConfig.canManageWebhooks`, which denies by default (an application that installs
// this plugin and never configures the gate exposes nothing), and a caller that fails it learns
// nothing about which endpoint ids exist.
//
// The secret appears in exactly two responses — the creation of an endpoint and a rotation — and
// never again; every other shape here is secret-free.

import { Api } from "@awthaq/api";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

/** The caller failed `canManageWebhooks` (or is rate limited before it is asked). */
export class WebhooksActionDenied extends Schema.TaggedError<WebhooksActionDenied>()(
  "WebhooksActionDenied",
  {},
  { httpApiStatus: 403 },
) {}

/** An unknown endpoint id — only ever reported to a caller who passed the gate. */
export class WebhookEndpointNotFound extends Schema.TaggedError<WebhookEndpointNotFound>()(
  "WebhookEndpointNotFound",
  {},
  { httpApiStatus: 404 },
) {}

export class WebhookDeliveryNotFound extends Schema.TaggedError<WebhookDeliveryNotFound>()(
  "WebhookDeliveryNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** The URL or the event filter is not acceptable; `reason` says which rule (SSRF floor, unknown event tag, ...). */
export class InvalidWebhookEndpoint extends Schema.TaggedError<InvalidWebhookEndpoint>()(
  "InvalidWebhookEndpoint",
  { reason: Schema.String },
  { httpApiStatus: 422 },
) {}

export class WebhookEndpointLimitReached extends Schema.TaggedError<WebhookEndpointLimitReached>()(
  "WebhookEndpointLimitReached",
  { limit: Schema.Number },
  { httpApiStatus: 409 },
) {}

/** Only a dead-lettered delivery can be retried by hand. */
export class WebhookDeliveryNotRetryable extends Schema.TaggedError<WebhookDeliveryNotRetryable>()(
  "WebhookDeliveryNotRetryable",
  {},
  { httpApiStatus: 409 },
) {}

const PathIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.length > 0 && value.length <= 255
        ? undefined
        : "a non-empty id of at most 255 characters",
    ),
  ),
);

export const EndpointIdParams = Schema.Struct({ endpointId: PathIdSchema });
export type EndpointIdParams = typeof EndpointIdParams.Type;

export const DeliveryIdParams = Schema.Struct({ deliveryId: PathIdSchema });
export type DeliveryIdParams = typeof DeliveryIdParams.Type;

const UrlSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.length > 0 && value.length <= 2048 ? undefined : "a URL of at most 2048 characters",
    ),
  ),
);
const DescriptionSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      value.trim().length > 0 && value.length <= 500
        ? undefined
        : "a non-blank description of at most 500 characters",
    ),
  ),
);
const EventTagsSchema = Schema.Array(
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((value: string) =>
        value.length > 0 && value.length <= 100
          ? undefined
          : "an event tag of at most 100 characters",
      ),
    ),
  ),
).pipe(
  Schema.check(
    Schema.makeFilter((value: ReadonlyArray<string>) =>
      value.length > 0 && value.length <= 100 ? undefined : "between 1 and 100 event tags",
    ),
  ),
);

/** `eventTags` is required: an endpoint says what it wants (`["*"]` for everything). */
export const CreateEndpointPayload = Schema.Struct({
  url: UrlSchema,
  description: Schema.optional(DescriptionSchema),
  eventTags: EventTagsSchema,
});
export type CreateEndpointPayload = typeof CreateEndpointPayload.Type;

export const UpdateEndpointPayload = Schema.Struct({
  url: Schema.optional(UrlSchema),
  /** `null` clears it. */
  description: Schema.optional(Schema.NullOr(DescriptionSchema)),
  eventTags: Schema.optional(EventTagsSchema),
  /** `false` switches the endpoint off (pending deliveries wait), `true` switches it back on. */
  enabled: Schema.optional(Schema.Boolean),
});
export type UpdateEndpointPayload = typeof UpdateEndpointPayload.Type;

export const DeliveryStatusSchema = Schema.Literals(["pending", "succeeded", "dead"]);

export const MAX_PAGE_SIZE = 200;

export const ListDeliveriesQuery = Schema.Struct({
  status: Schema.optional(DeliveryStatusSchema),
  /** The last delivery id of the previous page. */
  before: Schema.optional(PathIdSchema),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })),
    ),
  ),
});
export type ListDeliveriesQuery = typeof ListDeliveriesQuery.Type;

/** The wire shape of an endpoint. Never carries a secret. */
export class EndpointDto extends Schema.Class<EndpointDto>("WebhookEndpointDto")({
  id: Schema.String,
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  eventTags: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  /** `manual` (an administrator) or `failing` (the consecutive-failure threshold); null while enabled. */
  disabledReason: Schema.NullOr(Schema.String),
  consecutiveDead: Schema.Number,
  /** ISO instant the previous secret stops being accepted; null when no rotation is in its grace window. */
  previousSecretExpiresAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

/** The creation and rotation responses: the secret, shown this once. */
export class EndpointWithSecretDto extends Schema.Class<EndpointWithSecretDto>(
  "WebhookEndpointWithSecretDto",
)({
  endpoint: EndpointDto,
  /** `whsec_...`: the receiver verifies signatures with it. It is not retrievable again. */
  secret: Schema.String,
}) {}

/** One row of the delivery log: outcomes only — no payload and no response body. */
export class DeliveryDto extends Schema.Class<DeliveryDto>("WebhookDeliveryDto")({
  id: Schema.String,
  endpointId: Schema.String,
  eventId: Schema.String,
  eventTag: Schema.String,
  status: DeliveryStatusSchema,
  attempts: Schema.Number,
  nextAttemptAt: Schema.String,
  lastAttemptAt: Schema.NullOr(Schema.String),
  lastStatusCode: Schema.NullOr(Schema.Number),
  /** An error class (`timeout`, `connect`, `blocked`, `status`, ...), never a message. */
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
}) {}

const gate = [WebhooksActionDenied, Api.RateLimited] as const;

export const WebhooksAdminGroup = HttpApiGroup.make("webhooks.admin")
  .add(
    HttpApiEndpoint.post("createEndpoint", "/admin/webhooks/endpoints", {
      payload: CreateEndpointPayload,
      success: EndpointWithSecretDto,
      error: [...gate, InvalidWebhookEndpoint, WebhookEndpointLimitReached],
    }),
  )
  .add(
    HttpApiEndpoint.get("listEndpoints", "/admin/webhooks/endpoints", {
      success: Schema.Array(EndpointDto),
      error: gate,
    }),
  )
  .add(
    HttpApiEndpoint.get("getEndpoint", "/admin/webhooks/endpoints/:endpointId", {
      params: EndpointIdParams,
      success: EndpointDto,
      error: [...gate, WebhookEndpointNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateEndpoint", "/admin/webhooks/endpoints/:endpointId", {
      params: EndpointIdParams,
      payload: UpdateEndpointPayload,
      success: EndpointDto,
      error: [...gate, WebhookEndpointNotFound, InvalidWebhookEndpoint],
    }),
  )
  .add(
    HttpApiEndpoint.delete("deleteEndpoint", "/admin/webhooks/endpoints/:endpointId", {
      params: EndpointIdParams,
      success: HttpApiSchema.Empty(204),
      error: [...gate, WebhookEndpointNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("rotateSecret", "/admin/webhooks/endpoints/:endpointId/rotate-secret", {
      params: EndpointIdParams,
      success: EndpointWithSecretDto,
      error: [...gate, WebhookEndpointNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("listDeliveries", "/admin/webhooks/endpoints/:endpointId/deliveries", {
      params: EndpointIdParams,
      query: ListDeliveriesQuery,
      success: Schema.Array(DeliveryDto),
      error: [...gate, WebhookEndpointNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.post("retryDelivery", "/admin/webhooks/deliveries/:deliveryId/retry", {
      params: DeliveryIdParams,
      success: DeliveryDto,
      error: [...gate, WebhookDeliveryNotFound, WebhookDeliveryNotRetryable],
    }),
  )
  // Same tier and CSRF posture as the rest of the admin surface: `CsrfProtection` declared last so it runs first.
  .middleware(Api.AdminAuthentication)
  .middleware(Api.CsrfProtection);

export const WebhooksApi = HttpApi.make("auth").add(WebhooksAdminGroup);
