---
ID: "PV-241"
Title: "`awthaq plugin list --hooks` (and a rate-limit rule listing) do not exist although Auth.make's manifest already carries the resolved hook order"
Level: low
Category: "dx"
Status: open
Package: "cli"
Source: "packages/cli/src/Plugin.ts:1"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-241 — `awthaq plugin list --hooks` (and a rate-limit rule listing) do not exist although Auth.make's manifest already carries the resolved hook order

`LOW` · `dx` · `cli` · found while wiring `features/features/04-cross-cutting/12-hooks.feature` (P20a, REQ-EA-257/258) and `14-rate-limiting.feature` (REQ-EA-299)

Status: **open**

## Summary

BEH-EA-096 and BEH-EA-111 describe `awthaq plugin list --hooks` / `--graph` printing the resolved tap order and the resolved rate-limit rule order. The CLI's `plugin list` prints ids, `dependsOn`, groups and tables only, and its own header comment says hook chains "are not derivable without building the layers" — which stopped being true when PERS-003 added `Auth.make(...).manifest.hooks` (plugin-declared taps, sorted by `HookPoint.compareTaps`, no layer built). Rate-limit rules have no static declaration at all (they register at layer build, in `RateLimitsRegistry`), so a listing needs either a declared-rules counterpart to `taps` or a built composition.

The BDD scenarios were wired against the manifest (`hooks`) and the registry (`registered`), with their wording changed from "awthaq plugin list --hooks" to the manifest/registry read; this issue tracks the CLI surface itself.

## Recommended fix

Add `--hooks` to `plugin list` reading `manifest.hooks`; decide whether rate-limit rules become statically declarable (like `taps`) so the same command can list them.

## Comments

_Triage notes and discussion append here._
