---
"@awthaq/core": minor
"@awthaq/test": minor
---

`runPluginContractTests` checks a plugin's own hook taps (PV-260, BEH-EA-200).

- `plugin.taps` entries (`AuthPlugin.DeclaredTap`) now carry, beside `point` and `order`, the tap's `kind`, its `owner` (the plugin id), the `handler` itself and `exercise(input)`/`install(owner)` (`HookPoint.TapDeclaration` gained `kind`, `handler` and `exercise`). `exercise` runs the handler against a stub validated against the point's input schema and returns its `Exit`, unfiltered by any point's failure semantics.
- `runPluginContractTests` always verifies that each declared tap registers at its point under the plugin's id and declared order, and takes an opt-in `hooks: [{ point, input }]` that runs the plugin's actual handlers: an observe tap must not try to abort (`HookAbort`) and must not fail the observed operation, a veto tap may only abort with `HookAbort`, a divert tap must not fail.

Migration: a hand-built `AuthPlugin.Any` may still omit `taps`; code that builds a `DeclaredTap` by hand must supply the new fields (build it from `Point.declareTap(...)` and add `owner`).
