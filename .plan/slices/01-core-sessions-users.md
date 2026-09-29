# Slice 01-core-sessions-users — validation & fix plan

- Validated at HEAD `ec065a7` on 2026-09-29 against `packages/core/src/{Sessions,Verification,Users,Accounts,Slots,Auth,AuthPlugin}.ts` and their callers.
- Manifest: `.plan/_manifests/01-core-sessions-users.tsv` (74 issues). Machine-readable twin: `.plan/slices/01-core-sessions-users.json`.
- ID collisions: `AH-`, `ESS-`, `SMS-`, `TS-` prefixes are reused by two auditors; `issue_file` is the unique key, and cross-references to those prefixes use the file stem (e.g. `ESS-005-effect-stream-specialist`).

## Counts (verdict × level)

| Verdict | high | medium | low | info | Total |
|---|---|---|---|---|---|
| CONFIRMED | 3 | 18 | 8 | 1 | 30 |
| PARTIAL | 0 | 8 | 1 | 0 | 9 |
| ALREADY-FIXED | 1 | 1 | 2 | 0 | 4 |
| INVALID | 0 | 1 | 0 | 0 | 1 |
| DUPLICATE | 0 | 15 | 6 | 2 | 23 |
| WONTFIX-CANDIDATE | 0 | 4 | 1 | 2 | 7 |
| **Total** | 4 | 47 | 18 | 5 | 74 |

## Summary

The core session/user stratum is structurally sound (hashed id.secret tokens, constant-time session compare, CAS rotation, tombstone reuse detection, keyed `isLive`), and several audit claims have been overtaken by ~100 commits since the audit: the `as SessionId` casts, the verifyLive idle-expiry hole, the missing plugin migrations, and the missing reuse detection are gone. What remains is real:

1. **`Sessions.verify` checks row state before proving the secret.** Beyond the timing/expiry side channel the audit reported, this means RRS-003's reuse detection (family revocation + `auth.session.reuse`) fires on the **id half alone**. Anyone holding a superseded session id — the "public" half, which is in cookies, JWT `sid` claims and error messages — can force-log-out the user's current session. **New finding, recommend high priority** (planned under PIL-007).
2. **`issue(supersedes)` is still non-atomic** (tombstone + insert as two statements). A failed insert now produces a false reuse alarm as well as a logout.
3. **Nothing ever deletes expired sessions, tombstoned rows, consumed/expired verification rows, or memory reservations.** Ticket 30's Retention design is recorded but unimplemented.
4. **`Sessions.list` returns the 200 oldest rows, including expired ones.** Past that, `GET /session/current` dies with a 500 and `revoke` refuses owned sessions.
5. **Composition soundness gaps.** `Built<P>['layer']` is only right for pre-sorted tuples, slot-conflict checking is opt-in and nothing opts in, and ticket 26's single-HttpApi consolidation hasn't landed.
6. **Domain model gaps with recorded decisions still to implement.** UserIdentity/status (ticket 09) and HttpApi consolidation (ticket 26) are decided but not built. Error-channel policy, cookie configurability and plugin user fields still need decisions.

## Workstreams

### `session-docs-accuracy` — Session/memory-layer documentation accuracy

- **Closes:** PIL-006 (CONFIRMED), TRBS-005 (CONFIRMED), APS-010 (CONFIRMED), SEA-002 (CONFIRMED)
- **Why grouped:** Docs-only fixes in the same files: fixation mislabel, single-instance memory layers, ids-are-not-capabilities invariant, SQLite ceiling.
- **Effort:** S · **Order hint:** 1 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **PIL-006** — Reword the verify doc comment: fixation is prevented by fresh issuance/supersede (BEH-EA-053); throttled secret rotation limits the useful life of a leaked secret / stale hash snapshot. (effort S; full steps in the dossier)
  2. **TRBS-005** — Document every core layerMemory as single-process/test-grade and point multi-instance deployments at layerSql (or a future KV layer per ADR-EA-014). (effort S; full steps in the dossier)
  3. **APS-010** — Record the invariant 'ids are identifiers, never capabilities' in spec/invariants.md and on SessionId/UserId doc comments. (effort S; full steps in the dossier)
  4. **SEA-002** — Document the embedded-SQLite write ceiling and the move-to-Postgres signal; the retry/typed-error half rides on MA-004's decision. (effort S; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [PIL-006] No test (comment-only); pnpm lint/format:check.
  - [TRBS-005] Docs only; pnpm run spec:verify:strict.
  - [APS-010] pnpm run spec:verify:strict.
  - [SEA-002] Docs; pnpm run spec:verify:strict.
- **Acceptance:**
  - [PIL-006] No source comment calls secret rotation a session-fixation defense.
  - [TRBS-005] Each core layerMemory carries the single-instance warning; ADR-EA-014 states it.
  - [APS-010] The invariant exists and is referenced from both brands.
  - [SEA-002] An operator-facing doc states the SQLite ceiling and escalation path.

### `session-verify-hardening` — Session verify: prove the secret before any state branch

- **Closes:** IDS-008 (CONFIRMED), RRS-005 (WONTFIX-CANDIDATE), SMS-007 (DUPLICATE), PIL-007 (PARTIAL)
- **Why grouped:** PIL-007/SMS-007 share one root (verify branches on row state before the secret proof); validation found that this ordering lets an id-only caller trigger RRS-003 family revocation — a forced-logout DoS — so this goes first. IDS-008 is a cheap issue()-side invariant in the same file. RRS-005 (grace window) is decided against.
- **Effort:** M · **Order hint:** 1 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **IDS-008** — Enforce the self-act-as invariant inside Sessions.issue (both layers) as a typed defect, and document that the nesting check needs the caller's session and stays with the producer. (effort S; full steps in the dossier)
  2. **PIL-007** — Prove the secret before any row-state branch: hash first, look up, constant-time compare (against a dummy hash on miss), and only then evaluate tombstone/expiry; reuse detection must require a matching secret. (effort M; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [IDS-008] packages/core/test/Sessions.test.ts (both suites): 'BEH-EA-209: issue refuses actingAs naming the session's own userId' — expect a defect whose squashed error is InvalidActingAs (Effect.exit + Cause.squash).
  - [PIL-007] packages/core/test/Sessions.test.ts (both suites, write first — fails today): 'RRS-003: presenting a superseded id with a WRONG secret does not revoke the family' — issue, supersede, then verify(`${oldId}.deadbeef`): expect SessionNotFound, the successor session still verifies, and no auth.session.reuse event on AuthEvents.
  - [PIL-007] Same file: 'BEH-EA-056: an expired row with a wrong secret fails SessionNotFound, not SessionExpired' (id-only callers learn nothing about expiry).
  - [PIL-007] Same file: 'replaying the full pre-supersede token still triggers reuse detection' (regression guard for RRS-003).
  - [PIL-007] features/features/02-domain/07-sessions.feature: add a BEH-EA-056 scenario 'a wrong secret against a superseded session revokes nothing'.
- **Acceptance:**
  - [IDS-008] Sessions.issue({ userId: u, actingAs: { type: 'user', id: u } }) dies with InvalidActingAs in both layers.
  - [IDS-008] Admin.impersonate behavior unchanged (its typed refusal still fires first).
  - [PIL-007] No code path in verify mutates state or publishes an event unless the presented secret matches the stored hash.
  - [PIL-007] SessionExpired is only ever returned for a caller that presented the correct secret.
  - [PIL-007] Unknown-id and known-id-wrong-secret both perform one SHA-256 + one constant-time compare.

### `httpapi-surface-consolidation` — One served HttpApi: core groups in Auth.make (ticket 26)

- **Closes:** MW-002 (CONFIRMED)
- **Why grouped:** Decided design (wayfinder ticket 26); touches Auth.ts composeApi and every composition site.
- **Effort:** L · **Order hint:** 2 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **MW-002** — Implement ticket 26: composed api always carries core session/account groups, optional extraGroups for qadi's subject group, AuthHttp.coreHandlers convenience, and update every composition site. (effort L; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [MW-002] packages/core/test/AuthPlugin.test.ts (write first): 'BEH-EA-031/032: Auth.make(...).api contains the session and account groups' and 'a plugin contributing a group named session is refused with GroupIdConflict naming core'.
  - [MW-002] packages/server/test/AuthHttp.test.ts: 'GET /session/current is served from AuthHttp.routes(built.api) with coreHandlers'.
  - [MW-002] features/features/01-contract-and-persistence/04-contract-stratum.feature: BEH-EA-032 scenario for a single served document.
- **Acceptance:**
  - [MW-002] One HttpApi value (id 'auth') carries session/account (+ subject when passed) and all plugin groups.
  - [MW-002] A composition missing core handlers fails loudly at layer build (intended).
  - [MW-002] OpenAPI output from AuthHttp.docs(built.api) lists /session/* and /user.

### `session-supersede-atomicity` — Atomic issue(supersedes)

- **Closes:** AH-007 (ALREADY-FIXED), TTE-004 (ALREADY-FIXED), ECF-007 (DUPLICATE), ESR-002 (PARTIAL), PIL-004 (DUPLICATE), SMS-006 (DUPLICATE)
- **Why grouped:** Four findings on one defect (tombstone + insert not atomic). The AH-007/TTE-004 casts on the same lines were already removed.
- **Effort:** M · **Order hint:** 2 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **ESR-002** — Make issue(supersedes) one atomic unit in both layers: SQL tombstone+insert inside one transaction; memory tombstone+insert inside one Ref.modify. (effort M; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [ESR-002] packages/core/test/Sessions.test.ts (layerSql suite): 'BEH-EA-053: a failing insert during issue(supersedes) leaves the superseded session live and untombstoned' — provide a SessionsRepository wrapper whose `insert` fails with SqlError after delegating tombstone; assert the old token still verifies and no auth.session.reuse event was published. Write first; it fails today.
  - [ESR-002] packages/core/test/Sessions.test.ts (both suites): 'two concurrent issue(supersedes: same id) never leave two tombstone children' (Effect.all concurrency unbounded) — exactly one new session inherits familyId, the other founds a fresh family or fails.
  - [ESR-002] features/features/02-domain/07-sessions.feature: update the BEH-EA-053 scenario wording (tombstone, not delete) if it asserts deletion.
- **Acceptance:**
  - [ESR-002] A SqlError on the new-row insert leaves the superseded row with supersededAt NULL and still verifiable.
  - [ESR-002] layerMemory issue(supersedes) performs exactly one Ref.modify on the session map.
  - [ESR-002] BEH-EA-053 text no longer says 'deleted'; pnpm run spec:verify:strict passes.
  - [ESR-002] pnpm run typecheck && pnpm run test pass.

### `verification-hardening` — Verification constant-time compare and race test

- **Closes:** ACS-002 (CONFIRMED), MLO-004 (DUPLICATE), TSS-005 (DUPLICATE), MLO-006 (CONFIRMED)
- **Why grouped:** Three duplicate findings on one comparison plus a missing BEH-EA-062 race test.
- **Effort:** S · **Order hint:** 2 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **ACS-002** — Extract one shared constant-time comparator into @awthaq/ports and use it in Verification.layerMemory; document the SQL WHERE-equality exception. (effort S; full steps in the dossier)
  2. **MLO-006** — Add a concurrent-consume race test to the dual-layer Verification suite. (effort S; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [ACS-002] packages/ports/test/ConstantTime.test.ts: equal/unequal/length-mismatch cases.
  - [ACS-002] Existing Verification suites stay green.
  - [MLO-006] The test itself (should pass on HEAD; it is a regression guard).
- **Acceptance:**
  - [ACS-002] No `!==`/`===` comparison of a secret digest remains in packages/core/src.
  - [MLO-006] Both layers prove at-most-one concurrent consume success.

### `plugin-composition-soundness` — Auth.make static/runtime agreement and always-on slot conflicts

- **Closes:** JH-006 (CONFIRMED), MA-007 (DUPLICATE), ELC-006 (CONFIRMED), TTE-006 (WONTFIX-CANDIDATE), MA-005 (CONFIRMED), TS-004 (DUPLICATE), ELC-002 (DUPLICATE), JH-005 (DUPLICATE)
- **Why grouped:** All in Auth.ts/AuthPlugin.ts/Slots.ts: tuple-order soundness (JH-006/MA-007), dependsOn overwrite (ELC-006), opt-in SlotConflict (MA-005 + 3 dups). Sequence after MW-002 since both edit composeApi/composeLayer and Built<P>.
- **Effort:** M · **Order hint:** 3 · **Depends on workstreams:** httpapi-surface-consolidation
- **Ordered steps:**
  1. **JH-006** — Make the static fold provably equal to the runtime fold by refusing out-of-order tuples in Validate<P> (dependency must be listed before its dependent). (effort M; full steps in the dossier)
  2. **ELC-006** — Refuse a second AuthPlugin.layer registration for the same class whose dependsOn ids differ from the first (a definition-time invariant violation). (effort S; full steps in the dossier)
  3. **MA-005** — Make slot-conflict checking always-on: Auth.make provides one SlotsRegistry per composition, and Slots.override requires the registry instead of looking it up optionally. (effort M; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [JH-006] packages/core/test/AuthPlugin.test.ts (write first): `// @ts-expect-error - plugin "pong" depends on plugin "ping", which must be listed before it` on `Auth.make([Pong, Ping])` (mirrors the existing MissingDep @ts-expect-error at line ~148); fails today because the tuple is accepted.
  - [JH-006] Same file: a positive case asserting `Layer.Services<typeof built.layer>` for [Ping, Pong] excludes Ping (expectTypeOf).
  - [JH-006] features/.../02-plugin-composition-validate.feature: scenario 'an out-of-order tuple is refused at compile time'.
  - [ELC-006] packages/core/test/AuthPlugin.test.ts: 'two AuthPlugin.layer calls for one class with different dependsOn throw ConflictingDependsOn'; 'identical dependsOn re-registration is allowed' (covers Roles' pattern).
  - [MA-005] packages/core/test/AuthPlugin.test.ts (write first): 'INV-EA-004: Auth.make of two plugins overriding the same slot fails layer build with SlotConflict' — two test plugins each built with Slots.override on one slot, no Slots.layer provided by the test; today it builds and last-wins.
  - [MA-005] packages/core/test/Slots.test.ts: 'override without a registry is a type error' (@ts-expect-error when providing directly without SlotsRegistry).
  - [MA-005] features/features/00-foundations/03-ports-slots-hooks-registries.feature: BEH-EA-012 scenario runs through Auth.make without an explicit Slots.layer.
- **Acceptance:**
  - [JH-006] Auth.make([Dependent, Dependency]) is a compile error naming both ids.
  - [JH-006] All existing Auth.make call sites (examples, TestAuth, package tests) still compile (they are already ordered).
  - [ELC-006] Divergent dependsOn registrations fail loudly at module load; Roles' two same-deps layers still work.
  - [MA-005] Any Auth.make composition with two overriders of one slot fails at build with SlotConflict naming both owners.
  - [MA-005] Roles alone still composes and resolves its slot.
  - [MA-005] No application code needs to mention Slots.layer.

### `session-list-correctness` — Sessions.list returns exactly the live sessions

- **Closes:** VB-001 (ALREADY-FIXED), PIL-003 (DUPLICATE), ESS-005 (CONFIRMED)
- **Why grouped:** ESS-005 and PIL-003 share the 200-oldest-rows truncation; validation found GET /session/current dies past 200 rows. VB-001's verifyLive half is already fixed.
- **Effort:** M · **Order hint:** 3 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **ESS-005** — Make Sessions.list return exactly the user's live (non-tombstoned, non-expired) sessions, newest-activity first, in both layers, and stop server handlers from using list for keyed lookups. (effort M; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [ESS-005] packages/core/test/Sessions.test.ts (both suites, write first): 'BEH-EA-054: list excludes expired sessions and orders newest-activity first' (use ShortLivedLayer + TestClock).
  - [ESS-005] Same file (layerSql): 'BEH-EA-054: list returns all 250 live sessions, not the oldest 200'.
  - [ESS-005] packages/server/test/AuthHttp.test.ts: 'GET /session/current succeeds for a user with >200 historical sessions' (fails with a defect today).
  - [ESS-005] features/features/02-domain/07-sessions.feature: BEH-EA-054 scenario for expired sessions not appearing in the device list.
- **Acceptance:**
  - [ESS-005] Both layers return the same set/order for the same state.
  - [ESS-005] No handler dies or answers SessionNotFound for an owned live session because of list truncation.
  - [ESS-005] BEH-EA-054 text states list = live sessions only.

### `data-retention-sweep` — Retention sweep (ticket 30)

- **Closes:** DRS-003 (ALREADY-FIXED), ERS-007 (DUPLICATE), TRBS-006 (DUPLICATE), ESR-006 (DUPLICATE), ECF-008 (DUPLICATE), CSG-003 (CONFIRMED)
- **Why grouped:** Six findings on unbounded growth of sessions/verification rows/reservations in both layers; ticket 30 fixes the design. DRS-003 (plugin migrations) is already fixed and listed here for closure.
- **Effort:** L · **Order hint:** 4 · **Depends on workstreams:** session-supersede-atomicity
- **Ordered steps:**
  1. **CSG-003** — Implement ticket 30's Retention service: cutoff-based purge primitives on both Sessions and Verification (both layers), a RetentionConfig reference, Retention.sweep, and an opt-in Retention.layerScheduled. (effort L; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [CSG-003] packages/core/test/Retention.test.ts (new, runs against memory and SQL layers, write first): 'Retention.sweep deletes sessions past absoluteExpiresAt + sessionGrace and keeps live ones' (TestClock).
  - [CSG-003] Same file: 'Retention.sweep deletes consumed/expired verification rows older than the forensic window, keeps live and recent ones'.
  - [CSG-003] Same file: 'Retention.layerScheduled runs sweep on the configured interval' (TestClock.adjust).
  - [CSG-003] packages/sql/test/Repositories.test.ts: deleteExpiredBefore returns the affected count on sqlite (and the postgres suite).
  - [CSG-003] features/features/02-domain/08-verification-tokens.feature: amend the 'row has not been physically deleted' scenario to remain true before the forensic window.
- **Acceptance:**
  - [CSG-003] After sweep, no session row older than absoluteExpiresAt + grace and no verification row consumed/expired before the window remains, in both layers.
  - [CSG-003] The scheduled layer is off unless explicitly provided.
  - [CSG-003] Memory layers' maps shrink after sweep.
  - [CSG-003] pnpm check passes (knip sees Retention used).

### `users-identity-model` — UserIdentity union, status, phone normalization (ticket 09)

- **Closes:** SCP-005 (PARTIAL), FAMS-002 (CONFIRMED), SOS-008 (CONFIRMED)
- **Why grouped:** FAMS-002's decided model change; SOS-008 adds the E.164 piece ticket 09 left open; SCP-005 is the SCIM spec write-down of tickets 08/09.
- **Effort:** XL · **Order hint:** 4 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **SCP-005** — Record ticket 08/09's SCIM identity decisions in spec/models/12-scim.md (docs only). (effort S; full steps in the dossier)
  2. **FAMS-002** — Implement ticket 09: UserRecord.identity: UserIdentity union + status, widened create, promoteIdentity, setStatus, dialect-branched migrations, and retire OAuth's synthetic email. (effort XL; full steps in the dossier)
  3. **SOS-008** — Ship E.164 normalization as part of ticket 09's Phone identity, enforced at the Users boundary, plus the verify-phone identifier scheme. (effort M; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [SCP-005] pnpm run spec:verify:strict.
  - [FAMS-002] packages/core/test/Users.test.ts (both suites, write first): 'create Anonymous user without email', 'promoteIdentity Anonymous -> Email enforces uniqueness', 'setStatus suspended is not writable via updateProfile'.
  - [FAMS-002] packages/oauth/test: 'provider profile without email creates an Anonymous-identity user, never a synthetic email'.
  - [FAMS-002] features/features/02-domain/06-users-accounts.feature: BEH-EA-041 revised scenarios.
  - [SOS-008] packages/core/test/Phone.test.ts: '+1 555 0100', '15550100' (default region US) and '+15550100' normalize identically; invalid inputs fail decode.
- **Acceptance:**
  - [SCP-005] 12-scim.md states the mapping and deactivate/delete semantics.
  - [FAMS-002] No production code fabricates an email; anonymous and phone users persist in both layers; migrations run on sqlite + postgres test suites.
  - [SOS-008] Three spellings of one number resolve to one stored value; the type system prevents unnormalized phones reaching Users.

### `accounts-targeted-writes` — Column-targeted Accounts secret writes

- **Closes:** RRS-006 (PARTIAL)
- **Why grouped:** Single finding; removes read-pass-through writes of secret columns.
- **Effort:** M · **Order hint:** 5 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **RRS-006** — Replace read-pass-through writes with column-targeted UPDATE statements (no read needed) so writers of one secret never rewrite another. (effort M; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [RRS-006] packages/core/test/Accounts.test.ts (SQL suite): 'updateProviderTokens never rewrites passwordHash' (set both on one row via link, update tokens concurrently with updateCredentialHash, both survive).
- **Acceptance:**
  - [RRS-006] No Accounts write path reads and re-writes a secret column it is not changing.

### `core-error-taxonomy` — Core error channels and tags

- **Closes:** EEM-008 (DUPLICATE), EOTS-004 (CONFIRMED), MA-004 (CONFIRMED), GC-004 (CONFIRMED), ESS-008 (CONFIRMED), EEM-006 (DUPLICATE)
- **Why grouped:** Infra-failure policy (MA-004/EEM-006, needs decision), tag collisions (ESS-008/EEM-008), ids in messages (EOTS-004), layer divergence on races (GC-004). EOTS-004/GC-004/ESS-008 can ship independently of the MA-004 decision.
- **Effort:** XL · **Order hint:** 5 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **EOTS-004** — Stop interpolating identifiers into core error messages; carry them only as typed fields, and state the logging policy. (effort S; full steps in the dossier)
  2. **MA-004** — Adopt one infrastructure-error policy across core Shapes (recommended: typed StoreUnavailable), recorded as an ADR, and make every Shape's E channel authoritative for both layers. (effort XL; full steps in the dossier)
  3. **GC-004** — Give UsersRepository a targeted, Option-returning profile update and map a missing row to UserNotFound so layerSql honors the Shape's declared E like layerMemory. (effort S; full steps in the dossier)
  4. **ESS-008** — Make internal (Data) and wire (Schema) error tags disjoint by construction and guard it with a test. (effort M; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [EOTS-004] packages/core/test/Sessions.test.ts: 'SessionNotFound.message never contains the session id' (both suites, write first).
  - [EOTS-004] Same for Users/Verification tests.
  - [MA-004] packages/core/test/Sessions.test.ts (layerSql, write first): 'a SqlError from the repository surfaces as StoreUnavailable, not a defect' (stub SessionsRepository failing with SqlError).
  - [MA-004] packages/server/test/Authentication.test.ts: 'StoreUnavailable from verify answers 503, not 401/500'.
  - [MA-004] features/features/03-http-layer/11-http-error-mapping.feature: scenario for store outage -> 503.
  - [GC-004] packages/core/test/Users.test.ts (both suites, write first): 'updateProfile on a user deleted concurrently fails UserNotFound, never a defect' — race via a BeforeUserDelete-free delete between findById and update using a repository stub for SQL.
  - [ESS-008] ErrorTags test (write first; fails today on the 5 collisions).
- **Acceptance:**
  - [EOTS-004] grep for '${id}' / '${identifier}' / '${email}' inside `message:` template literals in packages/core/src returns nothing.
  - [MA-004] No core *Shape mentions PlatformError; every layerSql IO failure is a typed StoreUnavailable; invariant violations still die.
  - [MA-004] Grep finds zero `catchTag("PlatformError", Effect.die)` in plugin src.
  - [GC-004] updateProfile/delete in layerSql never die on a missing row; both layers return UserNotFound.
  - [ESS-008] No tag string is shared between a Data.TaggedError and a Schema.TaggedError across packages/*/src; the guard runs in pnpm check.
- **Blocked on decision:** MA-004 (see Decisions needed).

### `user-import-idempotency` — Idempotent, transactional user import

- **Closes:** SAM-008 (DUPLICATE), AOMS-008 (PARTIAL), MW-007 (WONTFIX-CANDIDATE), SCP-003 (CONFIRMED)
- **Why grouped:** createOrGet (SCP-003) is the primitive under the import surface (AOMS-008/SAM-008). MW-007 is a wontfix candidate.
- **Effort:** L · **Order hint:** 5 · **Depends on workstreams:** users-identity-model
- **Ordered steps:**
  1. **AOMS-008** — Provide a transactional, idempotent import primitive in core and batch importers on top of it. (effort L; full steps in the dossier)
  2. **SCP-003** — Add Users.createOrGet: insert, and on unique violation return the existing record deterministically (both layers). (effort S; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [AOMS-008] packages/core/test/Users.test.ts: 'importUser twice with the same input returns the same user with created=false'; 'a failing link rolls back the user row' (SQL suite).
  - [AOMS-008] packages/migrate-auth0/test: batch import of N users is re-runnable after a mid-batch failure.
  - [SCP-003] packages/core/test/Users.test.ts (both suites): 'two concurrent createOrGet for one email return the same user, exactly one created=true' (Effect.all unbounded).
- **Acceptance:**
  - [AOMS-008] Re-running an import converges without errors; no partial user (user without its credential account) survives a failed row.
  - [SCP-003] createOrGet is idempotent under retries and concurrency in both layers.

### `session-cookie-policy` — Configurable session cookie with a secure default

- **Closes:** IC-007 (CONFIRMED), EP-008 (DUPLICATE), AGA-004 (CONFIRMED), BO-005 (CONFIRMED)
- **Why grouped:** Four findings all constrained by BEH-EA-055's fixed attribute set — one decision, one helper routed through all 8 issuance sites.
- **Effort:** L · **Order hint:** 6 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **IC-007** — Introduce SessionCookieConfig with a secure default and typed opt-in modes (incl. __Secure-+Domain for multi-subdomain apps); route every issuance site through one helper. (effort L; full steps in the dossier)
  2. **AGA-004** — Deliver the `HostEmbedded` mode of IC-007's SessionCookieConfig (SameSite=None; Partitioned; __Host- kept) for session and CSRF cookies. (effort S; full steps in the dossier)
  3. **BO-005** — Give the session cookie a Max-Age derived from the session's absoluteExpiresAt (recomputed at every rotation), via IC-007's cookie helper, with a 'browserSession' opt-out. (effort S; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [IC-007] packages/core/test/Sessions.test.ts: 'sessionCookie default renders exactly __Host-session; Secure; HttpOnly; SameSite=Strict; Path=/ plus Max-Age from absoluteExpiresAt' (pure unit test, write first).
  - [IC-007] packages/server/test/AuthHttp.test.ts: 'rotated cookie carries a recomputed Max-Age'; 'HostEmbedded mode emits SameSite=None; Partitioned and keeps __Host-'.
  - [IC-007] features/features/03-http-layer/09-authentication-middleware.feature (or 07-sessions.feature): BEH-EA-055 scenarios per mode.
  - [AGA-004] packages/server/test/AuthHttp.test.ts: 'HostEmbedded mode issues __Host-session with SameSite=None; Partitioned' and same for the CSRF cookie.
  - [BO-005] packages/core/test/Sessions.test.ts: helper computes Max-Age = absoluteExpiresAt - now.
  - [BO-005] packages/server/test/AuthHttp.test.ts: 'sign-in Set-Cookie carries Max-Age ~= 30d' and 'rotation Set-Cookie Max-Age shrinks toward absolute expiry'.
- **Acceptance:**
  - [IC-007] Default output byte-identical to today except Max-Age (if persistence='absolute' is chosen).
  - [IC-007] A SecureDomain mode issues __Secure-session with Domain; __Host- + Domain is a type error.
  - [IC-007] All issuance sites use the helper (grep SESSION_COOKIE_ATTRIBUTES finds only the helper).
  - [AGA-004] With HostEmbedded configured, both cookies carry Partitioned and SameSite=None; default output unchanged.
  - [BO-005] Every Set-Cookie for the session carries Max-Age <= remaining absolute lifetime.
  - [BO-005] BEH-EA-055 documents the lifetime attribute.
- **Blocked on decision:** IC-007, AGA-004, BO-005 (see Decisions needed).

### `users-profile-surface` — User profile fields: image, email change, plugin-contributed fields

- **Closes:** SAM-004 (PARTIAL), BAM-009 (PARTIAL), BE-007 (DUPLICATE), SCP-004 (DUPLICATE)
- **Why grouped:** BAM-009/SCP-004 need email mutation + image; SAM-004/BE-007 need BEH-EA-040/048's extension point (decision needed).
- **Effort:** XL · **Order hint:** 6 · **Depends on workstreams:** users-identity-model
- **Ordered steps:**
  1. **SAM-004** — Implement the BEH-EA-040/048 user-field extension point (decision option A), decomposed into four tickets, with interim docs. (effort XL; full steps in the dossier)
  2. **BAM-009** — Add a nullable image field and a verified email-change primitive to Users; document better-auth field mapping. (effort L; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [SAM-004] packages/core/test/AuthPlugin.test.ts: 'a plugin declaring userFields exposes them on Users with inferred types' and '@ts-expect-error writing a non-clientWritable field via the HTTP payload type'.
  - [SAM-004] features/features/02-domain/06-users-accounts.feature: BEH-EA-048 scenarios.
  - [BAM-009] packages/core/test/Users.test.ts (both suites): 'changeEmail resets emailVerified and enforces uniqueness'; 'updateProfile sets image'.
  - [BAM-009] packages/password/test: change-email flow end to end.
- **Acceptance:**
  - [SAM-004] A plugin can declare a typed user field end-to-end (migration, storage, typed read/write, client type) without touching core source.
  - [BAM-009] A user can change email only via a verified flow; image round-trips.
- **Blocked on decision:** SAM-004 (see Decisions needed).

### `verification-otp-substrate` — Verification as an OTP substrate (ticket 05 prerequisites)

- **Closes:** SOS-007 (WONTFIX-CANDIDATE), MLO-002 (CONFIRMED), BCR-005 (PARTIAL), SOS-004 (CONFIRMED), THS-005 (CONFIRMED), BCR-008 (WONTFIX-CANDIDATE)
- **Why grouped:** Short codes (BCR-005) are only safe with an attempt budget (SOS-004); reserve (MLO-002) is the resend-window primitive; TOTP replay (THS-005) belongs to the two-factor design.
- **Effort:** M · **Order hint:** 6 · **Depends on workstreams:** —
- **Ordered steps:**
  1. **MLO-002** — Make reserve's status a decision: document it as the resend-window primitive for MagicLink/EmailOtp (ticket 05) and use it there; until then note it in the Shape doc. (effort S; full steps in the dossier)
  2. **BCR-005** — Let Verification.issue mint caller-formatted values via a typed generator option (never a raw caller string), keeping hashing and single-use semantics. (effort M; full steps in the dossier)
  3. **SOS-004** — Add an optional per-token attempt budget: each failed consume against a live row increments attempts; the row is burned at maxAttempts. (effort M; full steps in the dossier)
  4. **THS-005** — Add a lastUsedStep compare-and-set to the TOTP secret row in the two-factor design and implementation. (effort S; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [MLO-002] If Password is wired: packages/password/test 'two concurrent resendVerification calls send one mail'.
  - [BCR-005] packages/core/test/Verification.test.ts (both suites): 'Digits(6) issue returns a 6-digit value that consumes once'; property test for uniform digit distribution (optional).
  - [SOS-004] packages/core/test/Verification.test.ts (both suites, write first): 'a token with maxAttempts 3 is unusable after 3 wrong guesses even with the right value next'.
  - [THS-005] packages/two-factor/test: 'the same valid code presented twice (sequentially and concurrently) succeeds once'.
- **Acceptance:**
  - [MLO-002] reserve has a documented consumer or a production caller.
  - [BCR-005] EmailOtp can issue 6-digit codes through Verification without bending identifiers.
  - [SOS-004] Bounded-guess tokens cannot be brute-forced within TTL; 256-bit tokens without maxAttempts behave as today.
  - [THS-005] Replay of a TOTP code within its window is refused.

### `session-policy` — Session policy features: concurrent cap, amr

- **Closes:** SMS-003 (CONFIRMED), PIL-008 (WONTFIX-CANDIDATE), THS-003 (CONFIRMED)
- **Why grouped:** Opt-in features on SessionConfig/SessionView; SMS-003's cap enforcement reuses ESR-002's atomic issue.
- **Effort:** L · **Order hint:** 7 · **Depends on workstreams:** session-supersede-atomicity
- **Ordered steps:**
  1. **SMS-003** — Add an opt-in concurrent-session cap to SessionConfig (default: none, preserving BEH-EA-047) with a typed eviction policy, enforced atomically in issue, publishing an event on eviction. (effort M; full steps in the dossier)
  2. **THS-003** — Add RFC 8176 `amr` evidence to sessions: set at issue by the authenticating plugin, extendable by reauthenticate, exposed on SessionView/SessionListItem/SessionDto. (effort L; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [SMS-003] packages/core/test/Sessions.test.ts (both suites, write first): 'maxConcurrent {limit: 2, evictOldest}: issuing a 3rd session evicts the least-recently-active and publishes auth.session.revoked(limitEvicted)'.
  - [SMS-003] Same: 'default config never evicts (BEH-EA-047)'.
  - [THS-003] packages/core/test/Sessions.test.ts (both suites): 'issue records amr and verify returns it'; 'reauthenticate unions amr'.
  - [THS-003] packages/password/test: sign-in session carries amr ['pwd'].
- **Acceptance:**
  - [SMS-003] Default behavior unchanged; with a cap configured the user never holds more than `limit` live sessions after issue returns.
  - [THS-003] Every issued session carries a non-empty amr for password/passkey/oauth sign-ins; SQL and memory agree.

### `build-tooling-hygiene` — Build/test tooling hygiene

- **Closes:** AH-006 (PARTIAL), ELC-004 (CONFIRMED), MTS-001 (CONFIRMED)
- **Why grouped:** Declaration-specifier guard, project-reference trimming (after MW-002 adds core->api), test-layer boilerplate.
- **Effort:** S · **Order hint:** 8 · **Depends on workstreams:** httpapi-surface-consolidation
- **Ordered steps:**
  1. **AH-006** — Add a consumer-resolution guard to package:smoke rather than rewriting emitted declarations. (effort S; full steps in the dossier)
  2. **ELC-004** — Provide ready-made crypto-provided memory aggregates and migrate tests. (effort M; full steps in the dossier)
  3. **MTS-001** — Trim every tsconfig.src.json references list to its transitive src-import closure and add a CI guard. (effort S; full steps in the dossier)
- **Test plan (write the failing tests first):**
  - [AH-006] The smoke check itself (passes today).
  - [ELC-004] Existing suites stay green after migration.
  - [MTS-001] The guard script itself run in pnpm check (fails today on the 32 edges).
- **Acceptance:**
  - [AH-006] pnpm package:smoke fails if a published package's types stop resolving for a nodenext, skipLibCheck:false consumer.
  - [ELC-004] New tests have a one-line way to get crypto-provided memory layers; site count drops substantially.
  - [MTS-001] Zero unreachable or missing reference edges; pnpm run typecheck and pnpm build pass.

### `read-replica-routing` — Read-replica consistency (cross-slice canonical RRC-001)

- **Closes:** RRC-004 (DUPLICATE), DRS-004 (WONTFIX-CANDIDATE), RRC-006 (INVALID), RRC-005 (DUPLICATE)
- **Why grouped:** RRC-004/RRC-005 are latent and closed by RRC-001's ticket-28 design (sql slice); RRC-006 is invalid; DRS-004 wontfix. No work planned in this slice.
- **Effort:** S · **Order hint:** 9 · **Depends on workstreams:** —
- **No work in this slice** — see the dossiers for the closure reasons.

## Decisions needed

### SAM-004 — No home for auth.users metadata; plugin-contributed fields are spec-only

Options:
- A) Implement BEH-EA-040/048 as specified: a plugin declares typed scalar `userFields` (Schema per field + `clientWritable: boolean`, default per BEH-EA-048) in AuthPlugin.Service options; its migration adds `${pluginId}_${field}` nullable columns to users; Users gains typed get/set for declared fields; Auth.make's type computes the composed field set (types-first).
- B) Typed JSON attributes: one `attributes` JSON column keyed by plugin id, each plugin supplying a Schema; validated on write, gated per field.
- C) Docs only: sanctioned pattern = plugin-owned prefixed side table keyed by userId (+ the existing opaque metadata for app data).

**Recommendation:** A — it is what the spec already prescribes (BEH-EA-040 scalar-only shared-table extension through a declared extension point; BEH-EA-048 write-gating) and gives type-level field inference, matching the type-system-first preference. Ship C's documentation immediately as an interim note; decompose A into (1) declaration + type computation, (2) migration lane, (3) Users read/write + gating, (4) client DTO inference.

### IC-007 / AGA-004 / BO-005 — Fixed non-configurable __Host-/Strict cookie forecloses legitimate deployments

Options:
- A) Keep BEH-EA-055 fixed (status quo): wontfix IC-007/EP-008/AGA-004; fix BO-005 only by adding a lifetime to the fixed set.
- B) Add a `SessionCookieConfig` Context.Reference whose default is exactly today's attribute set, with a typed, closed union of opt-in modes: `Host` (default, __Host-, SameSite=Strict), `HostEmbedded` (__Host-, SameSite=None, Partitioned — CHIPS keeps the __Host- prefix), `SecureDomain({ domain, sameSite })` (__Secure- prefix + Domain for multi-subdomain apps), plus `persistence: 'absolute' | 'browserSession'` for Max-Age. Illegal combinations (e.g. __Host- + Domain) are unrepresentable by construction.
- C) Free-form cookie options passthrough (Auth.js style).

