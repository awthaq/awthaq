// Plan 22 (ADR-EA-004 rev 1.3): the schema lock. The structural schema core plus this plugin's migrations
// build on a fresh SQLite database, and the plugin's migration names in ledger order, are pinned in
// `schema.sqlite.json`. A refactor of how a migration is written must not move it; a deliberate schema
// change is a reviewed diff of that file (`vitest run --update`).
import { TestAuth } from "@awthaq/test";
import { expect, it } from "@effect/vitest";
import * as UserClaims from "../src/UserClaims.ts";

it("qadi: the migrated schema and the migration names are locked", async () => {
  const locked = await TestAuth.migratedSchema(UserClaims.UserClaims);
  await expect(JSON.stringify(locked, null, 2)).toMatchFileSnapshot("schema.sqlite.json");
});
