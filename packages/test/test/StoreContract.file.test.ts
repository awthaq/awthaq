// Plan 02: the store contract on a SQLite WAL file, where two connections really lock (SEA-004).
import * as StoreContract from "../src/StoreContract.ts";
import { framework, walFileClient } from "./support/storeContract.ts";

StoreContract.run(framework, { mode: "sql", label: "SQLite WAL file", client: walFileClient });
