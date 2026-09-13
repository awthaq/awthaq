// `tsc -b tsconfig.packages.json` errors (TS18002, "the 'files' list is
// empty") when tsconfig.packages.json's `references` array is empty, which
// it is until M1 Core adds real packages (spec/roadmap.md). Same class of
// "no packages yet" problem as scripts/circular.mjs guards against, solved
// the same way: check first, skip the real build cleanly when there is
// nothing yet to build, and run+propagate the real `tsc -b` exit code once
// there is.
import { globSync } from "glob";
import { spawnSync } from "node:child_process";

const packages = globSync(["packages/*/package.json"]);

if (packages.length === 0) {
  console.log("build: no packages/* yet, skipping");
} else {
  const result = spawnSync("tsc", ["-b", "tsconfig.packages.json"], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