**Recommendation:** B. It matches the 'flexibility over complexity' preference while keeping the secure default byte-identical and making insecure/illegal combos unrepresentable (types-first). Default persistence: 'absolute' (Max-Age = absoluteExpiresAt - now, recomputed on every rotation) for Auth.js/better-auth parity (BO-005); 'browserSession' stays available. SameSite=None modes must keep the CSRF double-submit middleware mandatory (document in BEH-EA-055/Csrf).

### MA-004 — Environmental failures (SqlError, SchemaError, PlatformError) are systematically routed to the defect channel

Options:
- A) Codify the de facto policy (NHS-002/EEM-003's d16134b already chose it at the HTTP edge): infrastructure failures are defects. Remove PlatformError from every core *Shape E channel (orDie at the layer seam, as layerSql already does for SqlError/SchemaError) and write an ADR saying so. Smallest change; callers lose the ability to retry/fallback.
- B) Typed infrastructure error: one core `StoreUnavailable` (Data.TaggedError carrying `cause` and `operation`) replaces PlatformError in every core Shape and absorbs SqlError/SchemaError-from-IO in layerSql; genuine invariant violations still die. Middleware maps StoreUnavailable to 503 (+ Retry-After) instead of dying to 500. Callers (SQLite busy, pool exhaustion) can retry with Schedule.
- C) Status quo, documented per-layer (not recommended: Shape E channels stay non-authoritative).

**Recommendation:** B — richer and closes both findings: EEM-006's complaint (PlatformError taxing every call site with a die mapping) disappears because PlatformError no longer appears in any public channel, and MA-004's complaint (environmental failures uncatchable) is fixed with one typed, retryable error. Record it in a new ADR (spec/decisions/017/018-infrastructure-error-policy.md) and roll out per service (Sessions first — hot path — then Users/Accounts/Verification/AuditLog), since it touches ~270 orDie/die sites.

## Per-issue dossiers

### Workstream `session-docs-accuracy`

#### TRBS-005 — Memory layer revocation never propagates: per-process Ref, zero cross-instance story

