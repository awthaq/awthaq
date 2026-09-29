// ERAS-006: the sqlite-dialect `CoreMigrations` branches and the repositories
// are meant to run over any sqlite-dialect driver, including the HTTP-capable
// ones an edge deployment would use (libSQL/Turso, D1). This runs the shared
// contract cases over `@effect/sql-libsql` (file: URL, so no server) — a
// driver that is not `node:sqlite` — so the README's driver matrix is not
// aspirational. `Migrator` holds the whole pending batch in `withTransaction`,
// which libSQL supports; D1 has no interactive transactions (see README).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { contractCases, repositoriesLayer } from "./contract.ts";

/** A fresh database file per layer build, removed when the layer's scope closes. */
const LibsqlLive = Layer.unwrap(
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "awthaq-libsql-"))),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  ).pipe(Effect.map((dir) => LibsqlClient.layer({ url: `file:${join(dir, "auth.db")}` }))),
);

contractCases(
  "Repositories contract (@effect/sql-libsql)",
  "sqlite",
  repositoriesLayer(LibsqlLive),
);
