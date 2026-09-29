// @awthaq/webhooks — WebhookPayload
//
// CWM-004 (ADR-EA-029/030): what leaves the process. An event already carries identifiers, never
// contact details (ADR-EA-029), so the body is the typed event plus a small envelope; this module
// adds the two rules that keep it that way for an *external* consumer:
//
//   - free text about a person (`PII_FIELDS`, the impersonation justification) is never sent, and
//   - the client address is sent only when the endpoint's plugin configuration asks for it
//     (`includeClientContext`), because it is personal data under GDPR and most consumers do not
//     need it. The user agent rides with it.
//
// A last, deliberately blunt rule is defence in depth for an event added later without thinking of
// this: any payload field named like a credential or contact detail is dropped. The event schema
// is the source of truth; this guard exists so a mistake there does not become a leak to a third party.
//
// Filters: an endpoint subscribes to exact event tags (`auth.user.signedIn`), to a family
// (`auth.organization.*`), or to everything (`*`). Every pattern must match at least one tag the
// library can publish, so a typo is refused at registration instead of silently delivering nothing.

import { AuthEvents } from "@awthaq/core";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Payload field names that are never sent, whatever an event schema says: anything that reads as a
 * credential or a contact detail (`email`, `accessToken`, `passwordHash`, `phone`, ...). Matched as a
 * substring, case-insensitively, because the failure this guards against is a *new* field with an
 * unforeseen name; no field of a shipped event matches (an identifier such as `credentialId` does not).
 */
const NEVER_SENT = /(email|phone|password|token|secret|hash|authorization|cookie)/i;

/** The fields `AuthEvents.publish` adds around a payload; they are re-shaped below, not copied. */
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "_tag",
  "eventId",
  "occurredAt",
  "correlationId",
  "traceId",
  "spanId",
  "ip",
  "userAgent",
  "tenantId",
]);

export interface PayloadOptions {
  /** Send the client address and user agent. Default off. */
  readonly includeClientContext: boolean;
}

/** The delivered document. `webhook-id` (the header) equals `id`. */
export interface WebhookBody {
  readonly version: 1;
  /** The event tag, e.g. `auth.user.signedIn`. */
  readonly type: string;
  /** The event id, stable across retries and the receiver's idempotency key. */
  readonly id: string;
  /** ISO instant the event was published. */
  readonly timestamp: string;
  readonly correlationId?: string;
  readonly traceId?: string;
  /** BEH-EA-309: the tenant (organization id) the event happened in; absent outside a tenant scope. An identifier, never a name. */
  readonly tenantId?: string;
  /** The event's own fields, minus what the rules above remove. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Present only with `includeClientContext`. */
  readonly client?: { readonly ip?: string; readonly userAgent?: string };
}

export const toBody = (event: AuthEvents.Published, options: PayloadOptions): WebhookBody => {
  const scrubbed = new Set(AuthEvents.PII_FIELDS[event._tag] ?? []);
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (ENVELOPE_FIELDS.has(key) || scrubbed.has(key) || NEVER_SENT.test(key)) continue;
    if (key === "clientIp" && !options.includeClientContext) continue;
    data[key] = value;
  }
  const correlationId = Option.getOrUndefined(event.correlationId);
  const traceId = Option.getOrUndefined(event.traceId);
  const tenantId = Option.getOrUndefined(event.tenantId);
  const ip = Option.getOrUndefined(event.ip);
  const userAgent = Option.getOrUndefined(event.userAgent);
  return {
    version: 1,
    type: event._tag,
    id: event.eventId,
    timestamp: DateTime.formatIso(event.occurredAt),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(tenantId === undefined ? {} : { tenantId }),
    data,
    ...(options.includeClientContext && (ip !== undefined || userAgent !== undefined)
      ? {
          client: {
            ...(ip === undefined ? {} : { ip }),
            ...(userAgent === undefined ? {} : { userAgent }),
          },
        }
      : {}),
  };
};

/** The user an event is about, for erasure and export of the delivery log: the first identifier field that names a user. */
export const subjectUserId = (event: AuthEvents.Published): string | undefined => {
  for (const key of ["userId", "targetUserId", "adminUserId"]) {
    const value: unknown = Reflect.get(event, key);
    if (typeof value === "string") return value;
  }
  return undefined;
};

// ---- tenants ---------------------------------------------------------------------------------

/**
 * BEH-EA-309: whether an endpoint of `endpointTenant` hears an event that happened in `eventTenant`. A tenant's
 * endpoint hears only its own tenant's events. The platform's own endpoint (no tenant) hears the events that
 * belong to no tenant, and every tenant's only when `hearAllTenants` is set: an operator's SIEM feed is a
 * deliberate choice, never a default.
 */
export const tenantRoutes = (
  endpointTenant: Option.Option<string>,
  eventTenant: Option.Option<string>,
  hearAllTenants: boolean,
): boolean =>
  Option.isSome(endpointTenant)
    ? Option.isSome(eventTenant) && eventTenant.value === endpointTenant.value
    : hearAllTenants || Option.isNone(eventTenant);

// ---- the test ping ---------------------------------------------------------------------------

/** The `type` of the synthetic event a test ping sends. No subscription filter can name it: it is sent to one endpoint on request. */
export const TEST_EVENT_TAG = "webhook.test";

/** BEH-EA-310: the synthetic document a test ping delivers: identifiers only, signed like any other delivery. */
export const testBody = (input: {
  readonly eventId: string;
  readonly at: DateTime.Utc;
  readonly endpointId: string;
  readonly tenantId: Option.Option<string>;
}): WebhookBody => ({
  version: 1,
  type: TEST_EVENT_TAG,
  id: input.eventId,
  timestamp: DateTime.formatIso(input.at),
  ...(Option.isSome(input.tenantId) ? { tenantId: input.tenantId.value } : {}),
  data: { endpointId: input.endpointId },
});

// ---- filters ---------------------------------------------------------------------------------

/** Every tag the library can publish. */
export const knownEventTags: ReadonlyArray<string> = AuthEvents.AuthEventSchema.members.flatMap(
  (member) => {
    const tag = member.fields._tag.ast.literal;
    return typeof tag === "string" ? [tag] : [];
  },
);

/** `*`, a family `prefix.*`, or an exact tag. */
export const patternMatches = (pattern: string, tag: string): boolean =>
  pattern === "*" ||
  (pattern.endsWith(".*") ? tag.startsWith(pattern.slice(0, -1)) : pattern === tag);

export const matchesAny = (patterns: ReadonlyArray<string>, tag: string): boolean =>
  patterns.some((pattern) => patternMatches(pattern, tag));

/** The first pattern that matches no publishable tag (a typo), or `undefined` when all do. */
export const unknownPattern = (patterns: ReadonlyArray<string>): string | undefined =>
  patterns.find((pattern) => !knownEventTags.some((tag) => patternMatches(pattern, tag)));
