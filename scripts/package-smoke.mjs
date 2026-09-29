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
import { fileURLToPath } from "node:url";
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
