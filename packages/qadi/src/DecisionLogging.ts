// @awthaq/qadi — DecisionLogging
//
// TS-003 (BEH-EA-164/167): qadi ships a write-only `DecisionSink` port
// (ADR-QD: read optionally by `evaluate`, so it costs nothing until wired) but
// awthaq shipped no implementation, so an operator could not see *which policy
// denied which subject* without writing their own sink. These two layers are
// that implementation, opt-in the way every awthaq extra is — providing one IS
// the switch, there is no config flag to forget:
//
// - `DecisionSinkLog`: logs every denial (and every evaluation that could not
//   reach a verdict) with the subject, policy, action and evaluation id.
// - `DecisionSinkAudit`: the same, and additionally publishes an
//   `auth.authz.denied` `AuthEvent`, which `AuthEvents.publish` records in the
//   durable `AuditLog` — the denial is queryable after the process is gone.
//
// **BEH-EA-167 holds by construction:** `DecisionSinkShape.record` has an
// error channel of `never`, so a sink cannot change a decision; these layers
// only observe. An allow records nothing (denials are the security-relevant
// signal; qadi's own decision stream serves full traffic).
import { AuthEvents } from "@awthaq/core";
import { DecisionSink } from "@qadi/core";
import type { DecisionRecord, SinkRecord } from "@qadi/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Records what an evaluation came to, if it is worth surfacing; `undefined` for an allow or an obligation-gate record. */
const surface = (record: SinkRecord) => {
  if (record._tag !== "Decision") return undefined;
  const outcome = record.outcome;
  if (outcome._tag === "Failed") {
    return { kind: "failed" as const, record, reason: outcome.error._tag };
  }
  if (outcome.decision._tag === "Deny") {
    return { kind: "denied" as const, record, reason: outcome.decision.reason };
  }
  return undefined;
};

const logFields = (record: DecisionRecord, reason: string) => ({
  subjectId: record.subjectId,
  evaluationId: record.evaluationId,
  policy: record.policy._tag,
  action: record.action,
  reason,
});

/** Logs every denial at `warning` and every failed evaluation at `error`; changes no decision. */
export const DecisionSinkLog = Layer.succeed(
  DecisionSink,
  DecisionSink.of({
    record: (record) => {
      const seen = surface(record);
      if (seen === undefined) return Effect.void;
      return seen.kind === "denied"
        ? Effect.logWarning("awthaq.authz.denied", logFields(seen.record, seen.reason))
        : Effect.logError("awthaq.authz.evaluationFailed", logFields(seen.record, seen.reason));
    },
  }),
);

/** As `DecisionSinkLog`, and publishes each denial as an `auth.authz.denied` event into the durable `AuditLog`. */
export const DecisionSinkAudit = Layer.effect(
  DecisionSink,
  Effect.gen(function* () {
    const events = yield* AuthEvents.AuthEvents;
    return DecisionSink.of({
      record: (record) => {
        const seen = surface(record);
        if (seen === undefined) return Effect.void;
        if (seen.kind === "failed") {
          return Effect.logError(
            "awthaq.authz.evaluationFailed",
            logFields(seen.record, seen.reason),
          );
        }
        return Effect.logWarning("awthaq.authz.denied", logFields(seen.record, seen.reason)).pipe(
          Effect.andThen(
            events.publish({
              _tag: "auth.authz.denied",
              subjectId: seen.record.subjectId,
              evaluationId: seen.record.evaluationId,
              policyTag: seen.record.policy._tag,
              action: seen.record.action,
              reason: seen.reason,
            }),
          ),
        );
      },
    });
  }),
);
