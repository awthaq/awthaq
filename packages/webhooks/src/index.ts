// @awthaq/webhooks — Plugin
//
// Opt-in signed outbound webhooks over the event relay (CWM-004/MAPS-010, ADR-EA-030): Standard-
// Webhooks-style HMAC signatures, per-endpoint secrets sealed with the Encryption port, at-least-once
// delivery with retry, backoff and dead-letter, SSRF-safe endpoints, per-endpoint event filters, a
// delivery log, and a fail-closed admin API.
//
// spec/behaviors/34-webhooks.md, BEH-EA-275 through 282 and BEH-EA-299 through 303. See spec/overview.md for the full package map.

export * as WebhookDelivery from "./WebhookDelivery.ts";
export * as WebhookHeaders from "./WebhookHeaders.ts";
export * as WebhookPayload from "./WebhookPayload.ts";
export * as WebhookRecords from "./WebhookRecords.ts";
export * as WebhookSignature from "./WebhookSignature.ts";
export * as WebhookTransport from "./WebhookTransport.ts";
export * as Webhooks from "./Webhooks.ts";
export * as WebhooksApi from "./WebhooksApi.ts";
