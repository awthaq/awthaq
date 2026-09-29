// Cycle guard over every package's `src`. Two passes, because a cycle that only
// exists through `import type` is still a cycle for the compiler and for anyone
// reading the graph, and madge's default (`skipTypeImports: true`) cannot see it
// (ELC-003: AuditLog <-> AuthEvents was exactly that, and slipped through):
//
//   1. value cycles — type-only imports skipped, i.e. real runtime import cycles;
//   2. type-inclusive cycles — every import counted, `import type` too.
//
// Pass 2 is a superset of pass 1, so it is the one that has to stay empty; pass 1
// only labels the failure ("runtime" vs "type-level") so the message says which
// kind of break is needed. Anchored at the repo root, not the cwd (MTS-009): a run
// from the wrong directory must fail loudly rather than scan nothing and pass.
import * as glob from "glob";
import madge from "madge";
import { rootDir } from "./_root.mjs";

const files = glob.globSync(["packages/*/src/**/*.{ts,tsx}"], { cwd: rootDir, absolute: true });

if (files.length === 0) {
  console.error("circular: no packages/*/src files found under " + rootDir);
  process.exit(1);
}

const cyclesOf = async (skipTypeImports) => {
  const res = await madge(files, {
    baseDir: rootDir,
    detectiveOptions: {
      ts: { skipTypeImports },
      tsx: { skipTypeImports },
    },
  });
  return res.circular();
};

try {
  const runtime = await cyclesOf(true);
  const typeInclusive = await cyclesOf(false);
  const typeOnly = typeInclusive.filter(
    (cycle) =>
      !runtime.some(
        (known) => known.length === cycle.length && known.every((f) => cycle.includes(f)),
      ),
  );
  if (runtime.length > 0) {
    console.error("Circular dependencies found (runtime import cycles)");
    console.error(runtime);
  }
  if (typeOnly.length > 0) {
    console.error(
      "Circular dependencies found (type-level cycles: only `import type` closes them)",
    );
    console.error(typeOnly);
  }
  if (runtime.length > 0 || typeOnly.length > 0) process.exit(1);
} catch (error) {
  console.error(error);
  process.exit(1);
}
