// Plan 28: the store contract on the bundle that seals `users.metadata` and `sessions.ipAddress`/
// `userAgent` (CSG-006). `:memory:` SQLite by default; under `pnpm test:pg` the same cases run on a
// Postgres schema (`TestSql`).
import * as TestSql from "../src/TestSql.ts";
import { runSealedOnSql } from "./support/storeContract.ts";

runSealedOnSql("SQL", TestSql.layer("store_contract_sealed"));
