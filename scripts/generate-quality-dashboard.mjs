#!/usr/bin/env node
// Generates a self-contained HTML type-system quality dashboard for the
// awthaq monorepo from per-package KPI JSON files (see
// /tmp/awthaq-kpi/CONTRACT.md for the 50-KPI contract).
//
// Usage: node scripts/generate-quality-dashboard.mjs [--metrics-dir DIR] [--out FILE]

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const METRICS_DIR = resolve(argOf("--metrics-dir", ".quality-metrics"));
const OUT = resolve(argOf("--out", "type-quality-dashboard.html"));

// ---------------------------------------------------------------------------
// 50-KPI registry. dir: lower|higher|band|bool. scored:false => context KPI.
// warn/fail are the scoring thresholds (score 100 at warn-side, 0 past fail).
// ---------------------------------------------------------------------------
const CATS = {
  A: {
    name: "Type Safety",
    w: 0.3,
    hue: "#4FC3F7",
    blurb: "escape hatches, suppressions, soundness",
  },
  B: {
    name: "Type Complexity",
    w: 0.15,
    hue: "#B18CFF",
    blurb: "generics, conditionals, union width",
  },
  C: { name: "Effect Idiom", w: 0.15, hue: "#FFB454", blurb: "gen vs flatMap, schema, services" },
  D: { name: "Maintainability", w: 0.25, hue: "#34F5A2", blurb: "file size, branching, docs" },
  E: { name: "Coupling", w: 0.15, hue: "#FF7AB6", blurb: "deps, exports, config drift" },
};

