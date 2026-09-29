#!/usr/bin/env node
// Mechanical drift checks for spec/, called from verify-traceability.sh.
//
// Each check prints one line `STATUS<TAB>name<TAB>detail` (PASS | FAIL | SKIP)
// that the bash driver folds into its own report. They exist because the
// spec tree once claimed "pre-implementation, no code exists" for months while
// twenty-odd packages shipped (DTWS-001), and because tables of surface,
// gates and test paths drift silently unless something diffs them against the
// tree (TMS-009, MM-005, AVS-008, DTWS-008).
//
//   9  stale implementation-status phrases      (DTWS-001, DTWS-005, DTWS-006)
//  10  enforcement cells name real test files   (TMS-009, DTWS-007)
//  11  gates marked Active name a real command  (MM-005)
//  12  core HttpApi inventory matches source    (AVS-008, DoD gate 10)
//  13  ports inventory matches source           (DTWS-008, DoD gate 10)
//  14  Document Control revision is current     (BDD-003)
//  15  no REQ-EA tag is claimed twice           (BDD-003)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const specDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(specDir, "..");

const results = [];
const report = (status, name, detail) => results.push(`${status}\t${name}\t${detail}`);

const walk = (dir, accept, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "lib" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, accept, out);
    else if (accept(path)) out.push(path);
  }
  return out;
};

const lines = (path) => readFileSync(path, "utf8").split("\n");
const rel = (path) => relative(root, path);

// ---------------------------------------------------------------------------
// 9. Present-tense "nothing exists" phrases. Past-tense history ("was
// pre-implementation") is deliberately not matched. The phrase list is the
// contract: adding a new stale-claim shape to it is how the next drift is
// prevented from recurring.
// ---------------------------------------------------------------------------
const STALE = [
  /awthaq is (currently |still )?\**pre-implementation/i,
  /no line of runtime source exists/i,
  /no package\.json, no source tree/i,
  /this describes a planned system/i,
  /no step-definition layer/i,
  /no test runner/i,
  /no milestone above has begun/i,
  /there is no code for any gate to check/i,
  /no code exists yet, anywhere in this repository/i,
  /there is no `pnpm check`/i,
  /no `\.github\/workflows\/check\.yml`/i,
  /every gate is \**not yet active/i,
];
{
  const files = [
    ...walk(specDir, (p) => p.endsWith(".md")),
    ...walk(join(root, "docs"), (p) => p.endsWith(".md")),
    join(root, "README.md"),
    join(root, "features", "README.md"),
  ].filter((p) => existsSync(p) && !p.includes(`${join("spec", "scripts")}`));
  const hits = [];
  for (const file of files) {
    lines(file).forEach((text, i) => {
      if (STALE.some((re) => re.test(text))) hits.push(`${rel(file)}:${i + 1}`);
    });
  }
  if (hits.length > 0) report("FAIL", "stale implementation-status phrases", hits.join(" "));
  else report("PASS", "stale implementation-status phrases", `${files.length} file(s) scanned, none claim the project is unbuilt`);
}

