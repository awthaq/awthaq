#!/usr/bin/env node
// DTWS-002: a package README must not claim its package is unshipped while the
// package ships real source (and must keep the banner while it is a placeholder).
//
// 20 of 21 READMEs once carried "This describes a planned package ... no line of
// source in this package has shipped yet" while shipping real code, which made
// every package look pre-implementation to a reader. The rule this enforces:
//
//   - a package whose `src/` is the empty placeholder (only `index.ts`, with no
//     `export` statement) MUST carry the "planned package" banner;
//   - a package with real source MUST NOT.
//
// Runs from `pnpm check`. Exit code 1 on any drift.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

const BANNER = "This describes a planned package";

const isPlaceholder = (srcDir) => {
  if (!existsSync(srcDir)) return true;
  const files = readdirSync(srcDir, { recursive: true }).filter((name) => /\.(ts|tsx)$/.test(name));
  if (files.length === 0) return true;
  if (files.length > 1) return false;
  const only = readFileSync(join(srcDir, files[0]), "utf8");
  // `export {};` is the placeholder's own marker, not an export.
  return !/^\s*export\s+(?!\{\s*\})/m.test(only);
};

const problems = [];
for (const name of readdirSync(packagesDir).sort()) {
  const readme = join(packagesDir, name, "README.md");
  if (!existsSync(readme)) continue;
  const bannered = readFileSync(readme, "utf8").includes(BANNER);
  const placeholder = isPlaceholder(join(packagesDir, name, "src"));
  if (bannered && !placeholder) {
    problems.push(`packages/${name}/README.md claims the package is planned, but it ships source`);
  } else if (!bannered && placeholder) {
    problems.push(
      `packages/${name}/README.md dropped the planned-package banner, but src/ is still a placeholder`,
    );
  }
}

if (problems.length > 0) {
  console.error(
    `readme-status: ${problems.length} drift(s)\n${problems.map((p) => `  ${p}`).join("\n")}`,
  );
  process.exit(1);
}
console.log("readme-status: every package README matches its package's shipped state");
