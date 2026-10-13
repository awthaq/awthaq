// @awthaq/test — TestFramework
//
// Its own module so the conformance suites and `TestAuth` can share it without importing each other.

/** `describe`/`it`/`assert` — kept as an injected shape rather than importing `@effect/vitest` directly, so this harness has no hard dependency on which test runner a third-party plugin author uses. `it`'s body may be async (the migration and redaction checks run real effects). */
export interface TestFramework {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => void | Promise<void>) => void;
  readonly fail: (message: string) => never;
}
