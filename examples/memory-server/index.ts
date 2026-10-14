// @awthaq/example-memory-server
//
// Upstream-hardening map, ticket 09: a multi-plugin composition the
// README's own quickstart doesn't cover (Password + Organization,
// together), running over the in-memory persistence bundle (`Persistence.memory`
// plus each plugin's `records.memory`) instead of Postgres — no `DATABASE_URL`, no migration
// run, no `AWTHAQ_ENCRYPTION_KEY`. Additional to, not a replacement for,
// the README's own single-plugin Postgres quickstart (that one stays
// exactly as `shipping-gaps` ticket 29 shipped it).
//
// TRBS-005: this composition is single-process by construction — every
// memory layer here is a per-process `Ref`, so a session revoked on one
// instance is not revoked on another and state is lost on restart. Use the
// `Persistence.sql()` and each plugin's `records.sql` for anything multi-instance.
//
// Run it:
//   node --experimental-strip-types index.ts
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { main } from "./app.ts";

NodeRuntime.runMain(main(3001));
