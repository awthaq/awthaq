// Mirrors scripts/circular.mjs's own convention: glob.globSync returns an
// empty array (not an ENOENT) when packages/*/package.json doesn't exist
// yet, so this stays a harmless no-op rather than hard-failing on an
// unmatched shell glob.
//
// Per package (including bare stub packages like cli/api-key/magic-link/
// two-factor — metadata correctness is worth checking even for a stub),
// three local, credential-free checks that together catch more than a
// bare pack: the tarball assembles (npm pack --dry-run), the package.json
// shape is publish-correct (publint), and the published types actually
// resolve for TS consumers (@arethetypeswrong/cli). Runs after `pnpm
// typecheck` in the `check` script chain, since typecheck's `tsc -b`
// project references are what produce the real `lib/` output these
// checks pack and inspect.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as glob from "glob";
import { publint } from "publint";
import { formatMessage } from "publint/utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const packageJsonPaths = glob
  .globSync(["packages/*/package.json"], { cwd: rootDir, absolute: true })
  .sort();

if (packageJsonPaths.length === 0) {
  console.log("package:smoke: no packages/*/package.json files yet, skipping");
  process.exit(0);
}

const attwBin = path.join(rootDir, "node_modules", ".bin", "attw");

let failed = false;

// DESS-001 drift guards — a README must not describe a package as unbuilt once
// `src/` holds real modules, and a rewritten README's snippets must only import
// what the package actually exports.
const STALE_README_BANNER = "no line of source in this package has shipped yet";
// Packages whose README still carries the pre-implementation banner although
// `src/` has modules. Rewrite the README and delete the entry: this list only
// ever shrinks.
const STALE_README_ALLOWLIST = new Set([
  "admin",
  "api",
  "core",
  "oauth",
  "organization",
  "passkey",
  "password",
  "ports",
  "qadi",
  "server",
  "sql",
]);
// READMEs whose ```ts/```tsx `@awthaq/*` imports are checked against the built
// package's real exports.
const SNIPPET_CHECKED_READMES = new Set(["client", "react", "next"]);

/** The runtime export names of `@awthaq/<name>[/<subpath>]`, from its built `exports` entry. */
const builtExports = async (specifier) => {
  const [, name, ...rest] = specifier.split("/");
  const dir = path.join(rootDir, "packages", name);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const entry = manifest.exports[rest.length === 0 ? "." : `./${rest.join("/")}`];
  if (entry === undefined) return undefined;
  return Object.keys(await import(pathToFileURL(path.join(dir, entry.import)).href));
};

/** Problems in one README's snippets: an imported name that the package does not export. */
const snippetImportProblems = async (readme) => {
  const problems = [];
  for (const block of readme.matchAll(/```(?:ts|tsx)\n([\s\S]*?)```/g)) {
    for (const found of block[1].matchAll(
      /^import\s+(?!type\b)([^;"]*?)\s+from\s+"(@awthaq\/[^"]+)";/gm,
    )) {
      const [, clause, specifier] = found;
      const exported = await builtExports(specifier);
      if (exported === undefined) {
        problems.push(`README imports from "${specifier}", which the package does not export`);
        continue;
      }
      const named = clause.match(/\{([\s\S]*)\}/);
      const names =
        named === null
          ? []
          : named[1]
              .split(",")
              .map((part) => part.trim().split(/\s+as\s+/)[0])
              .filter(Boolean);
      for (const name of names) {
        if (!exported.includes(name)) {
          problems.push(`README imports { ${name} } from "${specifier}", which is not exported`);
        }
      }
    }
  }
  return problems;
};

for (const packageJsonPath of packageJsonPaths) {
  const pkgDir = path.dirname(packageJsonPath);
  const pkgName = path.basename(pkgDir);
  const problems = [];

  // 1. npm pack --dry-run --json — the tarball actually assembles.
  try {
    const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: pkgDir,
      encoding: "utf8",
    });
    const packResult = JSON.parse(packOutput);
    if (!Array.isArray(packResult) || packResult.length === 0) {
      problems.push("npm pack --dry-run produced no output");
    }
  } catch (error) {
    console.error(`package:smoke: FAIL ${pkgName} — npm pack --dry-run failed`);
    console.error(error instanceof Error ? error.message : error);
    failed = true;
    continue;
  }

  // 2. publint — package.json metadata / exports shape correctness.
  // level: "suggestion" surfaces everything so warnings/suggestions can
  // still be printed for visibility; only "error"-level messages fail
  // the check below.
  const { messages, pkg } = await publint({ pkgDir, level: "suggestion" });
  for (const message of messages) {
    const formatted = formatMessage(message, pkg);
    if (message.type === "error") {
      problems.push(`publint: ${formatted}`);
    } else {
      console.log(`package:smoke: ${pkgName} publint ${message.type}: ${formatted}`);
    }
  }

  // 3. @arethetypeswrong/cli — do the published types actually resolve
  // for TS consumers (the "works locally, breaks for TS consumers" class
  // of bug a bare pack/publint can't see). --pack runs its own npm pack
  // against pkgDir and cleans the tarball up afterward.
  //
  // Profile "esm-only" (not the default "strict"): every package here
  // ships `"type": "module"` with an `exports` map that only has
  // "types"/"bun"/"import"/"default" conditions — no "require", by
  // deliberate design (a plugin exposes no CJS entrypoint at all). attw's
  // default "strict" profile assumes dual CJS/ESM support and flags that
  // as NoResolution (node10) / CJSResolvesToESM (node16-cjs) on every one
  // of the 21 packages — a known-noisy default for an intentionally
  // ESM-only package shape, not a real problem; "esm-only" is attw's own
  // built-in profile for exactly this case (ignores node10/node16-cjs).
  try {
    execFileSync(attwBin, ["--pack", pkgDir, "--profile", "esm-only", "--format", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stdout =
      error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    problems.push(`attw: default-severity problems found${stdout ? `\n${stdout}` : ""}`);
  }

  // 4. RSC-002: the built client modules of @awthaq/react must still open with
  // the "use client" directive (tsc keeps a leading prologue; a future
  // build change that dropped it would silently break Server Component use).
  if (pkgName === "react") {
    for (const file of ["index.js", "Providers.js", "Hooks.js"]) {
      const built = readFileSync(path.join(pkgDir, "lib", file), "utf8");
      if (!built.startsWith('"use client";')) {
        problems.push(`lib/${file} does not start with "use client"`);
      }
    }
  }

  // 5. DESS-001: README drift.
  const readme = readFileSync(path.join(pkgDir, "README.md"), "utf8");
  const srcModules = glob
    .globSync(["src/**/*.{ts,tsx}"], { cwd: pkgDir })
    .filter((file) => file !== "src/index.ts").length;
  if (
    readme.includes(STALE_README_BANNER) &&
    srcModules > 1 &&
    !STALE_README_ALLOWLIST.has(pkgName)
  ) {
    problems.push(
      `README still says "${STALE_README_BANNER}" — rewrite it from the shipped modules ` +
        "(packages whose README is not yet rewritten are listed in STALE_README_ALLOWLIST)",
    );
  }
  if (SNIPPET_CHECKED_READMES.has(pkgName)) {
    problems.push(...(await snippetImportProblems(readme)));
  }

  if (problems.length > 0) {
    console.error(`package:smoke: FAIL ${pkgName}`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    failed = true;
  } else {
    console.log(`package:smoke: PASS ${pkgName}`);
  }
}

if (failed) {
  process.exit(1);
}
