// Plan 28: the store contract on the bundle that seals `users.metadata` and `sessions.ipAddress`/
// `userAgent` (CSG-006). `:memory:` SQLite by default; under `pnpm test:pg` the same cases run on a
// Postgres schema (`TestSql`).
import * as StoreContract from "../src/StoreContract.ts";
import * as TestSql from "../src/TestSql.ts";
import { framework } from "./support/storeContract.ts";

StoreContract.run(framework, {
  mode: "sealed",
  label: "SQL",
  client: TestSql.layer("store_contract_sealed"),
});
