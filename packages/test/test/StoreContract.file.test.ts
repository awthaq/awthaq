// Plan 02: the store contract on a SQLite WAL file, where two connections really lock (SEA-004).
import { runOnSql, walFileClient } from "./support/storeContract.ts";

runOnSql("SQLite WAL file", walFileClient);
