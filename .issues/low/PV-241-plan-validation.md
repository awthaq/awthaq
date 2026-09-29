---
ID: "PV-241"
Title: "`awthaq plugin list --hooks` (and a rate-limit rule listing) do not exist although Auth.make's manifest already carries the resolved hook order"
Level: low
Category: "dx"
Status: resolved
Package: "cli"
Source: "packages/cli/src/Plugin.ts:1"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-241 — `awthaq plugin list --hooks` (and a rate-limit rule listing) do not exist although Auth.make's manifest already carries the resolved hook order

`LOW` · `dx` · `cli` · found while wiring `features/features/04-cross-cutting/12-hooks.feature` (P20a, REQ-EA-257/258) and `14-rate-limiting.feature` (REQ-EA-299)

Status: **resolved**

## Summary

BEH-EA-096 and BEH-EA-111 describe `awthaq plugin list --hooks` / `--graph` printing the resolved tap order and the resolved rate-limit rule order. The CLI's `plugin list` prints ids, `dependsOn`, groups and tables only, and its own header comment says hook chains "are not derivable without building the layers" — which stopped being true when PERS-003 added `Auth.make(...).manifest.hooks` (plugin-declared taps, sorted by `HookPoint.compareTaps`, no layer built). Rate-limit rules have no static declaration at all (they register at layer build, in `RateLimitsRegistry`), so a listing needs either a declared-rules counterpart to `taps` or a built composition.

The BDD scenarios were wired against the manifest (`hooks`) and the registry (`registered`), with their wording changed from "awthaq plugin list --hooks" to the manifest/registry read; this issue tracks the CLI surface itself.

## Recommended fix

Add `--hooks` to `plugin list` reading `manifest.hooks`; decide whether rate-limit rules become statically declarable (like `taps`) so the same command can list them.

## Comments

_Triage notes and discussion append here._

**Plan note (2026-09-29, P22):** Half done and left open on purpose. Shipped: awthaq plugin list --hooks (+ --format json) in packages/cli/src/Plugin.ts (Plugin.hooks, renderHooks) and Cli.ts, reading Auth.make(...).manifest.hooks: each point's plugin-declared taps in resolved order, with the application-taps caveat; tests in packages/cli/test/Inspection.test.ts over a two-plugin fixture (test/support/HookedApp.ts, red first: hooks flag and Plugin.hooks did not exist); BEH-EA-202 and the cli README updated. Remaining: the rate-limit rule listing. Rules register at layer build (RateLimitsRegistry), so a manifest-only command has nothing to read; it needs a design call between (a) a static declaration counterpart to taps (AuthPlugin.layer option, like declareTap, feeding manifest.rateLimits) and (b) an out-of-manifest command that builds the layers. Option (a) fits BEH-EA-208 (manifest-only) and is the recommendation, but it touches AuthPlugin and every plugin that registers rules (password, oauth, passkey, api-key), so it is left for its own change.

**Resolved (2026-09-29):** Static `rateLimits` declaration on `AuthPlugin.Service` (option (a), like `taps`): each rule's `group` is confined to the plugin's own contract groups by the compiler; `AuthPlugin.declareRateLimits`, `RateLimits.registerDeclared` and `RateLimits.declarationDrift` keep the declaration and the registry from drifting, with drift tests for password, oauth, passkey, api-key, magic-link, email-otp, two-factor and device-authorization. `AuthPlugin.layer` gains `ports` (joined into `RIn`, completeness compiler-checked), and both reach `Auth.make(...).manifest` (`rateLimits`, `ports`). `awthaq plugin list --rules` prints the declared rules; `plugin list --graph` prints each plugin's required ports and where its declared taps sit in each hook chain (BEH-EA-111, BEH-EA-202; scenarios REQ-EA-578/579 reworded back). Gates from a clean build: typecheck, 3246 tests, 1334 BDD scenarios, spec:verify:strict, oxlint, oxfmt, knip, package:smoke, test:pg (586).
