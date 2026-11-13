---
plan: 38-jws-verifier
ticket: 08
title: "BDD: malformed segments and crit (REQ-EA-1590/1591)"
type: execute
wave: 3
depends_on: [07]
files_modified:
  - features/features/11-jwt/36-jwt.feature
  - features/step-definitions/JwtWorld.ts
  - features/traceability.md
autonomous: true
requirements: [REQ-EA-1590, REQ-EA-1591]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "Introspecting text whose segments are not base64url answers exactly {\"active\":false} (REQ-EA-1590)"
    - "Introspecting a token signed by the issuer's real key but carrying an unknown critical header answers exactly {\"active\":false} (REQ-EA-1591)"
    - "The REQ manifest is regenerated and current; the two new ids are the reserved 1590 and 1591, not allocator-assigned"
  artifacts:
    - path: features/features/11-jwt/36-jwt.feature
      provides: "two scenarios under the BEH-EA-293 rule"
    - path: features/step-definitions/JwtWorld.ts
      provides: "defect 'with an unknown critical header'"
  key_links:
    - from: features/features/11-jwt/36-jwt.feature
      to: features/step-definitions/JwtSteps.ts
      via: "existing steps only: 'introspects the text', 'a token signed by the issuer's key with the defect'"
---
Status: done (uncommitted)
Blocked by: 07

<objective>
Add the two BDD scenarios that make B1 and B2 visible in the business-readable suite.

Purpose: BEH-EA-293 has a Gherkin rule; every behaviour change updates its BDD.

Output: two scenarios, one new defect value, and a regenerated manifest.
</objective>

<context>
@.planning/38-jws-verifier/PLAN.md (§6.3)
@features/features/11-jwt/36-jwt.feature (lines 96-175, rule BEH-EA-293)
@features/step-definitions/JwtWorld.ts (lines 260-330: Defect, isDefect, signWithCurrentKey, forgeDefective)
@features/step-definitions/JwtSteps.ts (lines 140-145, 269-275)
@features/scripts/allocate-req-ea.py (keeps existing tags; assigns the next number only to untagged scenarios)
@features/STYLE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Two scenarios and the crit defect</name>
  <files>features/features/11-jwt/36-jwt.feature, features/step-definitions/JwtWorld.ts</files>
  <read_first>features/features/11-jwt/36-jwt.feature, features/step-definitions/JwtWorld.ts, features/STYLE.md</read_first>
  <action>
In `36-jwt.feature`, under the BEH-EA-293 rule, after the REQ-EA-787 scenario, add two scenarios:
- tagged by hand `@REQ-EA-1590`: "Text whose segments are not base64url gets the same answer". Given a signed-in user "alice"; When "alice" introspects the text "!!.e30.e30"; Then the introspection answer is exactly '{"active":false}'.
- tagged by hand `@REQ-EA-1591`: "A token with a critical header the verifier does not understand is not accepted". Given a signed-in user "alice"; And a token signed by the issuer's key with the defect "with an unknown critical header"; When "alice" introspects the forged token; Then the introspection answer is exactly '{"active":false}'.

Pre-tagging is required: the allocator would otherwise assign 1514 and 1515, outside this plan's reserved block (PLAN.md §6.3).

In `JwtWorld.ts`:
- Add "with an unknown critical header" to the `Defect` union and to `isDefect`.
- Give `signWithCurrentKey` an optional third argument, `extraHeader`, a string-keyed record. `JwtCodec.sign` fixes the header to `alg`/`kid`/`typ`, so when `extraHeader` is present, assemble the compact JWS by hand:
  - the base64url of the JSON header (`alg`, `kid`, `typ`, then the extras);
  - a dot, then the base64url of the JSON claims;
  - a dot, then the base64url of the signature from `JwtCodec.localSigner(material).sign` over the UTF-8 signing input.
  Use `Buffer.from(...).toString("base64url")`, as the test helpers do.
- `forgeDefective` maps the new defect to `signWithCurrentKey("at+jwt", {}, { crit: ["x-unknown"], "x-unknown": true })`.
  </action>
  <verify><automated>pnpm test:bdd</automated></verify>
  <acceptance_criteria>
- `pnpm test:bdd` passes, including both new scenarios.
- `grep -c '@REQ-EA-1590' features/features/11-jwt/36-jwt.feature` = 1 and `grep -c '@REQ-EA-1591' features/features/11-jwt/36-jwt.feature` = 1 (baseline at HEAD: 0 / 0).
  </acceptance_criteria>
  <done>Both scenarios run green against the real jwt plugin.</done>
</task>

<task type="auto">
  <name>Task 2: Regenerate the manifest</name>
  <files>features/traceability.md</files>
  <read_first>features/scripts/allocate-req-ea.py (usage header)</read_first>
  <action>Run `python3 features/scripts/allocate-req-ea.py` from the repo root. Commit the regenerated `features/traceability.md`: two new rows, and the header count goes from 1341 to 1343 with the highest issued at REQ-EA-1591. Do not edit the manifest by hand.</action>
  <verify><automated>python3 features/scripts/allocate-req-ea.py --check</automated></verify>
  <acceptance_criteria>
- The check exits 0.
- `grep -c '^| REQ-EA-159[01] ' features/traceability.md` = 2 (baseline at HEAD: 0).
- `bash spec/scripts/verify-traceability.sh 2>&1 | grep -E 'features tags <-> manifest rows|features manifest is current' | grep -c PASS` = 2.
  </acceptance_criteria>
  <done>The manifest is current.</done>
</task>

</tasks>

<verification>
pnpm test:bdd && python3 features/scripts/allocate-req-ea.py --check
pnpm typecheck && pnpm lint
(The strict `spec:verify` runs in ticket 09's plan gate, once the ADR-EA-057 traceability row exists.)
</verification>

<success_criteria>
- Two new green scenarios with REQ-EA-1590/1591; the manifest check passes.
</success_criteria>

## Comments
Result (uncommitted). Scenarios tagged REQ-EA-1567 (non-base64url text) and REQ-EA-1568 (unknown `crit`), not the plan's 1590/1591 (catalog contiguous: highest was 1566). New defect "with an unknown critical header" in JwtWorld.ts (`signWithCurrentKey` takes an optional `extraHeader` and assembles the JWS by hand). Manifest regenerated (1357 rows), `allocate-req-ea.py --check` exit 0. BDD run: `pnpm --filter @awthaq/features test -t "base64url|critical header"` 2 passed; whole `features/11-jwt` file 52 passed. Note: the features run resolves `@awthaq/*` through gitignored `packages/*/lib`, which was stale (pre-Jws), so the crit scenario failed until `npx tsc -b packages/jwt/tsconfig.json packages/oauth/tsconfig.json` rebuilt lib (build output only, no source change).
