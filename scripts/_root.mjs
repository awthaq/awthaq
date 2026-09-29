// Shared by the root dev scripts (MTS-009, MM-009): every script anchors at the
// repository root instead of the cwd, so running one from the wrong directory
// fails loudly rather than globbing nothing and "succeeding", and the compiler is
// launched through node on the workspace's own (tsgo-patched) `typescript`, not
// whatever `tsc` a PATH lookup or a POSIX shell happens to find.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tscJs = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");

/** Runs the workspace `tsc` with `args` from the repo root and returns its exit status. */
export const runTsc = (args) => {
  if (!existsSync(tscJs)) {
    console.error(`${tscJs} not found: run \`pnpm install\` first`);
    return 1;
  }
  const result = spawnSync(process.execPath, [tscJs, ...args], { cwd: rootDir, stdio: "inherit" });
  return result.status ?? 1;
};