const KPI_META = [
  // A — Type Safety
  {
    id: "A1",
    key: "anyUsage",
    cat: "A",
    label: "`any` usage",
    dir: "lower",
    warn: 1,
    fail: 3,
    agg: "sum",
    w: 1.5,
    scored: true,
    desc: "Occurrences of the any type in source. Every any erases checking.",
  },
  {
    id: "A2",
    key: "asAnyCasts",
    cat: "A",
    label: "as any casts",
    dir: "lower",
    warn: 0,
    fail: 1,
    agg: "sum",
    w: 2,
    scored: true,
    desc: "Explicit casts to any — the loudest soundness escape hatch.",
  },
  {
    id: "A3",
    key: "typeAssertions",
    cat: "A",
    label: "type assertions",
    dir: "lower",
    warn: 1,
    fail: 4,
    agg: "sum",
    w: 1,
    scored: true,
    desc: "`as T` casts (excluding as const / as any / as unknown).",
  },
  {
    id: "A4",
    key: "nonNullAssertions",
    cat: "A",
    label: "non-null `!`",
    dir: "lower",
    warn: 0,
    fail: 2,
    agg: "sum",
    w: 1.5,
    scored: true,
    desc: "Postfix non-null assertions — unchecked nullability overrides.",
  },
  {
    id: "A5",
    key: "suppressions",
    cat: "A",
    label: "suppressions",
    dir: "lower",
    warn: 0,
    fail: 0,
    agg: "sum",
    w: 2,
    scored: true,
    desc: "@ts-ignore / @ts-expect-error / @ts-nocheck. Zero tolerance.",
  },
  {
    id: "A6",
    key: "strictEnabled",
    cat: "A",
    label: "strict mode",
    dir: "bool",
    agg: "and",
    w: 1.5,
    scored: true,
    desc: "strict: true in the effective tsconfig.",
  },
  {
    id: "A7",
    key: "noUncheckedIndexedAccess",
    cat: "A",
    label: "unchecked-index guard",
    dir: "bool",
    agg: "and",
    w: 2,
    scored: true,
    desc: "noUncheckedIndexedAccess — critical for an auth library.",
  },
  {
    id: "A8",
    key: "unknownOverAnyPct",
    cat: "A",
    label: "unknown over any",
    dir: "higher",
    warn: 95,
    fail: 70,
    agg: "locavg",
    w: 1,
    scored: true,
    neutralIfZero: true,
    unit: "%",
    desc: "Share of unknown vs any used for opaque data.",
  },
  {
    id: "A9",
    key: "explicitReturnTypesPct",
    cat: "A",
    label: "explicit returns",
    dir: "higher",
    warn: 80,
    fail: 50,
    agg: "locavg",
    w: 1,
    scored: true,
    neutralIfZero: true,
    unit: "%",
    desc: "Exported functions annotating their return type.",
  },
  {
    id: "A10",
    key: "brandedTypes",
    cat: "A",
    label: "branded types",
    dir: "higher",
    warn: 1,
    fail: 0,
    agg: "sum",
    w: 0.5,
    scored: true,
    desc: "Nominal typing via Brand / Tagged / Schema.brand.",
  },
  // B — Type Complexity
  {
    id: "B1",
    key: "exportedTypeCount",
    cat: "B",
    label: "exported types",
    agg: "sum",
    scored: false,
    desc: "Exported type aliases + interfaces. Context: API surface.",
  },
  {
    id: "B2",
    key: "maxGenericArity",
    cat: "B",
    label: "max generic arity",
    dir: "lower",
    warn: 3,
    fail: 5,
    agg: "max",
    w: 1.5,
    scored: true,
    desc: "Highest type-parameter count on one declaration.",
  },
  {
    id: "B3",
    key: "genericDeclarations",
    cat: "B",
    label: "generic declarations",
    agg: "sum",
    scored: false,
    desc: "Declarations carrying type parameters.",
  },
  {
    id: "B4",
    key: "conditionalTypes",
    cat: "B",
    label: "conditional types",
    dir: "lower",
    warn: 2,
    fail: 6,
    agg: "sum",
    w: 1,
    scored: true,
    desc: "T extends X ? A : B in type positions.",
  },
  {
    id: "B5",
    key: "mappedTypes",
    cat: "B",
    label: "mapped types",
    dir: "lower",
    warn: 1,
    fail: 4,
    agg: "sum",
    w: 0.75,
    scored: true,
    desc: "[K in ...] remappings.",
  },
  {
    id: "B6",
    key: "maxUnionSize",
    cat: "B",
    label: "max union size",
    dir: "lower",
    warn: 6,
    fail: 10,
    agg: "max",
    w: 1,
    scored: true,
    desc: "Widest single union type.",
  },
  {
    id: "B7",
    key: "intersectionTypes",
    cat: "B",
    label: "intersections",
    dir: "lower",
    warn: 3,
    fail: 8,
    agg: "sum",
    w: 0.5,
    scored: true,
    desc: "& compositions in type positions.",
  },
  {
    id: "B8",
    key: "templateLiteralTypes",
    cat: "B",
    label: "template literal types",
    dir: "lower",
    warn: 2,
    fail: 5,
    agg: "sum",
    w: 0.5,
    scored: true,
    desc: "`${...}` string types.",
  },
  {
    id: "B9",
    key: "inferUsage",
    cat: "B",
    label: "infer usage",
    dir: "lower",
    warn: 3,
    fail: 8,
    agg: "sum",
    w: 0.5,
    scored: true,
    desc: "infer sites in conditional types.",
  },
  {
    id: "B10",
    key: "utilityTypes",
    cat: "B",
    label: "utility types",
    dir: "lower",
    warn: 10,
    fail: 25,
    agg: "sum",
    w: 0.5,
    scored: true,
    desc: "Pick/Omit/Record/ReturnType/... derivations.",
  },
  // C — Effect Idiom
  {
    id: "C1",
    key: "effectGenCount",
    cat: "C",
    label: "Effect.gen",
    agg: "sum",
    scored: false,
    desc: "Effect.gen blocks.",
  },
  {
    id: "C2",
    key: "flatMapCount",
    cat: "C",
    label: "flatMap chains",
    agg: "sum",
    scored: false,
    desc: ".flatMap / Effect.flatMap occurrences.",
  },
  {
    id: "C3",
    key: "genPreferencePct",
    cat: "C",
    label: "gen preference",
    dir: "higher",
    warn: 70,
    fail: 40,
    agg: "genratio",
    w: 2,
    scored: true,
    neutralIfZero: true,
    unit: "%",
    desc: "Effect.gen share of sequencing (gen vs flatMap).",
  },
  {
    id: "C4",
    key: "schemaDeclarations",
    cat: "C",
    label: "schema declarations",
    agg: "sum",
    scored: false,
    desc: "Schema.* usages — declarative validation surface.",
  },
  {
    id: "C5",
    key: "serviceTags",
    cat: "C",
    label: "service tags",
    agg: "sum",
    scored: false,
    desc: "Context.Tag services.",
  },
  {
    id: "C6",
    key: "layerCount",
    cat: "C",
    label: "layers",
    agg: "sum",
    scored: false,
    desc: "Layer.* usages.",
  },
  {
    id: "C7",
    key: "taggedErrors",
    cat: "C",
    label: "tagged errors",
    agg: "sum",
    scored: false,
    desc: "Data.TaggedError / TaggedError — typed error channel.",
  },
  {
    id: "C8",
    key: "yieldStarCount",
    cat: "C",
    label: "yield*",
    agg: "sum",
    scored: false,
    desc: "yield* delegations inside gen blocks.",
  },
  {
    id: "C9",
    key: "effectConstructors",
    cat: "C",
    label: "effect constructors",
    agg: "sum",
    scored: false,
    desc: "Effect.try / tryPromise / suspend / sync / fn.",
  },
  {
    id: "C10",
    key: "pipeCalls",
    cat: "C",
    label: "pipe calls",
    agg: "sum",
    scored: false,
    desc: "pipe(...) occurrences.",
  },
  // D — Maintainability
  {
    id: "D1",
    key: "fileCount",
    cat: "D",
    label: "source files",
    agg: "sum",
    scored: false,
    desc: "src .ts file count.",
  },
  {
    id: "D2",
    key: "totalLoc",
    cat: "D",
    label: "source LOC",
    agg: "sum",
    scored: false,
    desc: "Non-blank source lines.",
  },
  {
    id: "D3",
    key: "avgFileLoc",
    cat: "D",
    label: "avg file LOC",
    dir: "lower",
    warn: 120,
    fail: 250,
    agg: "locavg",
    w: 1.5,
    scored: true,
    desc: "Mean non-blank lines per file.",
  },
  {
    id: "D4",
    key: "maxFileLoc",
    cat: "D",
    label: "max file LOC",
    dir: "lower",
    warn: 200,
    fail: 400,
    agg: "max",
    w: 1,
    scored: true,
    desc: "Largest source file.",
  },
  {
    id: "D5",
    key: "exportedFunctions",
    cat: "D",
    label: "exported functions",
    agg: "sum",
    scored: false,
    desc: "Exported functions and exported arrow fns.",
  },
  {
    id: "D6",
    key: "maxFunctionLoc",
    cat: "D",
    label: "max function LOC",
    dir: "lower",
    warn: 40,
    fail: 80,
    agg: "max",
    w: 1.5,
    scored: true,
    desc: "Longest single function body.",
  },
  {
    id: "D7",
    key: "branchPoints",
    cat: "D",
    label: "branch points",
    dir: "lower",
    warn: 15,
    fail: 40,
    agg: "sum",
    w: 1,
    scored: true,
    desc: "if / switch / case / ternary / catch.",
  },
  {
    id: "D8",
    key: "commentDensityPct",
    cat: "D",
    label: "comment density",
    dir: "band",
    band: [8, 30],
    agg: "locavg",
    w: 0.75,
    scored: true,
    unit: "%",
    desc: "Comment lines share of LOC. Ideal band 8–30%.",
  },
  {
    id: "D9",
    key: "jsdocCoveragePct",
    cat: "D",
    label: "JSDoc coverage",
    dir: "higher",
    warn: 70,
    fail: 40,
    agg: "locavg",
    w: 1.5,
    scored: true,
    unit: "%",
    desc: "Exported symbols carrying a /** */ doc block.",
  },
  {
    id: "D10",
    key: "todoCount",
    cat: "D",
    label: "TODO / FIXME",
    dir: "lower",
    warn: 0,
    fail: 2,
    agg: "sum",
    w: 1,
    scored: true,
    desc: "Outstanding TODO / FIXME / HACK / XXX markers.",
  },
  // E — Coupling & Consistency
  {
    id: "E1",
    key: "workspaceImports",
    cat: "E",
    label: "workspace imports",
    agg: "sum",
    scored: false,
    desc: "Distinct @awthaq/* specifiers imported.",
  },
  {
    id: "E2",
    key: "externalDeps",
    cat: "E",
    label: "external deps",
    dir: "lower",
    warn: 3,
    fail: 6,
    agg: "max",
    w: 1,
    scored: true,
    desc: "Runtime dependency count in package.json.",
  },
  {
    id: "E3",
    key: "effectVersion",
    cat: "E",
    label: "effect version",
    agg: "first",
    scored: false,
    desc: "effect version spec from package.json.",
  },
  {
    id: "E4",
    key: "exportedTypeNames",
    cat: "E",
    label: "exported type names",
    scored: false,
    desc: "All exported type/interface/class names (duplicate detection).",
  },
  {
    id: "E5",
    key: "namingViolations",
    cat: "E",
    label: "naming violations",
    dir: "lower",
    warn: 0,
    fail: 1,
    agg: "sum",
    w: 2,
    scored: true,
    desc: "Exported types not PascalCase.",
  },
  {
    id: "E6",
    key: "defaultExports",
    cat: "E",
    label: "default exports",
    dir: "lower",
    warn: 0,
    fail: 1,
    agg: "sum",
    w: 1,
    scored: true,
    desc: "export default — breaks named-import consistency.",
  },
  {
    id: "E7",
    key: "barrelReexports",
    cat: "E",
    label: "barrel re-exports",
    dir: "lower",
    warn: 4,
    fail: 10,
    agg: "sum",
    w: 0.5,
    scored: true,
    desc: "export * / export { } statements in src/index.ts.",
  },
  {
    id: "E8",
    key: "tsconfigOverrides",
    cat: "E",
    label: "tsconfig drift",
    dir: "lower",
    warn: 2,
    fail: 5,
    agg: "max",
    w: 0.75,
    scored: true,
    desc: "compilerOptions keys diverging from tsconfig.base.json.",
  },
  {
    id: "E9",
    key: "testRatioPct",
    cat: "E",
    label: "test ratio",
    dir: "higher",
    warn: 60,
    fail: 20,
    agg: "locavg",
    w: 1.5,
    scored: true,
    unit: "%",
    desc: "Test LOC relative to source LOC.",
  },
  {
    id: "E10",
    key: "internalRelativeImports",
    cat: "E",
    label: "relative imports",
    agg: "sum",
    scored: false,
    desc: "Intra-package relative imports (cohesion).",
  },
];