`medium` · `security` · `core` · [.issues/medium/TRBS-005-token-revocation-blacklist-specialist.md](../../.issues/medium/TRBS-005-token-revocation-blacklist-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:317` — No doc comment on layerMemory; nothing states the single-process constraint.
```ts
export const layerMemory: Layer.Layer<Sessions, never, Crypto.Crypto | AuthEvents.AuthEvents> =
  Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const state = yield* Ref.make(HashMap.empty<SessionId, SessionRow>());
```
- `spec/decisions/014-session-storage-backend-neutrality.md:19` — The single-process caveat is spelled out for RateLimiter only, not for Sessions/Users/Accounts/Verification memory layers.
```ts
... (BEH-EA-109: "the memory store is adequate for a single process and for tests; Redis (or a SQL-backed store) is the production default for multi-instance deployments").
```

**Fix plan:** Document every core layerMemory as single-process/test-grade and point multi-instance deployments at layerSql (or a future KV layer per ADR-EA-014).

Steps:
1. Add a doc comment to Sessions/Users/Accounts/Verification `layerMemory` stating: per-process Ref, not shared across instances, revocation does not propagate, unbounded growth until Retention.sweep (CSG-003) — use layerSql for multi-instance.
2. Add the same sentence to ADR-EA-014 (spec/decisions/014-session-storage-backend-neutrality.md) Consequences and to examples/memory-server/index.ts's header.
3. Note AuthEvents' in-process PubSub has the same boundary (cross-slice ESS/AuthEvents owners).

Files: `packages/core/src/Sessions.ts`, `packages/core/src/Users.ts`, `packages/core/src/Accounts.ts`, `packages/core/src/Verification.ts`, `spec/decisions/014-session-storage-backend-neutrality.md`, `examples/memory-server/index.ts`

Tests:
- Docs only; pnpm run spec:verify:strict.

Acceptance:
- Each core layerMemory carries the single-instance warning; ADR-EA-014 states it.

Spec refs: BEH-EA-054 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### SEA-002 — Single-writer write path is sound but its event-loop cost and 5s busy ceiling are nowhere surfaced

`medium` · `performance` · `core` · [.issues/medium/SEA-002-sqlite-embedded-auth-specialist.md](../../.issues/medium/SEA-002-sqlite-embedded-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence medium)

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:76` — The throttle bounds steady-state writes; nothing documents the SQLite single-writer/busy_timeout ceiling.
```ts
      touchEvery: Duration.hours(1),
```
- `packages/core/src/Sessions.ts:710` — Hot write paths die on SqlError (busy timeout) — the retry half is MA-004's taxonomy question.
```ts
      const row = yield* repo.insert(insert).pipe(Effect.orDie);
```

**Fix plan:** Document the embedded-SQLite write ceiling and the move-to-Postgres signal; the retry/typed-error half rides on MA-004's decision.

Steps:
1. Add spec/appendices/04-sqlite-embedded-deployment.md (+ index.yaml): writes serialize (Semaphore(1)), node:sqlite blocks the event loop, busy_timeout default 5s then SqlError -> defect today, sizing guidance, when to switch to Postgres.
2. Once MA-004 lands a typed infra error, add a bounded retry (Schedule) around Sessions.issue/touch for SQLITE_BUSY in layerSql.

Files: `spec/appendices/04-sqlite-embedded-deployment.md`, `spec/appendices/index.yaml`, `packages/core/src/Sessions.ts`

Tests:
- Docs; pnpm run spec:verify:strict.

Acceptance:
- An operator-facing doc states the SQLite ceiling and escalation path.

Spec refs: — · Effort **S** · Depends on: MA-004 · Needs decision: no

**Recommended status:** `ready-for-agent`

#### PIL-006 — Secret rotation mislabeled 'the standard session-fixation defense'

`low` · `docs` · `core` · [.issues/low/PIL-006-pilcrow.md](../../.issues/low/PIL-006-pilcrow.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:187` — Mislabel still present verbatim at HEAD.
```ts
   * Upstream-hardening map, ticket 01: the same throttled-touch write also
   * rotates the session's secret (the standard session-fixation defense) —
```

**Fix plan:** Reword the verify doc comment: fixation is prevented by fresh issuance/supersede (BEH-EA-053); throttled secret rotation limits the useful life of a leaked secret / stale hash snapshot.

Steps:
1. Edit SessionsShape.verify's doc comment (Sessions.ts ~187-194) accordingly.
2. grep the repo (packages/*/src, spec/, .scratch excluded) for 'session-fixation defense' and fix any copy (e.g. packages/next/src/GetSession.ts comments quoting this text).

Files: `packages/core/src/Sessions.ts`, `packages/next/src/GetSession.ts`

Tests:
- No test (comment-only); pnpm lint/format:check.

Acceptance:
- No source comment calls secret rotation a session-fixation defense.

Spec refs: BEH-EA-052, BEH-EA-053 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### APS-010 — All principal identifiers are UUIDv7: time-ordered, partially predictable

`info` · `security` · `core` · [.issues/info/APS-010-auth-pentest-specialist.md](../../.issues/info/APS-010-auth-pentest-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence medium)

Informational and accurate: no exploit today, but PIL-007's finding (reuse detection triggerable by id alone) is exactly the kind of 'authorizes on id' path this invariant warns about — it strengthens the case for writing the invariant down.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:328` — UUIDv7 ids (time-prefixed) — accurate; secret half is 256-bit.
```ts
        const id = SessionId(yield* crypto.randomUUIDv7);
        const secret = toHex(yield* crypto.randomBytes(32));
```

**Fix plan:** Record the invariant 'ids are identifiers, never capabilities' in spec/invariants.md and on SessionId/UserId doc comments.

Steps:
1. Add INV-EA-0NN to spec/invariants.md: no endpoint or state transition may act on a principal/session id without a secret/credential proof; ids are UUIDv7 and time-ordered.
2. Reference it from SessionId (Sessions.ts:29) and UserId (Users.ts:47) doc comments.
3. Wire the new INV into spec/traceability.md.

Files: `spec/invariants.md`, `packages/core/src/Sessions.ts`, `packages/core/src/Users.ts`, `spec/traceability.md`

Tests:
- pnpm run spec:verify:strict.

Acceptance:
- The invariant exists and is referenced from both brands.

Spec refs: BEH-EA-049, BEH-EA-033 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

### Workstream `session-verify-hardening`

#### RRS-005 — Zero grace window on rotation: any missed delivery permanently kills the legitimate client

`medium` · `security` · `core` · [.issues/medium/RRS-005-refresh-token-rotation-specialist.md](../../.issues/medium/RRS-005-refresh-token-rotation-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence high)

Real trade-off, but explicitly decided twice (upstream-hardening ticket 01, wayfinder ticket 11): immediate invalidation, no dual-valid state. Per the brief, not re-litigated. Missed-delivery mitigations that DID land: per-request memoization (Authentication.resolveSession), RSC rotation delivery (6055f62).

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:191` — Behavior confirmed; it is a recorded design choice.
```ts
   * `actingAs` session, which never touches this path at all). The old
   * secret's hash is overwritten in the same atomic write, so it stops
   * verifying immediately — no grace window. A concurrent second `verify`
```
- `.scratch/upstream-hardening/map.md:130` — Decision on record; re-affirmed by wayfinder ticket 11 (RRS-003 design: 'No grace window').
```ts
... old secret invalidates immediately, no grace window (matches every other write in this codebase — no dual-valid-state precedent to extend).
```
- `packages/core/src/Sessions.ts:439` — The finding's 'reuse detection does not exist' premise is stale — RRS-003 (9017a8a) landed it.
```ts
        if (Option.isSome(row.value.supersededAt)) {
          if (Option.isNone(row.value.reusedAt)) {
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `wontfix`

#### IDS-008 — Chain-depth and self-act-as invariants live only in the Admin plugin, not in Sessions.issue

`low` · `architecture` · `core` · [.issues/low/IDS-008-impersonation-delegation-specialist.md](../../.issues/low/IDS-008-impersonation-delegation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:173` — Generic parameter, no validation in either layer's issue.
```ts
    /** BEH-EA-209/210: sets a hard expiry (`idleExpiresAt = absoluteExpiresAt`) and disables idle-refresh for this session's whole lifetime. */
    readonly actingAs?: ActingAs;
```
- `packages/core/src/Sessions.ts:360` — actingAs only changes expiry; actingAs.id === userId is never checked.
```ts
        const idleExpiresAt =
          input.actingAs === undefined
            ? DateTime.min(DateTime.addDuration(now, config.idle), absoluteExpiresAt)
            : absoluteExpiresAt;
```
- `packages/admin/src/Admin.ts:271` — The only guards live in the Admin plugin.
```ts
        if (caller.ref.id === targetUserId) {
          return yield* Effect.fail(new AdminApi.AdminSelfImpersonationRefused());
        }
        if (caller.actingAs !== undefined) {
          return yield* Effect.fail(new AdminApi.AdminAlreadyImpersonating());
```

**Fix plan:** Enforce the self-act-as invariant inside Sessions.issue (both layers) as a typed defect, and document that the nesting check needs the caller's session and stays with the producer.

Steps:
1. Add `export class InvalidActingAs extends Data.TaggedError("InvalidActingAs")<{ readonly reason: "self" }>` to Sessions.ts.
2. At the top of both `issue` implementations: `if (input.actingAs !== undefined && input.actingAs.type === "user" && input.actingAs.id === input.userId) return yield* Effect.die(new InvalidActingAs({ reason: "self" }))` — a programming error in the producing plugin, so die (keeps issue's public E channel unchanged). Check the actual `ActingAs.type` literal Admin passes (`caller.ref.type`) and compare on type+id.
3. Nested acting-as cannot be checked at issue (issue never sees the caller's session); document on `SessionsShape.issue.actingAs` that producers MUST refuse a caller whose own session carries actingAs (BEH-EA-216), citing Admin.impersonate as the reference implementation.

Files: `packages/core/src/Sessions.ts`, `packages/core/test/Sessions.test.ts`, `spec/behaviors/27-admin-impersonation.md`

Tests:
- packages/core/test/Sessions.test.ts (both suites): 'BEH-EA-209: issue refuses actingAs naming the session's own userId' — expect a defect whose squashed error is InvalidActingAs (Effect.exit + Cause.squash).

Acceptance:
- Sessions.issue({ userId: u, actingAs: { type: 'user', id: u } }) dies with InvalidActingAs in both layers.
- Admin.impersonate behavior unchanged (its typed refusal still fires first).

Spec refs: BEH-EA-209, BEH-EA-214 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### PIL-007 — Expiry is checked before the secret, and the error tag leaks expiry state

`low` · `security` · `core` · [.issues/low/PIL-007-pilcrow.md](../../.issues/low/PIL-007-pilcrow.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) — canonical for SMS-007-session-management-specialist

Holds: verify branches on row state (tombstone, absolute, idle expiry) before proving knowledge of the secret, so an id-only caller gets a different code path/timing for expired vs live vs superseded rows. Overstated: the SessionExpired/SessionNotFound tag distinction does not reach HTTP (Authentication.resolveSession maps both to Unauthenticated; @awthaq/next maps both to undefined). Found during validation and more serious than the audit claim: because the RRS-003 tombstone branch also runs before the secret check, anyone who knows a superseded session's id can trigger family revocation of the victim's live session (forced logout DoS + false reuse alarm). Recommend the orchestrator treat this workstream as high priority.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:786` — Expiry branches run before the secret is hashed (layerSql; layerMemory identical at 460-469).
```ts
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `awthaq: session expired: ${id}`, id }),
        );
      }
```
- `packages/core/src/Sessions.ts:796` — Secret proof only happens after the state branches.
```ts
      const presentedHash = yield* hashSecret(crypto, secret);
      const matches = constantTimeEqual(
        new TextEncoder().encode(presentedHash),
        new TextEncoder().encode(row.secretHash),
      );
```
- `packages/core/src/Sessions.ts:770` — NEW, more severe consequence of the same ordering: reuse detection (family revocation) fires on the id half alone — `<supersededId>.<anything>` revokes the user's live successor session and publishes a false auth.session.reuse. Session ids are 'public' (cookie, JWT `sid`, error messages — see EOTS-004).
```ts
      if (row.supersededAt !== null) {
        if (row.reusedAt === null) {
          const familyId = SessionId(row.familyId);
          yield* repo.markReused(id, now).pipe(Effect.orDie);
          yield* repo.revokeFamily(familyId).pipe(Effect.orDie);
```
- `packages/server/src/Authentication.ts:186` — Partially refutes PIL-007's 'tag leaks' half: at the HTTP boundary both tags collapse to one Unauthenticated.
```ts
        : sessions
            .verify(Redacted.make(raw))
            .pipe(
              Effect.catchTag("PlatformError", Effect.die),
              Effect.mapError(() => new Api.Unauthenticated()),
            ),
```

**Fix plan:** Prove the secret before any row-state branch: hash first, look up, constant-time compare (against a dummy hash on miss), and only then evaluate tombstone/expiry; reuse detection must require a matching secret.

Steps:
1. In both verify implementations (Sessions.ts layerMemory ~411-534, layerSql ~735-853): compute `presentedHash = hashSecret(crypto, secret)` immediately after parsing `id.secret`, BEFORE the row lookup (also addresses SMS-007's lookup-before-hash asymmetry).
2. On a primary-store miss keep the legacy-bridge fallback, but before failing compare `presentedHash` against a module-level fixed dummy digest with constantTimeEqual so the miss path does the same work.
3. On a hit, run `constantTimeEqual(presentedHash, row.secretHash)` FIRST. A mismatch fails the uniform `SessionNotFound` with no side effects — in particular it must NOT markReused/revokeFamily/publish auth.session.reuse.
4. Only after a match: tombstone branch (reuse -> markReused + revokeFamily + event), then absolute/idle expiry (SessionExpired), then actingAs / throttled touch as today. Note a tombstoned row still stores the pre-rotation secretHash, so a genuine replay of the old full token still matches and still trips reuse detection.
5. Extract the ordering into one shared internal helper (e.g. `classifyPresentedRow(row, presentedHash, now)` returning a tagged outcome) used by both layers so they cannot drift.
6. Update the SessionsShape.verify doc comment (RRS-003 paragraph) to state that reuse detection requires the full credential.

Files: `packages/core/src/Sessions.ts`, `packages/core/test/Sessions.test.ts`, `spec/behaviors/07-sessions.md`

Tests:
- packages/core/test/Sessions.test.ts (both suites, write first — fails today): 'RRS-003: presenting a superseded id with a WRONG secret does not revoke the family' — issue, supersede, then verify(`${oldId}.deadbeef`): expect SessionNotFound, the successor session still verifies, and no auth.session.reuse event on AuthEvents.
- Same file: 'BEH-EA-056: an expired row with a wrong secret fails SessionNotFound, not SessionExpired' (id-only callers learn nothing about expiry).
- Same file: 'replaying the full pre-supersede token still triggers reuse detection' (regression guard for RRS-003).
- features/features/02-domain/07-sessions.feature: add a BEH-EA-056 scenario 'a wrong secret against a superseded session revokes nothing'.

Acceptance:
- No code path in verify mutates state or publishes an event unless the presented secret matches the stored hash.
- SessionExpired is only ever returned for a caller that presented the correct secret.
- Unknown-id and known-id-wrong-secret both perform one SHA-256 + one constant-time compare.

Spec refs: BEH-EA-050, BEH-EA-056, BEH-EA-051 · Effort **M** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### SMS-007 — verify short-circuits on unknown id before hashing — a session-id existence oracle by timing

`info` · `security` · `core` · [.issues/info/SMS-007-session-management-specialist.md](../../.issues/info/SMS-007-session-management-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **PIL-007**

Same root cause as PIL-007 (verify decides on row state before doing the secret work); PIL-007's plan hashes before lookup and compares against a dummy digest on miss, closing this timing asymmetry too.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:423` — Lookup (and on miss, the legacy bridge) happens before any hashing — confirmed at HEAD.
```ts
        const row = yield* Ref.get(state).pipe(Effect.map((s) => HashMap.get(s, id)));
        if (Option.isNone(row)) {
          const bridged = yield* bridgeLegacySession(raw);
```
- `packages/core/src/Sessions.ts:470` — Hashing only happens on the known-id path.
```ts
        const presentedHash = yield* hashSecret(crypto, secret);
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

### Workstream `httpapi-surface-consolidation`

#### MW-002 — Served API surface is fragmented across three HttpApi values; core session/account routes are unreachable via Auth.make

`high` · `api` · `core` · [.issues/high/MW-002-matias-woloski.md](../../.issues/high/MW-002-matias-woloski.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

Decision on record (wayfinder ticket 26): seed composeApi with AuthCore.AuthCoreApi's session/account groups, add Auth.make's optional `extraGroups`, add AuthHttp.coreHandlers. Nothing of it has landed (EHA-001's duplicate-group refusal did, 2e0ee35).

**Evidence at HEAD:**

- `packages/core/src/Auth.ts:393` — Only plugin groups; AuthCore's session/account groups never enter the composed api.
```ts
  const contributions = order.flatMap((plugin) =>
    Object.values(plugin.contract.groups).map((group) => ({ plugin, group })),
  );
```
- `packages/api/src/index.ts:12` — Still 'planned'.
```ts
// Planned next: `SessionView` itself (BEH-EA-026), folding `session` into `Auth.make`'s
// full plugin-composed `api` (BEH-EA-032) rather than the standalone `AuthCoreApi` here.
```
- `packages/core/src/Auth.ts:481` — No extraGroups option yet.
```ts
export function make(plugins: ReadonlyArray<AuthPlugin.Any>) {
```

**Fix plan:** Implement ticket 26: composed api always carries core session/account groups, optional extraGroups for qadi's subject group, AuthHttp.coreHandlers convenience, and update every composition site.

Steps:
1. packages/core/src/Auth.ts: import `AuthCore` from @awthaq/api; in composeApi seed `contributions` with `Object.values(AuthCore.AuthCoreApi.groups)` attributed to a pseudo-owner id "core" (so GroupIdConflict messages name core), then extraGroups, then plugin groups. Duplicate-id refusal (BEH-EA-032) now also refuses a plugin that reuses `session`/`account`.
2. Add the second overload parameter `options?: { readonly extraGroups?: ReadonlyArray<HttpApiGroup.Constraint> }` to `make` (both signatures); `Built<P>['api']` becomes `HttpApi<"auth", GroupsOf<P[number]> | CoreGroups | ExtraGroups>` — make the overload generic over `const X extends ReadonlyArray<HttpApiGroup.Constraint> = []` so extra groups are typed (types-first).
3. packages/server/src/AuthHttp.ts: export `coreHandlers = Layer.mergeAll(Session.SessionHandlers, Account.AccountHandlers)`.
4. Update every composition that serves built.api: packages/test/src/TestAuth.ts (provide coreHandlers by default), examples/memory-server/index.ts, and the AuthHttp.test.ts files in admin/jwt/oauth/passkey/organization/password/server/next/qadi tests; qadi's composition roots pass `extraGroups: [SubjectApi.SubjectGroup]`.
5. Update AuthCore.ts / Subject.ts / api index.ts doc comments: these HttpApi values are typed inputs for HttpApiBuilder.group, not separately served documents.
6. Spec: BEH-EA-031/032 text in spec/behaviors/04-contract-stratum.md reflects that Auth.make prepends core groups; traceability.
7. Keep core -> api tsconfig reference (MTS-001 must not trim it).

Files: `packages/core/src/Auth.ts`, `packages/server/src/AuthHttp.ts`, `packages/api/src/AuthCore.ts`, `packages/api/src/index.ts`, `packages/test/src/TestAuth.ts`, `examples/memory-server/index.ts`, `packages/core/test/AuthPlugin.test.ts`, `spec/behaviors/04-contract-stratum.md`

Tests:
- packages/core/test/AuthPlugin.test.ts (write first): 'BEH-EA-031/032: Auth.make(...).api contains the session and account groups' and 'a plugin contributing a group named session is refused with GroupIdConflict naming core'.
- packages/server/test/AuthHttp.test.ts: 'GET /session/current is served from AuthHttp.routes(built.api) with coreHandlers'.
- features/features/01-contract-and-persistence/04-contract-stratum.feature: BEH-EA-032 scenario for a single served document.

Acceptance:
- One HttpApi value (id 'auth') carries session/account (+ subject when passed) and all plugin groups.
- A composition missing core handlers fails loudly at layer build (intended).
- OpenAPI output from AuthHttp.docs(built.api) lists /session/* and /user.

Spec refs: BEH-EA-031, BEH-EA-032, BEH-EA-009 · Effort **L** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

### Workstream `session-supersede-atomicity`

#### ESR-002 — Session supersede path commits delete and insert as two unwrapped statements

`medium` · `correctness` · `core` · [.issues/medium/ESR-002-effect-sql-repository-specialist.md](../../.issues/medium/ESR-002-effect-sql-repository-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) — canonical for PIL-004, ECF-007, SMS-006-session-management-specialist

The audit's 'delete-then-insert' wording is stale: RRS-003 (9017a8a) replaced the delete with a tombstone UPDATE. The root defect is intact — the supersede is still two unwrapped statements in layerSql (and two Ref steps in layerMemory) — and the failure consequence is now worse: a half-applied supersede leaves the client holding a tombstoned token, whose next use fires reuse detection (family revocation + a false `auth.session.reuse` security event) instead of a plain logout. BEH-EA-053's title ('the superseded row is deleted') and Password.ts:153's comment are also stale versus the tombstone design.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:671` — SQL layer: tombstone UPDATE autocommits on its own ...
```ts
      let familyId = id;
      if (input.supersedes !== undefined) {
        const ancestor = yield* repo
          .tombstone({ id: input.supersedes, supersededBy: id, supersededAt: now })
```
- `packages/core/src/Sessions.ts:710` — ... and the replacement INSERT is a second, independent statement; no withTransaction anywhere in layerSql.
```ts
      const row = yield* repo.insert(insert).pipe(Effect.orDie);
```
- `packages/core/src/Sessions.ts:338` — Memory layer: tombstone is one Ref.modify; the new row lands in a separate Ref.update at line 381 (interruptible gap).
```ts
          const ancestor = yield* Ref.modify(
            state,
            (s): readonly [Option.Option<SessionRow>, HashMap.HashMap<SessionId, SessionRow>] => {
              const current = HashMap.get(s, supersedes);
```
- `packages/core/src/Sessions.ts:439` — Consequence at HEAD: if the INSERT fails after the tombstone commits, the client still holds the old token; its next presentation is treated as refresh-token REUSE (family revoke + auth.session.reuse event) — a false theft alarm on top of the logout.
```ts
        if (Option.isSome(row.value.supersededAt)) {
          if (Option.isNone(row.value.reusedAt)) {
            const familyId = row.value.familyId;
```
- `packages/password/src/Password.ts:1143` — The only production supersede caller (changePassword).
```ts
        const issued = yield* sessions
          .issue({ userId: input.userId, supersedes: input.currentSessionId })
          .pipe(Effect.orDie);
```

**Fix plan:** Make issue(supersedes) one atomic unit in both layers: SQL tombstone+insert inside one transaction; memory tombstone+insert inside one Ref.modify.

Steps:
1. layerSql (Sessions.ts ~644-712): add `SqlClient.SqlClient` to the layer's requirements (mirrors Accounts.layerSql) and wrap the tombstone + `SqlModels.Session.insert.makeEffect` + `repo.insert` sequence of `issue` in `sql.withTransaction(...)`, mapping `SqlError` to die exactly as Accounts.unlink does (Effect.catchTag("SqlError", Effect.die)). Keep id/secret/hash generation outside the transaction (pure/crypto work).
2. layerMemory (Sessions.ts 327-383): compute `row` after reading the ancestor inside ONE `Ref.modify` — look up `supersedes`, derive `familyId`, write both the tombstoned ancestor and the new row in the same returned HashMap. Remove the separate `Ref.update(state, (s) => HashMap.set(s, id, row))`.
3. Harden `SessionsRepositoryLive.tombstone` (packages/sql/src/Repositories.ts ~504-517) with `AND "supersededAt" IS NULL` so two concurrent supersedes of the same row cannot both tombstone it and fork the family; the loser gets NoSuchElementError, which issue already maps to 'no ancestor'.
4. Update the SessionsShape.issue doc comment to state the atomicity guarantee for both layers; fix Password.ts:153 ('deletes the row it supersedes' -> 'tombstones').
5. Spec: retitle/re-word BEH-EA-053 in spec/behaviors/07-sessions.md from 'the superseded row is deleted' to 'the superseded row is tombstoned atomically with the new row's insertion' and regenerate traceability (pnpm run spec:verify:strict).

Files: `packages/core/src/Sessions.ts`, `packages/sql/src/Repositories.ts`, `packages/password/src/Password.ts`, `spec/behaviors/07-sessions.md`, `packages/core/test/Sessions.test.ts`

Tests:
- packages/core/test/Sessions.test.ts (layerSql suite): 'BEH-EA-053: a failing insert during issue(supersedes) leaves the superseded session live and untombstoned' — provide a SessionsRepository wrapper whose `insert` fails with SqlError after delegating tombstone; assert the old token still verifies and no auth.session.reuse event was published. Write first; it fails today.
- packages/core/test/Sessions.test.ts (both suites): 'two concurrent issue(supersedes: same id) never leave two tombstone children' (Effect.all concurrency unbounded) — exactly one new session inherits familyId, the other founds a fresh family or fails.
- features/features/02-domain/07-sessions.feature: update the BEH-EA-053 scenario wording (tombstone, not delete) if it asserts deletion.

Acceptance:
- A SqlError on the new-row insert leaves the superseded row with supersededAt NULL and still verifiable.
- layerMemory issue(supersedes) performs exactly one Ref.modify on the session map.
- BEH-EA-053 text no longer says 'deleted'; pnpm run spec:verify:strict passes.
- pnpm run typecheck && pnpm run test pass.

Spec refs: BEH-EA-053, BEH-EA-049 · Effort **M** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### PIL-004 — SQL issue(supersedes) deletes the old session outside any transaction

`medium` · `correctness` · `core` · [.issues/medium/PIL-004-pilcrow.md](../../.issues/medium/PIL-004-pilcrow.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **ESR-002**

Same root cause (SQL supersede outside a transaction), same file/line; the 'memory layer is atomic' remark is also stale — memory is two Ref steps. Wording ('deletes') is stale since 9017a8a; defect persists as tombstone-then-insert.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:671` — SQL layer: tombstone UPDATE autocommits on its own ...
```ts
      let familyId = id;
      if (input.supersedes !== undefined) {
        const ancestor = yield* repo
          .tombstone({ id: input.supersedes, supersededBy: id, supersededAt: now })
```
- `packages/core/src/Sessions.ts:710` — ... and the replacement INSERT is a second, independent statement; no withTransaction anywhere in layerSql.
```ts
      const row = yield* repo.insert(insert).pipe(Effect.orDie);
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### AH-007 — Redundant assertion after sound narrowing in session supersedes path

`low` · `correctness` · `core` · [.issues/low/AH-007-anders-hejlsberg.md](../../.issues/low/AH-007-anders-hejlsberg.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `9017a8a`

Removed when RRS-003 rewrote the supersede path (git log -S 'input.supersedes as SessionId' -> 9017a8a).

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:335` — Narrowed const, no assertion; `grep ' as [A-Z]' packages/core/src` finds none.
```ts
        let familyId = id;
        if (input.supersedes !== undefined) {
          const supersedes = input.supersedes;
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### TTE-004 — Redundant branded cast `input.supersedes as SessionId` violates the zero-assertion rule for no benefit

`low` · `compliance` · `core` · [.issues/low/TTE-004-typescript-type-level-engineer.md](../../.issues/low/TTE-004-typescript-type-level-engineer.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `9017a8a`

The cast is gone. The secondary ask (an oxlint rule mechanically forbidding `as` in src; .oxlintrc.json has none) is tracked by AH-004-anders-hejlsberg (cross-slice).

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:335` — Cast gone.
```ts
        let familyId = id;
        if (input.supersedes !== undefined) {
          const supersedes = input.supersedes;
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### ECF-007 — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard

`low` · `correctness` · `core` · [.issues/low/ECF-007-effect-concurrency-fiber-specialist.md](../../.issues/low/ECF-007-effect-concurrency-fiber-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **ESR-002**

Same root cause; its 'collapse both mutations into one Ref.modify' memory-layer ask is folded into ESR-002's plan. Wording ('deletes') is stale since 9017a8a; defect persists as tombstone-then-insert.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:671` — SQL layer: tombstone UPDATE autocommits on its own ...
```ts
      let familyId = id;
      if (input.supersedes !== undefined) {
        const ancestor = yield* repo
          .tombstone({ id: input.supersedes, supersededBy: id, supersededAt: now })
```
- `packages/core/src/Sessions.ts:710` — ... and the replacement INSERT is a second, independent statement; no withTransaction anywhere in layerSql.
```ts
      const row = yield* repo.insert(insert).pipe(Effect.orDie);
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### SMS-006 — SQL issue's supersede is a non-transactional delete-then-insert

`low` · `correctness` · `core` · [.issues/low/SMS-006-session-management-specialist.md](../../.issues/low/SMS-006-session-management-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **ESR-002**

Same root cause; its 'swapIntoPlace repository op' alternative is subsumed by the transaction wrap in ESR-002's plan. Wording ('deletes') is stale since 9017a8a; defect persists as tombstone-then-insert.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:671` — SQL layer: tombstone UPDATE autocommits on its own ...
```ts
      let familyId = id;
      if (input.supersedes !== undefined) {
        const ancestor = yield* repo
          .tombstone({ id: input.supersedes, supersededBy: id, supersededAt: now })
```
- `packages/core/src/Sessions.ts:710` — ... and the replacement INSERT is a second, independent statement; no withTransaction anywhere in layerSql.
```ts
      const row = yield* repo.insert(insert).pipe(Effect.orDie);
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

### Workstream `verification-hardening`

#### ACS-002 — Verification token digest compared with !== instead of constant-time equality

`low` · `security` · `core` · [.issues/low/ACS-002-applied-cryptography-specialist.md](../../.issues/low/ACS-002-applied-cryptography-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for MLO-004, TSS-005

Negligible exploitability (digests of 256-bit secrets) — a consistency/defense-in-depth fix. Cross-slice: consolidating the 4 copies also serves TSS-003 (OAuth state compare) and ACS-005.

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:202` — Plain !== on the digest (layerMemory).
```ts
              const row = HashMap.get(s, identifier);
              if (
                Option.isNone(row) ||
                isExpired(row.value, now) ||
                row.value.valueHash !== presentedHash
              ) {
```
- `packages/core/src/Sessions.ts:50` — Module-private helper; copies also in passkey/ChallengeStore.ts:230, server/Csrf.ts:38, ports/PasswordHasher.ts:73.
```ts
const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};
```

**Fix plan:** Extract one shared constant-time comparator into @awthaq/ports and use it in Verification.layerMemory; document the SQL WHERE-equality exception.

Steps:
1. New packages/ports/src/ConstantTime.ts exporting `equalBytes(a, b)` and `equalHex(a, b)` (from Sessions.ts's helper); export from ports index.
2. Verification.layerMemory.consume: split the condition — `Option.isNone(row) || isExpired(...) || !ConstantTime.equalHex(row.value.valueHash, presentedHash)`.
3. Sessions.ts: import the shared helper, delete the private copy. (Other packages' copies: follow-up under TSS-003/ACS-005.)
4. Verification.layerSql / VerificationRepository.tryConsume doc comment: note the digest equality happens inside the DB predicate; accepted exception because both sides are SHA-256 of a 256-bit secret (BEH-EA-060).

Files: `packages/ports/src/ConstantTime.ts`, `packages/ports/src/index.ts`, `packages/core/src/Verification.ts`, `packages/core/src/Sessions.ts`, `packages/sql/src/Repositories.ts`

Tests:
- packages/ports/test/ConstantTime.test.ts: equal/unequal/length-mismatch cases.
- Existing Verification suites stay green.

Acceptance:
- No `!==`/`===` comparison of a secret digest remains in packages/core/src.

Spec refs: BEH-EA-056, BEH-EA-060 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### MLO-004 — Token-secret comparison is not constant time, diverging from the codebase's own BEH-EA-056 posture

`low` · `security` · `core` · [.issues/low/MLO-004-magic-link-email-otp-specialist.md](../../.issues/low/MLO-004-magic-link-email-otp-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **ACS-002**

Same line, same root cause, same fix (shared constant-time helper + documented SQL exception).

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:202` — Plain !== on the digest (layerMemory).
```ts
              const row = HashMap.get(s, identifier);
              if (
                Option.isNone(row) ||
                isExpired(row.value, now) ||
                row.value.valueHash !== presentedHash
              ) {
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### TSS-005 — Verification.consume compares valueHash with plain !==, inconsistent with repo constant-time standard

`low` · `security` · `core` · [.issues/low/TSS-005-timing-side-channel-specialist.md](../../.issues/low/TSS-005-timing-side-channel-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **ACS-002**

Same line, same root cause, same fix (shared constant-time helper + documented SQL exception).

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:202` — Plain !== on the digest (layerMemory).
```ts
              const row = HashMap.get(s, identifier);
              if (
                Option.isNone(row) ||
                isExpired(row.value, now) ||
                row.value.valueHash !== presentedHash
              ) {
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### MLO-006 — No concurrent-consume test for BEH-EA-062's 'at most one concurrent caller succeeds' guarantee

`low` · `testing` · `core` · [.issues/low/MLO-006-magic-link-email-otp-specialist.md](../../.issues/low/MLO-006-magic-link-email-otp-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/test/Verification.test.ts:99` — Sequential only; the only concurrent test (line 179) races issue, not consume.
```ts
    it.effect("BEH-EA-058/062: consuming succeeds exactly once, and a replay is refused", () =>
```

**Fix plan:** Add a concurrent-consume race test to the dual-layer Verification suite.

Steps:
1. packages/core/test/Verification.test.ts inside `suite(...)`: issue one token, `Effect.all([consume, consume], { concurrency: 'unbounded', mode: 'either' })`, assert exactly one Right and one Left(TokenConsumed), and exactly one auth.token.replay event.
2. Mirror at repository level in packages/sql/test/Repositories.test.ts (and the postgres variant) for tryConsume.

Files: `packages/core/test/Verification.test.ts`, `packages/sql/test/Repositories.test.ts`, `packages/sql/test/Repositories.postgres.test.ts`

Tests:
- The test itself (should pass on HEAD; it is a regression guard).

Acceptance:
- Both layers prove at-most-one concurrent consume success.

Spec refs: BEH-EA-062 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

### Workstream `plugin-composition-soundness`

#### JH-006 — Static layer type matches the runtime fold only when the tuple is pre-sorted

`medium` · `correctness` · `core` · [.issues/medium/JH-006-jared-hanson.md](../../.issues/medium/JH-006-jared-hanson.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for MA-007

**Evidence at HEAD:**

- `packages/core/src/Auth.ts:218`
```ts
/**
 * The type-level mirror of `composeLayer`'s runtime fold
 * (`rest.reduce((acc, plugin) => Layer.provideMerge(plugin.layer, acc), first.layer)`):
 * walks `P` left to right with an accumulator, each next plugin's `layer`
 * provided everything folded in so far, so a later plugin's requirement on
 * an earlier one nets out of the result instead of staying in `RIn` next to
 * what already provides it. This only matches `composeLayer`'s *runtime*
```
- `packages/core/src/Auth.ts:225` — The divergence is conceded in the comment; Validate<P> (159-167) checks only DuplicateId and MissingDep, not order.
```ts
 * fold — which runs on `linkPlugins`' topologically sorted order, so it is
 * correct regardless of the order plugins were passed in — when `P` itself
 * already lists dependencies before dependents; `Auth.make`'s own examples,
 * and `test/AuthPlugin.test.ts`, do exactly that.
```

**Fix plan:** Make the static fold provably equal to the runtime fold by refusing out-of-order tuples in Validate<P> (dependency must be listed before its dependent).

Steps:
1. Auth.ts: add `OutOfOrderDep<P, Seen = never>` — walk P left-to-right; for each Head, if `IdOf<PluginDeps<Head>>` is not a subset of `Seen` (ids of earlier elements) yield `readonly [depId, headId]`; recurse with `Seen | Head['id']`. Reuse PluginDeps/IdOf.
2. Extend `Validate<P>`: after DuplicateId and MissingDep, if OutOfOrderDep<P> is not never, narrow to `{ readonly awthaq: `plugin "${By}" depends on plugin "${Dep}", which must be listed before it` }`.
3. Keep linkPlugins' topological sort (still needed for migrations/manifest and cycle detection); with the order check the runtime order equals P's order for every accepted tuple, so FoldLayer<P> is exact. Update the FoldLayer doc comment to say the invariant is enforced, not conventional.
4. Update spec/behaviors/02-plugin-composition-validate.md BEH-EA-011 (or add a new BEH id) to require dependency-before-dependent order in the tuple, and fix the stale module header (Auth.ts:7-17: SlotConflict/AuthCore remarks).

Files: `packages/core/src/Auth.ts`, `packages/core/test/AuthPlugin.test.ts`, `spec/behaviors/02-plugin-composition-validate.md`, `features/features/00-foundations/02-plugin-composition-validate.feature`

Tests:
- packages/core/test/AuthPlugin.test.ts (write first): `// @ts-expect-error - plugin "pong" depends on plugin "ping", which must be listed before it` on `Auth.make([Pong, Ping])` (mirrors the existing MissingDep @ts-expect-error at line ~148); fails today because the tuple is accepted.
- Same file: a positive case asserting `Layer.Services<typeof built.layer>` for [Ping, Pong] excludes Ping (expectTypeOf).
- features/.../02-plugin-composition-validate.feature: scenario 'an out-of-order tuple is refused at compile time'.

Acceptance:
- Auth.make([Dependent, Dependency]) is a compile error naming both ids.
- All existing Auth.make call sites (examples, TestAuth, package tests) still compile (they are already ordered).

Spec refs: BEH-EA-009, BEH-EA-011, BEH-EA-013 · Effort **M** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### MA-007 — Built<P>['layer']'s static type assumes caller-side dependency ordering the runtime does not require

`medium` · `api` · `core` · [.issues/medium/MA-007-michael-arnaldi.md](../../.issues/medium/MA-007-michael-arnaldi.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **JH-006**

Identical finding (same source line, same divergence, same two remedies). JH-006's plan adopts MA-007's 'SameOrderCheck in Validate<P>' option.

**Evidence at HEAD:**

- `packages/core/src/Auth.ts:225` — The divergence is conceded in the comment; Validate<P> (159-167) checks only DuplicateId and MissingDep, not order.
```ts
 * fold — which runs on `linkPlugins`' topologically sorted order, so it is
 * correct regardless of the order plugins were passed in — when `P` itself
 * already lists dependencies before dependents; `Auth.make`'s own examples,
 * and `test/AuthPlugin.test.ts`, do exactly that.
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### TTE-006 — Double `any` in GroupsFor erases endpoint checking at the plugin contract boundary

`medium` · `api` · `core` · [.issues/medium/TTE-006-typescript-type-level-engineer.md](../../.issues/medium/TTE-006-typescript-type-level-engineer.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence medium)

The `any` only widens the constraint bound; each plugin's concrete Groups is still inferred and its handlers are type-checked against it (AuthPlugin.layer's handlers parameter), and the recommended contract kit already exists (`TestAuth.runPluginContractTests`, used e.g. by packages/admin/test/AuthHttp.test.ts:338). Aliasing the `any` is cosmetic.

**Evidence at HEAD:**

- `packages/core/src/AuthPlugin.ts:31` — Upstream-forced (HttpApiGroup's Endpoints is invariant); scoped lint-disable with rationale.
```ts
/* oxlint-disable no-explicit-any */
export type GroupsFor<Id extends string> = HttpApiGroup.HttpApiGroup<
  Id | `${Id}.${string}`,
  any,
  any
>;
/* oxlint-enable no-explicit-any */
```
- `packages/core/src/AuthPlugin.ts:214` — Refutes 'endpoints never type-check': Groups is inferred concretely from the contract, and handlers are checked against it here.
```ts
    readonly handlers: Layer.Layer<HttpApiGroup.ToService<"auth", Groups>, HE, HR>;
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `wontfix`

#### MA-005 — Slot-conflict protection is opt-in; two plugins overriding one slot silently last-win without Slots.layer

`medium` · `architecture` · `core` · [.issues/medium/MA-005-michael-arnaldi.md](../../.issues/medium/MA-005-michael-arnaldi.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for TS-004-torin-sandall, ELC-002, JH-005

**Evidence at HEAD:**

- `packages/core/src/Slots.ts:39`
```ts
// Unlike `RateLimits.rule`, providing `SlotsRegistry` is optional, not
// required: `override`'s own requirement is only the implementation
// `Effect`'s own `R` — `Effect.serviceOption` looks the registry up without
// ever placing it in `RIn`, so a plugin using `override` (like
// `@awthaq/roles`'s `Roles`) does not force every caller to also
// provide `Slots.layer`.
```
- `packages/core/src/Slots.ts:191` — No registry -> no check.
```ts
  Layer.effect(slot, implementation).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.flatMap(Effect.serviceOption(SlotsRegistry), (registry) =>
          Option.isSome(registry) ? registry.value.claim(owner, slot) : Effect.void,
```
- `packages/core/src/Auth.ts:445` — Auth.make never provides Slots.layer; grep finds no production/TestAuth/example provider of Slots.layer.
```ts
  return rest.reduce((acc, plugin) => Layer.provideMerge(plugin.layer, acc), first.layer);
```

**Fix plan:** Make slot-conflict checking always-on: Auth.make provides one SlotsRegistry per composition, and Slots.override requires the registry instead of looking it up optionally.

Steps:
1. Slots.ts: change `override` to `Effect.flatMap(SlotsRegistry, (r) => r.claim(owner, slot))` — `SlotsRegistry` joins the returned layer's RIn (`Layer.Layer<never, E | SlotConflict, R | SlotsRegistry>`). Update the module header (lines 39-48) accordingly.
2. Auth.ts composeLayer: `Layer.provideMerge(folded, Slots.layer)` so every plugin layer in the fold shares one registry and the composed layer also exposes it (ROut) for introspection; mirror at type level: `Built<P>['layer']` = `ProvideMerged<FoldLayer<P>, typeof Slots.layer>` (removes SlotsRegistry from RIn).
3. Optionally do the same for RateLimits.layer (RateLimits.rule already REQUIRES RateLimitsRegistry, so forgetting it is a type error today; folding it into Auth.make is DX, not correctness). If done, drop RateLimits.layer from packages/test/src/TestAuth.ts MemoryPorts and examples to avoid two registries.
4. Spec: update BEH-EA-012 / INV-EA-004 wording in spec/behaviors/02-plugin-composition-validate.md and spec/invariants.md: conflict is refused at layer-build time by Auth.make's per-composition registry (compile-time remains structurally impossible, as documented).
5. Fix Auth.ts's stale header (lines 11-13) that says SlotConflict 'does not exist until Slots land'.

Files: `packages/core/src/Slots.ts`, `packages/core/src/Auth.ts`, `packages/core/test/Slots.test.ts`, `packages/core/test/AuthPlugin.test.ts`, `packages/test/src/TestAuth.ts`, `spec/behaviors/02-plugin-composition-validate.md`, `spec/invariants.md`

Tests:
- packages/core/test/AuthPlugin.test.ts (write first): 'INV-EA-004: Auth.make of two plugins overriding the same slot fails layer build with SlotConflict' — two test plugins each built with Slots.override on one slot, no Slots.layer provided by the test; today it builds and last-wins.
- packages/core/test/Slots.test.ts: 'override without a registry is a type error' (@ts-expect-error when providing directly without SlotsRegistry).
- features/features/00-foundations/03-ports-slots-hooks-registries.feature: BEH-EA-012 scenario runs through Auth.make without an explicit Slots.layer.

Acceptance:
- Any Auth.make composition with two overriders of one slot fails at build with SlotConflict naming both owners.
- Roles alone still composes and resolves its slot.
- No application code needs to mention Slots.layer.

Spec refs: BEH-EA-012, BEH-EA-021, INV-EA-004 · Effort **M** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### TS-004 — SlotConflict protection for the one-resolver invariant is opt-in and nothing opts in

`medium` · `architecture` · `core` · [.issues/medium/TS-004-torin-sandall.md](../../.issues/medium/TS-004-torin-sandall.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MA-005**

Same root cause (opt-in SlotsRegistry, nothing opts in); SubjectResolver is the concrete slot at stake. Note: ID collision — another TS-004 exists (.issues/medium/TS-004-tim-smart.md); this entry is TS-004-torin-sandall.

**Evidence at HEAD:**

- `packages/core/src/Slots.ts:39`
```ts
// Unlike `RateLimits.rule`, providing `SlotsRegistry` is optional, not
// required: `override`'s own requirement is only the implementation
// `Effect`'s own `R` — `Effect.serviceOption` looks the registry up without
// ever placing it in `RIn`, so a plugin using `override` (like
// `@awthaq/roles`'s `Roles`) does not force every caller to also
// provide `Slots.layer`.
```
- `packages/core/src/Slots.ts:191` — No registry -> no check.
```ts
  Layer.effect(slot, implementation).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.flatMap(Effect.serviceOption(SlotsRegistry), (registry) =>
          Option.isSome(registry) ? registry.value.claim(owner, slot) : Effect.void,
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### ELC-002 — Slot-conflict guarantee (INV-EA-004) holds only when the application opts in by providing Slots.layer

`medium` · `architecture` · `core` · [.issues/medium/ELC-002-effect-layer-context-architect.md](../../.issues/medium/ELC-002-effect-layer-context-architect.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MA-005**

Same root cause; its 'include Slots.layer in TestAuth.MemoryPorts' ask is superseded by Auth.make providing the registry itself.

**Evidence at HEAD:**

- `packages/core/src/Slots.ts:39`
```ts
// Unlike `RateLimits.rule`, providing `SlotsRegistry` is optional, not
// required: `override`'s own requirement is only the implementation
// `Effect`'s own `R` — `Effect.serviceOption` looks the registry up without
// ever placing it in `RIn`, so a plugin using `override` (like
// `@awthaq/roles`'s `Roles`) does not force every caller to also
// provide `Slots.layer`.
```
- `packages/core/src/Slots.ts:191` — No registry -> no check.
```ts
  Layer.effect(slot, implementation).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.flatMap(Effect.serviceOption(SlotsRegistry), (registry) =>
          Option.isSome(registry) ? registry.value.claim(owner, slot) : Effect.void,
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### JH-005 — Slot-conflict and rate-limit-rule enforcement is opt-in — silent last-build-wins by default

`medium` · `architecture` · `core` · [.issues/medium/JH-005-jared-hanson.md](../../.issues/medium/JH-005-jared-hanson.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MA-005**

Slots half is the same root cause. The RateLimits half is refuted: RateLimits.rule's return type REQUIRES RateLimitsRegistry (RateLimits.ts:152-158: `Layer.Layer<never, RateLimitScopeViolation, RateLimitsRegistry>`), so forgetting RateLimits.layer is a compile error, not a silent last-wins.

**Evidence at HEAD:**

- `packages/core/src/Slots.ts:39`
```ts
// Unlike `RateLimits.rule`, providing `SlotsRegistry` is optional, not
// required: `override`'s own requirement is only the implementation
// `Effect`'s own `R` — `Effect.serviceOption` looks the registry up without
// ever placing it in `RIn`, so a plugin using `override` (like
// `@awthaq/roles`'s `Roles`) does not force every caller to also
// provide `Slots.layer`.
```
- `packages/core/src/RateLimits.ts:152` — Hard requirement — refutes the rate-limit half.
```ts
export const rule = (
  owner: AuthPlugin.Any,
  input: RuleInput,
): Layer.Layer<never, RateLimitScopeViolation, RateLimitsRegistry> =>
  Layer.effectDiscard(
    Effect.flatMap(RateLimitsRegistry, (registry) => registry.register(owner, input)),
  );
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### ELC-006 — AuthPlugin.layer silently overwrites a prior dependsOn registration for the same plugin class

`low` · `correctness` · `core` · [.issues/low/ELC-006-effect-layer-context-architect.md](../../.issues/low/ELC-006-effect-layer-context-architect.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/src/AuthPlugin.ts:254` — Unconditional overwrite keyed by class identity.
```ts
  dependsOnByPlugin.set(plugin, options.dependsOn ?? noDependencies);
```
- `packages/roles/src/Roles.ts:247` — Real multi-registration exists (Roles builds AuthPlugin.layer twice, lines 247/254); latent only because both pass no dependsOn today.
```ts
  ).pipe(Layer.provideMerge(AuthPlugin.layer(Roles, { make: rolesMake })));
```

**Fix plan:** Refuse a second AuthPlugin.layer registration for the same class whose dependsOn ids differ from the first (a definition-time invariant violation).

Steps:
1. AuthPlugin.ts: add `export class ConflictingDependsOn extends Data.TaggedError("ConflictingDependsOn")<{ readonly pluginId: string; readonly first: ReadonlyArray<string>; readonly second: ReadonlyArray<string>; readonly message: string }>`.
2. In `layer(...)` before `dependsOnByPlugin.set`: read the existing entry; if present and its id list (sorted) differs from the new one, `throw new ConflictingDependsOn(...)` (same throw-at-definition posture as Auth.ts's LinkerInvariantViolation); identical lists are a no-op re-registration.

Files: `packages/core/src/AuthPlugin.ts`, `packages/core/test/AuthPlugin.test.ts`

Tests:
- packages/core/test/AuthPlugin.test.ts: 'two AuthPlugin.layer calls for one class with different dependsOn throw ConflictingDependsOn'; 'identical dependsOn re-registration is allowed' (covers Roles' pattern).

Acceptance:
- Divergent dependsOn registrations fail loudly at module load; Roles' two same-deps layers still work.

Spec refs: BEH-EA-008, BEH-EA-016 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

### Workstream `session-list-correctness`

#### VB-001 — verifyLive's session liveness check ignores idle expiry

`medium` · `security` · `core` · [.issues/medium/VB-001-vittorio-bertocci.md](../../.issues/medium/VB-001-vittorio-bertocci.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `6629fd2`

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:586` — Keyed liveness applying both absolute and idle expiry (596-598).
```ts
      const isLive: SessionsShape["isLive"] = (userId, id) =>
```
- `packages/jwt/src/Jwt.ts:446` — verifyLive/introspectLive no longer use list/expiresAt.
```ts
            return yield* sessions.isLive(Users.UserId(sub), Sessions.SessionId(sid));
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### PIL-003 — No expired-session reaper, and list caps at the 200 oldest rows

`medium` · `correctness` · `core` · [.issues/medium/PIL-003-pilcrow.md](../../.issues/medium/PIL-003-pilcrow.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **ESS-005-effect-stream-specialist**

Three claims: (1) list caps at the 200 oldest rows — still true, canonical ESS-005; (2) no expired-session reaper — still true, covered by CSG-003's retention workstream; (3) jwt verifyLive built on list can reject valid JWTs — fixed by 6629fd2 (Sessions.isLive).

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:641`
```ts
/** Generous enough for `Sessions.list`'s realistic device-list sizes; real UI-facing pagination (BEH-EA-036) is a repository-level concern this Shape doesn't itself expose. */
const LIST_PAGE_SIZE = 200;
```
- `packages/sql/src/Repositories.ts:435` — Oldest-first, expired rows included: page 1 fills with dead rows first.
```ts
            ? sql`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  AND "supersededAt" IS NULL
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
```
- `packages/jwt/src/Jwt.ts:446` — The verifyLive half is ALREADY FIXED (6629fd2): jwt now uses a keyed isLive, not list.
```ts
            return yield* sessions.isLive(Users.UserId(sub), Sessions.SessionId(sid));
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### ESS-005 — Sessions.list silently truncates at 200 rows and discards the repository's nextCursor

`medium` · `correctness` · `core` · [.issues/medium/ESS-005-effect-stream-specialist.md](../../.issues/medium/ESS-005-effect-stream-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for PIL-003

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:641`
```ts
/** Generous enough for `Sessions.list`'s realistic device-list sizes; real UI-facing pagination (BEH-EA-036) is a repository-level concern this Shape doesn't itself expose. */
const LIST_PAGE_SIZE = 200;
```
- `packages/core/src/Sessions.ts:872` — page.nextCursor is discarded; memory layer (569-584) returns everything — layers diverge.
```ts
    const list: SessionsShape["list"] = (userId, current) =>
      repo.listByUser(userId, undefined, LIST_PAGE_SIZE).pipe(
        Effect.map((page) =>
          page.items.map((row): SessionListItem => ({
```
- `packages/sql/src/Repositories.ts:435` — Oldest-first, expired rows included: page 1 fills with dead rows first.
```ts
            ? sql`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                  AND "supersededAt" IS NULL
                  ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
```
- `packages/server/src/Session.ts:64` — Worse consequence than reported: past 200 rows GET /session/current DIES (500) because the newest (current) session falls off page 1; `revoke` (line 102) likewise refuses an owned session beyond page 1.
```ts
        const items = yield* sessions.list(userId, sessionId);
        const item = items.find((row) => row.current);
        if (item === undefined) {
          return yield* Effect.die(new Error("awthaq: current session missing from its own list"));
        }
```

**Fix plan:** Make Sessions.list return exactly the user's live (non-tombstoned, non-expired) sessions, newest-activity first, in both layers, and stop server handlers from using list for keyed lookups.

Steps:
1. Repository: add expiry predicates to SessionsRepositoryLive's `page` query (`AND "absoluteExpiresAt" > ${now} AND "idleExpiresAt" > ${now}`; `now` passed in the request, pre-encoded like `markReused`) and switch ordering to `"lastActiveAt" DESC, id DESC` with a matching keyset cursor (BEH-EA-036 stays keyset-only). Add an index migration in packages/sql/src/CoreMigrations.ts on sessions("userId", "lastActiveAt") if the plan needs it.
2. Sessions.layerSql.list: drain pages with a bounded loop (Effect.iterate / Stream.paginate over nextCursor) up to a `SessionConfig.listLimit` (default 1000) instead of one 200-row page; if the bound is hit, log once via Effect.logWarning rather than silently truncating.
3. Sessions.layerMemory.list: apply the same expiry filter and ordering so both layers return identical results.
4. Add a keyed `describe(userId, id): Effect<Option<SessionListItem>>` to SessionsShape (reuses isLive's single findById + ownership + tombstone + expiry checks) and use it in packages/server/src/Session.ts `current` (replace the list+find+die) and `revoke` (ownership check).
5. Optionally expose `listPage(userId, cursor?, limit?)` on SessionsShape for real UI pagination; keep `list` as the drained convenience.

Files: `packages/core/src/Sessions.ts`, `packages/sql/src/Repositories.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/server/src/Session.ts`, `packages/core/test/Sessions.test.ts`, `packages/server/test/AuthHttp.test.ts`

Tests:
- packages/core/test/Sessions.test.ts (both suites, write first): 'BEH-EA-054: list excludes expired sessions and orders newest-activity first' (use ShortLivedLayer + TestClock).
- Same file (layerSql): 'BEH-EA-054: list returns all 250 live sessions, not the oldest 200'.
- packages/server/test/AuthHttp.test.ts: 'GET /session/current succeeds for a user with >200 historical sessions' (fails with a defect today).
- features/features/02-domain/07-sessions.feature: BEH-EA-054 scenario for expired sessions not appearing in the device list.

Acceptance:
- Both layers return the same set/order for the same state.
- No handler dies or answers SessionNotFound for an owned live session because of list truncation.
- BEH-EA-054 text states list = live sessions only.

Spec refs: BEH-EA-054, BEH-EA-036 · Effort **M** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

### Workstream `data-retention-sweep`

#### DRS-003 — Zero production migrations exist for all 11 plugin-owned tables — no surface on which residency partitioning could ship

`high` · `architecture` · `core` · [.issues/high/DRS-003-data-residency-sharding-specialist.md](../../.issues/high/DRS-003-data-residency-sharding-specialist.md) · current status `ready-for-agent`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `58ef46a`

Plugin DDL shipped in 58ef46a (admin/organization/passkey, BAM-002), 2ebd195 (jwt), 1331cd5 (roles), 994412d (BE-001 fixture cleanup). Residual noted in Migrations.ts:40 — Migrations.run has no production call site — is a separate concern (CLI migration tooling, wayfinder ticket 07).

**Evidence at HEAD:**

- `packages/core/src/Migrations.ts:33`
```ts
 * BE-001 (.issues/high): every plugin that owns a table now populates its
 * own `migrations` (`admin`, `jwt`, `organization`, `passkey`, `roles` —
```
- `packages/organization/src/Organization.ts:1236` — Also admin/Admin.ts:254, passkey/Passkey.ts:539, jwt/Jwt.ts:311, roles/Roles.ts:220.
```ts
    migrations: organizationMigrations,
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### CSG-003 — No retention sweep: expired sessions and consumed/expired verification rows persist forever

`high` · `compliance` · `core` · [.issues/high/CSG-003-compliance-soc2-gdpr-specialist.md](../../.issues/high/CSG-003-compliance-soc2-gdpr-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) — canonical for TRBS-006, ESR-006, ERS-007, ECF-008

Follow the recorded decision (wayfinder ticket 30, data-retention-gdpr-erasure): a Retention domain service + RetentionConfig Context.Reference + opt-in scheduled layer. grep for Retention/deleteExpired/sweep across packages/*/src finds nothing at HEAD. The DRS-002 erasure half of ticket 30 has since landed (ec065a7, e940a12) and is out of scope here.

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:300`
```ts
      // BEH-EA-057/ADR-EA-016: one atomic upsert — matches `layerMemory`'s
      // one-live-token overwrite behavior even under two concurrent
      // `issue`s for the same `identifier`, since the DB engine's own
      // conflict resolution (not a separate delete-then-insert racing
      // itself) decides "fresh row" vs. "replace the current live row" in
      // a single statement. Already-consumed history is never touched.
```
- `packages/core/src/Sessions.ts:786` — Expiry is a read-time rejection; the row is never removed.
```ts
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `awthaq: session expired: ${id}`, id }),
```
- `packages/core/src/Verification.ts:151` — Memory reservations/tokens/sessions maps are never pruned either.
```ts
      const reservations = yield* Ref.make(HashMap.empty<string, DateTime.Utc>());
```
- `packages/sql/src/Repositories.ts:530` — Every DELETE on sessions is keyed by id/userId/familyId — none by expiry; RRS-003 tombstoned rows (supersededAt set) are never deleted by anything, adding a new accumulating class.
```ts
      const revokeFamily: SessionsRepositoryShape["revokeFamily"] = (familyId) =>
        sql`DELETE FROM sessions WHERE "familyId" = ${familyId} AND "supersededAt" IS NULL`.pipe(
```

**Fix plan:** Implement ticket 30's Retention service: cutoff-based purge primitives on both Sessions and Verification (both layers), a RetentionConfig reference, Retention.sweep, and an opt-in Retention.layerScheduled.

Steps:
1. packages/sql/src/Repositories.ts: add `deleteExpiredBefore(cutoff: DateTime.Utc): Effect<number, SqlError>` to SessionsRepositoryShape (`DELETE FROM sessions WHERE "absoluteExpiresAt" < ${cutoff}` — covers tombstoned rows too, since they keep their original expiry) and to VerificationRepositoryShape (`DELETE FROM verification_tokens WHERE ("consumedAt" IS NOT NULL AND "consumedAt" < ${cutoff}) OR "expiresAt" < ${cutoff}`), plus `deleteExpiredBefore(now)` on VerificationReservationsRepository. Use SqlSchema with pre-encoded DateTimes (see markReused's comment) and return affected-row counts (RETURNING id counted, or dialect rowCount).
2. packages/core/src/Sessions.ts / Verification.ts: add `purgeExpired(before: DateTime.Utc): Effect<number>` to SessionsShape and VerificationShape (Verification's also prunes the reservations map/table). layerMemory implements it with one Ref.modify filtering HashMap entries (this closes ECF-008's memory growth); layerSql delegates to the new repository ops (orDie per the current layer convention, or the typed infra error if MA-004's decision lands first).
3. New packages/core/src/Retention.ts: `RetentionConfig` Context.Reference defaulting to `{ sessionGrace: Duration.days(7), verificationForensicWindow: Duration.days(90), sweepInterval: Duration.days(1) }` with a `.config(partial)` helper (ADR-EA-011 pattern, mirror PasswordConfig); `sweep` Effect computing both cutoffs from DateTime.now and returning `{ sessionsDeleted, verificationRowsDeleted }`; `layerScheduled` = `Layer.effectDiscard(Effect.forkScoped(Effect.repeat(sweep, Schedule.spaced(interval))))`, NOT included by Auth.make or TestAuth (opt-in per ticket 30).
4. Export Retention from packages/core/src/index.ts; knip must see a consumer (examples/memory-server can opt in).
5. Spec: new ADR spec/decisions/017-retention-and-erasure.md (+ index.yaml) recording the Retention shape; amend spec/behaviors/08-verification-tokens.md 'already-consumed history is never touched' to 'never touched by ordinary reads/issues; purged only by Retention.sweep after the forensic window'; add BEH-EA ids for purge semantics and wire traceability.
6. Document the default windows as operator-confirmable compliance policy (ticket 30 flags the numbers as a business call).

Files: `packages/sql/src/Repositories.ts`, `packages/core/src/Sessions.ts`, `packages/core/src/Verification.ts`, `packages/core/src/Retention.ts`, `packages/core/src/index.ts`, `spec/decisions/017-retention-and-erasure.md`, `spec/decisions/index.yaml`, `spec/behaviors/07-sessions.md`, `spec/behaviors/08-verification-tokens.md`, `spec/traceability.md`

Tests:
- packages/core/test/Retention.test.ts (new, runs against memory and SQL layers, write first): 'Retention.sweep deletes sessions past absoluteExpiresAt + sessionGrace and keeps live ones' (TestClock).
- Same file: 'Retention.sweep deletes consumed/expired verification rows older than the forensic window, keeps live and recent ones'.
- Same file: 'Retention.layerScheduled runs sweep on the configured interval' (TestClock.adjust).
- packages/sql/test/Repositories.test.ts: deleteExpiredBefore returns the affected count on sqlite (and the postgres suite).
- features/features/02-domain/08-verification-tokens.feature: amend the 'row has not been physically deleted' scenario to remain true before the forensic window.

Acceptance:
- After sweep, no session row older than absoluteExpiresAt + grace and no verification row consumed/expired before the window remains, in both layers.
- The scheduled layer is off unless explicitly provided.
- Memory layers' maps shrink after sweep.
- pnpm check passes (knip sees Retention used).

Spec refs: BEH-EA-051, BEH-EA-061, BEH-EA-063, BEH-EA-058 · Effort **L** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### TRBS-006 — Expired sessions are never evicted in either layer; the store grows unbounded

`medium` · `performance` · `core` · [.issues/medium/TRBS-006-token-revocation-blacklist-specialist.md](../../.issues/medium/TRBS-006-token-revocation-blacklist-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSG-003**

Same root cause (no expiry-based eviction of session rows in either layer). Its 'lazy delete on the expired verify branch' variant is NOT adopted: ticket 30 keeps a forensic grace window past expiry, which an eager delete would defeat.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:786` — Expiry is a read-time rejection; the row is never removed.
```ts
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `awthaq: session expired: ${id}`, id }),
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### ESR-006 — No retention mechanism for expired sessions and consumed/expired verification tokens

`medium` · `architecture` · `core` · [.issues/medium/ESR-006-effect-sql-repository-specialist.md](../../.issues/medium/ESR-006-effect-sql-repository-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSG-003**

Same root cause and same recommended fix (deleteExpiredSessions/deleteConsumedTokensBefore) — exactly CSG-003/ticket 30's repository primitives.

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:300`
```ts
      // BEH-EA-057/ADR-EA-016: one atomic upsert — matches `layerMemory`'s
      // one-live-token overwrite behavior even under two concurrent
      // `issue`s for the same `identifier`, since the DB engine's own
      // conflict resolution (not a separate delete-then-insert racing
      // itself) decides "fresh row" vs. "replace the current live row" in
      // a single statement. Already-consumed history is never touched.
```
- `packages/core/src/Sessions.ts:786` — Expiry is a read-time rejection; the row is never removed.
```ts
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `awthaq: session expired: ${id}`, id }),
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### ECF-008 — Memory layers never reap expired state: reservations, sessions, and tokens grow unboundedly

`medium` · `performance` · `core` · [.issues/medium/ECF-008-effect-concurrency-fiber-specialist.md](../../.issues/medium/ECF-008-effect-concurrency-fiber-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSG-003**

Same root cause for the memory layers (sessions, verification tokens, reservations never reaped). CSG-003's plan adds purgeExpired to both memory layers, including the reservations map.

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:151` — Memory reservations/tokens/sessions maps are never pruned either.
```ts
      const reservations = yield* Ref.make(HashMap.empty<string, DateTime.Utc>());
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### ERS-007 — No background maintenance workload exists; session expiry is lazy-only

`info` · `architecture` · `core` · [.issues/info/ERS-007-effect-runtime-scheduler-specialist.md](../../.issues/info/ERS-007-effect-runtime-scheduler-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSG-003**

Info-level restatement: lazy-only expiry with no background maintenance fiber. Ticket 30's opt-in Retention.layerScheduled is the 'optional scoped reaper Layer' this finding recommends.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:786` — Expiry is a read-time rejection; the row is never removed.
```ts
      if (DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(row.absoluteExpiresAt)) {
        return yield* Effect.fail(
          new SessionExpired({ message: `awthaq: session expired: ${id}`, id }),
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

### Workstream `users-identity-model`

#### FAMS-002 — UserRecord requires an email; Firebase anonymous and phone users cannot be represented

`high` · `architecture` · `core` · [.issues/high/FAMS-002-firebase-auth-migration-specialist.md](../../.issues/high/FAMS-002-firebase-auth-migration-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

Decision on record: wayfinder ticket 09 (UserIdentity tagged union Email/Phone/Anonymous, status active|suspended, Users.promoteIdentity, Users.setStatus, migrations 10-12). Nothing has landed yet (metadata from AOMS-002 is unrelated).

**Evidence at HEAD:**

- `packages/core/src/Users.ts:51` — Still required at HEAD.
```ts
export interface UserRecord {
  readonly id: UserId;
  /** BEH-EA-041: always the lower-cased form of whatever email was given. */
  readonly email: string;
  readonly emailVerified: boolean;
```
- `packages/oauth/src/OAuth.ts:799` — Synthetic-email workaround still present.
```ts
                      .create({ email: profile.email ?? `${providerId}:${profile.subject}`, name })
```

**Fix plan:** Implement ticket 09: UserRecord.identity: UserIdentity union + status, widened create, promoteIdentity, setStatus, dialect-branched migrations, and retire OAuth's synthetic email.

Steps:
1. packages/core/src/Users.ts: `UserIdentity` = Email{email,emailVerified} | Phone{phone,phoneVerified} | Anonymous; UserRecord {id, identity, name, status, metadata, createdAt, updatedAt}; `create({ identity, name, metadata? })` with EmailAlreadyExists | PhoneAlreadyExists; `promoteIdentity(id, identity)` (Anonymous -> Email/Phone, uniqueness-checked); `setStatus(id, status)` (dedicated write path, excluded from updateProfile); `findByPhone`. Keep verifyEmail; add verifyPhone.
2. packages/sql/src/Models.ts User: email NullOr, phone NullOr, phoneVerified (BooleanFromBit, excluded from update like emailVerified), status literal; toUserRecord folds columns into the union (no `as`: construct each variant explicitly; an impossible combo dies with a typed defect).
3. packages/sql/src/CoreMigrations.ts: migrations 10 (add phone/phoneVerified/status), 11 (email nullable; SQLite table-rebuild), 12 (partial unique index on phone). Verify lower(email) unique index semantics with NULLs on both dialects.
4. Call sites: password signUp/signIn (Email identity), oauth JIT (no email -> Anonymous or Phone; delete the `${providerId}:${profile.subject}` fallback), migrate-auth0 importUser, admin/organization readers of `.email` (grep `\.email\b` across packages/*/src), api AccountDto (identity-aware DTO), qadi subject attributes.
5. Sign-in paths refuse a `suspended` user before Sessions.issue (ticket 09); SCIM/admin callers pair setStatus('suspended') with Sessions.revokeAll.
6. Spec: revise BEH-EA-041/042 (versioned change BEH-EA-041 explicitly licenses), add phone and status BEH ids; traceability.

Files: `packages/core/src/Users.ts`, `packages/sql/src/Models.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/sql/src/Repositories.ts`, `packages/oauth/src/OAuth.ts`, `packages/password/src/Password.ts`, `packages/migrate-auth0/src/ImportAuth0User.ts`, `packages/api/src/Account.ts`, `spec/behaviors/06-domain-users-accounts.md`

Tests:
- packages/core/test/Users.test.ts (both suites, write first): 'create Anonymous user without email', 'promoteIdentity Anonymous -> Email enforces uniqueness', 'setStatus suspended is not writable via updateProfile'.
- packages/oauth/test: 'provider profile without email creates an Anonymous-identity user, never a synthetic email'.
- features/features/02-domain/06-users-accounts.feature: BEH-EA-041 revised scenarios.

Acceptance:
- No production code fabricates an email; anonymous and phone users persist in both layers; migrations run on sqlite + postgres test suites.

Spec refs: BEH-EA-041, BEH-EA-042, BEH-EA-046 · Effort **XL** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### SCP-005 — External-id mapping substrate exists in Accounts but the SCIM id/externalId mapping decision is undocumented

`medium` · `architecture` · `core` · [.issues/medium/SCP-005-scim-provisioning-specialist.md](../../.issues/medium/SCP-005-scim-provisioning-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence medium)

Holds: spec/models/12-scim.md still records no id/externalId mapping or DELETE semantics. Superseded: the design decision was made in wayfinder ticket 08 (scim-owned scim_external_id table; deactivation via ticket 09's status, delete != deactivate), so only the spec write-down remains.

**Evidence at HEAD:**

- `packages/core/src/Accounts.ts:33` — Substrate as described.
```ts
export interface AccountRecord {
  readonly id: AccountId;
  readonly userId: UserId;
  readonly providerId: string;
  readonly subject: string;
```
- `.scratch/resolve-ready-for-human-findings/issues/08-saml-scim-roadmap-scope.md:100` — The mapping decision now exists (ticket 08) — and it is NOT 'reuse Accounts'.
```ts
   - An external-id/tombstone mapping on `Users` (or a
     `scim_external_id` join table keyed by `(scimConnectionId,
     externalId)` — the shape SCIM's `createUser`/`patchUser` need to
     correlate a directory record with an awthaq `UserId` across repeat
     syncs) — new, scoped to the `scim` package itself so it doesn't leak
     SCIM-specific concerns into `packages/core`.
```

**Fix plan:** Record ticket 08/09's SCIM identity decisions in spec/models/12-scim.md (docs only).

Steps:
1. spec/models/12-scim.md: SCIM resource id = awthaq UserId; externalId persisted in a scim-owned `scim_external_id(scimConnectionId, externalId, userId)` table, not as an Accounts link; `active:false` -> Users.setStatus('suspended') + Sessions.revokeAll; SCIM DELETE -> unlink mapping + (configurable) Users.eraseAccount vs suspend, postconditions observably different from deactivate.
2. Link ticket 08 and ticket 09 from the model doc.

Files: `spec/models/12-scim.md`

Tests:
- pnpm run spec:verify:strict.

Acceptance:
- 12-scim.md states the mapping and deactivate/delete semantics.

Spec refs: — · Effort **S** · Depends on: FAMS-002 · Needs decision: no

**Recommended status:** `ready-for-agent`

#### SOS-008 — No phone identity groundwork: no phone field, no E.164 normalization, identifier taxonomy is email/password only

`low` · `dx` · `core` · [.issues/low/SOS-008-sms-otp-specialist.md](../../.issues/low/SOS-008-sms-otp-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Ticket 09 adds a Phone identity but does not specify normalization; this plan supplies that missing piece.

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:72` — Identifier taxonomy has no phone scheme.
```ts
  /** BEH-EA-057: e.g. `verify-email:<userId>`, `reset-password:<userId>`. */
  readonly identifier: string;
```
- `packages/core/src/Users.ts:53` — No phone field; no normalization helper anywhere (grep E.164: none).
```ts
  /** BEH-EA-041: always the lower-cased form of whatever email was given. */
  readonly email: string;
```

**Fix plan:** Ship E.164 normalization as part of ticket 09's Phone identity, enforced at the Users boundary, plus the verify-phone identifier scheme.

Steps:
1. Add a branded `E164` schema (packages/core/src/Phone.ts or @awthaq/ports): `Schema.String.pipe(Schema.check(/^\+[1-9]\d{1,14}$/), Schema.brand('E164'))` plus `normalizePhone(raw, defaultRegion?)` (strip separators; require a leading + or a configured default country code). Evaluate a vetted lib (libphonenumber-js) vs a minimal normalizer — recommend the lib behind the helper.
2. Users.create/promoteIdentity/findByPhone accept only `E164` (type-level: the Phone identity's `phone` is the branded type) — raw strings cannot reach storage.
3. Document the identifier scheme `verify-phone:<userId>` (keyed on user id, normalized number in payload) in BEH-EA-057 and 08-verification-tokens.md.
4. Invariant (better-auth parity): phoneVerified can never be true while phone is null — guaranteed by the union shape.

Files: `packages/core/src/Phone.ts`, `packages/core/src/Users.ts`, `spec/behaviors/08-verification-tokens.md`, `spec/behaviors/06-domain-users-accounts.md`

Tests:
- packages/core/test/Phone.test.ts: '+1 555 0100', '15550100' (default region US) and '+15550100' normalize identically; invalid inputs fail decode.

Acceptance:
- Three spellings of one number resolve to one stored value; the type system prevents unnormalized phones reaching Users.

Spec refs: BEH-EA-041, BEH-EA-057 · Effort **M** · Depends on: FAMS-002 · Needs decision: no

**Recommended status:** `ready-for-agent`

### Workstream `accounts-targeted-writes`

#### RRS-006 — AccountsRepository.update read-modify-write of all three secret columns is a lost-update hazard

`medium` · `api` · `core` · [.issues/medium/RRS-006-refresh-token-rotation-specialist.md](../../.issues/medium/RRS-006-refresh-token-rotation-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence medium)

Holds: the generic update rewrites all secret columns from a prior read with no CAS; the transaction wrap (default READ COMMITTED on Postgres) does not prevent a lost update. Overstated: the cited cross-column clobber (rehash-on-login vs token refresh) needs one row carrying both a passwordHash and provider tokens, which link() never produces (password rows vs federated rows). The live residual is two concurrent writers of the same federated row (callback re-auth updateProviderTokens vs OAuthTokenAccess.refresh), where a stale token set can be reinstated.

**Evidence at HEAD:**

- `packages/core/src/Accounts.ts:600` — Still read-pass-through-write of every secret column, now inside sql.withTransaction (PPS-001, e234d46) and without the repository's second re-read.
```ts
    const updateCredentialHash: AccountsShape["updateCredentialHash"] = Effect.fnUntraced(
      function* (id, hash) {
        const performUpdate = Effect.gen(function* () {
          const existing = yield* repo.findById(id).pipe(
```
- `packages/core/src/Accounts.ts:656` — updateProviderTokens mirrors it; the write-back of the untouched column is what allows a lost update.
```ts
          const update = yield* SqlModels.Account.update
            .makeEffect({
              id,
              passwordHash: existing.passwordHash,
              ...tokenSetToRow(tokens),
            })
```
- `packages/oauth/src/OAuthTokenAccess.ts:128` — A real token-refresh writer now exists (BE-002, e773cf1) — no longer latent.
```ts
    yield* accounts.updateProviderTokens(accountId, nextTokens).pipe(Effect.orDie);
```

**Fix plan:** Replace read-pass-through writes with column-targeted UPDATE statements (no read needed) so writers of one secret never rewrite another.

Steps:
1. packages/sql/src/Repositories.ts AccountsRepositoryShape: add `setPasswordHash(id, hash, aad)` and `setProviderTokens(id, tokens, aad)` as `UPDATE accounts SET <only those columns>, "updatedAt"=? WHERE id=? RETURNING id` (findOneOption) — keep the AAD/encryption handling the current `update` does for those columns.
2. Accounts.layerSql updateCredentialHash/updateProviderTokens: call the targeted ops; `None` -> AccountNotFound; drop the transaction + read (AAD needs providerId/userId: fetch them in the same statement via RETURNING, or read once without writing back secrets).
3. Optional hardening for concurrent refreshes of one row: `setProviderTokens` takes `expectedUpdatedAt` (CAS); OAuthTokenAccess.refresh retries/uses the winner's token on CAS loss (single-flight).

Files: `packages/core/src/Accounts.ts`, `packages/sql/src/Repositories.ts`, `packages/oauth/src/OAuthTokenAccess.ts`, `packages/core/test/Accounts.test.ts`

Tests:
- packages/core/test/Accounts.test.ts (SQL suite): 'updateProviderTokens never rewrites passwordHash' (set both on one row via link, update tokens concurrently with updateCredentialHash, both survive).

Acceptance:
- No Accounts write path reads and re-writes a secret column it is not changing.

Spec refs: BEH-EA-044, BEH-EA-116, BEH-EA-034 · Effort **M** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

### Workstream `core-error-taxonomy`

#### EOTS-004 — Session ids — the public half of a bearer credential — are interpolated into error messages that reach logs

`medium` · `security` · `core` · [.issues/medium/EOTS-004-effect-observability-tracing-specialist.md](../../.issues/medium/EOTS-004-effect-observability-tracing-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Heightened by PIL-007's finding: a superseded session id alone is currently enough to trigger family revocation, so session ids in logs are more sensitive than the audit assumed.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:428` — Also 457, 477, 525, 547, 615, 759, 783, 803, 842, 859, 915; SessionExpired at 462/467/788/793.
```ts
            new SessionNotFound({ message: `awthaq: no such session: ${id}` }),
```
- `packages/core/src/Users.ts:133` — Same pattern for users/accounts/verification identifiers (`token replay or unknown token: ${identifier}` embeds `reset-password:<userId>`).
```ts
                Effect.fail(new UserNotFound({ message: `awthaq: no such user: ${id}`, id })),
```

**Fix plan:** Stop interpolating identifiers into core error messages; carry them only as typed fields, and state the logging policy.

Steps:
1. Sessions.ts: messages become constant strings (`awthaq: no such session`, `awthaq: session expired`, `awthaq: session idle-expired`); SessionNotFound gains optional typed `id?: SessionId` for in-process correlation; SessionExpired keeps `id`.
2. Same treatment for Users (UserNotFound/EmailAlreadyExists — email is PII), Accounts (AccountNotFound/AccountAlreadyLinked), Verification (TokenConsumed: identifier embeds userId).
3. Document in an ADR-EA-013 addendum (redaction policy) which typed fields may be logged; coordinate with EOTS-005 (log-site redaction, cross-slice).

Files: `packages/core/src/Sessions.ts`, `packages/core/src/Users.ts`, `packages/core/src/Accounts.ts`, `packages/core/src/Verification.ts`, `spec/decisions/013-error-taxonomy-http-mapping.md`

Tests:
- packages/core/test/Sessions.test.ts: 'SessionNotFound.message never contains the session id' (both suites, write first).
- Same for Users/Verification tests.

Acceptance:
- grep for '${id}' / '${identifier}' / '${email}' inside `message:` template literals in packages/core/src returns nothing.

Spec refs: BEH-EA-049, BEH-EA-088 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### MA-004 — Environmental failures (SqlError, SchemaError, PlatformError) are systematically routed to the defect channel

`medium` · `architecture` · `core` · [.issues/medium/MA-004-michael-arnaldi.md](../../.issues/medium/MA-004-michael-arnaldi.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for EEM-006

No ADR covers infra-failure channel policy (ADR-EA-013 is wire-error mapping only). d16134b (NHS-002/EEM-003) made `PlatformError` die in Authentication middleware, a de facto policy with no spec backing.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:747` — SqlError on the verify hot path is a defect.
```ts
      const found = yield* repo.findById(id).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          NoSuchElementError: () => Effect.succeed(Option.none()),
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
```
- `packages/core/src/Sessions.ts:224` — Declared E advertises PlatformError (layerMemory's crypto failure) but not layerSql's real failure mode.
```ts
  readonly verify: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<
    { readonly session: SessionView; readonly rotated: Option.Option<Redacted.Redacted<string>> },
    SessionNotFound | SessionExpired | PlatformError.PlatformError
  >;
```
- `packages/core/src/Users.ts:266` — The conflated rationale the finding quotes.
```ts
 * BEH-EA-041's uniqueness is a real database constraint here (a `UNIQUE`
 * index on `lower(email)`, declared by whichever schema/migration creates
 * the `users` table) rather than `layerMemory`'s in-process `HashMap`
 * check — a duplicate `create` surfaces as `SqlError`'s `UniqueViolation`
 * reason, mapped to `EmailAlreadyExists`; every other repository failure
 * (a schema mismatch, a dropped connection) is a genuine defect, not a
```

**Fix plan:** Adopt one infrastructure-error policy across core Shapes (recommended: typed StoreUnavailable), recorded as an ADR, and make every Shape's E channel authoritative for both layers.

Steps:
1. Write the ADR (decision above) + BEH ids for 'core service error channels carry domain errors plus StoreUnavailable only'.
2. Add `StoreUnavailable` to packages/core/src (e.g. new internal module `Errors.ts`, exported) with `{ operation: string; cause: unknown }` (cause excluded from message; see EOTS-004).
3. Per service (Sessions, Users, Accounts, Verification, AuditLog): replace `PlatformError.PlatformError` in Shape E with StoreUnavailable; in layerMemory map crypto PlatformError -> StoreUnavailable; in layerSql replace `SqlError: Effect.die` / `Effect.orDie` on IO with a mapError to StoreUnavailable (keep die for SchemaError decode mismatches that indicate a code/schema bug, and for NoSuchElement invariants).
4. Update callers: remove the `catchTag("PlatformError", Effect.die)` sites in password/oauth/passkey/migrate-auth0 (9 sites) and the Authentication middleware's die; map StoreUnavailable to a new wire error (503) in packages/api Api.ts per ADR-EA-013's per-domain pattern.
5. Add a Schedule-based retry helper for SQLITE_BUSY/serialization failures usable by layerSql hot writes (serves SEA-002).

Files: `packages/core/src/Errors.ts`, `packages/core/src/Sessions.ts`, `packages/core/src/Users.ts`, `packages/core/src/Accounts.ts`, `packages/core/src/Verification.ts`, `packages/core/src/AuditLog.ts`, `packages/server/src/Authentication.ts`, `packages/api/src/Api.ts`, `packages/password/src/Password.ts`, `packages/oauth/src/OAuth.ts`, `packages/passkey/src/Passkey.ts`, `spec/decisions/`

Tests:
- packages/core/test/Sessions.test.ts (layerSql, write first): 'a SqlError from the repository surfaces as StoreUnavailable, not a defect' (stub SessionsRepository failing with SqlError).
- packages/server/test/Authentication.test.ts: 'StoreUnavailable from verify answers 503, not 401/500'.
- features/features/03-http-layer/11-http-error-mapping.feature: scenario for store outage -> 503.

Acceptance:
- No core *Shape mentions PlatformError; every layerSql IO failure is a typed StoreUnavailable; invariant violations still die.
- Grep finds zero `catchTag("PlatformError", Effect.die)` in plugin src.

Spec refs: BEH-EA-035 · Effort **XL** · Depends on: — · Needs decision: yes

**Recommended status:** `ready-for-human`

#### GC-004 — Memory and SQL implementations of Users diverge on race failure modes

`medium` · `correctness` · `core` · [.issues/medium/GC-004-giulio-canti.md](../../.issues/medium/GC-004-giulio-canti.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/src/Users.ts:320` — Read-then-update; a concurrent delete between them dies.
```ts
    const updateProfile: UsersShape["updateProfile"] = Effect.fnUntraced(function* (id, input) {
      const existing = yield* findById(id);
      const nextMetadata =
        input.metadata === undefined ? Option.getOrNull(existing.metadata) : input.metadata;
      const update = yield* SqlModels.User.update
        .makeEffect({ id, email: existing.email, name: input.name, metadata: nextMetadata })
        .pipe(Effect.orDie);
      const row = yield* repo.update(update).pipe(Effect.orDie);
```
- `../effect/packages/effect/src/unstable/sql/SqlModel.ts:155` — effect's SqlModel.update already converts the missing row into a defect.
```ts
        Effect.catchTag("NoSuchElementError", Effect.die),
```

**Fix plan:** Give UsersRepository a targeted, Option-returning profile update and map a missing row to UserNotFound so layerSql honors the Shape's declared E like layerMemory.

Steps:
1. packages/sql/src/Repositories.ts: add `updateProfile({ id, name, metadata, updatedAt })` to UsersRepositoryShape as `SqlSchema.findOneOption` over `UPDATE users SET name=?, metadata=?, "updatedAt"=? WHERE id=? RETURNING *` (metadata `undefined` handled by the caller passing the current value or a COALESCE form).
2. Users.layerSql.updateProfile: call it directly; `Option.none()` -> `UserNotFound`. Drops the read-modify-write of `email` (also removes the lost-update window on name/metadata vs other writers).
3. Users.layerSql.delete_: keep findById for the hook payload, but make the final `repo.delete` a `DELETE ... RETURNING id` (findOneOption) and map none -> UserNotFound so a concurrent delete is reported consistently with layerMemory's behavior (decide: memory currently succeeds silently after its read; align both to UserNotFound).

Files: `packages/core/src/Users.ts`, `packages/sql/src/Repositories.ts`, `packages/core/test/Users.test.ts`

Tests:
- packages/core/test/Users.test.ts (both suites, write first): 'updateProfile on a user deleted concurrently fails UserNotFound, never a defect' — race via a BeforeUserDelete-free delete between findById and update using a repository stub for SQL.

Acceptance:
- updateProfile/delete in layerSql never die on a missing row; both layers return UserNotFound.

Spec refs: BEH-EA-041 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### ESS-008 — Three _tag strings duplicated across the Data and Schema error taxonomies

`medium` · `correctness` · `core` · [.issues/medium/ESS-008-effect-schema-specialist.md](../../.issues/medium/ESS-008-effect-schema-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for EEM-008

Note ID collision: another ESS-008 exists (.issues/medium/ESS-008-effect-stream-specialist.md); this is ESS-008-effect-schema-specialist.

**Evidence at HEAD:**

- `packages/core/src/Users.ts:70` — core (Data)
```ts
export class EmailAlreadyExists extends Data.TaggedError("EmailAlreadyExists")<{
```
- `packages/password/src/PasswordApi.ts:36` — wire (Schema) — same tag string
```ts
export class EmailAlreadyExists extends Schema.TaggedError<EmailAlreadyExists>()(
```
- `packages/core/src/Verification.ts:65` — core; PasswordApi.ts:50 declares the same tag
```ts
export class TokenConsumed extends Data.TaggedError("TokenConsumed")<{
```
- `packages/core/src/Sessions.ts:142` — core; packages/api/src/Session.ts:34 declares "SessionNotFound" too. RateLimited (ports vs api) and PasskeyCredentialNotFound (PasskeyCredentials vs PasskeyApi) also collide.
```ts
export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly message: string;
}> {}
```
- `packages/password/src/Password.ts:987` — Bridging by string convention.
```ts
                Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
```

**Fix plan:** Make internal (Data) and wire (Schema) error tags disjoint by construction and guard it with a test.

Steps:
1. Rename the internal tags only (wire tags are the HTTP contract), using one convention: internal tags prefixed by their service, e.g. Data.TaggedError("Sessions/NotFound"), ("Users/EmailAlreadyExists"), ("Verification/TokenConsumed"), ports RateLimiter ("RateLimiter/RateLimited"), PasskeyCredentials ("PasskeyCredentials/NotFound"). Class names can stay; update every catchTag/catchTags key (Password.ts 748/987/1070, OAuth.ts 638/802, Passkey.ts 979, server Session.ts/Account.ts, next GetSession.ts, tests).
2. Add packages/core/test/ErrorTags.test.ts (or a repo-level script under scripts/ wired into pnpm check) that imports every package's public error classes and asserts no Data-tag equals a Schema-tag.
3. Record the convention in ADR-EA-013 (spec/decisions/013-error-taxonomy-http-mapping.md) as an addendum.

Files: `packages/core/src/Sessions.ts`, `packages/core/src/Users.ts`, `packages/core/src/Verification.ts`, `packages/ports/src/RateLimiter.ts`, `packages/passkey/src/PasskeyCredentials.ts`, `packages/password/src/Password.ts`, `packages/oauth/src/OAuth.ts`, `packages/passkey/src/Passkey.ts`, `packages/next/src/GetSession.ts`, `spec/decisions/013-error-taxonomy-http-mapping.md`

Tests:
- ErrorTags test (write first; fails today on the 5 collisions).

Acceptance:
- No tag string is shared between a Data.TaggedError and a Schema.TaggedError across packages/*/src; the guard runs in pnpm check.

Spec refs: BEH-EA-088 · Effort **M** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### EEM-006 — PlatformError sits in core typed channels, taxing every plugin call site with a die mapping

`medium` · `architecture` · `core` · [.issues/medium/EEM-006-effect-error-management-specialist.md](../../.issues/medium/EEM-006-effect-error-management-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MA-004**

Same root question (what core Shapes do with infrastructure failures) from the opposite direction. MA-004's recommended option B removes PlatformError from every public channel, which is EEM-006's ask.

**Evidence at HEAD:**

- `packages/core/src/Users.ts:88` — PlatformError still exported in the public channel.
```ts
  readonly create: (input: {
    readonly email: string;
    readonly name: string;
    readonly metadata?: string;
  }) => Effect.Effect<UserRecord, EmailAlreadyExists | PlatformError.PlatformError>;
```
- `packages/migrate-auth0/src/ImportAuth0User.ts:50` — One of 9 repeated die mappings at call sites.
```ts
      .pipe(Effect.catchTag("PlatformError", Effect.die));
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### EEM-008 — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim

`low` · `dx` · `core` · [.issues/low/EEM-008-effect-error-management-specialist.md](../../.issues/low/EEM-008-effect-error-management-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **ESS-008-effect-schema-specialist**

Tag-collision half = ESS-008 (canonical, higher level). Its 'stringly message fields' half is handled by EOTS-004's plan (ids moved from message strings into typed fields).

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:142` — core; packages/api/src/Session.ts:34 declares "SessionNotFound" too. RateLimited (ports vs api) and PasskeyCredentialNotFound (PasskeyCredentials vs PasskeyApi) also collide.
```ts
export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly message: string;
}> {}
```
- `packages/password/src/Password.ts:987` — Bridging by string convention.
```ts
                Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

### Workstream `user-import-idempotency`

#### SAM-008 — Import path is three sequential single-row calls per user with an emailVerified lockout hazard

`medium` · `dx` · `core` · [.issues/medium/SAM-008-supabase-auth-migration-specialist.md](../../.issues/medium/SAM-008-supabase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **AOMS-008**

Same root cause (no batch/upsert/transactional import surface). The emailVerified-lockout hazard is handled for Auth0 by importUser's `input.emailVerified` branch; AOMS-008's core importUser makes it first-class for every source.

**Evidence at HEAD:**

- `packages/migrate-auth0/src/ImportAuth0User.ts:32` — Since the audit, a single-user Auth0 import helper exists (AOMS-001) — still per-row, non-idempotent, no transaction spanning create+verify+link, no export.
```ts
 * Not idempotent — re-running a bulk import against a partially-imported
 * batch surfaces `EmailAlreadyExists`/`AccountAlreadyLinked` rather than
 * silently double-importing; a caller driving a bulk migration script
 * decides for itself whether to treat those as "already migrated, skip"
 * or a real failure.
```
- `packages/core/src/Users.ts:80`
```ts
/**
 * BEH-EA-041/042: no operation below accepts `emailVerified` as input —
 * `create` always starts it `false` (supplier-authority default), and
 * `verifyEmail` is the only transition, one-directional and idempotent.
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### AOMS-008 — No bulk user import/export surface anywhere in the monorepo

`medium` · `api` · `core` · [.issues/medium/AOMS-008-auth0-okta-migration-specialist.md](../../.issues/medium/AOMS-008-auth0-okta-migration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) — canonical for SAM-008

Partially overtaken: @awthaq/migrate-auth0's importUser (60947ff) documents and implements the create+verifyEmail+link recipe for one Auth0 user. Still missing: batching, a transaction spanning the three writes, re-runnable (idempotent) semantics, a Supabase/generic importer, and any list/export API (admin listUsers is BAM-005/EP-003's scope, cross-slice).

**Evidence at HEAD:**

- `packages/migrate-auth0/src/ImportAuth0User.ts:32` — Since the audit, a single-user Auth0 import helper exists (AOMS-001) — still per-row, non-idempotent, no transaction spanning create+verify+link, no export.
```ts
 * Not idempotent — re-running a bulk import against a partially-imported
 * batch surfaces `EmailAlreadyExists`/`AccountAlreadyLinked` rather than
 * silently double-importing; a caller driving a bulk migration script
 * decides for itself whether to treat those as "already migrated, skip"
 * or a real failure.
```
- `packages/core/src/Users.ts:80`
```ts
/**
 * BEH-EA-041/042: no operation below accepts `emailVerified` as input —
 * `create` always starts it `false` (supplier-authority default), and
 * `verifyEmail` is the only transition, one-directional and idempotent.
```

**Fix plan:** Provide a transactional, idempotent import primitive in core and batch importers on top of it.

Steps:
1. Core: `Users.importUser({ identity, name, emailVerified, metadata?, credentials: [{ providerId, subject, issuer?, credentialHash? }] })` — a single, explicitly import-only entry point (not exposed over HTTP) allowed to set emailVerified at creation (document the BEH-EA-042 exception for imports), runs create-or-get (SCP-003) + links inside one SqlTransaction.withTransaction, and returns `{ user, created: boolean }` so re-runs converge.
2. migrate-auth0 importUser delegates to it; add `importUsers(stream, { batchSize, concurrency })` returning per-row outcomes; add a Supabase importer mapping auth.users (+ raw_user_meta_data -> metadata).
3. Export: depend on BAM-005's admin listUsers (keyset) for reconciliation; do not add a separate export API here.
4. Document the recipe in the migrate-* READMEs.

Files: `packages/core/src/Users.ts`, `packages/migrate-auth0/src/ImportAuth0User.ts`, `packages/ports/src/SqlTransaction.ts`, `spec/behaviors/06-domain-users-accounts.md`

Tests:
- packages/core/test/Users.test.ts: 'importUser twice with the same input returns the same user with created=false'; 'a failing link rolls back the user row' (SQL suite).
- packages/migrate-auth0/test: batch import of N users is re-runnable after a mid-batch failure.

Acceptance:
- Re-running an import converges without errors; no partial user (user without its credential account) survives a failed row.

Spec refs: BEH-EA-041, BEH-EA-042, BEH-EA-043 · Effort **L** · Depends on: SCP-003, FAMS-002 · Needs decision: no

**Recommended status:** `ready-for-agent`

#### MW-007 — Users port requires a full 7-method shape — no partial-adapter path for immutable/legacy stores

`medium` · `api` · `core` · [.issues/medium/MW-007-matias-woloski.md](../../.issues/medium/MW-007-matias-woloski.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence medium)

The project's chosen adoption path for existing stores is migration with bridges (LegacyPasswordVerifiers + @awthaq/migrate-auth0, LegacySessionBridge + @awthaq/migrate-better-auth), not live read-only legacy user stores. A partial adapter would make sign-up/verify/delete flows fail at runtime with a new UnsupportedOperation in every Shape channel — speculative infrastructure with no consumer. Revisit if a live-legacy-store integration is requested.

**Evidence at HEAD:**

- `packages/core/src/Users.ts:87` — Accurate: one all-or-nothing Shape (6 methods at HEAD, not 7).
```ts
export interface UsersShape {
  readonly create: (input: {
    readonly email: string;
    readonly name: string;
    readonly metadata?: string;
  }) => Effect.Effect<UserRecord, EmailAlreadyExists | PlatformError.PlatformError>;
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `wontfix`

#### SCP-003 — Users.create has no create-or-get: IdP timeout retries surface as EmailAlreadyExists instead of idempotent success

`medium` · `correctness` · `core` · [.issues/medium/SCP-003-scim-provisioning-specialist.md](../../.issues/medium/SCP-003-scim-provisioning-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/src/Users.ts:290` — Unique violation becomes an error, never the existing row.
```ts
      const row = yield* repo.insert(insert).pipe(
        Effect.catchTag("SqlError", (error) =>
          error.reason._tag === "UniqueViolation"
            ? Effect.fail(
                new EmailAlreadyExists({
```

**Fix plan:** Add Users.createOrGet: insert, and on unique violation return the existing record deterministically (both layers).

Steps:
1. UsersShape: `createOrGet(input): Effect<{ user: UserRecord; created: boolean }, PlatformError | (MA-004's infra error)>`.
2. layerMemory: inside the existing Ref.modify, return the existing record when byEmail has the key.
3. layerSql: `INSERT ... ON CONFLICT (lower(email)) DO NOTHING RETURNING *`, then `findByEmail` on empty result (both dialects support ON CONFLICT on an expression index — verify postgres needs the index expression; otherwise catch UniqueViolation and findByEmail).
4. Identity union (FAMS-002): conflict target per identity kind; Anonymous never conflicts.

Files: `packages/core/src/Users.ts`, `packages/sql/src/Repositories.ts`, `packages/core/test/Users.test.ts`

Tests:
- packages/core/test/Users.test.ts (both suites): 'two concurrent createOrGet for one email return the same user, exactly one created=true' (Effect.all unbounded).

Acceptance:
- createOrGet is idempotent under retries and concurrency in both layers.

Spec refs: BEH-EA-041 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

### Workstream `session-cookie-policy`

#### AGA-004 — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate

`medium` · `security` · `core` · [.issues/medium/AGA-004-api-gateway-auth-specialist.md](../../.issues/medium/AGA-004-api-gateway-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Holds. One correction to the audit's recommended fix: CHIPS does NOT require dropping the __Host- prefix (Partitioned cookies are recommended to use __Host-), so an embedded mode can keep __Host-; it only trades SameSite=Strict for SameSite=None.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:151` — No maxAge/expires, no partitioned, no domain; used verbatim at 8 issuance sites (password x3, passkey, oauth, admin, next GetSession, server deliverRotation).
```ts
/** BEH-EA-055: the one session cookie's fixed, non-configurable attribute set. */
export const SESSION_COOKIE_NAME = "__Host-session";
export const SESSION_COOKIE_ATTRIBUTES = {
  secure: true,
  httpOnly: true,
  sameSite: "strict",
  path: "/",
} as const;
```
- `packages/server/src/Authentication.ts:234` — No site sets `partitioned`; effect's Cookies options do support it (../effect Cookies.ts:67).
```ts
    ? HttpServerResponse.setCookie(
        response,
        Sessions.SESSION_COOKIE_NAME,
        token,
        Sessions.SESSION_COOKIE_ATTRIBUTES,
      ).pipe(Effect.orDie)
```

**Fix plan:** Deliver the `HostEmbedded` mode of IC-007's SessionCookieConfig (SameSite=None; Partitioned; __Host- kept) for session and CSRF cookies.

Steps:
1. Implemented as part of IC-007's SessionCookieConfig work (same helper, same sites).
2. Add the `partitioned: true` + `sameSite: 'none'` rendering for the HostEmbedded mode in both the session helper and Csrf.ts's cookie.
3. Document in BEH-EA-055 that HostEmbedded requires the CSRF double-submit middleware (already mandatory for cookie auth) and is meant for third-party-iframe deployments.

Files: `packages/core/src/Sessions.ts`, `packages/server/src/Csrf.ts`, `spec/behaviors/07-sessions.md`, `spec/behaviors/10-csrf.md`

Tests:
- packages/server/test/AuthHttp.test.ts: 'HostEmbedded mode issues __Host-session with SameSite=None; Partitioned' and same for the CSRF cookie.

Acceptance:
- With HostEmbedded configured, both cookies carry Partitioned and SameSite=None; default output unchanged.

Spec refs: BEH-EA-055 · Effort **S** · Depends on: IC-007 · Needs decision: yes

**Recommended status:** `ready-for-human`

#### BO-005 — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login

`medium` · `dx` · `core` · [.issues/medium/BO-005-balazs-orban.md](../../.issues/medium/BO-005-balazs-orban.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:151` — No maxAge/expires, no partitioned, no domain; used verbatim at 8 issuance sites (password x3, passkey, oauth, admin, next GetSession, server deliverRotation).
```ts
/** BEH-EA-055: the one session cookie's fixed, non-configurable attribute set. */
export const SESSION_COOKIE_NAME = "__Host-session";
export const SESSION_COOKIE_ATTRIBUTES = {
  secure: true,
  httpOnly: true,
  sameSite: "strict",
  path: "/",
} as const;
```
- `packages/core/src/Sessions.ts:70` — Server lifetime 30d/7d vs a cookie with no Max-Age (browser-session).
```ts
export const SessionConfig: Context.Reference<SessionConfig> = Context.Reference<SessionConfig>(
  "awthaq/core/SessionConfig",
  {
    defaultValue: () => ({
      absolute: Duration.days(30),
      idle: Duration.days(7),
```

**Fix plan:** Give the session cookie a Max-Age derived from the session's absoluteExpiresAt (recomputed at every rotation), via IC-007's cookie helper, with a 'browserSession' opt-out.

Steps:
1. Implement `persistence` in SessionCookieConfig (IC-007 plan); the helper sets `maxAge = DateTime.distance(now, session.absoluteExpiresAt)` for 'absolute'.
2. deliverRotation (packages/server/src/Authentication.ts) must pass the refreshed SessionView so Max-Age is recomputed; next/GetSession's rotation path likewise.
3. If the decision is to ship BO-005 alone (option A), add `maxAge` computation to the existing fixed constant path via the same helper and amend BEH-EA-055's attribute list.

Files: `packages/core/src/Sessions.ts`, `packages/server/src/Authentication.ts`, `packages/next/src/GetSession.ts`, `spec/behaviors/07-sessions.md`

Tests:
- packages/core/test/Sessions.test.ts: helper computes Max-Age = absoluteExpiresAt - now.
- packages/server/test/AuthHttp.test.ts: 'sign-in Set-Cookie carries Max-Age ~= 30d' and 'rotation Set-Cookie Max-Age shrinks toward absolute expiry'.

Acceptance:
- Every Set-Cookie for the session carries Max-Age <= remaining absolute lifetime.
- BEH-EA-055 documents the lifetime attribute.

Spec refs: BEH-EA-055, BEH-EA-051 · Effort **S** · Depends on: IC-007 · Needs decision: yes

**Recommended status:** `ready-for-human`

#### IC-007 — Fixed non-configurable __Host-/Strict cookie forecloses legitimate deployments

`low` · `architecture` · `core` · [.issues/low/IC-007-iain-collins.md](../../.issues/low/IC-007-iain-collins.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for EP-008

Fact holds exactly: one compile-time constant, no escape hatch. It is spec-mandated (BEH-EA-055), so relaxing it is a product decision.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:151` — No maxAge/expires, no partitioned, no domain; used verbatim at 8 issuance sites (password x3, passkey, oauth, admin, next GetSession, server deliverRotation).
```ts
/** BEH-EA-055: the one session cookie's fixed, non-configurable attribute set. */
export const SESSION_COOKIE_NAME = "__Host-session";
export const SESSION_COOKIE_ATTRIBUTES = {
  secure: true,
  httpOnly: true,
  sameSite: "strict",
  path: "/",
} as const;
```
- `spec/behaviors/07-sessions.md:115` — Any configurability is a spec change to BEH-EA-055 — hence the decision.
```ts
REQUIREMENT: The session cookie MUST be named with the `__Host-` prefix,
             MUST carry `Secure`, `HttpOnly`, and `SameSite=Strict`, MUST
             set `Path=/`, and MUST NOT set a `Domain` attribute.
```

**Fix plan:** Introduce SessionCookieConfig with a secure default and typed opt-in modes (incl. __Secure-+Domain for multi-subdomain apps); route every issuance site through one helper.

Steps:
1. Decide option (see decision). Then in Sessions.ts replace the two constants with `SessionCookieConfig` (Context.Reference, default = today's attributes) and a pure helper `sessionCookie(config, session: SessionView, now) => { name, value options }` that computes name (`__Host-session` / `__Secure-session`), attributes, and `maxAge` from `session.absoluteExpiresAt` when persistence = 'absolute'. Keep `SESSION_COOKIE_NAME` exported for readers (SubjectExtractor, AliasLegacyCookieMiddleware, Api.SessionCookie) or derive it from config.
2. Route all 8 issuance sites through the helper: packages/password/src/Password.ts (3 securitySetCookie calls ~390/414/489), packages/passkey/src/Passkey.ts ~366, packages/oauth/src/OAuth.ts ~435, packages/admin/src/Admin.ts ~167, packages/next/src/GetSession.ts ~168, packages/server/src/Authentication.ts deliverRotation ~234 (rotation must recompute Max-Age).
3. Cookie readers (packages/api/src/Api.ts SessionCookie security scheme, packages/qadi/src/SubjectExtractor.ts:41, migrate-better-auth alias middleware) read the configured name.
4. Apply the same embedded/partitioned option to the CSRF cookie (packages/server/src/Csrf.ts) so an embedded deployment works end to end.
5. Spec: rewrite BEH-EA-055 as 'secure default + typed opt-in modes', add a BEH id per mode, update traceability; document the embedded mode's trade-offs (SameSite=None relies on CSRF token).

Files: `packages/core/src/Sessions.ts`, `packages/password/src/Password.ts`, `packages/passkey/src/Passkey.ts`, `packages/oauth/src/OAuth.ts`, `packages/admin/src/Admin.ts`, `packages/next/src/GetSession.ts`, `packages/server/src/Authentication.ts`, `packages/server/src/Csrf.ts`, `packages/api/src/Api.ts`, `packages/qadi/src/SubjectExtractor.ts`, `spec/behaviors/07-sessions.md`

Tests:
- packages/core/test/Sessions.test.ts: 'sessionCookie default renders exactly __Host-session; Secure; HttpOnly; SameSite=Strict; Path=/ plus Max-Age from absoluteExpiresAt' (pure unit test, write first).
- packages/server/test/AuthHttp.test.ts: 'rotated cookie carries a recomputed Max-Age'; 'HostEmbedded mode emits SameSite=None; Partitioned and keeps __Host-'.
- features/features/03-http-layer/09-authentication-middleware.feature (or 07-sessions.feature): BEH-EA-055 scenarios per mode.

Acceptance:
- Default output byte-identical to today except Max-Age (if persistence='absolute' is chosen).
- A SecureDomain mode issues __Secure-session with Domain; __Host- + Domain is a type error.
- All issuance sites use the helper (grep SESSION_COOKIE_ATTRIBUTES finds only the helper).

Spec refs: BEH-EA-055, BEH-EA-065 · Effort **L** · Depends on: — · Needs decision: yes

**Recommended status:** `ready-for-human`

#### EP-008 — Session cookie identity is a fixed, non-configurable __Host- constant

`low` · `architecture` · `core` · [.issues/low/EP-008-eugenio-pace.md](../../.issues/low/EP-008-eugenio-pace.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **IC-007**

Same fact (fixed, non-configurable __Host- constant); EP-008's per-domain-scope ask is served by IC-007's SecureDomain/config mode, and its 'document the constraint' ask by the BEH-EA-055 rewrite.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:151` — No maxAge/expires, no partitioned, no domain; used verbatim at 8 issuance sites (password x3, passkey, oauth, admin, next GetSession, server deliverRotation).
```ts
/** BEH-EA-055: the one session cookie's fixed, non-configurable attribute set. */
export const SESSION_COOKIE_NAME = "__Host-session";
export const SESSION_COOKIE_ATTRIBUTES = {
  secure: true,
  httpOnly: true,
  sameSite: "strict",
  path: "/",
} as const;
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

### Workstream `users-profile-surface`

#### SAM-004 — No home for auth.users metadata; plugin-contributed fields are spec-only

`medium` · `api` · `core` · [.issues/medium/SAM-004-supabase-auth-migration-specialist.md](../../.issues/medium/SAM-004-supabase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) — canonical for BE-007

Holds: plugin-contributed fields (BEH-EA-040/048) have no implementation. Overtaken: 'no home for metadata' is partly fixed by AOMS-002's opaque `metadata` column (fefa4c7), which is server-writable only.

**Evidence at HEAD:**

- `packages/core/src/AuthPlugin.ts:126` — No plugin-contributed-field option on AuthPlugin.Service (BEH-EA-040/048 unimplemented).
```ts
      readonly tables?: ReadonlyArray<`${Id}_${string}`>;
      readonly migrations?: Migrations;
```
- `packages/core/src/Users.ts:57` — Partially addressed since the audit (fefa4c7): an opaque, server-only-writable metadata string now exists.
```ts
  /**
   * AOMS-002: free-form, opaque per-user metadata (e.g. a JSON-encoded
   * string) — mirrors `@awthaq/organization`'s own
   * `OrganizationRecord.metadata`. This service never parses or
   * interprets it; an IdP migration (Auth0's `user_metadata`/
   * `app_metadata`) or an application-level claims-enrichment hook is
```
- `packages/api/src/Account.ts:24` — metadata is not client-writable over HTTP — the BEH-EA-048 hazard does not apply to it.
```ts
export const UpdateProfilePayload = Schema.Struct({ name: Schema.String });
```

**Fix plan:** Implement the BEH-EA-040/048 user-field extension point (decision option A), decomposed into four tickets, with interim docs.

Steps:
1. Interim: document in spec/behaviors/06-domain-users-accounts.md that app data goes in `metadata` (server-only) or a plugin-prefixed side table; authorization hints must never be client-writable.
2. AuthPlugin.ts: `Service` options gain `userFields?: Record<string, { schema: Schema.Top; clientWritable?: boolean }>`; `Any`/`Class` carry it; Auth.ts computes `UserFieldsOf<P>` for typed access.
3. Migration lane: renumberMigrations allows a plugin migration to ALTER users only for its declared `${id}_${field}` columns (BEH-EA-040 enforcement in the linker).
4. Users: `getFields(id)`/`setFields(id, patch)` typed by the composed field set; the HTTP updateProfile payload includes only clientWritable fields (BEH-EA-048 gating).
5. Client inference (packages/client) exposes clientWritable fields in the profile type.

Files: `packages/core/src/AuthPlugin.ts`, `packages/core/src/Auth.ts`, `packages/core/src/Users.ts`, `packages/sql/src/Models.ts`, `packages/api/src/Account.ts`, `spec/behaviors/05-persistence-stratum.md`, `spec/behaviors/06-domain-users-accounts.md`

Tests:
- packages/core/test/AuthPlugin.test.ts: 'a plugin declaring userFields exposes them on Users with inferred types' and '@ts-expect-error writing a non-clientWritable field via the HTTP payload type'.
- features/features/02-domain/06-users-accounts.feature: BEH-EA-048 scenarios.

Acceptance:
- A plugin can declare a typed user field end-to-end (migration, storage, typed read/write, client type) without touching core source.

Spec refs: BEH-EA-040, BEH-EA-048 · Effort **XL** · Depends on: — · Needs decision: yes

**Recommended status:** `ready-for-human`

#### BAM-009 — User profile surface cannot receive better-auth user fields: no image, no email change

`medium` · `api` · `core` · [.issues/medium/BAM-009-better-auth-migration-specialist.md](../../.issues/medium/BAM-009-better-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) — canonical for SCP-004

Holds: no `image`, no email-change operation. Covered elsewhere: role mapping via BAM-006 (1331cd5, SQL role assignments); banned/banReason via ticket 09's `status` (FAMS-002) — ban reason/expiry fields would extend that.

**Evidence at HEAD:**

- `packages/core/src/Users.ts:96` — Still no email change and no image; metadata was added.
```ts
  readonly updateProfile: (
    id: UserId,
    input: { readonly name: string; readonly metadata?: string | null },
  ) => Effect.Effect<UserRecord, UserNotFound>;
```
- `packages/sql/src/Models.ts:40` — No image column.
```ts
export class User extends Model.Class<User>("User")({
  id: Model.UuidV7Insert(UserId),
  email: Schema.String,
```

**Fix plan:** Add a nullable image field and a verified email-change primitive to Users; document better-auth field mapping.

Steps:
1. Users/Models: `image: Option<string>` (nullable column, migration), settable via updateProfile (client-writable, like name) — add to UpdateProfilePayload and AccountDto.
2. Users.changeEmail(id, newEmail): atomically sets email (lower-cased, uniqueness -> EmailAlreadyExists) and resets emailVerified=false (the only transition that may clear it; update BEH-EA-042 wording). With ticket 09 in place this operates on the Email identity variant.
3. Password plugin: a change-email flow = Verification.issue('change-email:<userId>', payload {newEmail}) mailed to the new address; on consume, Users.changeEmail then Users.verifyEmail inside one SqlTransaction (BEH-EA-058).
4. Document better-auth -> awthaq field mapping (image->image, role->roles plugin, banned/banReason/banExpires->status (+ future fields)) in packages/migrate-better-auth README/spec model.

Files: `packages/core/src/Users.ts`, `packages/sql/src/Models.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/api/src/Account.ts`, `packages/password/src/Password.ts`, `spec/behaviors/06-domain-users-accounts.md`

Tests:
- packages/core/test/Users.test.ts (both suites): 'changeEmail resets emailVerified and enforces uniqueness'; 'updateProfile sets image'.
- packages/password/test: change-email flow end to end.

Acceptance:
- A user can change email only via a verified flow; image round-trips.

Spec refs: BEH-EA-041, BEH-EA-042, BEH-EA-058 · Effort **L** · Depends on: FAMS-002 · Needs decision: no

**Recommended status:** `ready-for-agent`

#### BE-007 — User profile is a closed shape — no user-field extension point for apps or plugins

`medium` · `api` · `core` · [.issues/medium/BE-007-bereket-engida.md](../../.issues/medium/BE-007-bereket-engida.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **SAM-004**

Same gap (no user-field extension point); likewise partially overtaken by AOMS-002's opaque metadata.

**Evidence at HEAD:**

- `packages/core/src/AuthPlugin.ts:126` — No plugin-contributed-field option on AuthPlugin.Service (BEH-EA-040/048 unimplemented).
```ts
      readonly tables?: ReadonlyArray<`${Id}_${string}`>;
      readonly migrations?: Migrations;
```
- `packages/core/src/Users.ts:57` — Partially addressed since the audit (fefa4c7): an opaque, server-only-writable metadata string now exists.
```ts
  /**
   * AOMS-002: free-form, opaque per-user metadata (e.g. a JSON-encoded
   * string) — mirrors `@awthaq/organization`'s own
   * `OrganizationRecord.metadata`. This service never parses or
   * interprets it; an IdP migration (Auth0's `user_metadata`/
   * `app_metadata`) or an application-level claims-enrichment hook is
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### SCP-004 — Users mutation surface cannot express SCIM PATCH: updateProfile accepts {name} only

`medium` · `api` · `core` · [.issues/medium/SCP-004-scim-provisioning-specialist.md](../../.issues/medium/SCP-004-scim-provisioning-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **BAM-009**

Email mutability = BAM-009's changeEmail. `active` = ticket 09's Users.setStatus (FAMS-002). The 'plugin owns its own table' alternative was decided by ticket 08 (scim_external_id in packages/scim).

**Evidence at HEAD:**

- `packages/core/src/Users.ts:96`
```ts
  readonly updateProfile: (
    id: UserId,
    input: { readonly name: string; readonly metadata?: string | null },
  ) => Effect.Effect<UserRecord, UserNotFound>;
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

### Workstream `verification-otp-substrate`

#### MLO-002 — Verification.reserve - the domain-level resend/serialization primitive - has zero production callers

`medium` · `architecture` · `core` · [.issues/medium/MLO-002-magic-link-email-otp-specialist.md](../../.issues/medium/MLO-002-magic-link-email-otp-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:121` — grep `.reserve(` in packages/*/src: zero callers.
```ts
  readonly reserve: (input: {
    readonly identifier: string;
    readonly ttl: Duration.Duration;
  }) => Effect.Effect<boolean>;
```

**Fix plan:** Make reserve's status a decision: document it as the resend-window primitive for MagicLink/EmailOtp (ticket 05) and use it there; until then note it in the Shape doc.

Steps:
1. VerificationShape.reserve doc comment: 'intended consumer: MagicLink/EmailOtp resend window (wayfinder ticket 05); not yet wired'.
2. When EmailOtp/MagicLink land (ticket 05), implement their 'configurable resend window' with `reserve({ identifier: 'resend:<purpose>:<userId>', ttl })` and add a test there.
3. Optional now: guard Password.requestReset/resendVerification mail sends with reserve as de-dup under concurrency (defense-in-depth below the RateLimiter).

Files: `packages/core/src/Verification.ts`, `packages/password/src/Password.ts`, `spec/models/05-email-otp.md`

Tests:
- If Password is wired: packages/password/test 'two concurrent resendVerification calls send one mail'.

Acceptance:
- reserve has a documented consumer or a production caller.

Spec refs: BEH-EA-063 · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### BCR-005 — Verification.issue mints its own 256-bit hex value, leaving no way to issue caller-formatted codes

`medium` · `security` · `core` · [.issues/medium/BCR-005-backup-codes-recovery-specialist.md](../../.issues/medium/BCR-005-backup-codes-recovery-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence medium)

The backup-code motivation is superseded by wayfinder ticket 05 (own two_factor_recovery_code table). But the same ticket's EmailOtp ('6 digits, hashed storage, reusing Verification') still needs Verification to hold a caller-formatted short code — so the capability gap remains.

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:158` — Value always self-minted (layerSql identical at 287).
```ts
      const issue: VerificationShape["issue"] = Effect.fnUntraced(function* (input) {
        const id = VerificationTokenId(yield* crypto.randomUUIDv7);
        const value = toHex(yield* crypto.randomBytes(32));
```
- `.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md:38` — Decision: backup codes do NOT go through Verification.
```ts
   - **Recovery codes**: table `two_factor_recovery_code` (`id`, `userId`, `codeHash`, `usedAt` nullable) — hashed via the existing `PasswordHasher` port
```

**Fix plan:** Let Verification.issue mint caller-formatted values via a typed generator option (never a raw caller string), keeping hashing and single-use semantics.

Steps:
1. VerificationShape.issue input gains `format?: { readonly _tag: 'Hex256' } | { readonly _tag: 'Digits'; readonly length: 6 | 8 } | { readonly _tag: 'Alphanumeric'; readonly length: number }` (default Hex256). Generation stays inside Verification using crypto.randomBytes with rejection sampling (no modulo bias).
2. Low-entropy formats require `maxAttempts` (SOS-004) at the type level — make `format` and `maxAttempts` a discriminated input so a Digits token without an attempt budget does not type-check.
3. Both layers; document in BEH-EA-057/060.

Files: `packages/core/src/Verification.ts`, `spec/behaviors/08-verification-tokens.md`

Tests:
- packages/core/test/Verification.test.ts (both suites): 'Digits(6) issue returns a 6-digit value that consumes once'; property test for uniform digit distribution (optional).

Acceptance:
- EmailOtp can issue 6-digit codes through Verification without bending identifiers.

Spec refs: BEH-EA-057, BEH-EA-060 · Effort **M** · Depends on: SOS-004 · Needs decision: no

**Recommended status:** `ready-for-agent`

#### SOS-004 — Verification.consume enforces no attempt budget — unlimited guesses against a live token, safe only while codes are 256-bit

`medium` · `security` · `core` · [.issues/medium/SOS-004-sms-otp-specialist.md](../../.issues/medium/SOS-004-sms-otp-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:202` — Plain !== on the digest (layerMemory).
```ts
              const row = HashMap.get(s, identifier);
              if (
                Option.isNone(row) ||
                isExpired(row.value, now) ||
                row.value.valueHash !== presentedHash
              ) {
```
- `packages/core/src/Verification.ts:208` — Wrong guess leaves the row untouched (`s`) — unlimited in-TTL guesses.
```ts
                return [
                  Result.fail(
                    new TokenConsumed({
                      message: `awthaq: token replay or unknown token: ${identifier}`,
                      identifier,
                    }),
                  ),
                  s,
```

**Fix plan:** Add an optional per-token attempt budget: each failed consume against a live row increments attempts; the row is burned at maxAttempts.

Steps:
1. VerificationShape.issue input: `maxAttempts?: number` (required for low-entropy formats, see BCR-005). TokenRow/SQL model gain `attempts` + `maxAttempts` (migration on verification_tokens).
2. layerMemory.consume: in the same Ref.modify, on hash mismatch against a live row increment attempts and remove the row when attempts >= maxAttempts; still return uniform TokenConsumed.
3. layerSql: after tryConsume returns none, run `UPDATE verification_tokens SET attempts = attempts + 1, "consumedAt" = CASE WHEN attempts + 1 >= "maxAttempts" THEN ${now} ELSE "consumedAt" END WHERE identifier = ? AND "consumedAt" IS NULL AND "maxAttempts" IS NOT NULL` (single statement, atomic).
4. Document in BEH-EA-062/064 and spec/models/05-email-otp.md; ticket 05's per-challenge rate limit stays as a second layer.

Files: `packages/core/src/Verification.ts`, `packages/sql/src/Repositories.ts`, `packages/sql/src/Models.ts`, `packages/sql/src/CoreMigrations.ts`, `spec/behaviors/08-verification-tokens.md`

Tests:
- packages/core/test/Verification.test.ts (both suites, write first): 'a token with maxAttempts 3 is unusable after 3 wrong guesses even with the right value next'.

Acceptance:
- Bounded-guess tokens cannot be brute-forced within TTL; 256-bit tokens without maxAttempts behave as today.

Spec refs: BEH-EA-062, BEH-EA-059, BEH-EA-064 · Effort **M** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### THS-005 — No replay primitive for time-windowed codes: Verification is identifier-keyed single-use only

`medium` · `correctness` · `core` · [.issues/medium/THS-005-totp-hotp-mfa-specialist.md](../../.issues/medium/THS-005-totp-hotp-mfa-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence medium)

Belongs to the two-factor plugin (THS-001, cross-slice), not to core Verification: the fix amends ticket 05's two_factor_secret design.

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:186` — Identifier-keyed single-use only; no used-step notion anywhere.
```ts
      const consume: VerificationShape["consume"] = Effect.fnUntraced(
        function* (identifier, value) {
```
- `.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md:37` — Ticket 05's TOTP design omits a last-used-step column.
```ts
   - **Secret storage**: new table `two_factor_secret` (`userId` PK, `secret` — encrypted at rest, `confirmedAt` nullable
```

**Fix plan:** Add a lastUsedStep compare-and-set to the TOTP secret row in the two-factor design and implementation.

Steps:
1. Amend spec/models/06-two-factor-totp.md (and ticket 05 notes): `two_factor_secret.lastUsedStep INTEGER NULL`; verify accepts a code for step t in [now-1, now+1] only if `UPDATE two_factor_secret SET lastUsedStep = ? WHERE userId = ? AND (lastUsedStep IS NULL OR lastUsedStep < ?) RETURNING userId` returns a row.
2. Memory layer equivalent inside one Ref.modify.
3. Add a BEH id: 'a TOTP code is accepted at most once per time step, even concurrently'.

Files: `spec/models/06-two-factor-totp.md`, `packages/two-factor/src/`

Tests:
- packages/two-factor/test: 'the same valid code presented twice (sequentially and concurrently) succeeds once'.

Acceptance:
- Replay of a TOTP code within its window is refused.

Spec refs: — · Effort **S** · Depends on: THS-001 · Needs decision: no

**Recommended status:** `ready-for-agent`

#### SOS-007 — Rate-limit key strategies have no recipient/E.164 notion; SMS pumping protection would lean entirely on the warned-about escape hatch

`low` · `security` · `core` · [.issues/low/SOS-007-sms-otp-specialist.md](../../.issues/low/SOS-007-sms-otp-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence medium)

Forward-looking guidance for an SMS plugin that wayfinder ticket 05 §3 explicitly defers. Nothing to change in core now; carry 'mandatory per-E.164 + per-IP rule pair' into SOS-001's acceptance criteria when SMS lands.

**Evidence at HEAD:**

- `packages/core/src/RateLimits.ts:57` — Accurate; the function key already expresses per-recipient caps (Password's resendVerification precedent).
```ts
export type RateLimitKey = "principal" | "ip" | ((input: unknown) => string);
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `wontfix`

#### BCR-008 — Show-once primitive already exists: issue returns the plaintext value exactly once as Redacted

`info` · `dx` · `core` · [.issues/info/BCR-008-backup-codes-recovery-specialist.md](../../.issues/info/BCR-008-backup-codes-recovery-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence high)

Informational positive finding, no defect. Its 'reuse Verification.issue for backup codes' recommendation is superseded by ticket 05 (own two_factor_recovery_code table hashed with PasswordHasher).

**Evidence at HEAD:**

- `packages/core/src/Verification.ts:100` — Accurate observation of a strength.
```ts
  }) => Effect.Effect<
    { readonly token: VerificationTokenView; readonly value: Redacted.Redacted<string> },
    PlatformError.PlatformError
  >;
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `wontfix`

### Workstream `session-policy`

#### SMS-003 — No concurrent-session limit exists in config, shape, or either layer

`medium` · `security` · `core` · [.issues/medium/SMS-003-session-management-specialist.md](../../.issues/medium/SMS-003-session-management-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:58` — No cap / eviction policy anywhere.
```ts
export interface SessionConfig {
  readonly absolute: Duration.Duration;
  readonly idle: Duration.Duration;
  readonly touchEvery: Duration.Duration;
}
```
- `spec/behaviors/06-domain-users-accounts.md:104` — Constrains the fix: default must stay uncapped; an opt-in deployment policy is allowed.
```ts
REQUIREMENT: The base domain model MUST NOT cap the number of Accounts one
             User may link, nor the number of simultaneously valid Sessions
             one User may hold; a "single active session" policy, if
             wanted, is a capability layered on top by a plugin or
             deployment, never an implied base-model limit.
```

**Fix plan:** Add an opt-in concurrent-session cap to SessionConfig (default: none, preserving BEH-EA-047) with a typed eviction policy, enforced atomically in issue, publishing an event on eviction.

Steps:
1. SessionConfig gains `maxConcurrent: Option<{ readonly limit: number; readonly onExceed: "evictOldest" | "refuse" }>` defaulting to Option.none().
2. layerMemory.issue: inside the same Ref.modify as the insert (after ESR-002's refactor), count the user's live (non-tombstoned, unexpired) rows; evictOldest removes the least-recently-active ones, refuse returns a failure.
3. layerSql.issue: inside ESR-002's transaction, `SELECT id FROM sessions WHERE userId=? AND supersededAt IS NULL AND absoluteExpiresAt>now AND idleExpiresAt>now ORDER BY lastActiveAt ASC` then delete the overflow (evict) or fail (refuse). New repository op `listLiveIds(userId, now)`.
4. Ship v1 with `evictOldest` only, so issue's error channel is unchanged. A later `refuse` policy needs a typed `SessionLimitReached` in issue's E (not a die — it is user-facing), mapped by Password/OAuth/Passkey sign-in to a new wire error (e.g. TooManySessions, 409).
5. Publish `auth.session.revoked` with reason `"limitEvicted"` (extend AuthEvents' reason union) for each evicted session.
6. Spec: new BEH-EA id in 07-sessions.md for the opt-in cap; cross-reference BEH-EA-047 ('deployment capability').

Files: `packages/core/src/Sessions.ts`, `packages/sql/src/Repositories.ts`, `packages/core/src/AuthEvents.ts`, `spec/behaviors/07-sessions.md`, `packages/core/test/Sessions.test.ts`

Tests:
- packages/core/test/Sessions.test.ts (both suites, write first): 'maxConcurrent {limit: 2, evictOldest}: issuing a 3rd session evicts the least-recently-active and publishes auth.session.revoked(limitEvicted)'.
- Same: 'default config never evicts (BEH-EA-047)'.

Acceptance:
- Default behavior unchanged; with a cap configured the user never holds more than `limit` live sessions after issue returns.

Spec refs: BEH-EA-047, BEH-EA-054 · Effort **M** · Depends on: ESR-002 · Needs decision: no

**Recommended status:** `ready-for-agent`

#### THS-003 — Sessions carry no amr/trust/assurance field recording which factors authenticated the principal

`medium` · `security` · `core` · [.issues/medium/THS-003-totp-hotp-mfa-specialist.md](../../.issues/medium/THS-003-totp-hotp-mfa-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

authenticatedAt (3d16a96) answers 'how recently', not 'with which factors'. Two-factor (THS-001, wayfinder ticket 05) will need this to express 'mfa' obligations in qadi.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:92` — SessionView now has authenticatedAt (ticket 15) and actingAs, but no amr/factor evidence.
```ts
export interface SessionView {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly createdAt: DateTime.Utc;
```

**Fix plan:** Add RFC 8176 `amr` evidence to sessions: set at issue by the authenticating plugin, extendable by reauthenticate, exposed on SessionView/SessionListItem/SessionDto.

Steps:
1. Sessions.ts: `export type AuthMethod = string & Brand<'AuthMethod'>` (or a closed literal union of RFC 8176 values used here: 'pwd' | 'hwk' | 'swk' | 'user' | 'otp' | 'mfa' | 'fed'); SessionRow/SessionView gain `amr: ReadonlyArray<AuthMethod>`; `issue` input gains `amr?: ReadonlyArray<AuthMethod>` (default []); `reauthenticate(id, amr?)` unions new methods in.
2. SQL: migration in packages/sql/src/CoreMigrations.ts adding `amr TEXT NOT NULL DEFAULT '[]'` (JSON array) to sessions; Models.Session field with Schema.parseJson(Schema.Array(Schema.String)); toSessionView decodes.
3. Populate at issuance: Password.signIn/signUp -> ['pwd'], Passkey -> ['hwk','user'] (UV) , OAuth -> ['fed'], legacy bridge -> [], admin impersonation -> inherit none. Two-factor (future) appends 'otp' + 'mfa' via BeforeSessionIssue divert/verify.
4. Expose on packages/api SessionDto and qadi Subject attributes so obligations like `requires mfa` can be written (coordinate with qadi owners).
5. Spec: new BEH-EA id in 07-sessions.md (amr recorded at issuance, monotone within a session).

Files: `packages/core/src/Sessions.ts`, `packages/sql/src/Models.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/password/src/Password.ts`, `packages/passkey/src/Passkey.ts`, `packages/oauth/src/OAuth.ts`, `packages/api/src/Session.ts`, `spec/behaviors/07-sessions.md`

Tests:
- packages/core/test/Sessions.test.ts (both suites): 'issue records amr and verify returns it'; 'reauthenticate unions amr'.
- packages/password/test: sign-in session carries amr ['pwd'].

Acceptance:
- Every issued session carries a non-empty amr for password/passkey/oauth sign-ins; SQL and memory agree.

Spec refs: BEH-EA-049, BEH-EA-054 · Effort **L** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### PIL-008 — Admin impersonation semantics encoded in core's session model

`info` · `architecture` · `core` · [.issues/info/PIL-008-pilcrow.md](../../.issues/info/PIL-008-pilcrow.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence high)

Informational; the auditor's own recommendation is 'acceptable as-is'. The behavior is normative in spec/behaviors/27-admin-impersonation.md (BEH-EA-209/210). Revisit only if a second actingAs consumer never appears.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:81` — Deliberate, spec-backed (BEH-EA-209/210/212).
```ts
/**
 * BEH-EA-209: the caller's own identity, immutably attached to a session
 * minted on someone else's behalf (e.g. `@awthaq/admin`'s `impersonate`)
 * — a generic, `Admin`-agnostic field any future plugin could reuse.
 */
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `wontfix`

### Workstream `build-tooling-hygiene`

#### AH-006 — Emitted .d.ts keeps ./.ts relative specifiers while emitted .js is rewritten to .js

`medium` · `api` · `core` · [.issues/medium/AH-006-anders-hejlsberg.md](../../.issues/medium/AH-006-anders-hejlsberg.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence medium)

Fact holds, impact refuted for TypeScript consumers: a scratch consumer (package with exports.types -> lib/index.d.ts importing './b.ts', module/moduleResolution nodenext, skipLibCheck false, strict) type-checks cleanly under TypeScript 5.6.1-rc, 5.9.3 and tsgo 7.0.2 — TS resolves .ts specifiers in declaration files by design. Residual risk: non-tsc type resolvers / TS < 5.0. Cheap guard worth adding.

**Evidence at HEAD:**

- `packages/core/lib/Accounts.d.ts:12` — Build output (gitignored lib/) keeps .ts specifiers in 48 emitted .d.ts files.
```ts
import { UserId } from "./Users.ts";
```
- `tsconfig.base.json:22`
```ts
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
```

**Fix plan:** Add a consumer-resolution guard to package:smoke rather than rewriting emitted declarations.

Steps:
1. scripts/package-smoke.mjs: after attw, type-check a generated consumer (tmp dir, `import * as M from "@awthaq/<pkg>"`, module nodenext, skipLibCheck false) against each packed tarball with the repo's pinned TypeScript 5.x (node_modules/.pnpm typescript@5.9.3) — fails if declaration specifiers stop resolving.
2. Only if that guard ever fails: post-process lib/**/*.d.ts in scripts/build.mjs rewriting relative './x.ts' to './x.js'.

Files: `scripts/package-smoke.mjs`

Tests:
- The smoke check itself (passes today).

Acceptance:
- pnpm package:smoke fails if a published package's types stop resolving for a nodenext, skipLibCheck:false consumer.

Spec refs: — · Effort **S** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

#### MTS-001 — 32 of 85 project-reference edges are unreachable from src imports (template-copied reference lists)

`medium` · `correctness` · `core` · [.issues/medium/MTS-001-monorepo-tooling-specialist.md](../../.issues/medium/MTS-001-monorepo-tooling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/tsconfig.src.json:25` — core -> api has no src import today (becomes valid once MW-002 imports AuthCore).
```ts
      "path": "../api/tsconfig.src.json"
```
- `packages/two-factor/tsconfig.src.json:21` — Stub package (src/index.ts has no imports) referencing server/core/sql/ports/api. Recomputed at HEAD: 32 of 90 reference edges are not reachable through any transitive src import (admin->server, oauth/organization/passkey/password->server, cli/api-key/magic-link/two-factor x5-6, next->react, react->client, ports->api, sql->api, test->qadi, core->api).
```ts
      "path": "../server/tsconfig.src.json"
```

**Fix plan:** Trim every tsconfig.src.json references list to its transitive src-import closure and add a CI guard.

Steps:
1. For each package, set `references` to the packages its src imports directly (tsc -b resolves transitives); test-only imports go in tsconfig.test.json. Keep core -> api (MW-002 adds the import).
2. Add scripts/check-references.mjs (reuse the madge graph `pnpm circular` already builds, or a regex over `from "@awthaq/*"`) that fails when a reference is unreachable or an import lacks a reference; wire into `pnpm check`.

Files: `packages/*/tsconfig.src.json`, `scripts/check-references.mjs`, `package.json`

Tests:
- The guard script itself run in pnpm check (fails today on the 32 edges).

Acceptance:
- Zero unreachable or missing reference edges; pnpm run typecheck and pnpm build pass.

Spec refs: — · Effort **S** · Depends on: MW-002 · Needs decision: no

**Recommended status:** `ready-for-agent`

#### ELC-004 — Every memory layer requires Crypto.Crypto, forcing repeated Layer.provide(NodeCrypto.layer) boilerplate at ~40 composition sites

`low` · `dx` · `core` · [.issues/low/ELC-004-effect-layer-context-architect.md](../../.issues/low/ELC-004-effect-layer-context-architect.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/core/test/Users.test.ts:18` — Now 99 `Layer.provide(NodeCrypto.layer)` sites across 62 test/example/feature files (grew since the audit's ~40).
```ts
const MemoryLayer = Users.layerMemory.pipe(
```

**Fix plan:** Provide ready-made crypto-provided memory aggregates and migrate tests.

Steps:
1. packages/test/src: export `TestLayers.coreMemory` (Users/Accounts/Sessions/Verification memory + NodeCrypto + AuthEvents + Hooks defaults), reusing TestAuth's MemoryPorts construction.
2. packages/core/test/_layers.ts (core cannot depend on @awthaq/test): local helper `withNodeCrypto(layer)`; migrate core tests.
3. Migrate plugin tests opportunistically (mechanical).

Files: `packages/test/src/TestAuth.ts`, `packages/test/src/index.ts`, `packages/core/test/_layers.ts`

Tests:
- Existing suites stay green after migration.

Acceptance:
- New tests have a one-line way to get crypto-provided memory layers; site count drops substantially.

Spec refs: BEH-EA-193 · Effort **M** · Depends on: — · Needs decision: no

**Recommended status:** `ready-for-agent`

### Workstream `read-replica-routing`

#### RRC-004 — "Old secret stops verifying immediately — no grace window" holds only on a single primary; rotation and revocation degrade silently under lagging reads

`medium` · `correctness` · `core` · [.issues/medium/RRC-004-read-replica-consistency-specialist.md](../../.issues/medium/RRC-004-read-replica-consistency-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence medium) — duplicate of **RRC-001**

Cross-slice duplicate: RRC-001's decision (wayfinder ticket 28) pins session/verification hot-path reads (incl. SessionsRepository.findById used by verify/revoke) to the primary when ReadRouting lands. When implementing RRC-001, also add one sentence to SessionsShape.verify's doc: 'holds because verify-path reads are primary-pinned (ticket 28)'.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:191` — Claim stated unconditionally.
```ts
   * `actingAs` session, which never touches this path at all). The old
   * secret's hash is overwritten in the same atomic write, so it stops
   * verifying immediately — no grace window. A concurrent second `verify`
```
- `packages/core/src/Sessions.ts:747` — Reads go through the one ambient SqlClient; no replica routing exists at HEAD (grep ReadRouting: none), so the defect is latent.
```ts
      const found = yield* repo.findById(id).pipe(
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

#### DRS-004 — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning

`medium` · `architecture` · `core` · [.issues/medium/DRS-004-data-residency-sharding-specialist.md](../../.issues/medium/DRS-004-data-residency-sharding-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence medium)

No sharding/partitioning exists or is on the roadmap (spec/roadmap.md; non-goals exclude hosted multi-region). The tenancy key decision already on record (DRS-001 / wayfinder ticket 18: ambient tenantId column on all core tables) is the partition key if partitioning ever lands; adding a region hint to the token now is speculative infrastructure.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:747` — Accurate: verify is a bare findById; the token carries no routing hint.
```ts
      const found = yield* repo.findById(id).pipe(
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `wontfix`

#### RRC-006 — CAS touch loser returns a session view the presented token can no longer verify

`medium` · `correctness` · `core` · [.issues/medium/RRC-006-read-replica-consistency-specialist.md](../../.issues/medium/RRC-006-read-replica-consistency-specialist.md) · current status `needs-triage`

**Verdict:** INVALID (confidence medium)

The loser does not strand the client: both concurrent requests share one cookie jar, the winner's response carries Set-Cookie with the new token, and the loser's response sets nothing, so the jar ends on the valid credential regardless of arrival order. The recommended fix (loser re-rotates) would CREATE the bug: two rotations race two Set-Cookies and whichever arrives last may be the already-overwritten one. It also contradicts the recorded 'only one winner rotates' decision (upstream-hardening ticket 01). The residual 'winner's response lost in flight' case is RRS-005's grace-window question, already decided against.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:838` — CAS loser returns the winner's row with rotated: none (no Set-Cookie).
```ts
      if (Option.isNone(touched)) {
        const current = yield* repo.findById(id).pipe(
```
- `packages/server/src/Authentication.ts:229` — The loser's response sets no cookie, so the shared browser cookie jar keeps the winner's rotated token.
```ts
  if (Option.isNone(rotated)) {
    return Effect.succeed(response);
  }
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `wontfix`

#### RRC-005 — Newly issued or rotated session tokens can be rejected by the very next request under replica-served reads (false 401)

`medium` · `correctness` · `core` · [.issues/medium/RRC-005-read-replica-consistency-specialist.md](../../.issues/medium/RRC-005-read-replica-consistency-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence medium) — duplicate of **RRC-001**

Latent at HEAD (single primary). RRC-001/ticket 28 classifies the session verify read as primary-pinned, which is exactly this finding's recommended fix. Carry its regression test ('replay new token against an artificially lagged read') into RRC-001's test plan.

**Evidence at HEAD:**

- `packages/core/src/Sessions.ts:849` — Rotated token handed back; next request re-reads via repo.findById on the single primary today.
```ts
      return {
        session: toSessionView(touched.value),
        rotated: Option.some(Redacted.make(`${id}.${newSecret}`)),
      };
```

**Fix plan:** none — see verdict rationale above.

**Recommended status:** `resolved`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| MA-007 | medium | DUPLICATE | dup of JH-006. Identical finding (same source line, same divergence, same two remedies) | `packages/core/src/Auth.ts:225` |
| TTE-006 | medium | WONTFIX-CANDIDATE | The `any` only widens the constraint bound; each plugin's concrete Groups is still inferred and its handlers are type-checked against it (AuthPlugin.layer's handlers parameter), and the recommended contract kit already exists (`TestAuth.runPluginContractTests` | `packages/core/src/AuthPlugin.ts:31` |
| DRS-003 | high | ALREADY-FIXED | commit 58ef46a. Plugin DDL shipped in 58ef46a (admin/organization/passkey, BAM-002), 2ebd195 (jwt), 1331cd5 (roles), 994412d (BE-001 fixture cleanup) | `packages/core/src/Migrations.ts:33` |
| SOS-007 | low | WONTFIX-CANDIDATE | Forward-looking guidance for an SMS plugin that wayfinder ticket 05 §3 explicitly defers | `packages/core/src/RateLimits.ts:57` |
| EEM-008 | low | DUPLICATE | dup of ESS-008-effect-schema-specialist. Tag-collision half = ESS-008 (canonical, higher level) | `packages/core/src/Sessions.ts:142` |
| ERS-007 | info | DUPLICATE | dup of CSG-003. Info-level restatement: lazy-only expiry with no background maintenance fiber | `packages/core/src/Sessions.ts:786` |
| EP-008 | low | DUPLICATE | dup of IC-007. Same fact (fixed, non-configurable __Host- constant); EP-008's per-domain-scope ask is served by IC-007's SecureDomain/config mode, and its 'document the constraint' ask by the BEH-EA-055 rewrite. | `packages/core/src/Sessions.ts:151` |
| RRC-004 | medium | DUPLICATE | dup of RRC-001. Cross-slice duplicate: RRC-001's decision (wayfinder ticket 28) pins session/verification hot-path reads (incl | `packages/core/src/Sessions.ts:191` |
| RRS-005 | medium | WONTFIX-CANDIDATE | Real trade-off, but explicitly decided twice (upstream-hardening ticket 01, wayfinder ticket 11): immediate invalidation, no dual-valid state | `packages/core/src/Sessions.ts:191` |
| AH-007 | low | ALREADY-FIXED | commit 9017a8a. Removed when RRS-003 rewrote the supersede path (git log -S 'input.supersedes as SessionId' -> 9017a8a). | `packages/core/src/Sessions.ts:335` |
| TTE-004 | low | ALREADY-FIXED | commit 9017a8a. The cast is gone | `packages/core/src/Sessions.ts:335` |
| SMS-007 | info | DUPLICATE | dup of PIL-007. Same root cause as PIL-007 (verify decides on row state before doing the secret work); PIL-007's plan hashes before lookup and compares against a dummy digest on miss, closing this timing asymmetry too. | `packages/core/src/Sessions.ts:423` |
| TRBS-006 | medium | DUPLICATE | dup of CSG-003. Same root cause (no expiry-based eviction of session rows in either layer) | `packages/core/src/Sessions.ts:786` |
| VB-001 | medium | ALREADY-FIXED | commit 6629fd2.  | `packages/core/src/Sessions.ts:586` |
| PIL-003 | medium | DUPLICATE | dup of ESS-005-effect-stream-specialist. Three claims: (1) list caps at the 200 oldest rows — still true, canonical ESS-005; (2) no expired-session reaper — still true, covered by CSG-003's retention workstream; (3) jwt verifyLive built on list can reject vali | `packages/core/src/Sessions.ts:641` |
| ECF-007 | low | DUPLICATE | dup of ESR-002. Same root cause; its 'collapse both mutations into one Ref.modify' memory-layer ask is folded into ESR-002's plan | `packages/core/src/Sessions.ts:671` |
| PIL-004 | medium | DUPLICATE | dup of ESR-002. Same root cause (SQL supersede outside a transaction), same file/line; the 'memory layer is atomic' remark is also stale — memory is two Ref steps | `packages/core/src/Sessions.ts:671` |
| SMS-006 | low | DUPLICATE | dup of ESR-002. Same root cause; its 'swapIntoPlace repository op' alternative is subsumed by the transaction wrap in ESR-002's plan | `packages/core/src/Sessions.ts:671` |
| DRS-004 | medium | WONTFIX-CANDIDATE | No sharding/partitioning exists or is on the roadmap (spec/roadmap.md; non-goals exclude hosted multi-region) | `packages/core/src/Sessions.ts:747` |
| ESR-006 | medium | DUPLICATE | dup of CSG-003. Same root cause and same recommended fix (deleteExpiredSessions/deleteConsumedTokensBefore) — exactly CSG-003/ticket 30's repository primitives. | `packages/core/src/Verification.ts:300` |
| RRC-006 | medium | INVALID | The loser does not strand the client: both concurrent requests share one cookie jar, the winner's response carries Set-Cookie with the new token, and the loser's response sets nothing, so the jar ends on the valid credential regardless of arrival order | `packages/core/src/Sessions.ts:838` |
| RRC-005 | medium | DUPLICATE | dup of RRC-001. Latent at HEAD (single primary) | `packages/core/src/Sessions.ts:849` |
| PIL-008 | info | WONTFIX-CANDIDATE | Informational; the auditor's own recommendation is 'acceptable as-is' | `packages/core/src/Sessions.ts:81` |
| TS-004 | medium | DUPLICATE | dup of MA-005. Same root cause (opt-in SlotsRegistry, nothing opts in); SubjectResolver is the concrete slot at stake | `packages/core/src/Slots.ts:39` |
| ELC-002 | medium | DUPLICATE | dup of MA-005. Same root cause; its 'include Slots.layer in TestAuth.MemoryPorts' ask is superseded by Auth.make providing the registry itself. | `packages/core/src/Slots.ts:39` |
| JH-005 | medium | DUPLICATE | dup of MA-005. Slots half is the same root cause | `packages/core/src/Slots.ts:39` |
| SAM-008 | medium | DUPLICATE | dup of AOMS-008. Same root cause (no batch/upsert/transactional import surface) | `packages/migrate-auth0/src/ImportAuth0User.ts:32` |
| MW-007 | medium | WONTFIX-CANDIDATE | The project's chosen adoption path for existing stores is migration with bridges (LegacyPasswordVerifiers + @awthaq/migrate-auth0, LegacySessionBridge + @awthaq/migrate-better-auth), not live read-only legacy user stores | `packages/core/src/Users.ts:87` |
| EEM-006 | medium | DUPLICATE | dup of MA-004. Same root question (what core Shapes do with infrastructure failures) from the opposite direction | `packages/core/src/Users.ts:88` |
| BE-007 | medium | DUPLICATE | dup of SAM-004. Same gap (no user-field extension point); likewise partially overtaken by AOMS-002's opaque metadata. | `packages/core/src/AuthPlugin.ts:126` |
| SCP-004 | medium | DUPLICATE | dup of BAM-009. Email mutability = BAM-009's changeEmail | `packages/core/src/Users.ts:96` |
| ECF-008 | medium | DUPLICATE | dup of CSG-003. Same root cause for the memory layers (sessions, verification tokens, reservations never reaped) | `packages/core/src/Verification.ts:151` |
| MLO-004 | low | DUPLICATE | dup of ACS-002. Same line, same root cause, same fix (shared constant-time helper + documented SQL exception). | `packages/core/src/Verification.ts:202` |
| TSS-005 | low | DUPLICATE | dup of ACS-002. Same line, same root cause, same fix (shared constant-time helper + documented SQL exception). | `packages/core/src/Verification.ts:202` |
| BCR-008 | info | WONTFIX-CANDIDATE | Informational positive finding, no defect | `packages/core/src/Verification.ts:100` |
