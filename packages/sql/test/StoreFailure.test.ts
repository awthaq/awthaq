// Plan 05, phase 1: `StoreFailure`, the one mapping from a store's failure to the typed
// `StoreUnavailable` (ADR-EA-028). Core had no direct tests of `retryTransient`; these are new.
import { Defects } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import {
  AuthorizationError,
  ConnectionError,
  ConstraintError,
  SqlError,
  SqlSyntaxError,
} from "effect/unstable/sql/SqlError";
import * as StoreFailure from "../src/StoreFailure.ts";

const sqlError = (reason: ConstructorParameters<typeof SqlError>[0]["reason"]) =>
  new SqlError({ reason });

const connection = () => sqlError(new ConnectionError({ cause: new Error("down") }));

describe("StoreFailure.orStoreUnavailable", () => {
  it.effect("a connection failure becomes StoreUnavailable naming the operation", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.fail(connection()).pipe(
        StoreFailure.orStoreUnavailable("Probe.read"),
        Effect.flip,
      );
      assert.instanceOf(failure, StoreFailure.StoreUnavailable);
      assert.strictEqual(failure.operation, "Probe.read");
    }),
  );

  it.effect("a statement refused as malformed or unauthorised is a defect, not a 503", () =>
    Effect.gen(function* () {
      for (const reason of [
        new SqlSyntaxError({ cause: new Error("syntax") }),
        new AuthorizationError({ cause: new Error("rls") }),
      ]) {
        const exit = yield* Effect.exit(
          Effect.fail(sqlError(reason)).pipe(StoreFailure.orStoreUnavailable("Probe.write")),
        );
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          const defect = exit.cause.reasons.find((r) => r._tag === "Die");
          assert.instanceOf(defect?.defect, Defects.InvariantViolation);
          assert.strictEqual(defect?.defect.invariant, "store.statementRefused");
        }
      }
    }),
  );

  it.effect("a SchemaError dies", () =>
    Effect.gen(function* () {
      const schemaError = yield* Effect.flip(Schema.decodeUnknownEffect(Schema.Number)("x"));
      const exit = yield* Effect.exit(
        Effect.fail(schemaError).pipe(StoreFailure.orStoreUnavailable("Probe.decode")),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.isTrue(exit.cause.reasons.some((r) => r._tag === "Die"));
    }),
  );
});

describe("StoreFailure.retryTransient", () => {
  const attempts = (failWith: SqlError | undefined, times: number) =>
    Effect.gen(function* () {
      let calls = 0;
      const exit = yield* Effect.exit(
        Effect.suspend(() => {
          calls += 1;
          return failWith === undefined ? Effect.succeed("ok") : Effect.fail(failWith);
        }).pipe(StoreFailure.retryTransient({ times, schedule: Schedule.recurs(10) })),
      );
      return { calls, exit };
    });

  it.effect("retries a retryable reason up to `times` more times, then fails with the last", () =>
    Effect.gen(function* () {
      const outcome = yield* attempts(connection(), 2);
      assert.strictEqual(outcome.calls, 3);
      assert.isTrue(Exit.isFailure(outcome.exit));
    }),
  );

  it.effect("never retries a constraint violation or a syntax error", () =>
    Effect.gen(function* () {
      for (const reason of [
        new ConstraintError({ cause: new Error("c") }),
        new SqlSyntaxError({ cause: new Error("s") }),
      ]) {
        const outcome = yield* attempts(sqlError(reason), 3);
        assert.strictEqual(outcome.calls, 1);
      }
    }),
  );

  it.effect("a success is not retried", () =>
    Effect.gen(function* () {
      const outcome = yield* attempts(undefined, 3);
      assert.strictEqual(outcome.calls, 1);
      assert.isTrue(Exit.isSuccess(outcome.exit));
    }),
  );
});
