// BO-007: `@awthaq/react` re-exports `@qadi/react` by name, not `export *`, so an
// upstream rename or addition is a decision here rather than a silent change to
// this package's public API. Every runtime export of `@qadi/react` is either
// re-exported (same binding) or listed below as deliberately withheld.
import { assert, describe, it } from "@effect/vitest";

/** qadi's devtools instrumentation registry — import it from `@qadi/react` itself. */
const withheld = new Set([
  "gateInstances",
  "subscribeGates",
  "registerGate",
  "updateGateState",
  "clearGatesUnsafe",
]);

describe("@awthaq/react's @qadi/react re-exports (BO-007)", () => {
  // Dynamic imports: the lint config forbids static barrel imports in tests,
  // and here the barrels themselves are the subject.
  it("re-exports every upstream runtime export it does not deliberately withhold, as the same binding", async () => {
    const upstream = await import("@qadi/react");
    const ours = await import("../src/index.ts");
    const missing: Array<string> = [];
    for (const [name, value] of Object.entries(upstream)) {
      if (withheld.has(name)) continue;
      if (!(name in ours) || Reflect.get(ours, name) !== value) missing.push(name);
    }
    assert.deepStrictEqual(missing, []);
  });

  it("does not re-export the withheld devtools registry", async () => {
    const ours = await import("../src/index.ts");
    for (const name of withheld) assert.isFalse(name in ours, `${name} leaked`);
  });
});
