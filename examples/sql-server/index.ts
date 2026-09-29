// @awthaq/example-sql-server
//
// SEA-007: the runnable counterpart of the README quickstart. The same composition the
// quickstart shows, over a real, migrated SQL backend that is a SQLite file by default (no
// server to install) and Postgres as soon as `DATABASE_URL` is set. The plugin code does not
// change between the two; only the `SqlClient` layer does (see `app.ts`).
//
// Run it:
//   pnpm start
//   AWTHAQ_CSRF_SECRET="$(openssl rand -base64 32)" node --experimental-strip-types index.ts
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { main } from "./app.ts";

NodeRuntime.runMain(main(3002));
