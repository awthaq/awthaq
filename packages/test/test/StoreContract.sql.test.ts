// Plan 02: the store contract on the SQL adapters. `:memory:` SQLite by default; under
// `pnpm test:pg` the same cases run on a real Postgres schema (`TestSql`), concurrency included.
import * as TestSql from "../src/TestSql.ts";
import { runOnSql } from "./support/storeContract.ts";

runOnSql("SQL", TestSql.layer("store_contract"));
