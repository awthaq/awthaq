// Verbatim copy of `packages/tools/oxc/src/oxlint` from `Effect-TS/effect`
// (../effect, `@effect/oxc`, private/unpublished) — its own oxlint JS-plugin
// rules for the `effect` library itself. Loaded directly as TypeScript via
// oxlint's native Node type-stripping (no build step); see `.oxlintrc.json`'s
// `jsPlugins` entry. Update by re-copying from ../effect, not by hand-editing
// rule logic here.
import noBigIntLiterals from "./rules/no-bigint-literals.ts"
import noImportFromBarrelPackage from "./rules/no-import-from-barrel-package.ts"
import noJsExtensionImports from "./rules/no-js-extension-imports.ts"
import noOpaqueInstanceFields from "./rules/no-opaque-instance-fields.ts"
// Registered but NOT enabled in .oxlintrc.json — it drives TypeScript's
// classic compiler API (ts.createSourceFile, ts.SyntaxKind, ...), which no
// longer exists at `typescript`'s top-level import under the tsgo/Corsa
// rewrite this repo pins (`typescript: ^7.0.0`; root export is now just
// `./lib/version.cjs`). Crashes at runtime here. Fine to enable once/if a
// TS7-compatible rewrite exists upstream or this repo pins back to TS6.
import noUnusedInternal from "./rules/no-unused-internal.ts"

export default {
  meta: {
    name: "effect"
  },
  rules: {
    "no-bigint-literals": noBigIntLiterals,
    "no-import-from-barrel-package": noImportFromBarrelPackage,
    "no-js-extension-imports": noJsExtensionImports,
    "no-opaque-instance-fields": noOpaqueInstanceFields,
    "no-unused-internal": noUnusedInternal
  }
}
