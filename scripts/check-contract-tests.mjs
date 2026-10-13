#!/usr/bin/env node
// Plan 08 (BEH-EA-T6): every shipped plugin class runs the plugin contract suite, and the test
// harness stays dev-only.
//
//   1. Collect every `export class X extends AuthPlugin.Service<` under `packages/*/src` and the
//      plugin template's `src`. The package that owns it MUST have `test/Contract.test.ts`, and that
//      file MUST call `runPluginContractTests` with a factory returning `X`. (13 of 20 classes had no
//      call in their own package before this check existed.)
//   2. `@awthaq/test` is dev-only: no `packages/*/src` file outside `packages/test` imports it, and no
//      `packages/*/package.json` or `examples/*/package.json` lists it under `dependencies`.
//
// Runs from `pnpm check`. Exit code 1 on any problem.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { rootDir } from "./_root.mjs";

const read = (file) => readFileSync(file, "utf8");
const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    : [];
const isSource = (file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(".d.ts");

const owners = [
  ...readdirSync(path.join(rootDir, "packages")).map((name) => path.join("packages", name)),
  path.join("examples", "plugin-template"),
];

const CLASS = /export class (\w+) extends AuthPlugin\.Service</g;
const problems = [];
let classCount = 0;

for (const owner of owners) {
  const classes = [];
  for (const file of walk(path.join(rootDir, owner, "src")).filter(isSource)) {
    for (const match of read(file).matchAll(CLASS)) classes.push(match[1]);
  }
  if (classes.length === 0) continue;
  classCount += classes.length;
  const contractFile = path.join(rootDir, owner, "test", "Contract.test.ts");
  if (!existsSync(contractFile)) {
    problems.push(`${owner}: has no test/Contract.test.ts (plugin classes: ${classes.join(", ")})`);
    continue;
  }
  // A call that is commented out does not run: strip comments before looking for calls.
  const code = read(contractFile).replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, "$1");
  const [, ...calls] = code.split("runPluginContractTests(");
  const covered = new Set(
    calls.flatMap((segment) => {
      const factory = /=>\s*(?:[\w$]+\.)*([\w$]+)/.exec(segment);
      return factory === null ? [] : [factory[1]];
    }),
  );
  for (const name of classes) {
    if (!covered.has(name)) {
      problems.push(`${owner}: plugin class ${name} is not run by test/Contract.test.ts`);
    }
  }
}

// An anchoring guard: a regex or a directory layout that matched nothing must not read as success.
if (classCount === 0) {
  problems.push("found no `AuthPlugin.Service` classes: the scan is anchored wrongly");
}

for (const owner of owners.slice(0, -1)) {
  if (owner === path.join("packages", "test")) continue;
  for (const file of walk(path.join(rootDir, owner, "src")).filter(isSource)) {
    if (/from\s+["']@awthaq\/test["']/.test(read(file))) {
      problems.push(
        `${path.relative(rootDir, file)}: library source imports @awthaq/test (dev-only)`,
      );
    }
  }
}

const manifests = [
  ...owners.slice(0, -1),
  ...readdirSync(path.join(rootDir, "examples")).map((name) => path.join("examples", name)),
];
for (const owner of manifests) {
  const manifest = path.join(rootDir, owner, "package.json");
  if (!existsSync(manifest)) continue;
  if (JSON.parse(read(manifest)).dependencies?.["@awthaq/test"] !== undefined) {
    problems.push(`${owner}/package.json lists @awthaq/test under dependencies (dev-only)`);
  }
}

if (problems.length > 0) {
  console.error(
    `contract-tests: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `contract-tests: all ${classCount} plugin classes run the contract suite; @awthaq/test stays dev-only`,
);
