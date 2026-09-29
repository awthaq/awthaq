// @awthaq/core — Retention
//
// CSG-003/ALF-010 (wayfinder ticket 30, ADR-EA-031): the retention sweep. Expiry
// is a read-time rejection everywhere in this library — a session past its
// absolute expiry, a verification token past its TTL, a reservation past its
// window all stop *working* but their rows stay — so without a sweep the tables
// grow for ever. `Retention.sweep` is the one operation that physically deletes
// them, and it is opt-in twice over: nothing calls it unless the host does (or
// provides `layerScheduled`), and the audit trail is only ever purged when an
// operator configures a window for it (the default keeps everything: a forensic
// timeline is not something to delete on a guess).
//
// What is purged, and what the windows mean:
//   - sessions whose absolute or idle expiry is older than `sessionGrace`
//     (tombstoned refresh-rotation rows included — they keep their original
//     expiry, so reuse detection outlives the session's own life by the grace);
//   - verification tokens consumed or expired more than `verificationForensicWindow`
//     ago (`layerSql` keeps a consumed row as replay evidence, BEH-EA-058), and
//     expired reservations;
//   - audit rows older than the per-event-class windows in `auditLog`.
// The defaults (7 days, 90 days, audit forever) are a compliance policy an
// operator confirms for their jurisdiction, not a universal truth.
//
// Not covered: `admin_impersonation` and its hash-chained ledger are retained by
// decision (ADR-EA-031) — purging ended rows would break the chain that makes the
// ledger tamper-evident.

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { AuditLog } from "./AuditLog.ts";
import type { AuthEventTag } from "./AuthEventSchemas.ts";
import { Sessions } from "./Sessions.ts";
import { Verification } from "./Verification.ts";

/** Rows of these event tags are kept for `keepFor`, whatever `AuditRetention.default` says. */
export interface AuditRetentionRule {
  readonly tags: ReadonlyArray<AuthEventTag>;
  readonly keepFor: Duration.Duration;
}

export interface AuditRetention {
  /** How long an audit row of a tag no rule names is kept; `None` (the default) keeps it for ever. */
  readonly default: Option.Option<Duration.Duration>;
  /** Per-event-class windows; a tag named by no rule falls under `default`. A tag named twice takes the first rule. */
  readonly rules: ReadonlyArray<AuditRetentionRule>;
}

export interface RetentionConfigShape {
  /** How long past its expiry a session row is kept. Default 7 days. */
  readonly sessionGrace: Duration.Duration;
  /** How long a consumed or expired verification token is kept as evidence. Default 90 days. */
  readonly verificationForensicWindow: Duration.Duration;
  /** How often `layerScheduled` sweeps. Default 1 day. */
  readonly sweepInterval: Duration.Duration;
  /** Audit-trail windows; the default deletes nothing. */
  readonly auditLog: AuditRetention;
}

export const RetentionConfig = Context.Reference<RetentionConfigShape>(
  "awthaq/core/RetentionConfig",
  {
    defaultValue: () => ({
      sessionGrace: Duration.days(7),
      verificationForensicWindow: Duration.days(90),
      sweepInterval: Duration.days(1),
      auditLog: { default: Option.none(), rules: [] },
    }),
  },
);

/**
 * `Retention.config({ auditLog: { default: Option.some(Duration.days(365)), rules: [{ tags: ["auth.user.signInFailed"], keepFor: Duration.days(90) }] } })`
 * keeps failed sign-ins 90 days and every other audit row a year.
 */
export const config = (partial: Partial<RetentionConfigShape>) =>
  Layer.effect(
    RetentionConfig,
    Effect.map(Effect.service(RetentionConfig), (defaults): RetentionConfigShape => ({
      ...defaults,
      ...partial,
    })),
  );

export interface SweepReport {
  readonly sessionsDeleted: number;
  /** Tokens and reservations together. */
  readonly verificationRowsDeleted: number;
  readonly auditRowsDeleted: number;
}

const cutoff = (now: DateTime.Utc, window: Duration.Duration): DateTime.Utc =>
  DateTime.subtractDuration(now, window);

/**
 * Deletes what the configured windows say is past retention, once, and reports how
 * many rows went. Safe to run concurrently with normal traffic (bounded batches) and
 * idempotent.
 */
export const sweep = Effect.gen(function* () {
  const settings = yield* RetentionConfig;
  const sessions = yield* Sessions;
  const verification = yield* Verification;
  const auditLog = yield* AuditLog;
  const now = yield* DateTime.now;

  const sessionsDeleted = yield* sessions.purgeExpired(cutoff(now, settings.sessionGrace));
  const verificationRowsDeleted = yield* verification.purgeExpired(
    cutoff(now, settings.verificationForensicWindow),
  );

  // One delete per rule (a tag named by an earlier rule is left to it), then the default
  // window over every tag no rule named.
  let auditRowsDeleted = 0;
  const named: Array<AuthEventTag> = [];
  for (const rule of settings.auditLog.rules) {
    const tags = rule.tags.filter((tag) => !named.includes(tag));
    named.push(...tags);
    if (tags.length === 0) continue;
    auditRowsDeleted += yield* auditLog.purge({
      before: cutoff(now, rule.keepFor),
      eventTags: tags,
    });
  }
  if (Option.isSome(settings.auditLog.default)) {
    auditRowsDeleted += yield* auditLog.purge({
      before: cutoff(now, settings.auditLog.default.value),
      exceptTags: named,
    });
  }

  return { sessionsDeleted, verificationRowsDeleted, auditRowsDeleted } satisfies SweepReport;
});

/**
 * Opt-in: sweeps once at start-up, then every `RetentionConfig.sweepInterval`, in a scoped
 * background fiber. Not part of `Auth.make` or `TestAuth` — a host that wants scheduled
 * retention provides it; one that runs the sweep from its own job calls `sweep` instead. A
 * failed sweep is logged and retried at the next interval, never fatal.
 */
export const layerScheduled = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* RetentionConfig;
    const tick = sweep.pipe(
      Effect.tap((report) => Effect.logInfo("awthaq.retention.sweep", report)),
      Effect.catchCause((cause) => Effect.logError("awthaq.retention.sweep.failed", cause)),
    );
    yield* Effect.forkScoped(Effect.repeat(tick, Schedule.spaced(settings.sweepInterval)));
  }),
);
