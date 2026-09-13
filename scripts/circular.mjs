// Mirrors effect's own scripts/circular.mjs: glob.globSync returns an empty
// array (not an ENOENT) when packages/*/src doesn't exist yet, so this stays
// a harmless no-op until M1 Core adds real packages — unlike a raw
// `madge --circular packages/*/src` CLI invocation, which fails hard on an
// unmatched shell glob.
import * as glob from "glob";
import madge from "madge";

const files = glob.globSync(["packages/*/src/**/*.ts"]);

// madge's programmatic API assumes at least one file (its internal
// `commondir` call crashes on an empty array) — packages/* is empty until
// M1 Core, so skip the call entirely rather than let glob's harmless empty
// match turn into a hard failure the way a raw CLI glob would (see the
// comment above the `import`s).
if (files.length === 0) {
  console.log("circular: no packages/*/src files yet, skipping");
} else {
  madge(files, {
    detectiveOptions: {
      ts: {
        skipTypeImports: true,
      },
    },
  }).then((res) => {
    const circular = res.circular();
    if (circular.length) {
      console.error("Circular dependencies found");
      console.error(circular);
      process.exit(1);
    }
  });
}
