// MTS-004: one source of truth for the package roster.
//
// `packages/*/package.json` (and `examples/*`) is the roster. Everything that
// enumerates it by hand is derived from it here, and `--check` (run by
// `pnpm check`) fails when any of them has drifted — a new package can no longer
// be added to some lists and silently missed by the others:
//
//   tsconfig.base.json        `paths`      one entry per package export (the `bun` condition
//                                          names the source file; `.` maps to src/index.ts)
//   tsconfig.json             `references` every package, `features`, and every example
//   tsconfig.packages.json    `references` every package's tsconfig.src.json (the `pnpm build` set)
//   .changeset/config.json    `fixed[0]`   every package (private ones too: `privatePackages.version`
//                                          is on, so they version with the group)
//   packages/*/tsconfig.src.json  `paths` + `references`  exactly the workspace packages its own src imports
//   vitest.config.ts          `projects`   `packages/*` plus each example that has a vitest config
//   knip.json                 `workspaces` no key may name a directory that no longer exists
//   README.md                 mentions     every package appears by name (`@awthaq/<x>` or `packages/<x>`)
//
// The inclusion rule is deliberately "all packages": every package builds and
// typechecks in this repo whether or not it is published yet. Publishing is a
// separate switch (`private`), governed by the changeset `access`/`publishConfig`.
//
//   node scripts/sync-workspace.mjs --check   verify, exit 1 naming file + missing/extra entries
//   node scripts/sync-workspace.mjs --write   rewrite the derived arrays/objects in place
//
// `--write` patches only the roster block of each file, so comments elsewhere in
// the JSONC files survive; existing entries keep their order, new ones are
// appended alphabetically.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { rootDir } from "./_root.mjs";

const mode = process.argv.includes("--write") ? "write" : "check";
if (!process.argv.includes("--write") && !process.argv.includes("--check")) {
  console.error("usage: node scripts/sync-workspace.mjs --check | --write");
  process.exit(2);
}

const read = (file) => readFileSync(path.join(rootDir, file), "utf8");
const dirs = (parent) =>
  readdirSync(path.join(rootDir, parent), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(path.join(rootDir, parent, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .sort();

/** Strips `//` and block comments from JSONC, leaving string contents alone. */
const stripJsonc = (text) => {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
};
const parseJsonc = (text) => JSON.parse(stripJsonc(text));

/** Index just past the bracket matching the one at `open`, skipping strings and comments. */
const matching = (text, open) => {
  const pair = text[open] === "[" ? "]" : "}";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else if (c === "[" || c === "{") {
      depth++;
    } else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0 && c === pair) return i + 1;
    }
  }
  throw new Error("unbalanced brackets");
};

const packages = dirs("packages").map((dir) => {
  const manifest = JSON.parse(read(`packages/${dir}/package.json`));
  return { dir, name: manifest.name, manifest };
});
const examples = dirs("examples");

const problems = [];
const report = (file, missing, extra) => {
  if (missing.length > 0) problems.push(`${file}: missing ${missing.join(", ")}`);
  if (extra.length > 0) problems.push(`${file}: stale ${extra.join(", ")}`);
};
const diff = (have, want) => [
  want.filter((x) => !have.includes(x)),
  have.filter((x) => !want.includes(x)),
];

/** Existing order is kept; new entries are appended alphabetically; stale ones dropped. */
const merged = (have, want) => [
  ...have.filter((x) => want.includes(x)),
  ...want.filter((x) => !have.includes(x)).sort(),
];

const writes = new Map();
const stage = (file, text) => writes.set(file, text);

const refsRendered = (paths, indent) =>
  paths.length === 0
    ? "[]"
    : `[\n${paths.map((p) => `${indent}  {\n${indent}    "path": ${JSON.stringify(p)}\n${indent}  }`).join(",\n")}\n${indent}]`;