// ---------------------------------------------------------------------------
// 10. Enforcement cells: a line that cites a `packages/**`/`examples/**`/
// `features/**` path must not say "no test exists yet" when the path exists,
// and must not present a missing path as enforcing unless the line itself says
// it is planned or absent.
// ---------------------------------------------------------------------------
{
  const PATH = /`((?:packages|examples|features)\/[^`\s]+?)(?::\d+(?:-\d+)?)?`/g;
  const SAYS_MISSING = /no test exists yet|not yet exist|neither of which exists|nothing exists/i;
  const HONEST = /Planned:|does not exist|not exist|no (dedicated )?test|missing|no such/i;
  const problems = [];
  let checked = 0;
  for (const file of ["invariants.md", "traceability.md"].map((f) => join(specDir, f))) {
    lines(file).forEach((text, i) => {
      for (const m of text.matchAll(PATH)) {
        const cited = m[1].replace(/[.,;)]+$/, "");
        if (cited.includes("*") || !/\.(ts|tsx|feature|mjs|py|md)$/.test(cited)) continue;
        checked += 1;
        const exists = existsSync(join(root, cited));
        if (exists && SAYS_MISSING.test(text)) problems.push(`${rel(file)}:${i + 1} says ${cited} is missing but it exists`);
        if (!exists && !HONEST.test(text) && !SAYS_MISSING.test(text)) problems.push(`${rel(file)}:${i + 1} cites ${cited}, which does not exist`);
      }
    });
  }
  if (problems.length > 0) report("FAIL", "enforcement cells vs tree", problems.slice(0, 12).join("; ") + (problems.length > 12 ? `; +${problems.length - 12} more` : ""));
  else report("PASS", "enforcement cells vs tree", `${checked} cited path(s) agree with the tree`);
}

// ---------------------------------------------------------------------------
// 11. Definitions-of-done gate table: every gate marked Active must name, in
// its "Wired as" cell, either a `pnpm <script>` that exists in package.json AND
// runs inside `pnpm check`, or a checked-in file path that exists.
// ---------------------------------------------------------------------------
{
  const dod = join(specDir, "process", "definitions-of-done.md");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const chain = pkg.scripts.check ?? "";
  const rows = lines(dod).filter((l) => /^\| \d+ \|/.test(l));
  const problems = [];
  let active = 0;
  for (const row of rows) {
    const cells = row.split("|").map((c) => c.trim());
    const [, num, , , status, wired] = cells;
    if (!/^Active/.test(status ?? "")) continue;
    active += 1;
    const commands = [...(wired ?? "").matchAll(/`pnpm ([\w:-]+)`/g)].map((m) => m[1]);
    const paths = [...(wired ?? "").matchAll(/`((?:\.github|scripts|spec|packages|examples|features|tools)\/[^`\s]+)`/g)].map((m) => m[1]);
    if (commands.length === 0 && paths.length === 0) problems.push(`gate ${num} is Active but names no command or file`);
    for (const script of commands) {
      if (!(script in pkg.scripts)) problems.push(`gate ${num}: package.json has no script "${script}"`);
      else if (script !== "check" && !new RegExp(`pnpm ${script}(\\s|$)`).test(chain)) problems.push(`gate ${num}: "${script}" does not run inside pnpm check`);
    }
    for (const p of paths) if (!existsSync(join(root, p))) problems.push(`gate ${num}: ${p} does not exist`);
  }
  if (rows.length === 0) report("FAIL", "gates marked Active are wired", "no gate table found in definitions-of-done.md");
  else if (problems.length > 0) report("FAIL", "gates marked Active are wired", problems.join("; "));
  else report("PASS", "gates marked Active are wired", `${active} of ${rows.length} gate(s) Active, each names a real command or file`);
}

