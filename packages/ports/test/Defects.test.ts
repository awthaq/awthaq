// The three defect kinds are tagged, so a defect can be told apart from another without matching prose.
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Defects from "../src/Defects.ts";

const defectOf = (effect: Effect.Effect<never>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      if (!Exit.isFailure(exit)) return undefined;
      const reason = exit.cause.reasons.find(Cause.isDieReason);
      return reason?.defect;
    }),
  );

describe("Defects", () => {
  it.effect("unsupportedDialect dies with a tagged UnsupportedDialect naming the operation", () =>
    Effect.gen(function* () {
      const defect = yield* defectOf(Defects.unsupportedDialect("migrations"));
      assert.instanceOf(defect, Defects.UnsupportedDialect);
      if (!(defect instanceof Defects.UnsupportedDialect)) return;
      assert.strictEqual(defect._tag, "Defects/UnsupportedDialect");
      assert.strictEqual(defect.operation, "migrations");
      assert.strictEqual(defect.message, "awthaq: unsupported SQL dialect for migrations");
    }),
  );

  it.effect("invalidConfiguration and invariantViolation carry their field beside the sentence", () =>
    Effect.gen(function* () {
      const config = yield* defectOf(Defects.invalidConfiguration("ttl", "awthaq: ttl must be positive"));
      assert.instanceOf(config, Defects.InvalidConfiguration);
      if (config instanceof Defects.InvalidConfiguration) {
        assert.strictEqual(config.setting, "ttl");
        assert.strictEqual(config.message, "awthaq: ttl must be positive");
      }
      const invariant = yield* defectOf(
        Defects.invariantViolation(
          "MembershipVanished",
          "awthaq: membership vanished between check and write",
        ),
      );
      assert.instanceOf(invariant, Defects.InvariantViolation);
      if (invariant instanceof Defects.InvariantViolation) {
        assert.strictEqual(invariant.invariant, "MembershipVanished");
      }
    }),
  );
});
