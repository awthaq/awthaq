// @awthaq/test — Tools
//
// TestAuth test harness and the plugin contract-test suite (runPluginContractTests) — runs the whole plugin pipeline over an in-memory backend.
//
// Implemented: TestAuth.ts (spec/behaviors/25-testing-harness.md, BEH-EA-193 through BEH-EA-200 and the
// plan 08 additions): `TestAuth.layer(Auth.make([...]), options)` derives the host middleware the composed
// groups declare, selects every plugin's `records` bundle (memory, or a migrated SQL database) and declared
// `hookPoints`, and runs over `Persistence.memory`/`Persistence.sql()`; `TestAuth.app` serves it with a
// CSRF-aware `request`; `runPluginContractTests` is the plugin contract suite. The redaction half of
// BEH-EA-199 is mechanical (`RedactionGuard`).
// See spec/overview.md for the full package map.

export * as TestAuth from "./TestAuth.ts";
export * as TestEncryption from "./TestEncryption.ts";
export * as LaggingReplica from "./LaggingReplica.ts";
export * as CookieAssertions from "./CookieAssertions.ts";
export * as RedactionGuard from "./RedactionGuard.ts";
export * as SignInProbe from "./SignInProbe.ts";
export * as StoreContract from "./StoreContract.ts";
export * as TestSql from "./TestSql.ts";
