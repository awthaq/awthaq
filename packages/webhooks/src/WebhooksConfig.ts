// @awthaq/webhooks — WebhooksConfig
//
// ADR-EA-011: the plugin's policy knobs as a `Context.Reference` with defaults, so it works with one
// line of setup and an application overrides only what it means to (`Webhooks.config({...})`).
// Split out of `Webhooks.ts` so the delivery worker and the admin service read one definition
// without a module cycle.

import type { AuthSubject } from "@qadi/core";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface RateBudget {
  readonly limit: number;
  readonly window: Duration.Duration;
}

export interface WebhooksConfigShape {
  /**
   * Fail-closed by default: an application that installs the plugin but never configures a gate
   * denies every administrative call. `action` names the operation (`createEndpoint`, `listDeliveries`, ...)
   * so a host can let an auditor read the log while only an owner registers receivers.
   */
  readonly canManageWebhooks: (input: {
    readonly admin: AuthSubject;
    readonly action: string;
  }) => Effect.Effect<boolean>;
  /** Registered endpoints, all together. */
  readonly maxEndpoints: number;
  /** Delivery attempts before a delivery is dead-lettered. */
  readonly maxAttempts: number;
  /** Delay before the second attempt; each later delay is `retryFactor` times the previous, capped at `retryMax`. */
  readonly retryBase: Duration.Duration;
  readonly retryFactor: number;
  readonly retryMax: Duration.Duration;
  /** Deadline for one request (connect through response headers). */
  readonly requestTimeout: Duration.Duration;
  /** Deliveries claimed per worker tick, and how many run at once. */
  readonly batchSize: number;
  readonly concurrency: number;
  /** How long the worker waits when nothing is due. */
  readonly pollInterval: Duration.Duration;
  /** A claimed delivery is invisible to other workers this long; a worker that dies leaves it to lapse and be retried. */
  readonly lease: Duration.Duration;
  /** How long a rotated-out secret stays accepted (both signatures are sent meanwhile). */
  readonly secretGrace: Duration.Duration;
  /** Consecutive dead-lettered deliveries after which an endpoint is switched off; `0` never does. */
  readonly disableAfterConsecutiveDead: number;
  /** Finished (`succeeded`/`dead`) delivery rows are pruned after this long. */
  readonly deliveryRetention: Duration.Duration;
  /** Send the client address and user agent with an event. Off by default: they are personal data. */
  readonly includeClientContext: boolean;
  /** Development and test only: allow `http:` and private/loopback endpoint URLs. Never in production. */
  readonly allowPrivateTargets: boolean;
  /** Outbound budget per endpoint: over it, deliveries wait (they are not failed). */
  readonly deliveryRate: RateBudget;
  /** Administrative calls per administrator. */
  readonly adminRate: RateBudget;
  readonly userAgent: string;
}

const defaultWebhooksConfig: WebhooksConfigShape = {
  canManageWebhooks: () => Effect.succeed(false),
  maxEndpoints: 20,
  maxAttempts: 8,
  retryBase: Duration.seconds(10),
  retryFactor: 3,
  retryMax: Duration.hours(6),
  requestTimeout: Duration.seconds(10),
  batchSize: 50,
  concurrency: 8,
  pollInterval: Duration.seconds(1),
  lease: Duration.minutes(1),
  secretGrace: Duration.hours(24),
  disableAfterConsecutiveDead: 10,
  deliveryRetention: Duration.days(30),
  includeClientContext: false,
  allowPrivateTargets: false,
  deliveryRate: { limit: 300, window: Duration.minutes(1) },
  adminRate: { limit: 60, window: Duration.minutes(1) },
  userAgent: "awthaq-webhooks/1",
};

export const WebhooksConfig: Context.Reference<WebhooksConfigShape> = Context.Reference(
  "awthaq/webhooks/Config",
  { defaultValue: () => defaultWebhooksConfig },
);

export const config = (partial: Partial<WebhooksConfigShape>) =>
  Layer.succeed(WebhooksConfig, { ...defaultWebhooksConfig, ...partial });

/** The wait before attempt `attemptsMade + 1`, after `attemptsMade` failed attempts (1-based). */
export const retryDelay = (settings: WebhooksConfigShape, attemptsMade: number): Duration.Duration =>
  Duration.min(
    Duration.times(settings.retryBase, settings.retryFactor ** Math.max(0, attemptsMade - 1)),
    settings.retryMax,
  );
