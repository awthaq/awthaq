#!/usr/bin/env node
// ESS-008: an internal `Data.TaggedError` and a wire `Schema.TaggedError` must never share a
// `_tag` string.
//
// Both taxonomies once used the same names (`SessionNotFound`, `TokenConsumed`,
// `EmailAlreadyExists`, ...), so a `catchTag("X")` could not say whether it meant the core error
// or the HTTP contract error, and a wrongly-typed bridge between them compiled fine. The rule:
// internal tags are prefixed by their service (`Sessions/NotFound`, `Users/EmailAlreadyExists`);
// wire tags are the HTTP contract and keep their plain names.
//
// Scans `packages/*/src` for the class declarations (a declaration is `class X extends
// Data.TaggedError("Tag")` or `class X extends Schema.TaggedError<X>()("Tag"`), so it needs no
// build and no imports across packages (which the dependency direction would forbid for a test
// living in `@awthaq/core`). Runs from `pnpm check`. Exit code 1 on any shared tag.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

const dataTags = new Map();
const schemaTags = new Map();
const note = (map, tag, where) => map.set(tag, [...(map.get(tag) ?? []), where]);

const dataPattern = /class\s+(\w+)\s+extends\s+Data\.TaggedError\(\s*"([^"]+)"/g;
const schemaPattern = /class\s+(\w+)\s+extends\s+Schema\.TaggedError<\w+>\(\)\(\s*"([^"]+)"/g;

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
    const text = readFileSync(path, "utf8");
    for (const [pattern, map] of [
      [dataPattern, dataTags],
      [schemaPattern, schemaTags],
    ]) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        note(map, match[2], `${relative(root, path)} (${match[1]})`);
      }
    }
  }
}

const shared = [...dataTags.keys()].filter((tag) => schemaTags.has(tag)).sort();
if (shared.length > 0) {
  console.error("error-tags: a Data.TaggedError and a Schema.TaggedError share a tag:");
  for (const tag of shared) {
    console.error(`  "${tag}"`);
    console.error(`    internal: ${dataTags.get(tag).join(", ")}`);
    console.error(`    wire:     ${schemaTags.get(tag).join(", ")}`);
  }
  console.error('Prefix the internal tag with its service, e.g. "Sessions/NotFound" (ADR-EA-013).');
  process.exit(1);
}
console.log(
  `error-tags: ${dataTags.size} internal and ${schemaTags.size} wire error tags, none shared`,
);