// ---------------------------------------------------------------------------
// 12. Core HttpApi inventory (DoD gate 10): the `<!-- surface:api -->` block in
// ADR-EA-003 lists `group: endpoint, endpoint` per line; it must equal the
// endpoints @awthaq/api's core groups declare in source.
// ---------------------------------------------------------------------------
const block = (file, name) => {
  const text = readFileSync(file, "utf8");
  const m = text.match(new RegExp(`<!-- surface:${name} -->([\\s\\S]*?)<!-- /surface:${name} -->`));
  return m ? m[1] : null;
};
{
  const adr = join(specDir, "decisions", "003-httpapi-as-contract.md");
  const documented = block(adr, "api");
  if (documented === null) report("FAIL", "core API inventory vs source", "no <!-- surface:api --> block in ADR-EA-003");
  else {
    const want = new Map();
    for (const l of documented.split("\n")) {
      const m = l.match(/^\s*([a-z]+):\s*(.+?)\s*$/);
      if (m) want.set(m[1], m[2].split(/\s*,\s*/).sort().join(","));
    }
    const have = new Map();
    for (const file of ["Session.ts", "Account.ts", "Subject.ts"]) {
      let group = null;
      const names = [];
      const text = readFileSync(join(root, "packages", "api", "src", file), "utf8");
      for (const m of text.matchAll(/HttpApiGroup\.make\("(\w+)"\)|HttpApiEndpoint\.\w+\(\s*"(\w+)"/g)) {
        if (m[1]) group = m[1];
        else names.push(m[2]);
      }
      if (group) have.set(group, names.sort().join(","));
    }
    const diffs = [];
    for (const [g, names] of have) if (want.get(g) !== names) diffs.push(`${g}: source [${names}] vs ADR-EA-003 [${want.get(g) ?? "absent"}]`);
    for (const g of want.keys()) if (!have.has(g)) diffs.push(`${g}: in ADR-EA-003 but not in packages/api`);
    if (diffs.length > 0) report("FAIL", "core API inventory vs source", diffs.join("; "));
    else report("PASS", "core API inventory vs source", `${have.size} group(s) match packages/api/src`);
  }
}

// ---------------------------------------------------------------------------
// 13. Ports inventory: the `<!-- surface:ports -->` block in overview.md lists
// one module name per line; it must equal the `export * as X` names of
// packages/ports/src/index.ts.
// ---------------------------------------------------------------------------
{
  const documented = block(join(specDir, "overview.md"), "ports");
  if (documented === null) report("FAIL", "ports inventory vs source", "no <!-- surface:ports --> block in overview.md");
  else {
    const want = documented.split("\n").map((l) => l.trim()).filter(Boolean).sort();
    const src = readFileSync(join(root, "packages", "ports", "src", "index.ts"), "utf8");
    const have = [...src.matchAll(/^export \* as (\w+) from/gm)].map((m) => m[1]).sort();
    const missing = have.filter((n) => !want.includes(n));
    const extra = want.filter((n) => !have.includes(n));
    if (missing.length + extra.length > 0) report("FAIL", "ports inventory vs source", `undocumented: [${missing}] documented but absent: [${extra}]`);
    else report("PASS", "ports inventory vs source", `${have.length} module(s) match packages/ports/src/index.ts`);
  }
}

// ---------------------------------------------------------------------------
// 14. Every spec document's Document Control `Revision` equals the newest
// version named in its `Change History` (a Change History row can be added
// without the Revision field moving, which is how spec/traceability.md ended
// up "1.3" beside a 1.4 row).
// ---------------------------------------------------------------------------
{
  const problems = [];
  let checked = 0;
  for (const file of walk(specDir, (p) => p.endsWith(".md"))) {
    const text = readFileSync(file, "utf8");
    const revision = text.match(/^\s*>?\s*\|\s*Revision\s*\|\s*([\d.]+)\s*\|/m)?.[1];
    const history = text.match(/^\s*>?\s*\|\s*Change History\s*\|(.*)\|\s*$/m)?.[1];
    if (!revision || !history) continue;
    checked += 1;
    const versions = [...history.matchAll(/(?:^|<br>|;)\s*(\d+\.\d+)\s*\(/g)].map((m) => m[1]);
    if (versions.length === 0) continue;
    const cmp = (a, b) => a.split(".").map(Number).reduce((d, n, i) => d || n - Number(b.split(".")[i]), 0);
    const newest = versions.reduce((a, b) => (cmp(a, b) < 0 ? b : a));
    if (cmp(revision, newest) !== 0) problems.push(`${rel(file)}: Revision ${revision} but Change History ends at ${newest}`);
  }
  if (problems.length > 0) report("FAIL", "Document Control revision is current", problems.join("; "));
  else report("PASS", "Document Control revision is current", `${checked} document(s) checked`);
}

// ---------------------------------------------------------------------------
// 15. A REQ-EA tag is claimed by exactly one scenario. The allocator refuses a
// duplicate too, but only when someone runs it; parallel branches that each
// hand-picked "the next number" merged into silent collisions before this.
// ---------------------------------------------------------------------------
{
  const owners = new Map();
  for (const file of walk(join(root, "features", "features"), (p) => p.endsWith(".feature"))) {
    lines(file).forEach((text, i) => {
      const m = text.match(/^\s*@(REQ-EA-\d{3})\b/);
      if (!m) return;
      const at = `${relative(join(root, "features", "features"), file)}:${i + 1}`;
      owners.set(m[1], [...(owners.get(m[1]) ?? []), at]);
    });
  }
  const dupes = [...owners].filter(([, at]) => at.length > 1).map(([id, at]) => `${id} (${at.join(", ")})`);
  if (dupes.length > 0) report("FAIL", "REQ-EA tags are unique", dupes.join("; "));
  else report("PASS", "REQ-EA tags are unique", `${owners.size} tag(s), no scenario id claimed twice`);
}

console.log(results.join("\n"));