const SCORED = KPI_META.filter((k) => k.scored);

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function scoreKpi(k, v, pkg) {
  if (!k.scored) return null;
  if (v === null || v === undefined) return null;
  if (k.dir === "bool") return v === true ? 100 : 0;
  if (k.neutralIfZero) {
    const zeroCase =
      (k.key === "unknownOverAnyPct" && pkg.kpis.A.anyUsage + countUnknown(pkg) === 0) ||
      (k.key === "explicitReturnTypesPct" && pkg.kpis.D.exportedFunctions === 0) ||
      (k.key === "genPreferencePct" && pkg.kpis.C.effectGenCount + pkg.kpis.C.flatMapCount === 0);
    if (zeroCase) return 100;
  }
  if (k.dir === "band") {
    const [lo, hi] = k.band;
    if (v >= lo && v <= hi) return 100;
    if (v < lo) return clamp((v / lo) * 100, 0, 100);
    return clamp(100 - (v - hi) * 4, 0, 100);
  }
  if (k.dir === "higher") {
    if (v >= k.warn) return 100;
    if (v <= k.fail) return 0;
    return clamp(((v - k.fail) / (k.warn - k.fail)) * 100, 0, 100);
  }
  // lower
  if (v <= k.warn) return 100;
  if (v >= k.fail) return 0;
  return clamp(100 - ((v - k.warn) / (k.fail - k.warn)) * 100, 0, 100);
}
function countUnknown(pkg) {
  // unknown count is not a KPI itself; A8 already encodes the ratio, so the
  // neutral-check only needs anyUsage==0 shortcut.
  return pkg.kpis.A.anyUsage === 0 ? 0 : 1;
}
const LOC_WEIGHT_EXEMPT = new Set(["test"]); // packages/test IS tests; E9 not meaningful

function computeScores(pkg) {
  const perCat = {};
  for (const cid of Object.keys(CATS)) {
    const ks = SCORED.filter((k) => k.cat === cid);
    let sw = 0;
    let acc = 0;
    for (const k of ks) {
      let w = k.w;
      if (pkg.path.startsWith("packages/test") && k.key === "testRatioPct") w = 0;
      if (LOC_WEIGHT_EXEMPT.has(pkg.name) && k.key === "testRatioPct") w = 0;
      if (w === 0) continue;
      const s = scoreKpi(k, pkg.kpis[k.cat][k.key], pkg);
      if (s === null) continue;
      acc += s * w;
      sw += w;
    }
    perCat[cid] = sw === 0 ? null : Math.round((acc / sw) * 10) / 10;
  }
  let acc = 0;
  let wsum = 0;
  for (const [cid, cat] of Object.entries(CATS)) {
    if (perCat[cid] === null) continue;
    acc += perCat[cid] * cat.w;
    wsum += cat.w;
  }
  return { cats: perCat, overall: wsum ? Math.round((acc / wsum) * 10) / 10 : null };
}

// ---------------------------------------------------------------------------
// Load metrics
// ---------------------------------------------------------------------------
function loadPackages() {
  const files = readdirSync(METRICS_DIR).filter(
    (f) => f.endsWith(".json") && f !== "repo-checks.json",
  );
  const pkgs = [];
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(METRICS_DIR, f), "utf8"));
    const pkg = { name: raw.package, path: raw.path, kpis: raw.kpis, details: raw.details ?? {} };
    pkg.scores = computeScores(pkg);
    pkg.loc = raw.kpis.D.totalLoc;
    pkgs.push(pkg);
  }
  pkgs.sort((a, b) => (b.scores.overall ?? 0) - (a.scores.overall ?? 0));
  return pkgs;
}

function repoTotals(pkgs) {
  const totals = {};
  for (const k of KPI_META) {
    const vals = pkgs.map((p) => p.kpis[k.cat][k.key]).filter((v) => v !== undefined);
    if (vals.length === 0) {
      totals[k.id] = null;
      continue;
    }
    switch (k.agg) {
      case "sum":
        totals[k.id] = vals.reduce((a, b) => a + b, 0);
        break;
      case "max":
        totals[k.id] = Math.max(...vals);
        break;
      case "and":
        totals[k.id] = vals.every((v) => v === true);
        break;
      case "locavg": {
        let num = 0,
          den = 0;
        for (const p of pkgs) {
          const v = p.kpis[k.cat][k.key];
          if (typeof v !== "number") continue;
          num += v * Math.max(1, p.loc);
          den += Math.max(1, p.loc);
        }
        totals[k.id] = den ? Math.round((num / den) * 10) / 10 : null;
        break;
      }
      case "genratio": {
        let gen = 0,
          fm = 0;
        for (const p of pkgs) {
          gen += p.kpis.C.effectGenCount ?? 0;
          fm += p.kpis.C.flatMapCount ?? 0;
        }
        totals[k.id] = gen + fm ? Math.round((gen / (gen + fm)) * 1000) / 10 : null;
        break;
      }
      case "first":
        totals[k.id] = vals[0];
        break;
      default:
        totals[k.id] = null;
    }
  }
  return totals;
}

