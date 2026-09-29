// Per package (a stub with an honest manifest is checked too), three local,
// credential-free checks that together catch more than a bare pack: the tarball
// assembles (npm pack --dry-run), the package.json shape is publish-correct
// (publint), and the published types actually resolve for TS consumers
// (@arethetypeswrong/cli).
//
// These inspect the emitted `lib/`, which `pnpm typecheck`'s `tsc -b` project
// references produce (so this runs after it in `pnpm check`). A missing `lib/` is
// reported once, up front, as an actionable error (MM-007) instead of as N
// confusing publint/attw failures. Anchored at the repo root, and an empty roster
// is a failure, not a skip (MTS-009).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
  console.error(`package:smoke: no packages/*/package.json files found under ${rootDir}`);
  process.exit(1);
}

/** Every relative file an `exports` map points at (wildcard targets are skipped). */
const exportTargets = (value) => {
  if (typeof value === "string")
    return value.startsWith("./") && !value.includes("*") ? [value] : [];
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(exportTargets);
  return [];
};

const missingBuildOutputs = packageJsonPaths.flatMap((packageJsonPath) => {
  const pkgDir = path.dirname(packageJsonPath);
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return exportTargets(manifest.exports)
    .filter((target) => !existsSync(path.join(pkgDir, target)))
    .map((target) => `${path.relative(rootDir, pkgDir)}: ${target}`);
});

if (missingBuildOutputs.length > 0) {
  console.error(
    "package:smoke: built output is missing, run `pnpm typecheck` (or `pnpm build`) first:",
  );
  for (const missing of missingBuildOutputs) console.error(`  - ${missing}`);
  process.exit(1);
}

// MTS-003: knip cannot see this by-path bin call, so knip.json's root `ignoreDependencies`
// names `@arethetypeswrong/cli` (the only entry left; every workspace is analysed strictly).
const attwBin = path.join(rootDir, "node_modules", ".bin", "attw");

let failed = false;

// AH-006: emitted declarations keep the `./X.ts` relative specifiers the sources use (only the
// emitted `.js` is rewritten to `.js`). That is deliberate and works, because TypeScript maps a
// `.ts` specifier inside a declaration file to its `.d.ts` sibling; this guard keeps it true for
// a consumer that is strict about it: a `nodenext` program with `skipLibCheck` off must not hit a
// *module-resolution* error anywhere in any package's declaration graph. (Other declaration
// diagnostics are out of scope here: a tsgo emit gap for `Model.Class` generics in
// `@awthaq/sql`'s Models.d.ts is tracked on its own.)
const consumerResolutionProblems = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "awthaq-consumer-"));
  try {
    mkdirSync(path.join(dir, "node_modules", "@awthaq"), { recursive: true });
    const imports = [];
    for (const packageJsonPath of packageJsonPaths) {
      const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const name = manifest.name.replace("@awthaq/", "");
      symlinkSync(path.dirname(packageJsonPath), path.join(dir, "node_modules", "@awthaq", name));
      for (const key of Object.keys(manifest.exports ?? {})) {
        imports.push(`import * as m${imports.length} from "${manifest.name}${key.slice(1)}";`);
      }
    }
    const entries = imports.map((_, i) => `void m${i};`);
    writeFileSync(path.join(dir, "index.ts"), [...imports, ...entries].join("\n"));
    writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "esnext",
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          jsx: "react-jsx",
          lib: ["esnext", "dom"],
          types: [],
        },
        files: ["index.ts"],
      }),
    );
    let output = "";
    try {
      execFileSync(path.join(rootDir, "node_modules", ".bin", "tsc"), ["-p", dir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      output = error && typeof error === "object" && "stdout" in error ? String(error.stdout) : "";
    }
    // 2307/2792 cannot find module, 2691/5097 a `.ts` extension is refused, 7016 no declaration.
    return output
      .split("\n")
      .filter((line) => /error TS(2307|2792|2691|5097|7016):/.test(line))
      .map((line) => line.replaceAll(rootDir, "."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

{
  const resolutionProblems = consumerResolutionProblems();
  if (resolutionProblems.length > 0) {
    console.error("package:smoke: FAIL nodenext consumer (skipLibCheck off) cannot resolve:");
    for (const line of resolutionProblems) console.error(`  - ${line}`);
    failed = true;
  } else {
    console.log("package:smoke: PASS nodenext consumer resolves every package's declarations");
  }
}

// DESS-001 drift guard — a rewritten README's snippets must only import what the
// package actually exports. (The "README claims the package is unshipped" guard is
// `scripts/check-readme-status.mjs`, `pnpm check:readmes`.)
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

// MTS-010: dependency classification must be publish-true. Neither publint nor attw checks
// it, so a test-only import parked in `dependencies` (forcing every consumer to install it) or
// a package the emitted `lib/` imports but the manifest only lists as a devDependency (a
// consumer's install breaks) went unnoticed. The built `lib/` is the truth: every bare
// specifier it (or its declarations) imports must be a declared runtime/peer dependency, and
// every declared runtime dependency must be reached by it.
const builtImportedPackages = (pkgDir) => {
  const libDir = path.join(pkgDir, "lib");
  const found = new Set();
  if (!existsSync(libDir)) return found;
  const files = readdirSync(libDir, { recursive: true }).filter((f) => /\.(js|d\.ts)$/.test(f));
  for (const file of files) {
    // Comments are stripped first: prose like `import "x"` in a doc comment is not an import.
    const text = readFileSync(path.join(libDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const m of text.matchAll(/(?:from\s+|import\(|import\s+)"([^".][^"]*)"/g)) {
      const spec = m[1];
      if (spec.startsWith("node:")) continue;
      found.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
    }
  }
  return found;
};

/** Problems with one package's dependency classification against what its built output imports. */
const dependencyClassificationProblems = (pkgDir, manifest) => {
  const runtime = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const imported = builtImportedPackages(pkgDir);
  const problems = [];
  for (const name of imported) {
    if (name === manifest.name || runtime.has(name)) continue;
    problems.push(
      `lib/ imports "${name}", which is not in dependencies/peerDependencies (a consumer's install would miss it)`,
    );
  }
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!imported.has(name)) {
      problems.push(
        `"${name}" is a runtime dependency but no built module imports it (test-only? move it to devDependencies)`,
      );
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
  if (SNIPPET_CHECKED_READMES.has(pkgName)) {
    problems.push(...(await snippetImportProblems(readme)));
  }

  // 6. MTS-010: dependency classification against the built output.
  problems.push(
    ...dependencyClassificationProblems(pkgDir, JSON.parse(readFileSync(packageJsonPath, "utf8"))),
  );

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
