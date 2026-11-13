---
plan: 38-jws-verifier
ticket: 07
title: "ADR-EA-057, ADR-EA-017 rev 1.1, BEH-EA-293/298/127"
type: execute
wave: 3
depends_on: [05, 06]
files_modified:
  - spec/decisions/057-one-jws-verifier.md
  - spec/decisions/017-jwt-signing-key-rotation.md
  - spec/decisions/index.yaml
  - spec/behaviors/36-jwt.md
  - spec/behaviors/16-oauth.md
autonomous: true
requirements: [REQ-EA-1591, REQ-EA-1593, REQ-EA-1594, REQ-EA-1596]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "ADR-EA-057 exists, is indexed, and is Accepted — implemented"
    - "ADR-EA-017 decision 6 carries the alg-less-key note at revision 1.1; its decisions are otherwise unchanged"
    - "BEH-EA-293, 298 and 127 state the crit refusal and the RFC 7517 selection rules; no new BEH id is added"
  artifacts:
    - path: spec/decisions/057-one-jws-verifier.md
      provides: "the decision record"
  key_links:
    - from: spec/decisions/index.yaml
      to: spec/decisions/057-one-jws-verifier.md
      via: "index entry (verify-traceability check 1)"
---
Status: done (uncommitted)
Blocked by: 05, 06

<objective>
Record the decision and amend the behaviour entries the code now meets.

Purpose: an executor or reviewer must find the RFC rules in the spec, not only in `Jws.ts` (PLAN.md §6.1–6.2).

Output: one new ADR, one ADR revision, and three amended behaviour entries with Document Control revisions.
</objective>

<context>
@.planning/38-jws-verifier/PLAN.md (§6.1, §6.2 draft ADR text)
@spec/decisions/049-plugins-own-event-definitions.md (ADR shape and Document Control)
@spec/decisions/017-jwt-signing-key-rotation.md
@spec/decisions/index.yaml
@spec/behaviors/36-jwt.md (Document Control rev 1.2; BEH-EA-292, 293, 298)
@spec/behaviors/16-oauth.md (Document Control rev 1.6; BEH-EA-127 line 164 ESS-003/ACS-004 paragraph, line 172 id_token claim paragraph)
@spec/scripts/verify-traceability.sh (check 8: BEH ids contiguous, the reason no BEH-EA-368 is added)
</context>

<tasks>

<task type="auto">
  <name>Task 1: ADR-EA-057 and ADR-EA-017 revision 1.1</name>
  <files>spec/decisions/057-one-jws-verifier.md, spec/decisions/017-jwt-signing-key-rotation.md, spec/decisions/index.yaml</files>
  <read_first>spec/decisions/049-plugins-own-event-definitions.md, spec/decisions/017-jwt-signing-key-rotation.md</read_first>
  <action>
Create `spec/decisions/057-one-jws-verifier.md`, titled "ADR-EA-057: A Compact JWS Is Verified by One Module of `@awthaq/ports`, Under RFC 7515/7517 Key Selection".

Document Control as in ADR-EA-049:
- Document ID `EFAUTH-ADR-057`, revision 1.0, effective date of landing;
- Status "Accepted — implemented";
- Change History "1.0: Initial release (architecture plan 38 tickets 04–06)".