function loadChecks() {
  const p = join(METRICS_DIR, "repo-checks.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

// ---------------------------------------------------------------------------
// Aggregate risks + type collisions
// ---------------------------------------------------------------------------
function crossPackageFindings(pkgs) {
  const collisions = {};
  for (const p of pkgs) {
    for (const n of p.kpis.E.exportedTypeNames ?? []) {
      (collisions[n] ??= []).push(p.name);
    }
  }
  return Object.fromEntries(Object.entries(collisions).filter(([, v]) => v.length > 1));
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function build(pkgs, checks, collisions) {
  const totals = repoTotals(pkgs);
  // Repo KPI score = LOC-weighted mean of per-package scores (sum/max totals
  // would otherwise be compared against per-package thresholds).
  const scoredTotals = {};
  for (const k of SCORED) {
    let acc = 0,
      w = 0;
    for (const p of pkgs) {
      const s = scoreKpi(k, p.kpis[k.cat][k.key], p);
      if (s === null) continue;
      const lw = Math.max(1, p.loc);
      acc += s * lw;
      w += lw;
    }
    scoredTotals[k.id] = w ? Math.round((acc / w) * 10) / 10 : null;
  }
  const catScores = {};
  for (const cid of Object.keys(CATS)) {
    const ks = SCORED.filter((k) => k.cat === cid);
    let acc = 0,
      w = 0;
    for (const k of ks) {
      const s = scoredTotals[k.id];
      if (s === null || s === undefined) continue;
      acc += s * k.w;
      w += k.w;
    }
    catScores[cid] = w ? Math.round((acc / w) * 10) / 10 : null;
  }
  const overall =
    catScores.A !== null
      ? Math.round(
          Object.entries(CATS).reduce((a, [cid, c]) => a + (catScores[cid] ?? 0) * c.w, 0) * 10,
        ) / 10
      : null;

  const DATA = {
    generated: new Date().toISOString(),
    repo: "awthaq",
    overall,
    catScores,
    totals,
    scoredTotals,
    checks,
    collisions,
    cats: CATS,
    kpis: KPI_META,
    packages: pkgs.map((p) => ({
      name: p.name,
      path: p.path,
      loc: p.loc,
      scores: p.scores,
      kpis: p.kpis,
      details: p.details,
    })),
  };

  const fontHref =
    "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500&display=swap";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>awthaq · Type-System Integrity Console</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="${fontHref}">
<style>
:root{
  --bg:#07090D; --panel:#0D1118; --panel2:#11161F; --line:#1C2432; --line2:#263148;
  --ink:#E8EDF5; --dim:#8A96AB; --faint:#57627A;
  --pass:#34F5A2; --warn:#FFB454; --fail:#FF5C6E; --ctx:#57627A;
  --cA:#4FC3F7; --cB:#B18CFF; --cC:#FFB454; --cD:#34F5A2; --cE:#FF7AB6;
  --mono:'IBM Plex Mono',ui-monospace,monospace; --disp:'Chakra Petch',sans-serif; --body:'IBM Plex Sans',system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--ink);font-family:var(--body);font-size:14px;line-height:1.5;
  background-image:
    repeating-linear-gradient(0deg,transparent 0 39px,rgba(38,49,72,.14) 39px 40px),
    repeating-linear-gradient(90deg,transparent 0 39px,rgba(38,49,72,.14) 39px 40px);
}
.wrap{max-width:1440px;margin:0 auto;padding:0 28px 80px}
::selection{background:rgba(52,245,162,.25)}
/* ---------- header ---------- */
header{padding:34px 0 18px;border-bottom:1px solid var(--line);position:relative;overflow:hidden}
header::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(79,195,247,.05),transparent);pointer-events:none;
  transform:translateX(-100%);animation:sweep 7s ease-in-out infinite}
@keyframes sweep{40%,100%{transform:translateX(100%)}}
.brandrow{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap}
.wordmark{font-family:var(--disp);font-weight:700;font-size:30px;letter-spacing:.06em;text-transform:uppercase}
.wordmark b{color:var(--pass)}
.sub{font-family:var(--mono);font-size:11px;color:var(--dim);letter-spacing:.18em;text-transform:uppercase}
.gen{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--faint)}
.checks{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.chip{font-family:var(--mono);font-size:11px;padding:4px 10px;border:1px solid var(--line2);border-radius:3px;color:var(--dim);display:inline-flex;gap:7px;align-items:center}
.chip i{width:7px;height:7px;border-radius:50%;display:inline-block;background:var(--ctx)}
.chip.pass i{background:var(--pass);box-shadow:0 0 8px rgba(52,245,162,.7)} .chip.pass{color:#BFF5DB;border-color:rgba(52,245,162,.35)}
.chip.warn i{background:var(--warn);box-shadow:0 0 8px rgba(255,180,84,.7)} .chip.warn{color:#FFE3B8;border-color:rgba(255,180,84,.35)}
.chip.fail i{background:var(--fail);box-shadow:0 0 8px rgba(255,92,110,.7)} .chip.fail{color:#FFD2D8;border-color:rgba(255,92,110,.4)}
/* ---------- hero ---------- */
.hero{display:grid;grid-template-columns:300px 1fr;gap:22px;margin:26px 0}
@media(max-width:900px){.hero{grid-template-columns:1fr}}
.panel{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:6px;position:relative}
.panel::before{content:"";position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--line2),transparent)}
.gaugebox{padding:24px;display:flex;flex-direction:column;align-items:center;gap:8px}
.gaugebox h2{font-family:var(--mono);font-size:10px;letter-spacing:.22em;color:var(--dim);text-transform:uppercase}
.ring{position:relative;width:190px;height:190px}
.ring svg{transform:rotate(-90deg)}
.ring .num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring .num b{font-family:var(--disp);font-size:46px;font-weight:700;line-height:1}
.ring .num span{font-family:var(--mono);font-size:10px;color:var(--faint);letter-spacing:.15em;margin-top:6px}
.verdict{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;padding:4px 12px;border-radius:3px;border:1px solid}
.verdict.pass{color:var(--pass);border-color:rgba(52,245,162,.4);background:rgba(52,245,162,.06)}
.verdict.warn{color:var(--warn);border-color:rgba(255,180,84,.4);background:rgba(255,180,84,.06)}
.verdict.fail{color:var(--fail);border-color:rgba(255,92,110,.4);background:rgba(255,92,110,.06)}
.catpanel{padding:22px 24px;display:flex;flex-direction:column;gap:14px}
.catpanel h2{font-family:var(--mono);font-size:10px;letter-spacing:.22em;color:var(--dim);text-transform:uppercase}
.catrow{display:grid;grid-template-columns:190px 1fr 120px;gap:14px;align-items:center}
.catrow .nm{font-family:var(--disp);font-size:13px;font-weight:600;letter-spacing:.03em}
.catrow .nm small{display:block;font-family:var(--mono);font-size:10px;color:var(--faint);font-weight:400;letter-spacing:.05em}
.bar{height:8px;background:#151B26;border-radius:2px;overflow:hidden;position:relative}
.bar i{position:absolute;inset:0 auto 0 0;border-radius:2px;width:0;animation:grow 1.1s cubic-bezier(.2,.7,.2,1) forwards}
@keyframes grow{to{width:var(--w)}}
.catrow .val{font-family:var(--mono);font-size:13px;text-align:right;color:var(--dim)}
.catrow .val b{color:var(--ink);font-size:16px}
/* ---------- sections ---------- */
section{margin-top:44px}
.sechead{display:flex;align-items:baseline;gap:14px;margin-bottom:18px;border-bottom:1px solid var(--line);padding-bottom:10px}
.sechead h2{font-family:var(--disp);font-size:17px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.sechead .n{font-family:var(--mono);font-size:11px;color:var(--faint);letter-spacing:.12em}
.sechead .filters{margin-left:auto;display:flex;gap:6px}
.fbtn{font-family:var(--mono);font-size:10px;letter-spacing:.1em;padding:4px 10px;border:1px solid var(--line2);border-radius:3px;background:none;color:var(--dim);cursor:pointer;text-transform:uppercase}
.fbtn.on{color:var(--bg);background:var(--ink);border-color:var(--ink)}
/* ---------- kpi grid ---------- */
.kgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(255px,1fr));gap:12px}
.kcard{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:6px;padding:14px 16px;cursor:pointer;
  transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease;opacity:0;animation:pop .5s ease forwards}
.kcard:hover{transform:translateY(-3px);border-color:var(--line2);box-shadow:0 10px 30px rgba(0,0,0,.45)}
@keyframes pop{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.kcard .top{display:flex;align-items:center;gap:8px}
.kcard .kid{font-family:var(--mono);font-size:10px;color:var(--faint);letter-spacing:.1em}
.kcard .st{margin-left:auto;width:8px;height:8px;border-radius:50%}
.st.pass{background:var(--pass);box-shadow:0 0 9px rgba(52,245,162,.8)}
.st.warn{background:var(--warn);box-shadow:0 0 9px rgba(255,180,84,.8)}
.st.fail{background:var(--fail);box-shadow:0 0 9px rgba(255,92,110,.8)}
.st.ctx{background:var(--ctx)}
.kcard h3{font-family:var(--disp);font-size:14px;font-weight:600;margin-top:7px;letter-spacing:.02em}
.kcard .big{font-family:var(--mono);font-size:26px;font-weight:600;margin-top:4px}
.kcard .tgt{font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:2px;letter-spacing:.04em}
.kcard .desc{font-size:11px;color:var(--dim);margin-top:7px;min-height:28px}
.kcard .meter{margin-top:9px;height:3px;background:#151B26;border-radius:2px;overflow:hidden}
.kcard .meter i{display:block;height:100%}
.catdot{width:8px;height:8px;border-radius:2px;flex:none}
/* ---------- matrix ---------- */
.mscroll{overflow-x:auto;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
table.matrix{border-collapse:collapse;width:100%;min-width:980px;font-family:var(--mono);font-size:12px}
.matrix th{position:sticky;top:0;background:var(--panel2);color:var(--dim);font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:11px 12px;text-align:right;border-bottom:1px solid var(--line2);cursor:pointer;white-space:nowrap;user-select:none}
.matrix th:first-child,.matrix th.l{text-align:left}
.matrix td{padding:9px 12px;text-align:right;border-bottom:1px solid var(--line);white-space:nowrap}
.matrix td:first-child,.matrix td.l{text-align:left}
.matrix tbody tr{cursor:pointer;transition:background .12s}
.matrix tbody tr:hover{background:rgba(79,195,247,.05)}
.pname{font-family:var(--disp);font-weight:600;font-size:13px}
.pname small{color:var(--faint);font-family:var(--mono);font-weight:400;font-size:10px;margin-left:8px}
.heat{padding:2px 8px;border-radius:3px}
.ov{font-weight:600;font-size:14px}
/* ---------- drawers ---------- */
.drawer{position:fixed;top:0;right:-620px;width:600px;max-width:94vw;height:100vh;background:#0B0F16;border-left:1px solid var(--line2);z-index:50;
  transition:right .28s cubic-bezier(.2,.8,.2,1);display:flex;flex-direction:column;box-shadow:-30px 0 80px rgba(0,0,0,.55)}
.drawer.open{right:0}
.drawer .dhead{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
.drawer .dhead h3{font-family:var(--disp);font-size:17px;letter-spacing:.04em}
.drawer .dhead .x{margin-left:auto;background:none;border:1px solid var(--line2);color:var(--dim);width:28px;height:28px;border-radius:4px;cursor:pointer;font-family:var(--mono)}
.drawer .dbody{overflow-y:auto;padding:20px 24px 40px;flex:1}
.drawer h4{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin:20px 0 10px}
.dtable{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:11.5px}
.dtable td{padding:5px 8px;border-bottom:1px solid var(--line)}
.dtable td:last-child,.dtable td.r{text-align:right}
.dtable td.l{text-align:left}
.note{font-size:12px;color:var(--dim);border-left:2px solid var(--line2);padding:6px 10px;margin:6px 0}
.risk{border:1px solid var(--line);border-left-width:3px;border-radius:4px;padding:10px 12px;margin:8px 0;background:var(--panel)}
.risk.high{border-left-color:var(--fail)} .risk.medium{border-left-color:var(--warn)} .risk.low{border-left-color:var(--cA)}
.risk b{font-family:var(--disp);font-size:13px}
.risk .ev{font-family:var(--mono);font-size:10px;color:var(--faint)}
.risk p{font-size:12px;color:var(--dim);margin-top:4px}
.sev{font-family:var(--mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;padding:2px 7px;border-radius:2px;margin-left:8px;vertical-align:1px}
.sev.high{background:rgba(255,92,110,.14);color:var(--fail)} .sev.medium{background:rgba(255,180,84,.14);color:var(--warn)} .sev.low{background:rgba(79,195,247,.14);color:var(--cA)}
.ty{border:1px solid var(--line);border-radius:4px;padding:9px 12px;margin:6px 0;background:var(--panel)}
.ty b{font-family:var(--mono);color:var(--cB);font-size:12.5px}
.ty .ev{font-family:var(--mono);font-size:10px;color:var(--faint);margin-left:8px}
.ty p{font-size:12px;color:var(--dim);margin-top:3px}
.pill{display:inline-block;font-family:var(--mono);font-size:10px;border:1px solid var(--line2);border-radius:3px;padding:2px 8px;margin:2px 4px 2px 0;color:var(--dim)}
/* ---------- risks section ---------- */
.riskcols{columns:2;column-gap:12px}
@media(max-width:1000px){.riskcols{columns:1}}
.risk.pkg{font-family:var(--mono);font-size:10px;color:var(--faint);letter-spacing:.08em}
footer{margin-top:60px;border-top:1px solid var(--line);padding-top:18px;font-family:var(--mono);font-size:10.5px;color:var(--faint);display:flex;gap:18px;flex-wrap:wrap}
#scrim{position:fixed;inset:0;background:rgba(4,6,10,.6);z-index:40;opacity:0;pointer-events:none;transition:opacity .25s}
#scrim.on{opacity:1;pointer-events:auto}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="brandrow">
    <div class="wordmark">TYPE<b>FRAME</b></div>
    <div class="sub">awthaq · type-system integrity console</div>
    <div class="gen" id="gen"></div>
  </div>
  <div class="checks" id="checks"></div>
  <a class="chip warn" style="text-decoration:none;margin:10px 0 0" href="effect-idiom-report.html"><i></i>effect idiom dossier — 22.2 rescinded, read the errata</a>
</header>

<div class="hero">
  <div class="panel gaugebox">
    <h2>Composite Integrity</h2>
    <div class="ring" id="ring"></div>
    <div class="verdict" id="verdict"></div>
  </div>
  <div class="panel catpanel">
    <h2>Category Integrity — weighted A×0.30 B×0.15 C×0.15 D×0.25 E×0.15</h2>
    <div id="catbars"></div>
  </div>
</div>

<section id="kpis">
  <div class="sechead">
    <h2>KPI Board</h2><span class="n">50 indicators · 32 scored / 18 context</span>
    <div class="filters" id="kfilters"></div>
  </div>
  <div class="kgrid" id="kgrid"></div>
</section>

<section id="matrix">
  <div class="sechead">
    <h2>Package Matrix</h2><span class="n">click a row for full type-system detail · click headers to sort</span>
    <div class="filters" id="mfilters"></div>
  </div>
  <div class="mscroll"><table class="matrix" id="mtable"></table></div>
</section>

<section id="risks">
  <div class="sechead"><h2>Risk Register</h2><span class="n" id="riskn"></span></div>
  <div class="riskcols" id="risks"></div>
</section>

<footer>
  <span>TYPEFRAME v1</span>
  <span>50-KPI contract · 20 package analyzers</span>
  <span>scoring: pass ≥ 80 · warn ≥ 50 · fail &lt; 50</span>
  <span>regenerate: node scripts/generate-quality-dashboard.mjs</span>
</footer>
</div>

<div id="scrim"></div>
<aside class="drawer" id="drawer"><div class="dhead"><h3 id="dtitle"></h3><button class="x" onclick="closeDrawer()">✕</button></div><div class="dbody" id="dbody"></div></aside>

<script>
const DATA = __DATA__;
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const CATC = {A:'#4FC3F7',B:'#B18CFF',C:'#FFB454',D:'#34F5A2',E:'#FF7AB6'};
const CATN = {A:'Type Safety',B:'Type Complexity',C:'Effect Idiom',D:'Maintainability',E:'Coupling'};
const SCOL = {pass:'#34F5A2',warn:'#FFB454',fail:'#FF5C6E',ctx:'#57627A'};
const byId = {}; DATA.kpis.forEach(k => byId[k.id] = k);
const fmt = (v,k) => v === null || v === undefined ? '—' : (typeof v === 'boolean' ? (v?'ON':'OFF') : (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(1) : String(v)) + (k && k.unit ? k.unit : ''));
const stOf = s => s === null || s === undefined ? 'ctx' : (s >= 80 ? 'pass' : s >= 50 ? 'warn' : 'fail');
const hexA = (hex,a) => { const n = parseInt(hex.slice(1),16); return 'rgba('+(n>>16)+','+((n>>8)&255)+','+(n&255)+','+a+')'; };

/* header */
document.getElementById('gen').textContent = 'GENERATED ' + DATA.generated.replace('T',' ').slice(0,19) + ' UTC';
const checks = [
  ['typecheck', DATA.checks && DATA.checks.typecheckOk],
  ['circular deps', DATA.checks && DATA.checks.circularOk],
  ['strict', DATA.totals.A6], ['noUncheckedIndexedAccess', DATA.totals.A7],
  ['exactOptionalPropertyTypes', DATA.checks && DATA.checks.exactOptional],
  ['packages: ' + DATA.packages.length, true],
  ['dup type names: ' + Object.keys(DATA.collisions||{}).length, Object.keys(DATA.collisions||{}).length === 0],
];
document.getElementById('checks').innerHTML = checks.map(c =>
  '<span class="chip ' + (c[1] ? 'pass' : 'fail') + '"><i></i>' + esc(c[0]) + '</span>').join('');

/* ring gauge */
(function(){
  const o = DATA.overall, R = 80, C = 2*Math.PI*R, st = stOf(o);
  document.getElementById('ring').innerHTML =
    '<svg width="190" height="190"><circle cx="95" cy="95" r="'+R+'" fill="none" stroke="#151B26" stroke-width="13"/>' +
    '<circle cx="95" cy="95" r="'+R+'" fill="none" stroke="'+SCOL[st]+'" stroke-width="13" stroke-linecap="round" '+
    'stroke-dasharray="'+C+'" stroke-dashoffset="'+C+'" style="filter:drop-shadow(0 0 6px '+hexA(SCOL[st],.6)+');animation:ring 1.4s cubic-bezier(.3,.7,.2,1) forwards"/>' +
    '<style>@keyframes ring{to{stroke-dashoffset:'+(C*(1-o/100))+'}}</style></svg>' +
    '<div class="num"><b style="color:'+SCOL[st]+'">'+o.toFixed(1)+'</b><span>/ 100</span></div>';
  const v = document.getElementById('verdict'); v.textContent = st === 'pass' ? 'SYSTEM NOMINAL' : st === 'warn' ? 'DEGRADED — REVIEW WARNS' : 'CRITICAL — ACTION REQUIRED';
  v.classList.add(st);
})();

/* category bars */
document.getElementById('catbars').innerHTML = Object.keys(CATN).map((cid,i) => {
  const s = DATA.catScores[cid], st = stOf(s);
  return '<div class="catrow"><div class="nm"><span class="catdot" style="display:inline-block;background:'+CATC[cid]+';margin-right:8px"></span>'+CATN[cid]+' <small>'+DATA.cats[cid].blurb+'</small></div>' +
    '<div class="bar"><i style="--w:'+(s||0)+'%;background:linear-gradient(90deg,'+hexA(SCOL[st],.45)+','+SCOL[st]+');animation-delay:'+(0.15*i+0.2)+'s"></i></div>' +
    '<div class="val"><b style="color:'+SCOL[st]+'">'+(s===null?'—':s.toFixed(1))+'</b> /100</div></div>';
}).join('');

/* KPI grid */
let kfilter = 'ALL';
function kpiCard(k){
  const tv = DATA.totals[k.id], s = DATA.scoredTotals[k.id], st = k.scored ? stOf(s) : 'ctx';
  // worst offender among packages for scored KPIs
  let worst = '';
  if (k.scored) {
    let worstP = null, worstV = null;
    for (const p of DATA.packages) {
      const v = p.kpis[k.cat][k.key]; if (typeof v !== 'number' || k.dir === 'bool') continue;
      const worse = k.dir === 'lower' ? (worstV === null || v > worstV) : (worstV === null || v < worstV);
      if (worse) { worstV = v; worstP = p; }
    }
    if (worstP && worstV !== tv && DATA.packages.length > 1) worst = ' · worst ' + esc(worstP.name) + ' ' + fmt(worstV,k);
  }
  const pct = k.scored ? Math.max(0,Math.min(100,s)) : null;
  return '<div class="kcard" style="animation-delay:'+(k.id.charCodeAt(0)*0.02 + (+k.id.slice(1))*0.025)+'s" onclick="showKpi(\\''+k.id+'\\')">' +
    '<div class="top"><span class="catdot" style="background:'+CATC[k.cat]+'"></span><span class="kid">'+k.id+' · '+CATN[k.cat].toUpperCase()+(k.scored?'':' · CTX')+'</span><span class="st '+st+'"></span></div>' +
    '<h3>'+esc(k.label)+'</h3><div class="big" style="color:'+(st==='ctx'?'var(--ink)':SCOL[st])+'">'+fmt(tv,k)+'</div>' +
    '<div class="tgt">'+(k.scored ? 'target '+(k.dir==='lower'?'≤ ':'≥ ')+(k.dir==='bool'?'ON':fmt(k.warn,k)) : 'context metric')+worst+'</div>' +
    '<div class="desc">'+esc(k.desc)+'</div>' +
    '<div class="meter"><i style="width:'+(pct===null?'100%':pct+'%')+';background:'+(st==='ctx'?'var(--line2)':SCOL[st])+'"></i></div></div>';
}
function renderK(){
  const list = DATA.kpis.filter(k => kfilter === 'ALL' || k.cat === kfilter);
  document.getElementById('kgrid').innerHTML = list.map(kpiCard).join('');
}
document.getElementById('kfilters').innerHTML = ['ALL','A','B','C','D','E'].map(c =>
  '<button class="fbtn'+(c==='ALL'?' on':'')+'" data-f="'+c+'" onclick="setKF(\\''+c+'\\')">'+(c==='ALL'?'ALL':c+' · '+CATN[c])+'</button>').join('');
function setKF(c){ kfilter = c; document.querySelectorAll('#kfilters .fbtn').forEach(b => b.classList.toggle('on', b.dataset.f === c)); renderK(); }
renderK();

/* matrix */
let sortKey = 'overall', sortDir = -1, mfilter = 'ALL';
const COLS = [
  {k:'name', l:'Package', t:'s'}, {k:'loc', l:'LOC', t:'n'},
  {k:'A', l:'Safety', t:'c'}, {k:'B', l:'Complexity', t:'c'}, {k:'C', l:'Effect', t:'c'},
  {k:'D', l:'Maintain.', t:'c'}, {k:'E', l:'Coupling', t:'c'}, {k:'overall', l:'Overall', t:'o'},
  {k:'A1', l:'any', t:'k'}, {k:'A3', l:'asserts', t:'k'}, {k:'B2', l:'arity', t:'k'},
  {k:'B6', l:'∪max', t:'k'}, {k:'C3', l:'gen%', t:'k'}, {k:'D4', l:'maxLOC', t:'k'}, {k:'D9', l:'jsdoc%', t:'k'}, {k:'E9', l:'test%', t:'k'},
];
function cell(p, col){
  let v, s = null;
  if (col.t === 's') return '<td class="l"><span class="pname">'+esc(p.name)+'</span><small>'+esc(p.path)+'</small></td>';
  if (col.t === 'n') { v = p.loc; return '<td>'+v+'</td>'; }
  if (col.t === 'c') { s = p.scores.cats[col.k]; return '<td><span class="heat ov" style="color:'+SCOL[stOf(s)]+';background:'+hexA(SCOL[stOf(s)],.08)+'">'+(s===null?'—':s.toFixed(1))+'</span></td>'; }
  if (col.t === 'o') { s = p.scores.overall; return '<td class="ov" style="color:'+SCOL[stOf(s)]+'">'+s.toFixed(1)+'</td>'; }
  const k = byId[col.k]; v = p.kpis[k.cat][k.key];
  if (!k.scored) return '<td style="color:var(--faint)">'+fmt(v,k)+'</td>';
  const sc = kpiScore(k,p); s = sc;
  return '<td><span class="heat" style="color:'+SCOL[stOf(s)]+';background:'+hexA(SCOL[stOf(s)],.07)+'">'+fmt(v,k)+'</span></td>';
}
function kpiScore(k,p){
  // mirror of generator scoring for per-package display
  if (!k.scored) return null;
  const v = p.kpis[k.cat][k.key];
  if (k.dir === 'bool') return v === true ? 100 : 0;
  if (k.neutralIfZero) {
    if (k.key === 'genPreferencePct' && p.kpis.C.effectGenCount + p.kpis.C.flatMapCount === 0) return 100;
    if (k.key === 'explicitReturnTypesPct' && p.kpis.D.exportedFunctions === 0) return 100;
    if (k.key === 'unknownOverAnyPct' && p.kpis.A.anyUsage === 0) return 100;
  }
  if (k.key === 'testRatioPct' && p.name === 'test') return 100;
  if (k.dir === 'band') { const lo = k.band[0], hi = k.band[1];
    if (v >= lo && v <= hi) return 100; if (v < lo) return Math.min(100, v/lo*100); return Math.max(0, 100-(v-hi)*4); }
  if (k.dir === 'higher') return v >= k.warn ? 100 : (v <= k.fail ? 0 : Math.round((v-k.fail)/(k.warn-k.fail)*100));
  return v <= k.warn ? 100 : (v >= k.fail ? 0 : Math.round(100-(v-k.warn)/(k.fail-k.warn)*100));
}
function renderM(){
  let rows = DATA.packages.filter(p => mfilter === 'ALL' || p.path.startsWith('packages/'));
  const get = p => { if (COLS.find(c => c.k === sortKey).t === 'c') return p.scores.cats[sortKey]; if (sortKey === 'overall') return p.scores.overall; if (sortKey === 'name') return p.name; if (sortKey === 'loc') return p.loc; const k = byId[sortKey]; return p.kpis[k.cat][k.key]; };
  rows = rows.slice().sort((a,b) => { const va = get(a), vb = get(b); return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir; });
  document.getElementById('mtable').innerHTML =
    '<thead><tr>' + COLS.map(c => '<th class="'+(c.t==='s'?'l':'')+'" data-k="'+c.k+'">'+c.l+(sortKey===c.k?(sortDir<0?' ▾':' ▾'):'')+'</th>').join('') + '</tr></thead>' +
    '<tbody>' + rows.map(p => '<tr onclick="showPkg(\\''+p.name+'\\')">' + COLS.map(c => cell(p,c)).join('') + '</tr>').join('') + '</tbody>';
}
document.getElementById('mfilters').innerHTML = ['ALL','A','B','C','D','E'].map(c =>
  '<button class="fbtn'+(c==='ALL'?' on':'')+'" data-f="'+c+'" onclick="setMF(\\''+c+'\\')">'+(c==='ALL'?'ALL':c)+'</button>').join('');
function setMF(c){ mfilter = c; document.querySelectorAll('#mfilters .fbtn').forEach(b => b.classList.toggle('on', b.dataset.f === c)); renderM(); }
document.getElementById('mtable').addEventListener('click', e => {
  const th = e.target.closest('th'); if (!th) return;
  if (sortKey === th.dataset.k) sortDir *= -1; else { sortKey = th.dataset.k; sortDir = -1; }
  renderM();
});
renderM();

/* risk register */
(function(){
  const all = [];
  for (const p of DATA.packages) for (const r of (p.details.risks||[])) all.push({p:p.name, ...r});
  all.sort((a,b) => ['high','medium','low'].indexOf(a.severity) - ['high','medium','low'].indexOf(b.severity));
  document.getElementById('riskn').textContent = all.length + ' findings across ' + DATA.packages.length + ' packages';
  document.getElementById('risks').innerHTML = all.length ? all.map(r =>
    '<div class="risk '+esc(r.severity)+'"><span class="risk pkg">'+esc(r.p)+'</span><b>'+esc(r.title)+'</b><span class="sev '+esc(r.severity)+'">'+esc(r.severity)+'</span>' +
    '<div class="ev">'+esc(r.evidence||'')+'</div><p>'+esc(r.detail||'')+'</p></div>').join('') :
    '<div class="note">No package-level risks reported.</div>';
})();

/* drawers */
function openDrawer(title, html){ document.getElementById('dtitle').innerHTML = title; document.getElementById('dbody').innerHTML = html; document.getElementById('drawer').classList.add('open'); document.getElementById('scrim').classList.add('on'); }
function closeDrawer(){ document.getElementById('drawer').classList.remove('open'); document.getElementById('scrim').classList.remove('on'); }
document.getElementById('scrim').onclick = closeDrawer;
addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

window.showKpi = function(id){
  const k = byId[id];
  let h = '<div class="note">'+esc(k.desc)+'</div>';
  h += '<h4>Scoring model</h4><div class="note">'+(k.scored ? (k.dir==='bool' ? 'boolean: '+k.label : (k.dir==='band' ? 'band '+k.band.join('–')+k.unit : (k.dir==='lower'?'≤ ':'≥ ')+k.warn+(k.unit||'')+' → 100 pts · '+(k.dir==='lower'?'≥ ':'≤ ')+k.fail+(k.unit||'')+' → 0 pts')) + ' · weight '+k.w : 'context metric — displayed, not scored')+'</div>';
  h += '<h4>Per-package</h4><table class="dtable"><tr><td class="l">package</td><td class="r">value</td><td class="r">score</td></tr>';
  for (const p of DATA.packages) { const v = p.kpis[k.cat][k.key], s = kpiScore(k,p);
    h += '<tr style="cursor:pointer" onclick="showPkg(\\''+p.name+'\\')"><td class="l">'+esc(p.name)+'</td><td class="r">'+fmt(v,k)+'</td><td class="r" style="color:'+(s===null?'var(--faint)':SCOL[stOf(s)])+'">'+(s===null?'ctx':Math.round(s))+'</td></tr>'; }
  h += '</table>';
  openDrawer(k.id + ' · ' + esc(k.label), h);
};
window.showPkg = function(name){
  const p = DATA.packages.find(x => x.name === name);
  let h = '<div class="note" style="display:flex;gap:16px;flex-wrap:wrap">';
  h += '<span>LOC <b style="color:var(--ink)">'+p.loc+'</b></span><span>Overall <b style="color:'+SCOL[stOf(p.scores.overall)]+'">'+p.scores.overall.toFixed(1)+'</b></span></div>';
  h += '<h4>Category scores</h4><div>';
  for (const cid of Object.keys(CATN)) { const s = p.scores.cats[cid];
    h += '<span class="pill" style="border-color:'+hexA(CATC[cid],.5)+';color:'+CATC[cid]+'">'+cid+' '+CATN[cid]+': <b>'+(s===null?'—':s.toFixed(1))+'</b></span>'; }
  h += '</div><h4>All 50 KPIs</h4><table class="dtable">';
  for (const k of DATA.kpis) { const v = p.kpis[k.cat][k.key], s = kpiScore(k,p);
    h += '<tr><td class="l" style="color:var(--faint)">'+k.id+'</td><td class="l">'+esc(k.label)+'</td><td class="r">'+fmt(v,k)+'</td><td class="r" style="color:'+(s===null?'var(--faint)':SCOL[stOf(s)])+';width:42px">'+(s===null?'ctx':Math.round(s))+'</td></tr>'; }
  h += '</table>';
  const d = p.details || {};
  if (d.notableTypes && d.notableTypes.length) { h += '<h4>Notable types</h4>';
    for (const t of d.notableTypes) h += '<div class="ty"><b>'+esc(t.name)+'</b><span class="ev">'+esc(t.kind||'')+' · '+esc((t.file||'')+':'+(t.line||''))+'</span><p>'+esc(t.note||'')+'</p></div>'; }
  if (d.genericArities && d.genericArities.length) { h += '<h4>Generic arities</h4><div>' + d.genericArities.map(g => '<span class="pill">'+esc(g.name)+' · arity '+g.arity+'</span>').join('') + '</div>'; }
  if (d.unions && d.unions.length) { h += '<h4>Wide unions</h4><div>' + d.unions.map(u => '<span class="pill">'+esc(u.name)+' · '+u.size+' members · '+esc(u.file||'')+':'+(u.line||'')+'</span>').join('') + '</div>'; }
  if (d.strengths && d.strengths.length) { h += '<h4>Strengths</h4>'; for (const s of d.strengths) h += '<div class="note" style="border-left-color:var(--pass)">'+esc(s)+'</div>'; }
  if (d.risks && d.risks.length) { h += '<h4>Risks</h4>';
    for (const r of d.risks) h += '<div class="risk '+esc(r.severity)+'"><b>'+esc(r.title)+'</b><span class="sev '+esc(r.severity)+'">'+esc(r.severity)+'</span><div class="ev">'+esc(r.evidence||'')+'</div><p>'+esc(r.detail||'')+'</p></div>'; }
  openDrawer('<span style="color:'+CATC.D+'">'+esc(p.name)+'</span> <span style="color:var(--faint);font-family:var(--mono);font-size:11px">'+esc(p.path)+'</span>', h);
};
</script>
</body>
</html>`;

  return html.replace(
    "__DATA__",
    JSON.stringify(DATA)
      .replace(/<\/script/g, "<\\/script")
      .replace(/</g, "\\u003c"),
  );
}

const pkgs = loadPackages();
if (pkgs.length === 0) {
  console.error("No metric files found in " + METRICS_DIR);
  process.exit(1);
}
const html = build(pkgs, loadChecks(), crossPackageFindings(pkgs));
writeFileSync(OUT, html);
console.log(
  "dashboard: " +
    OUT +
    " (" +
    pkgs.length +
    " packages, overall " +
    pkgs[0].scores.overall +
    " top / " +
    (pkgs[pkgs.length - 1].scores.overall ?? "?") +
    " bottom)",
);
