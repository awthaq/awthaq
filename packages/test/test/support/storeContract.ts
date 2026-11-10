// The vitest `TestFramework` and the two file-backed clients the runner files pass to
// `StoreContract.run` (plan 37).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { TestFramework } from "../../src/TestFramework.ts";

export const framework: TestFramework = {
  describe: (name, body) => describe(name, body),
  // Postgres cases pay a round trip per statement, so give every case a generous budget.
  it: (name, body) => it(name, body, 60_000),
  fail: (message) => {
    throw new Error(message);
  },
};

/** A fresh database file per layer build, removed when the layer's scope closes (SEA-004). */
export const walFileClient = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "awthaq-store-contract-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    ),
    (dir) => SqliteClient.layer({ filename: join(dir, "auth.db") }),
  ),
);

/**
 * A fresh libSQL database file per layer build (a `file:` URL, so no server), removed when the layer's
 * scope closes: a driver that is not `node:sqlite`, proving the sqlite-dialect branches (ERAS-006).
 */
export const libsqlFileClient = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "awthaq-store-contract-libsql-"))),
      (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
    ),
    (dir) => LibsqlClient.layer({ url: `file:${join(dir, "auth.db")}` }),
  ),
);
