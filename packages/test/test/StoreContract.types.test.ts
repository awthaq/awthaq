// Plan 37 ticket 04 (ADR-EA-041 decision 6): the compile-time half of `StoreContract.suite`.
// `tsc -p tsconfig.test.json` is the assertion; the token runtime test makes the file a suite.
//
// 1. An operation of the port's interface without a verdict is an error.
// 2. A suite built for one port cannot stand for another (`Suite<in out Id>`).
import { AuditLogStore, RelayCursorStore } from "@awthaq/ports";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as StoreContract from "../src/StoreContract.ts";

const fresh = { name: "zero", run: Effect.void };

// 1. Each builder is never called: it only has to fail to type-check.
export const unclassified = () =>
  StoreContract.suite(RelayCursorStore.RelayCursorStore, {
    // @ts-expect-error - `get` has no verdict
    operations: { advance: { atomic: [fresh], race: [fresh] } },
  });

// 2. A suite for RelayCursorStore is not a suite for AuditLogStore.
export const wrongPort = (
  relay: StoreContract.Suite<RelayCursorStore.RelayCursorStore>,
): StoreContract.Suite<AuditLogStore.AuditLogStore> =>
  // @ts-expect-error - a RelayCursorStore suite is not an AuditLogStore suite
  // @effect-diagnostics-next-line missingEffectContext:off
  relay;

// 3. A key of `Suites` holding another port's suite is an error; the exported `suites` satisfies it.
export const wrongKey: StoreContract.Suites = {
  ...StoreContract.suites,
  // @ts-expect-error - a RelayCursorStore suite is not the `auditLog` suite
  // @effect-diagnostics-next-line missingEffectContext:off
  auditLog: StoreContract.relayCursor,
};

it("is checked by tsc -p tsconfig.test.json", () => {});
