#!/usr/bin/env node
// ADR-EA-037: every real transaction in library source is opened through `@awthaq/ports`'
// `SqlTransaction` (the `SqlTransaction` service, whose `layerSql` is built on it, or
// `SqlTransaction.transactional(sql)`), never with a bare `sql.withTransaction(...)`.
//
// A bare call opens a transaction with no unit of work behind it, so an event published or an
// observe tap run inside it reaches live subscribers at once and cannot be taken back if the
// transaction rolls back (and an attempt event's audit row is erased with it). `SqlClient` is
// effect's own type, so the compiler cannot forbid the call; this script does.
//
// Scans `packages/*/src` for `\bsql\.withTransaction(` outside `packages/ports/src/SqlTransaction.ts`
// (the one place that calls it), skipping comment lines. Runs from `pnpm check`. Exit code 1 on any hit.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const allowed = join(packagesDir, "ports", "src", "SqlTransaction.ts");
const pattern = /\bsql\s*\.\s*withTransaction\s*\(/g;

const offenders = [];
for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  const src = join(packagesDir, pkg.name, "src");
  let files;
  try {
    files = readdirSync(src, { recursive: true }).filter((name) => /\.(ts|tsx)$/.test(name));
  } catch {
    continue;
  }
  for (const file of files) {
    const path = join(src, file);
    if (path === allowed) continue;
    const code = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line))
      .join("\n");
    for (const match of code.matchAll(pattern)) {
      offenders.push(`${relative(root, path)}:${code.slice(0, match.index).split("\n").length}`);
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "check-transactions: a bare `sql.withTransaction(...)` opens a transaction with no unit of work\n" +
      "(ADR-EA-037). Use `SqlTransaction.transactional(sql)(effect)` from @awthaq/ports instead:\n" +
      offenders.map((where) => `  ${where}`).join("\n"),
  );
  process.exit(1);
}
console.log("check-transactions: no bare sql.withTransaction in packages/*/src");
