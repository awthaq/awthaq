// Plan 16: the store contract on libSQL (`@effect/sql-libsql`, a `file:` database, so no server). The
// README's driver matrix claims the shared cases pass here; this is the runner that makes it true.
import { libsqlFileClient, runOnSql } from "./support/storeContract.ts";

runOnSql("libSQL file", libsqlFileClient);
