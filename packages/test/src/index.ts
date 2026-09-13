// @effect-auth/test — Tools
//
// TestAuth test harness and the plugin contract-test suite (runPluginContractTests) — runs the whole plugin pipeline over an in-memory backend.
//
// Implemented: TestAuth.ts (spec/behaviors/25-testing-harness.md, BEH-EA-193
// through BEH-EA-200 — see that module's own header comment for what is
// deliberately deferred: a permissive `RateLimiter` and hook veto/observe
// isolation, both blocked on core modules — `RateLimits.ts`/`HookPoint.ts` —
// that do not exist yet; the redaction half of BEH-EA-199, already
// documented by that behavior file itself as not mechanically verifiable
// today).
// See spec/overview.md for the full package map.

export * as TestAuth from "./TestAuth.ts";