// --- tsconfig.base.json `paths` ---------------------------------------------------
{
  const file = "tsconfig.base.json";
  const text = read(file);
  const have = parseJsonc(text).compilerOptions.paths ?? {};
  const want = {};
  for (const { dir, name, manifest } of packages) {
    for (const [subpath, target] of Object.entries(manifest.exports ?? { ".": {} })) {
      const source =
        typeof target === "object" && typeof target.bun === "string"
          ? target.bun
          : "./src/index.ts";
      want[subpath === "." ? name : `${name}/${subpath.slice(2)}`] = [
        `./packages/${dir}/${source.slice(2)}`,
      ];
    }
  }
  const wanted = Object.keys(want);
  const held = Object.keys(have);
  // Only `@awthaq/*` keys are roster-owned; anything else (e.g. `@/*`) would be left alone.
  const [missing, extra] = diff(
    held.filter((k) => k.startsWith("@awthaq/")),
    wanted,
  );
  const wrong = wanted.filter(
    (k) => held.includes(k) && JSON.stringify(have[k]) !== JSON.stringify(want[k]),
  );
  report(file, missing, extra);
  if (wrong.length > 0) problems.push(`${file}: wrong target for ${wrong.join(", ")}`);
  if (mode === "write" && (missing.length > 0 || extra.length > 0 || wrong.length > 0)) {
    const keys = merged(
      held.filter((k) => k.startsWith("@awthaq/")),
      wanted,
    );
    const lines = keys.map((k) => `      ${JSON.stringify(k)}: ${JSON.stringify(want[k])}`);
    const paths = text.indexOf('"paths"');
    const open = text.indexOf("{", paths);
    stage(
      file,
      text.slice(0, open) + `{\n${lines.join(",\n")}\n    }` + text.slice(matching(text, open)),
    );
  }
}

// --- references lists ------------------------------------------------------------
const checkReferences = (file, want) => {
  const text = read(file);
  const have = parseJsonc(text).references.map((ref) => ref.path);
  const [missing, extra] = diff(have, want);
  report(file, missing, extra);
  if (mode === "write" && (missing.length > 0 || extra.length > 0)) {
    const at = text.indexOf('"references"');
    const open = text.indexOf("[", at);
    stage(
      file,
      text.slice(0, open) +
        refsRendered(merged(have, want), "  ") +
        text.slice(matching(text, open)),
    );
  }
};
checkReferences("tsconfig.json", [
  ...packages.map(({ dir }) => `packages/${dir}`),
  "features",
  ...examples.map((dir) => `examples/${dir}`),
]);
checkReferences(
  "tsconfig.packages.json",
  packages.map(({ dir }) => `packages/${dir}/tsconfig.src.json`),
);

// --- each package's tsconfig.src.json: exactly what its src imports ---------------
// (MM-002, MTS-001) `paths` maps a workspace import to source and `references` orders the
// project build; both must name exactly the `@awthaq/*` packages the package's own `src/`
// imports (type-only imports included), no more and no fewer: a dependency's own imports are
// resolved inside *its* project, so transitive ones are not repeated here. A stale edge is a
// false build dependency (a change to an unrelated package rebuilds this one); a missing one
// silently resolves to the built `lib/` instead of the source. Every export of an imported
// package (its `.` entry and subpaths) gets a `paths` entry.
{
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const importsOf = (dir) => {
    const found = new Set();
    const walk = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const source = readFileSync(full, "utf8");
          for (const m of source.matchAll(
            /(?:from|import\()\s*"(@awthaq\/[a-z0-9-]+)(?:\/[^"]*)?"/g,
          ))
            found.add(m[1]);
        }
      }
    };
    const src = path.join(rootDir, "packages", dir, "src");
    if (existsSync(src)) walk(src);
    return found;
  };
  const direct = new Map(
    packages.map(({ dir, name }) => [
      name,
      [...importsOf(dir)].filter((n) => n !== name && byName.has(n)),
    ]),
  );
  for (const { dir, name } of packages) {
    const file = `packages/${dir}/tsconfig.src.json`;
    if (!existsSync(path.join(rootDir, file))) continue;
    const deps = [...(direct.get(name) ?? [])].sort();
    const wantPaths = {};
    for (const dep of deps) {
      const { dir: depDir, manifest } = byName.get(dep);
      for (const [subpath, target] of Object.entries(manifest.exports ?? { ".": {} })) {
        const source =
          typeof target === "object" && typeof target.bun === "string"
            ? target.bun
            : "./src/index.ts";
        wantPaths[subpath === "." ? dep : `${dep}/${subpath.slice(2)}`] = [
          `../${depDir}/${source.slice(2)}`,
        ];
      }
    }
    const text = read(file);
    const parsed = parseJsonc(text);
    const havePaths = parsed.compilerOptions?.paths ?? {};
    const heldKeys = Object.keys(havePaths).filter((k) => k.startsWith("@awthaq/"));
    const [missingKeys, extraKeys] = diff(heldKeys, Object.keys(wantPaths));
    const wrongKeys = Object.keys(wantPaths).filter(
      (k) => k in havePaths && JSON.stringify(havePaths[k]) !== JSON.stringify(wantPaths[k]),
    );
    const wantRefs = deps.map((dep) => `../${byName.get(dep).dir}/tsconfig.src.json`);
    const haveRefs = (parsed.references ?? []).map((ref) => ref.path);
    const [missingRefs, extraRefs] = diff(haveRefs, wantRefs);
    report(
      file,
      [...missingKeys.map((k) => `paths ${k}`), ...missingRefs.map((r) => `reference ${r}`)],
      [...extraKeys.map((k) => `paths ${k}`), ...extraRefs.map((r) => `reference ${r}`)],
    );
    if (wrongKeys.length > 0)
      problems.push(`${file}: wrong paths target for ${wrongKeys.join(", ")}`);
    const drifted =
      missingKeys.length +
        extraKeys.length +
        wrongKeys.length +
        missingRefs.length +
        extraRefs.length >
      0;
    if (mode === "write" && drifted) {
      const keys = merged(heldKeys, Object.keys(wantPaths));
      const lines = [
        ...(parsed.compilerOptions?.paths?.["@/*"] === undefined
          ? []
          : [`      "@/*": ${JSON.stringify(havePaths["@/*"])}`]),
        ...keys.map((k) => `      ${JSON.stringify(k)}: ${JSON.stringify(wantPaths[k])}`),
      ];
      let next = text;
      const pathsAt = next.indexOf('"paths"');
      const pathsOpen = next.indexOf("{", pathsAt);
      next =
        next.slice(0, pathsOpen) +
        `{\n${lines.join(",\n")}\n    }` +
        next.slice(matching(next, pathsOpen));
      const refsAt = next.indexOf('"references"');
      const refsOpen = next.indexOf("[", refsAt);
      next =
        next.slice(0, refsOpen) +
        refsRendered(merged(haveRefs, wantRefs), "  ") +
        next.slice(matching(next, refsOpen));
      stage(file, next);
    }
  }
}

