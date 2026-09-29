// TS-003 (BEH-EA-164/167): the opt-in DecisionSink implementations. A denied
// `evaluate` reaches the sink exactly once, the decision itself is untouched
// (a sink cannot change it — BEH-EA-167), and audit mode lands the denial in
// the durable `AuditLog` as `auth.authz.denied`.
import { AuditLog, AuthEvents } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import {
  currentSubjectLayer,
  evaluate,
  EvaluationServicesNone,
  hasRole,
  isAllowed,
  makeSubject,
} from "@qadi/core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as DecisionLogging from "../src/DecisionLogging.ts";

const CoreLive = AuthEvents.layer.pipe(Layer.provideMerge(AuditLog.layerMemory));

const denied = evaluate(hasRole("admin"), { action: "delete-project" }).pipe(
  Effect.provide(currentSubjectLayer(makeSubject({ id: "user:u-1" }))),
);
const allowed = evaluate(hasRole("admin"), { action: "delete-project" }).pipe(
  Effect.provide(currentSubjectLayer(makeSubject({ id: "user:u-2", roles: ["admin"] }))),
);

const captured: Array<{ level: string; message: unknown }> = [];
const CaptureLogs = Logger.layer([
  Logger.make((options) => {
    captured.push({ level: options.logLevel, message: options.message });
  }),
]);

describe("DecisionSinkLog (TS-003)", () => {
  it.effect(
    "a denied evaluate emits exactly one warning naming subject and policy; the decision is unchanged",
    () =>
      Effect.gen(function* () {
        captured.length = 0;
        const decision = yield* denied;
        assert.isFalse(isAllowed(decision));
        const warnings = captured.filter((entry) => entry.level === "Warn");
        assert.strictEqual(warnings.length, 1);
        const text = JSON.stringify(warnings[0]?.message);
        assert.include(text, "awthaq.authz.denied");
        assert.include(text, "user:u-1");
        assert.include(text, "delete-project");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(EvaluationServicesNone, DecisionLogging.DecisionSinkLog, CaptureLogs),
        ),
      ),
  );

  it.effect("an allow records nothing", () =>
    Effect.gen(function* () {
      captured.length = 0;
      const decision = yield* allowed;
      assert.isTrue(isAllowed(decision));
      assert.strictEqual(captured.filter((entry) => entry.level === "Warn").length, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(EvaluationServicesNone, DecisionLogging.DecisionSinkLog, CaptureLogs),
      ),
    ),
  );
});

describe("DecisionSinkAudit (TS-003)", () => {
  const AuditLive = Layer.mergeAll(EvaluationServicesNone, DecisionLogging.DecisionSinkAudit).pipe(
    Layer.provideMerge(CoreLive),
  );

  it.effect(
    "audit mode writes auth.authz.denied to the AuditLog and leaves the decision alone",
    () =>
      Effect.gen(function* () {
        const auditLog = yield* AuditLog.AuditLog;
        const decision = yield* denied;
        assert.isFalse(isAllowed(decision));

        const recorded = yield* auditLog.list({ eventTag: "auth.authz.denied" });
        assert.strictEqual(recorded.length, 1);
        assert.deepStrictEqual(recorded[0]?.actorUserId, Option.some("u-1"));
        const payload = recorded[0]?.payload;
        assert.isTrue(typeof payload === "object" && payload !== null);
        if (typeof payload === "object" && payload !== null) {
          assert.strictEqual(
            Object.entries(payload).find(([k]) => k === "action")?.[1],
            "delete-project",
          );
          assert.strictEqual(
            Object.entries(payload).find(([k]) => k === "subjectId")?.[1],
            "user:u-1",
          );
        }

        yield* allowed;
        assert.strictEqual((yield* auditLog.list({ eventTag: "auth.authz.denied" })).length, 1);
      }).pipe(Effect.provide(AuditLive)),
  );
});
