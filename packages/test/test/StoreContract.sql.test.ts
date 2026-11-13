// Plan 02: the store contract on the SQL adapters. `:memory:` SQLite by default; under
// `pnpm test:pg` the same cases run on a real Postgres schema (`TestSql`), concurrency included.
import * as StoreContract from "../src/StoreContract.ts";
import * as TestSql from "../src/TestSql.ts";
import { framework } from "./support/storeContract.ts";

StoreContract.run(framework, {
  mode: "sql",
  label: "SQL",
  client: TestSql.layer("store_contract"),
});