Sections:
- Context, Decision, Alternatives considered, Consequences: take the five decisions and the text from PLAN.md §6.2 verbatim. Expand the alternatives from PLAN.md §3.6.
- Implementation: lists `packages/ports/src/Jws.ts`, the three callers, the vector table and the two differential runners.
- A short "Open points" list that records the defaults taken for PLAN.md Q1, Q2 and Q3 (copy them from the plan's "Decisions taken" section if an executor recorded a different answer).

In `017-jwt-signing-key-rotation.md`:
- Append to decision 6 the sentence from PLAN.md §6.2.
- Bump the revision to 1.1 and add a Change History entry "1.1: decision 6 note on keys that declare no `alg` (ADR-EA-057, plan 38)".
- Leave decisions 1–5 and the runbook unchanged (Accepted ADRs are not re-litigated).

In `index.yaml`, add the ADR-EA-057 entry after ADR-EA-049, with id, file, title and status in the existing shape.
  </action>
  <verify><automated>bash spec/scripts/verify-traceability.sh 2>&1 | grep -E 'index.yaml' | grep -c FAIL | grep -qx 0</automated></verify>
  <acceptance_criteria>
- `grep -c 'ADR-EA-057' spec/decisions/index.yaml` = 1 (baseline at HEAD: 0).
- `grep -c '| Revision | 1.1 |' spec/decisions/017-jwt-signing-key-rotation.md` = 1 (baseline at HEAD: 0).
- Check 3 (ADR ↔ traceability) is allowed to fail until ticket 09 adds the traceability row. Record that in Comments if this ticket lands alone.
  </acceptance_criteria>
  <done>The decision is recorded and indexed. ADR-EA-017 carries the note.</done>
</task>

<task type="auto">
  <name>Task 2: Amend BEH-EA-293, 298 (36-jwt) and 127 (16-oauth)</name>
  <files>spec/behaviors/36-jwt.md, spec/behaviors/16-oauth.md</files>
  <read_first>spec/behaviors/36-jwt.md (lines 1-70, 145-160), spec/behaviors/16-oauth.md (lines 1-15, 147-176)</read_first>
  <action>
`36-jwt.md`:
- BEH-EA-293's REQUIREMENT block gains two clauses, in the existing hard-wrapped style:
  - "a token MUST be refused when it is not three base64url segments of JSON objects, or when its header carries `crit` (RFC 7515 §4.1.11)";
  - "the key MUST be one whose `use` is absent or `sig`, whose `key_ops` is absent or includes `verify`, whose `alg`, if present, equals the header `alg`, and whose `kty`/`crv` fit it".
- Below the block, add one sentence: the rules live in `@awthaq/ports`'s `Jws` ([ADR-EA-057](../decisions/057-one-jws-verifier.md)), shared with the OIDC `id_token` verifier.
- BEH-EA-298 gains: "It MUST apply BEH-EA-293's rules to the fetched set; a key that names no `alg` is usable for an allowlisted algorithm its key type fits (RFC 7517 §4.4)."
- BEH-EA-292's text is unchanged.
- Revision 1.2 → 1.3. Change History: "1.3 (date): BEH-EA-293/298: `crit` refused, malformed segments refused without a defect, RFC 7517 key selection, `alg`-less JWKS keys; BEH-EA-292: a remote-registered key is served with its `kid` and `alg` (plan 38, ADR-EA-057)".

`16-oauth.md`, in BEH-EA-127, replace the sentence of the "Provider responses are decoded" paragraph that begins "JWKS entries are narrowed structurally" with: "JWKS entries are narrowed structurally before they can become key material, by the same rules as every verifier in the repo ([ADR-EA-057](../decisions/057-one-jws-verifier.md)):
- only RSA (`n`, `e`), EC (`crv`, `x`, `y`) and OKP (`crv`, `x`) entries are candidates;
- `use` absent or `sig`, `key_ops` absent or including `verify`;
- `alg` absent or equal to the token's;
- a `kty`/`crv` that fits the algorithm;
- a header `crit` refuses the token."

Then bump the revision 1.6 → 1.7 with a Change History entry naming plan 38.

Add no `## BEH-EA-` heading anywhere (check 8 requires contiguous ids; PLAN.md §6.1, Q8).
  </action>
  <verify><automated>bash spec/scripts/verify-traceability.sh 2>&1 | grep -E 'BEH-EA id integrity|Anchor|anchor' | grep -c FAIL | grep -qx 0</automated></verify>
  <acceptance_criteria>
- `grep -c 'crit' spec/behaviors/36-jwt.md` ≥ 1 (baseline at HEAD: 0).
- `grep -c 'key_ops' spec/behaviors/16-oauth.md` ≥ 1 (baseline at HEAD: 0).
- `grep -c '| Revision | 1.3 |' spec/behaviors/36-jwt.md` = 1, and `grep -c '| Revision | 1.7 |' spec/behaviors/16-oauth.md` = 1.
- `grep -ohE '^## BEH-EA-[0-9]+' spec/behaviors/*.md | sort -t- -k3 -n | tail -1` still prints `## BEH-EA-346`, unless other batch-4 plans landed first.
  </acceptance_criteria>
  <done>The behaviour entries state what the code does. No BEH id is added.</done>
</task>

</tasks>

<verification>
bash spec/scripts/verify-traceability.sh
pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular
</verification>

<success_criteria>
- ADR-EA-057 is indexed; ADR-EA-017 is at 1.1; 36-jwt is at 1.3 and 16-oauth at 1.7.
- The BEH id check passes.
</success_criteria>

## Comments
Result (uncommitted). ADR-EA-057 kept (`spec/decisions/057-one-jws-verifier.md`, indexed; strict verify accepts the unused 050-053/055/056 gaps, `FAIL: 0`). ADR-EA-017 rev 1.1 (decision 6 note). BEH-EA-293/298 amended in 36-jwt.md (rev 1.2 -> 1.3), BEH-EA-127 in 16-oauth.md (rev 1.7 -> 1.8, bumped from the current value); no BEH id added (highest stays BEH-EA-357; plan's 368-370 unused, Q8). 292 text unchanged. Deviation: spec/README.md and spec/overview.md not touched (README's ADR table stops at 040; overview already had the Jws entries from ticket 04).