// --- changesets `fixed` group ----------------------------------------------------
{
  const file = ".changeset/config.json";
  const text = read(file);
  const have = JSON.parse(text).fixed?.[0] ?? [];
  const want = packages.map(({ name }) => name).sort();
  const [missing, extra] = diff(have, want);
  report(file, missing, extra);
  if (mode === "write" && (missing.length > 0 || extra.length > 0)) {
    const at = text.indexOf('"fixed"');
    const open = text.indexOf("[", at);
    const items = want.map((n) => `      ${JSON.stringify(n)}`).join(",\n");
    stage(
      file,
      text.slice(0, open) + `[\n    [\n${items}\n    ]\n  ]` + text.slice(matching(text, open)),
    );
  }
}

// --- vitest projects (check only: the list is hand-written on purpose) ------------
{
  const file = "vitest.config.ts";
  const text = read(file);
  const listed = [...text.matchAll(/projects:\s*\[([^\]]*)\]/g)].flatMap((m) =>
    [...m[1].matchAll(/"([^"]+)"/g)].map((s) => s[1]),
  );
  const want = [
    "packages/*",
    ...examples
      .filter((dir) => existsSync(path.join(rootDir, "examples", dir, "vitest.config.ts")))
      .map((dir) => `examples/${dir}`),
  ];
  const [missing, extra] = diff(listed, want);
  report(file, missing, extra);
}

// --- knip.json workspaces: no key for a directory that is gone --------------------
{
  const file = "knip.json";
  const keys = Object.keys(parseJsonc(read(file)).workspaces ?? {});
  const gone = keys.filter(
    (key) => key !== "." && !existsSync(path.join(rootDir, key, "package.json")),
  );
  report(file, [], gone);
}

// --- README: every package is named ----------------------------------------------
{
  const readme = read("README.md");
  const missing = packages
    .filter(({ dir, name }) => !readme.includes(name) && !readme.includes(`packages/${dir}`))
    .map(({ name }) => name);
  report("README.md", missing, []);
}

if (mode === "write") {
  for (const [file, text] of writes) writeFileSync(path.join(rootDir, file), text);
  console.log(
    writes.size === 0
      ? "sync-workspace: nothing to rewrite"
      : `sync-workspace: rewrote ${[...writes.keys()].join(", ")}`,
  );
  if (
    problems.some(
      (p) =>
        p.startsWith("README.md") || p.startsWith("vitest.config.ts") || p.startsWith("knip.json"),
    )
  ) {
    console.error("sync-workspace: these are checked but not rewritten (edit by hand):");
    for (const problem of problems.filter((p) =>
      /^(README\.md|vitest\.config\.ts|knip\.json)/.test(p),
    ))
      console.error(`  - ${problem}`);
    process.exit(1);
  }
} else if (problems.length > 0) {
  console.error(
    "sync-workspace: the package roster has drifted (fix with `pnpm workspace:sync`, or by hand where noted):",
  );
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
} else {
  console.log(
    `sync-workspace: ${packages.length} packages and ${examples.length} examples match every roster`,
  );
}
