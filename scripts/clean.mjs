// `pnpm clean`: drops every emitted build output. Node's fs instead of `rm -rf`
// so it works on Windows too (MM-009).
import { globSync } from "glob";
import { rmSync } from "node:fs";
import { rootDir, runTsc } from "./_root.mjs";

const status = runTsc(["-b", "--clean"]);

for (const dir of globSync(["packages/*/lib", "examples/*/lib", "features/lib", "{packages,examples}/*/.tsbuildinfo", "features/.tsbuildinfo"], {
  cwd: rootDir,
  absolute: true,
  dot: true,
})) {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(status);
