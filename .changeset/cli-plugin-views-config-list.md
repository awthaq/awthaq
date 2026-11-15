---
"@awthaq/cli": minor
---

The `ConfigList` namespace is no longer exported from `@awthaq/cli`: `awthaq config list` prints exactly what it printed, now rendered inline by the command (BEH-EA-201, BEH-EA-229). `awthaq plugin list` renders every view (default, `--graph`, `--hooks`, `--rules`, `--events`) through one module that resolves `--format` and `--json` once, with unchanged output and exit codes (BEH-EA-202, BEH-EA-225).

Migration: run `awthaq config list` instead of calling `ConfigList`; in code, read `EffectiveConfig.read(yield* Doctor.configContext(config), Doctor.descriptorsOf(config))` and print it through `Output.report`. The old text renderer has no replacement.
