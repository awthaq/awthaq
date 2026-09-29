// MW-005: everything the release pipeline does that can be rehearsed without an
// npm credential. `pnpm release:dry-run`:
//
//   1. `changeset status --verbose`: which packages the pending changesets bump;
//   2. `pnpm publish --dry-run` for every package that is not `"private": true`
//      (`pnpm`, not `npm`, so `workspace:`/`catalog:` specifiers are rewritten the way
//      the real publish rewrites them).
//
// While every package is still private there is nothing to publish, and step 2 says
// so. `--package <name>` narrows step 2 to one package and makes "still private" a
// failure with the manual prerequisites spelled out: canary.yml uses that as its guard.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { rootDir } from "./_root.mjs";

const flag = process.argv.indexOf("--package");
const only = flag === -1 ? undefined : process.argv[flag + 1];

const packages = globSync(["packages/*/package.json"], { cwd: rootDir, absolute: true })
  .sort()
  .map((file) => ({ dir: path.dirname(file), manifest: JSON.parse(readFileSync(file, "utf8")) }));

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
};

// The changeset status is about the whole release, so it is skipped when narrowed to one package.
let failed =
  only === undefined && run("pnpm", ["exec", "changeset", "status", "--verbose"], rootDir) !== 0;

const selected =
  only === undefined ? packages : packages.filter(({ manifest }) => manifest.name === only);
if (only !== undefined && selected.length === 0) {
  console.error(`release:dry-run: no package named ${only}`);
  process.exit(1);
}

const publishable = selected.filter(({ manifest }) => manifest.private !== true);
if (only !== undefined && publishable.length === 0) {
  console.error(
    `release:dry-run: ${only} is still "private": true, so it cannot be published yet.\n` +
      "  Prerequisites (MW-005, all manual): a git remote, the @awthaq npm organisation, a trusted publisher\n" +
      '  for the package naming the release workflow, then drop "private": true from its manifest.',
  );
  process.exit(1);
}
if (publishable.length === 0) {
  console.log("release:dry-run: every package is private, nothing to publish yet");
}

for (const { dir, manifest } of publishable) {
  console.log(`release:dry-run: ${manifest.name}`);
  if (run("pnpm", ["publish", "--dry-run", "--no-git-checks", "--access", "public"], dir) !== 0)
    failed = true;
}

process.exit(failed ? 1 : 0);
