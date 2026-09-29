// Builds every package with `tsc -b tsconfig.packages.json`. Anchored at the repo
// root, and an empty roster is a hard failure (MTS-009): the old "no packages yet,
// skipping" branch turned a wrong-directory run into a silent success.
import { globSync } from "glob";
import { rootDir, runTsc } from "./_root.mjs";

const packages = globSync(["packages/*/package.json"], { cwd: rootDir });

if (packages.length === 0) {
  console.error(`build: no packages/*/package.json found under ${rootDir}`);
  process.exit(1);
}

process.exit(runTsc(["-b", "tsconfig.packages.json"]));
