# Slice 05-sql: validation and fix plan

- **Slice:** `05-sql` (packages/sql: models, migrations, repositories, dialects, key encryption)
- **Validated at:** `ec065a7` on 2026-09-29
- **Manifest:** `.plan/_manifests/05-sql.tsv` (50 rows, all covered)
- **Id collision:** `SMS-002` names two different issues. HIGH = `SMS-002-secrets-management-specialist` (decrypt `orDie` / key rotation); MEDIUM = `SMS-002-session-management-specialist` (expired sessions in the device list). Cross-references to AH-/ESS-/SMS-/TS- ids use the issue-file stem.

## Counts (verdict × level)

| Verdict | high | medium | low | info | total |
|---|---|---|---|---|---|
| CONFIRMED | 6 | 8 | 10 | 3 | 27 |
| PARTIAL | 1 | 4 | 1 | 0 | 6 |
| ALREADY-FIXED | 0 | 0 | 2 | 0 | 2 |
| INVALID | 0 | 0 | 1 | 0 | 1 |
| DUPLICATE | 0 | 4 | 4 | 3 | 11 |
| WONTFIX-CANDIDATE | 0 | 0 | 2 | 1 | 3 |
| **total** | 7 | 16 | 20 | 7 | 50 |

## Summary

The package is well-structured, and several audit claims have been overtaken by the 100+ commits since the audit. verifyLive now uses a keyed `isLive` (6629fd2), verifyEmail is dialect-branched (b8d6177), a durable audit table with range queries exists (6bd3f1d), and legacy session/password bridges exist (19a3e00, 60947ff). Five problems remain. (1) **Postgres reads do not work at all**: the models decode only SQLite shapes (`BooleanFromBit`, string DateTimes), while the pinned pg driver returns booleans and `Date`s. The pg contract suite has never actually run, because CI is configured but the repo has no remote. This is the top priority (TS-001), and plugin record stores share the defect class. (2) **Token decryption `orDie`s** (four duplicate findings), and because `layerEnv` is single-key, key rotation turns into crashes. Since BE-002, even overwriting a bad token decrypts it first. This needs KRS-002's multi-key provider, a typed per-row failure policy, and targeted token writes. (3) **The session device list** is still the backbone of four point lookups (GET /session, revoke ownership, passkey and qadi freshness). It truncates at 200 rows, lists expired sessions, and lacks an index aligned with its keyset order. (4) **Three decided-but-unimplemented architecture tickets**: identity union and suspension (ticket 09, overlapping ticket 19's `banned`), tenant column plus RLS (ticket 18), and read-replica routing (ticket 28). (5) **Documentation debt**: the README still says 'no line has shipped', and there is no operations guidance on drivers/edge, pool sizing, the encryption boundary, data location, or index rollout. Two findings are refuted or overstated: PPS-006 is invalid (the pinned driver auto-prepares and caches statements), and EOTS-008's 'no span at all' is wrong (every statement gets `sql.execute` with the query text; only named domain spans are missing).

## Workstreams

### 1. `sql-dialect-neutral-models`: Dialect-neutral SQL models (make Postgres reads work)

- **Closes:** TS-001-tim-smart, PPS-007, ESR-009, ESR-007, SSMS-007
- **Effort:** L
- **Depends on:** none
- **Why grouped:** Every Postgres SELECT through the core models fails decode today (BooleanFromBit / string-DateTime vs the pg driver's boolean/Date), so no pg-backed deployment works. The verifyEmail rewrite and pg contract-suite additions can only be verified once pg decode works. ESR-007/SSMS-007 were fixed by b8d6177 and close here.

**Ordered steps**

1. TS-001: add the `makeModels(dialect)` factory and dialect field table in Models.ts; resolve models from `sql.dialect` in every repository layer; move the 12 core `SqlModels.*.makeEffect` call sites to the resolved models; export `dialectFields` for plugins.
2. PPS-007: rewrite verifyEmail as a single UPDATE ... RETURNING that binds the boolean through the dialect field.
3. ESR-009: extract shared contract cases, then add the touch CAS, tombstone/markReused/reauthenticate, encrypted round-trip and AuditLog cases to the pg suite.
4. Add a `pnpm run test:pg` script (docker postgres:16). CI never runs because the repo has no remote.
5. File a cross-slice follow-up to apply `dialectFields` to plugin record stores (admin, jwt, organization, passkey, migrate-better-auth).

**Test plan**

- packages/sql/test/Models.test.ts (new, no-DB): pg-shaped and sqlite-shaped rows decode through the right factory output.
- packages/sql/test/Repositories.postgres.test.ts: every case green under test:pg, including the new ESR-009 cases.

**Acceptance**

- test:pg fully green on Postgres 16.
- SQLite suites unchanged and green.
- No `as` and no annotated Effect/Layer return types in new code.

### 2. `sql-encrypted-token-read-path`: Typed, rotation-safe encrypted token reads

- **Closes:** SMS-002-secrets-management-specialist, ESR-004, KRS-003, TS-005-tim-smart, SMS-007-secrets-management-specialist
- **Effort:** L
- **Depends on:** encryption-key-rotation (ports slice, KRS-002)
- **Why grouped:** Four findings describe the same `Effect.orDie` at Repositories.ts:227. The fix pairs with KRS-002's multi-key KeyProvider (ticket 22). SMS-007 is the spec wording about the same seam.

**Ordered steps**

1. (Ports slice) KRS-002: multi-key `layerEnv` plus a `decrypt` that returns `staleKid`.
2. Add the `AccountTokenUndecryptable` typed error and a strict/degrade decrypt policy per repository method.
3. Add targeted `updateProviderTokens`/`updatePasswordHash` repository writes, and switch core Accounts.ts to them.
4. Lazy re-encrypt on read via a CAS UPDATE, gated by `AccountsRepositoryConfig.reencryptOnRead`.
5. Core `findProviderTokens` returns a `ProviderTokensUnreadable` typed error.
6. Write ADR 017 (encryption-at-rest key rotation), and amend BEH-EA-034 and the glossary (SMS-007).

**Test plan**

- Tampered ciphertext causes a typed failure on findById and a degraded row on listByUser/findByProviderSubject.
- Retired-kid rows decrypt and are re-encrypted on read.
- updateProviderTokens heals an undecryptable row.

**Acceptance**

- No decrypt-path orDie remains in packages/sql.
- A key rotation that keeps the old kid in the keyset loses no data and crashes nothing.

### 3. `session-list-liveness-and-pagination`: Session device list: live-only, exhaustive, index-aligned, bounded

- **Closes:** TIR-003, SMS-002-session-management-specialist, PPS-002, SEA-006, SSMS-008, ESR-010
- **Effort:** M
- **Depends on:** retention (CSG-003, cross-slice; reaper only)
- **Why grouped:** All six touch the same `SessionsRepository.listByUser` query and its consumers: point lookups routed through a truncated page, expired rows listed, a missing composite index, and an unbounded limit.

**Ordered steps**

1. ESR-010: clamp the limit and add a schema bound (MAX_PAGE_SIZE = 200).
2. SMS-002(session): add the `now` parameter and expiry predicate in the repository and memory list.
3. PPS-002: add the partial composite index `sessions_user_created_live` (IF NOT EXISTS) and the row-value cursor.
4. TIR-003: add `Sessions.findOwned`; switch server Session.ts current/revoke, the passkey freshness check and the qadi reauth check to it; make `list` exhaustive by looping pages.

**Test plan**

- core Sessions: 201-session user (findOwned, exhaustive list), plus expired sessions hidden in both layers.
- sql: EXPLAIN QUERY PLAN uses the new index with no temp B-tree, and limit clamping works.
- server: GET /session works above 200 sessions.

**Acceptance**

- The device list equals the set of verifiable sessions.
- There is no silent truncation and no sort node.

### 4. `verification-store-hygiene`: Verification store: live-row lookup and payload parity

- **Closes:** PPS-003, SSMS-003, ESR-005, ESS-010-effect-schema-specialist
- **Effort:** S
- **Depends on:** none
- **Why grouped:** These are small, independent correctness and performance fixes in the verification repository and service. History growth is delegated to CSG-003's retention sweep.

**Ordered steps**

1. PPS-003: scope `findByIdentifier` to `consumedAt IS NULL` (served by the partial unique index) and update the two tests.
2. ESS-010: layerMemory normalizes a null payload to undefined, with a shared two-layer test.

**Test plan**

- findByIdentifier returns None after consume, and its plan uses the partial index.
- An explicit null payload round-trips as undefined on both layers.

**Acceptance**

- No unbounded verification scan is reachable.
- The layers agree on payload.

### 5. `sql-repository-hygiene`: Repository hygiene: email fold, brand unification, named spans

- **Closes:** ESR-003, MA-008, ESS-011-effect-schema-specialist, EOTS-008, PPS-008
- **Effort:** S
- **Depends on:** none
- **Why grouped:** These are independent small fixes to Repositories.ts/Models.ts that don't depend on the model factory. PPS-008 is closed wontfix.

**Ordered steps**

1. ESR-003: bind `email.toLowerCase()` in findByEmail (repository and core layerSql).
2. MA-008: core id types alias @awthaq/sql's branded types, with an expectTypeOf test.
3. EOTS-008: add named `<Prefix>.<method>` spans on every hand-written method, with no PII attributes.

**Test plan**

- Non-ASCII mixed-case email lookup on SQLite.
- Brand type-equality test.
- A span-capture test for Users.findByEmail, Sessions.touch and VerificationTokens.tryConsume.

**Acceptance**

- Dialect-independent email lookup.
- Single-source id types.
- Every repository method is traced by name.

### 6. `user-identity-lifecycle`: User identity union and suspension state

- **Closes:** SAM-003, SCP-001
- **Effort:** XL
- **Depends on:** sql-dialect-neutral-models, admin banned gate (BAM-005, admin slice; co-design)
- **Why grouped:** Both come from ticket 09 and change the same User model, migration file and sign-in gate. Ticket 19 (BAM-005) adds an overlapping `banned` gate on the same record, so co-design one gate and one migration.

**Ordered steps**

1. SCP-001 first (M): the status column, `Users.setStatus`, `Users.assertCanSignIn` at every `Sessions.issue` caller, and co-landing BAM-005's ban columns if scheduled together.
2. SAM-003 (L): the UserIdentity union, nullable email (SQLite table rebuild), phone/phoneVerified plus a unique partial index, `promoteIdentity`, the call-site sweep, and retiring OAuth's synthetic email.
3. Spec: BEH-EA-041/042 revision plus a new suspension BEH, with feature scenarios.

**Test plan**

- Suspended users cannot sign in via any method.
- Anonymous/Phone creation, uniqueness and promotion.
- The SQLite rebuild migration preserves rows and the email index.

**Acceptance**

- Deactivation never deletes.
- Identity-less and phone-only users are representable.
- One sign-in gate.

### 7. `tenancy-residency`: Tenant attribution column, RLS backstop, residency docs

- **Closes:** DRS-001, SSMS-009, CSG-009, SAM-006, DRS-005
- **Effort:** XL
- **Depends on:** organization TenantResolver/middleware (organization slice)
- **Why grouped:** Ticket 18 decided the tenant column plus RLS. CSG-009 and SAM-006 are the documentation halves, and DRS-005 needs the identity-uniqueness scope decided on top of it.

**Ordered steps**

1. DRS-001: TenantContext, the tenantId column plus index on 6 tables, repository-level stamping, opt-in pg RLS migrations with FORCE, TenantScope.withTenant, and the ADR.
2. DRS-005: record the identity uniqueness scope (recommended: global directory) in the ADR, and add (tenantId, userId) indexes on sessions/verification.
3. CSG-009 and SAM-006: README/overview sections on data location, the Supabase RLS cutover protocol and least-privilege roles.

**Test plan**

- Inserts stamp tenantId or NULL.
- pg RLS cross-tenant read denied inside withTenant.
- Single-tenant suites unchanged.

**Acceptance**

- Zero-cost default.
- Opt-in DB-enforced isolation on Postgres.
- Documented residency model.

### 8. `read-replica-routing`: Opt-in read-replica routing with causal tokens

- **Closes:** RRC-001, RRC-008, RRC-007
- **Effort:** XL
- **Depends on:** session-list-liveness-and-pagination
- **Why grouped:** Ticket 28's decision plus its test harness. It depends on TIR-003 moving the security-relevant point lookups off the replica-eligible device list. RRC-007 is closed as a positive observation codified in the ADR.

**Ordered steps**

1. Add ReadRouting.ts (ReplicaSqlClient, CausalToken, captureToken, forRead).
2. Resolve both clients at repository construction, and route only the replica-eligible listings (session device list, audit list).
3. Write the ADR and the BEH-EA-035 addendum, including the RETURNING discipline.
4. RRC-008: add the LaggingReplica test double and the four causal-handoff contract tests.

**Test plan**

- Default equals primary-only.
- Replica used only for listings.
- The causal token forces the primary.
- Lag-injection handoff tests.

**Acceptance**

- No behavior change by default.
- Session, verification and credential reads are never replica-served.

### 9. `retention-sweeps`: Retention for audit data (extends CSG-003's Retention)

- **Closes:** ALF-010
- **Effort:** M
- **Depends on:** retention (CSG-003, cross-slice)
- **Why grouped:** Ticket 30's Retention service covers sessions and verification history. Audit-log and impersonation retention extend the same config service. SMS-002(session)'s reaper and PPS-003's history growth also land through CSG-003.

**Ordered steps**

1. Add `AuditLogRepository.deleteOccurredBefore` and the `auth_audit_log_occurred_at` index.
2. Add `RetentionConfig.auditLog` (default retain-forever) with per-eventTag windows.
3. Add the admin impersonation purge contribution (admin slice).

**Test plan**

- Tag-scoped audit purge.
- The default purges nothing.

**Acceptance**

- Operators can bound audit retention per event class, and forensics-safe defaults apply.

### 10. `two-factor-recovery-codes`: Recovery-code set primitives (in the two-factor plugin build)

- **Closes:** BCR-002, BCR-009
- **Effort:** M
- **Depends on:** two-factor plugin build (ticket 05: AOMS-003/THS-001/ARF-005)
- **Why grouped:** Ticket 05 moved recovery codes into their own `two_factor_recovery_code` table, so the bulk-invalidate and count needs belong there, not in Verification. BCR-009's TTL problem disappears with that design.

**Ordered steps**

1. Give the two-factor plugin's recovery-code repository `replaceAll` (in one caller transaction), `countUnused` and a CAS `consume`.
2. Expose regeneration and remaining-count on the TwoFactor service.

**Test plan**

- Atomic regeneration.
- countUnused decrements.

**Acceptance**

- No Verification-stack additions.
- Regeneration is one transaction.

### 11. `sql-docs-operations`: Persistence-stratum README and operations docs

- **Closes:** ESR-008, ERAS-006, NAM-011, PPS-009, PPS-004, SSMS-006, NAM-007, CSG-006, PPS-006
- **Effort:** M
- **Depends on:** none
- **Why grouped:** These findings are documentation gaps about the same package, so the rewritten packages/sql/README.md is their single home. The libsql contract run (ERAS-006), the IF NOT EXISTS convention test (SSMS-006) and optional PII encryption (CSG-006, pending a decision) are the only code. PPS-006 is closed as invalid (the driver auto-prepares).

**Ordered steps**

1. ESR-008: rewrite the README skeleton, fix the index.ts header, and regenerate or delete .quality-metrics/sql.json.
2. ERAS-006: add the runtimes and drivers matrix plus a libsql contract test.
3. PPS-004: Postgres pool/pgbouncer/statement_timeout recipe, and update spec/overview.md:132.
4. PPS-009: record the JSON-as-TEXT decision in ADR-EA-004.
5. SSMS-006: the IF NOT EXISTS convention and the CONCURRENTLY runbook, with a test.
6. NAM-007: docs/migrations/authjs.md using LegacySessionBridge and LegacyPasswordVerifiers.
7. CSG-006: the encryption-boundary section, plus opt-in PII column encryption if option B is chosen.

**Test plan**

- Repositories.libsql.test.ts.
- The out-of-band pre-created index doesn't break the migration.
- (B) PII column ciphertext on disk.

**Acceptance**

- The README describes shipped behavior, and every docs finding links to a section.

### 12. `sql-contract-test-coverage`: SQLite contract coverage: file-backed WAL and timestamp invariants

- **Closes:** SEA-004, SEA-005
- **Effort:** S
- **Depends on:** sql-dialect-neutral-models (ESR-009's shared contract cases)
- **Why grouped:** Both are SQLite-specific test gaps in packages/sql/test and reuse ESR-009's extracted contract cases.

**Ordered steps**

1. Run the shared contract cases on a temp-file WAL database, with two-connection touch/claim races.
2. Add raw timestamp-format assertions for every write path and an epoch-order keyset test, and add a single encodeUtc helper.

**Test plan**

- Covered in the per-issue plans.

**Acceptance**

- Cross-connection atomicity and encoding invariants are pinned.

### 13. `migration-wiring`: Composed migration runner (tracked under BE-003, cli slice)

- **Closes:** SSMS-005
- **Effort:** M
- **Depends on:** cli migration tooling (BE-003, cli slice)
- **Why grouped:** This is a duplicate of cross-slice BE-003 (ticket 07). It is kept as a named workstream only to carry the tracking-table id-collision warning to BE-003's implementer.

**Ordered steps**

1. BE-003: implement a reusable `Migrations.runAll(core, plugins)` in @awthaq/core that the CLI's `migration apply` calls, using a stable, non-colliding id space (see SSMS-005's evidence).

**Test plan**

- "running core then plugin migrations applies every plugin migration" (fails today if run separately against the same tracking table).

**Acceptance**

- One command/Effect migrates a fresh database completely.

**Migration-id coordination:** CoreMigrations ends at id 17 at HEAD. Several workstreams append migrations: PPS-002, ALF-010, DRS-001 (plus its RLS set), SAM-003 (three) and SCP-001. Allocate ids in merge order, and use `IF NOT EXISTS` for every index (SSMS-006's convention).

## Decisions needed

### CSG-006: Core PII columns are plaintext at rest with no documented encryption boundary

- A — Documentation only: state the boundary and make full-disk/DB encryption a deployer requirement.
- B — A plus opt-in app-level encryption of non-lookup PII columns (sessions.ipAddress/userAgent, users.metadata) via the existing Encryption port, off by default.
- C — B plus deterministic/blind-index encryption of users.email, preserving lookups via an HMAC index column.

**Recommendation:** B. It is the richer, configurable option and costs little: the Encryption port, AAD scheme and (after SMS-002) the undecryptable-degrade policy already exist in AccountsRepositoryLive. Defer C, since it changes the email-uniqueness semantics that ESR-003 and DRS-005 are settling and has no current customer.

### DRS-005: Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding

- A — Global identity directory: email and (providerId, subject, issuer) stay globally unique. Users/accounts are the unsharded directory tier, and tenant partitioning applies to sessions/verification/audit only.
- B — Tenant-scoped identity: unique indexes are prefixed with COALESCE(tenantId, ''), so the same email is a different user per tenant. Login lookups require TenantContext.
- C — Both, selectable per deployment via alternative migration sets.

**Recommendation:** A. Ticket 18 fixed tenant = Organization row, and the organization plugin's membership model already lets one global user belong to many orgs. Tenant-scoped identity (B) would contradict that by forcing duplicate user rows per org, and C doubles the migration surface for a scenario with no customer yet. Revisit B as an opt-in only when a residency customer needs per-tenant identity isolation.

No other issue in this slice has an open decision. SAM-003/SCP-001 (ticket 09), DRS-001 (ticket 18), RRC-001 (ticket 28), TS-001 (ticket 29) and SMS-002-secrets/KRS-002 (ticket 22) follow the recorded wayfinder decisions, and BCR-002/BCR-009 follow ticket 05's recovery-code table decision. One coordination point is not a new decision: SCP-001's `status` and ticket 19's `banned` (BAM-005, admin slice) should share one sign-in gate and one migration.

## Per-issue dossiers

### Workstream `sql-dialect-neutral-models`

#### TS-001-tim-smart: Postgres row decode cannot succeed: BooleanFromBit and string-DateTime model variants contradict the pinned pg driver's binary codecs

`high` · `correctness` · `sql` · [.issues/high/TS-001-tim-smart.md](../../.issues/high/TS-001-tim-smart.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Models.ts:47`: Unchanged since the audit: the DB variants accept only 0|1.

  ```
    emailVerified: Model.Field({
      select: Schema.BooleanFromBit,
      insert: Schema.BooleanFromBit.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
      json: Schema.Boolean,
      jsonCreate: Schema.Boolean,
    }),
  ```

- `node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/src/Schema.ts:9910`: Installed rc.116: a JS boolean from the pg driver fails this decode.

  ```
  export const BooleanFromBit: BooleanFromBit = Literals([0, 1]).pipe(
    decodeTo(
      Boolean,
  ```

- `node_modules/.pnpm/@effect+sql-pg@4.0.0-rc.116_effect@4.0.0-rc.116/node_modules/@effect/sql-pg/src/PgTypes.ts:1169`: Pinned @effect/sql-pg decodes OID 16 (bool) to a JS boolean; timestamptz decodes to a Date (PgTypes.ts:1056 `new Date(...)`).

  ```
          return bytes[offset] !== 0
  ```

- `node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/src/unstable/schema/Model.ts:505`: String-only select decode; every createdAt/updatedAt uses it.

  ```
  export const DateTimeInsert: DateTimeInsert = Field({
    select: Schema.DateTimeUtcFromString,
    insert: DateTimeWithNow,
    json: Schema.DateTimeUtcFromString
  })
  ```

- `packages/sql/src/Models.ts:114`: BE-002 (e773cf1) added two more string-DateTime columns since the audit, so the affected surface has grown. TS-002's resolution note (b8d6177) confirms the pg suite still fails end-to-end on this bug.

  ```
    accessTokenExpiresAt: Schema.NullOr(Schema.DateTimeUtcFromString).pipe(
      Schema.withConstructorDefault(Effect.succeed(null)),
    ),
  ```

**Fix plan** (effort L): Follow ticket 29's decision: `Models.ts` becomes a `makeModels(dialect)` factory that selects Effect's own per-dialect Model field variants for the dialect-sensitive columns (boolean and DateTime). `Repositories.ts` resolves `sql.dialect` once at layer construction. The pg client's codecs are never overridden globally.

Steps:

1. In `packages/sql/src/Models.ts`, add an internal field table keyed by dialect. pg uses a `Model.Field` over `Schema.Boolean` (select/insert with constructor default, json/jsonCreate `Schema.Boolean`), `Model.DateTimeInsertFromDate`, `Model.DateTimeUpdateFromDate`, and `Schema.DateTimeUtcFromDate` / `Schema.NullOr(Schema.DateTimeUtcFromDate)` for plain timestamps. sqlite keeps today's `Schema.BooleanFromBit`, `Model.DateTimeInsert`, `Model.DateTimeUpdate`, and `Schema.DateTimeUtcFromString`. The json/jsonCreate/jsonUpdate variants stay byte-identical across the two branches. Build the table without `as const` or any other assertion, as two plain functions, one per dialect.
2. Export `makeModels(dialect: "pg" | "sqlite")`, which returns `{ User, Account, Session, VerificationToken, VerificationReservation, AuditLogRow }`. Route every dialect-sensitive column through the table: User.emailVerified/createdAt/updatedAt; Account.accessTokenExpiresAt/refreshTokenExpiresAt/createdAt/updatedAt; Session.absoluteExpiresAt/idleExpiresAt/createdAt/authenticatedAt/lastActiveAt/supersededAt/reusedAt; VerificationToken.expiresAt/consumedAt/createdAt; VerificationReservation.expiresAt. Also move `AuditLogRowSchema.occurredAt` (Repositories.ts:816-823) into the factory. Keep ids, strings, `Model.Sensitive` and payload fields declared once and shared.
3. Export dialect-independent *type* aliases for the shape interfaces (e.g. `export type User = InstanceType<ReturnType<typeof makeModels>["User"]>` and the insert/update variant Types). The decoded `Type` side is identical across dialects; only `Encoded` differs. Keep the aliases type-level and never cast.
4. In `packages/sql/src/Repositories.ts`, in each `Layer.effect`, resolve `const models = yield* resolveModels(sql)` right after `const sql = yield* SqlClient.SqlClient`. `resolveModels` uses `sql.onDialectOrElse({ pg: () => Effect.succeed(makeModels("pg")), sqlite: () => Effect.succeed(makeModels("sqlite")), orElse: () => Effect.die(...) })`, mirroring CoreMigrations' `orElse`. Pass `models.X` to `SqlModel.makeRepository` and the `SqlSchema` Result schemas. Expose `models` on each repository shape (or a small `SqlModels` Context.Service) so callers that construct variant inputs use the right class.
5. Update the 12 `SqlModels.<Model>.insert|update.makeEffect` call sites in `packages/core/src/{Users,Accounts,Sessions}.ts` to take the model from the repository/service instead of the static import.
6. Request schemas that encode DateTime parameters (`SessionCursorRequest`, touch/tombstone/reauthenticate/upsertLive/tryConsume/claim/AuditLog) should use the same per-dialect field, so pg binds a `Date` (timestamptz) rather than relying on text-parameter inference. b8d6177's real-pg run showed string binds for `updatedAt` do work, so treat this as consistency, not correctness, and let the pg test outcome decide.
7. Export the field table as `Models.dialectFields(dialect)` so plugin record stores with the same defect class can reuse it: admin ImpersonationRecords, jwt RevocationStore/SigningKeyRecords, organization *Records, passkey PasskeyCredentials/ChallengeStore, migrate-better-auth LegacySessionBridgeLive. File that plugin sweep as a cross-slice follow-up.
8. Update the `Models.ts` header comment: one declaration per field, except the per-dialect wire codec of the boolean/DateTime columns.
9. Add a local `pnpm run test:pg` script (docker `postgres:16` plus `AWTHAQ_POSTGRES_URL`) and document it. `.github/workflows/check.yml` configures a Postgres service, but this repo has no git remote (AGENTS.md), so that suite has never actually run.

Files: `packages/sql/src/Models.ts`, `packages/sql/src/Repositories.ts`, `packages/core/src/Users.ts`, `packages/core/src/Accounts.ts`, `packages/core/src/Sessions.ts`, `packages/sql/test/Models.test.ts (new)`, `packages/sql/test/Repositories.postgres.test.ts`, `package.json (test:pg script)`

Tests (write first):

- New failing unit test first, runnable without Postgres, in packages/sql/test/Models.test.ts: "makeModels('pg').User decodes a driver-shaped row { emailVerified: true, createdAt: Date, updatedAt: Date }" and "makeModels('sqlite').User decodes { emailVerified: 1, createdAt: ISO string }". Also assert both json variants encode identically.
- Existing packages/sql/test/Repositories.postgres.test.ts "migrates and round-trips a User through the real repository" and "Users.verifyEmail sets emailVerified/updatedAt via the quoted columns" fail today (per TS-002's resolution note) and must go green under `pnpm run test:pg`.
- The whole SQLite suite (packages/sql, core, organization, passkey, jwt, admin) stays green.

Acceptance:

- A real Postgres 16 run of Repositories.postgres.test.ts passes every case.
- `BooleanFromBit` appears in Models.ts only in the sqlite branch of the field table.
- No `as`/`as const` assertions were introduced, and no return-type annotations on new Effect/Layer consts.
- `pnpm check` is green.

Spec refs: BEH-EA-033, BEH-EA-034, ADR-EA-004

Depends on: none

**Recommended status:** `ready-for-agent`

#### ESR-007: verifyEmail hardcodes the bit literal 1 instead of the model's BooleanFromBit encoding

`low` · `correctness` · `sql` · [.issues/low/ESR-007-effect-sql-repository-specialist.md](../../.issues/low/ESR-007-effect-sql-repository-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence: high) (fixed by `b8d6177`)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:103`: b8d6177 (TS-002) replaced the unconditional literal with a dialect branch. The audit's premise that Postgres accepts `= 1` was wrong: TS-002 reproduced error 42804. Binding a BooleanFromBit value, as recommended, would also fail on pg (TS-001). PPS-007's plan binds through TS-001's dialect field, which removes the remaining second convention.

  ```
          yield* sql.onDialectOrElse({
            pg: () =>
              sql`UPDATE users SET "emailVerified" = TRUE, "updatedAt" = ${encodedNow} WHERE id = ${id}`,
            sqlite: () =>
              sql`UPDATE users SET "emailVerified" = 1, "updatedAt" = ${encodedNow} WHERE id = ${id}`,
  ```

**No fix:** No work needed; see the fixing commit and evidence.

**Recommended status:** `resolved`

#### ESR-009: Postgres contract suite omits the touch CAS and encryption round-trip behaviors

`low` · `testing` · `sql` · [.issues/low/ESR-009-effect-sql-repository-specialist.md](../../.issues/low/ESR-009-effect-sql-repository-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/test/Repositories.postgres.test.ts:169`: The pg suite has 8 cases. `grep -n touch` in the file finds nothing, and Encryption is wired only as a layer dependency (lines 30-48), never round-trip asserted.

  ```
    it.effect(
      "Sessions.listByUser/deleteAllForUserExcept/deleteAllByUser all resolve the quoted userId/createdAt columns",
  ```

- `packages/sql/test/Repositories.test.ts:427`: SQLite-only coverage of the touch CAS. The encryption round trip is at line 125, also SQLite-only.

  ```
      "upstream-hardening ticket 01: touch's compare-and-swap lets only the first of two racing callers rotate",
  ```

**Fix plan** (effort S): Mirror the security-relevant SQLite cases into the Postgres suite once TS-001 makes pg row decode possible.

Steps:

1. Add these pg cases to packages/sql/test/Repositories.postgres.test.ts: the touch CAS race (copy the Repositories.test.ts:427 body); tombstone/markReused/revokeFamily/reauthenticate RETURNING decode; the AccountsRepository encrypted round trip, asserting the raw `SELECT "accessToken" FROM accounts` is not the plaintext (copy :125); and AuditLogRepository insert/list with an occurredAfter/occurredBefore range.
2. Better still, extract shared case bodies into a `contractCases(SqlLive)` helper used by both suites, so future cases land on both dialects automatically. This also serves SEA-004's file-backed pass.

Files: `packages/sql/test/Repositories.postgres.test.ts`, `packages/sql/test/Repositories.test.ts`, `packages/sql/test/contract.ts (new, optional)`

Tests (write first):

- Postgres: "touch's compare-and-swap lets only the first of two racing callers rotate"
- Postgres: "accessToken/refreshToken round-trip encrypted; raw column bytes are not the plaintext"
- Postgres: "tombstone/markReused/reauthenticate decode their RETURNING rows"
- Postgres: "AuditLog.list filters by occurredAt range"

Acceptance:

- `pnpm run test:pg` runs the new cases green.
- The SQLite and pg suites share their case bodies.

Spec refs: BEH-EA-035, BEH-EA-052

Depends on: TS-001-tim-smart

**Recommended status:** `ready-for-agent`

#### PPS-007: verifyEmail pays an extra round trip: UPDATE followed by a separate findById instead of RETURNING

`low` · `performance` · `sql` · [.issues/low/PPS-007-postgres-performance-specialist.md](../../.issues/low/PPS-007-postgres-performance-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:103`: TS-002 (b8d6177) changed the literal but kept the UPDATE-then-findById double round trip.

  ```
          yield* sql.onDialectOrElse({
            pg: () =>
              sql`UPDATE users SET "emailVerified" = TRUE, "updatedAt" = ${encodedNow} WHERE id = ${id}`,
            sqlite: () =>
              sql`UPDATE users SET "emailVerified" = 1, "updatedAt" = ${encodedNow} WHERE id = ${id}`,
            orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for verifyEmail")),
          });
          return yield* repo.findById(id);
  ```

**Fix plan** (effort S): Collapse verifyEmail into one `UPDATE ... RETURNING *` decoded through the dialect model. Bind the boolean through the model's own encoding so the per-dialect literal branch disappears.

Steps:

1. In `UsersRepositoryLive`, replace the `onDialectOrElse` block and `repo.findById` with a `SqlSchema.findOne({ Request: Schema.Struct({ id: UserId, updatedAt: <dialect DateTime field> }), Result: models.User, execute: (r) => sql`UPDATE users SET "emailVerified" = ${verifiedTrue}, "updatedAt" = ${r.updatedAt} WHERE id = ${r.id} RETURNING *` })`. `verifiedTrue` is `true` encoded through the dialect boolean field from TS-001's table: pg binds `true`, sqlite binds `1`.
2. Zero rows back fails with `Cause.NoSuchElementError`, keeping the shape's existing error channel.

Files: `packages/sql/src/Repositories.ts`, `packages/sql/test/Repositories.test.ts`, `packages/sql/test/Repositories.postgres.test.ts`

Tests (write first):

- packages/sql/test/Repositories.test.ts: "verifyEmail on an unknown id fails NoSuchElementError" and "verifyEmail returns the updated row from the same statement" (use a statement-counting SqlClient wrapper, or a span count once EOTS-008 lands).
- The existing pg case "Users.verifyEmail sets emailVerified/updatedAt via the quoted columns" stays green.

Acceptance:

- verifyEmail issues exactly one statement.
- The `onDialectOrElse` literal branch is removed from verifyEmail.

Spec refs: BEH-EA-042

Depends on: TS-001-tim-smart

**Recommended status:** `ready-for-agent`

#### SSMS-007: Boolean write path uses literal 1 and leans on driver reconciliation for Postgres

`low` · `correctness` · `sql` · [.issues/low/SSMS-007-sql-schema-migration-specialist.md](../../.issues/low/SSMS-007-sql-schema-migration-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence: high) (fixed by `b8d6177`)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:105`: The pg branch now writes TRUE, which was this finding's own first recommended option (commit b8d6177, TS-002). Its secondary 'pg read decode leans on the driver' point is TS-001.

  ```
              sql`UPDATE users SET "emailVerified" = TRUE, "updatedAt" = ${encodedNow} WHERE id = ${id}`,
  ```

**No fix:** No work needed; see the fixing commit and evidence.

**Recommended status:** `resolved`

### Workstream `sql-encrypted-token-read-path`

#### SMS-002-secrets-management-specialist: Key rotation is a data-losing dead end: single-key env provider plus Effect.orDie on decrypt

`high` · `correctness` · `sql` · [.issues/high/SMS-002-secrets-management-specialist.md](../../.issues/high/SMS-002-secrets-management-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high) (canonical for ESR-004, KRS-003, TS-005-tim-smart)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:223`: Still `Effect.orDie` at HEAD (the line moved from :199 to :227).

  ```
        value === null
          ? Effect.succeed(null)
          : encryption
              .decrypt(value, tokenAad(providerId, userId, field))
              .pipe(Effect.map(Redacted.value), Effect.orDie);
  ```

- `packages/ports/src/KeyProvider.ts:96`: Still single-key. Multi-key is KRS-002 (ticket 22), which is unimplemented: `grep AWTHAQ_ENCRYPTION_KEYS packages` finds nothing.

  ```
      const material: KeyMaterial = { kid, key: Redacted.make(decoded.success) };
      const getKey: KeyProviderShape["getKey"] = (requestedKid) =>
        requestedKid === kid
          ? Effect.succeed(material)
          : Effect.fail(new UnknownKeyId({ kid: requestedKid }));
  ```

- `packages/oauth/src/OAuth.ts:659`: The typed-mapping precedent the SQL path lacks.

  ```
              DecryptionFailed: () => new OAuthApi.OAuthCallbackFailed(),
              UnknownKeyId: () => new OAuthApi.OAuthCallbackFailed(),
  ```

- `packages/core/src/Accounts.ts:645`: New since the audit (BE-002): even *overwriting* an undecryptable token first decrypts it, so a rotation-affected row can never self-heal.

  ```
      const updateProviderTokens: AccountsShape["updateProviderTokens"] = Effect.fnUntraced(
        function* (id, tokens) {
          const performUpdate = Effect.gen(function* () {
            const existing = yield* repo.findById(id).pipe(
  ```

**Fix plan** (effort L): Replace `Effect.orDie` on decrypt with a typed, per-row failure policy. Point token reads surface a typed error; identity/list reads degrade the unreadable column to null and log. Token-only writes stop decrypting the old value. Add lazy re-encryption once KRS-002's multi-key provider and `staleKid` result land (ticket 22).

Steps:

1. Prerequisite (ports slice, KRS-002/ticket 22): `KeyProvider.layerEnv` reads the `AWTHAQ_ENCRYPTION_KEYS` keyset plus the current `AWTHAQ_ENCRYPTION_KEY_ID`, and `EncryptionShape.decrypt` returns `{ plaintext, staleKid: Option<string> }`.
2. In Repositories.ts, add an `AccountTokenUndecryptable` tagged error (`accountId`, `field: "accessToken" | "refreshToken"`, `reason: "DecryptionFailed" | "UnknownKeyId"`), using the same tagged-error style as the rest of the package, and add it to `AccountsRepositoryShape.findById`'s error channel.
3. Rewrite `decryptToken` to `Effect.catchTags({ DecryptionFailed, UnknownKeyId })` into that error, with no `orDie`. Give `decryptRow` a policy argument. `"strict"` (findById) propagates the typed error. `"degrade"` (findByProviderSubject, listByUser, and the insert/update echo) maps an undecryptable column to `null` and emits `Effect.logWarning` annotated with accountId/field/kid, never ciphertext. OAuth sign-in and unlink's last-account check (core Accounts.ts:556) then keep working for a row with a bad token.
4. Add targeted repository writes that never read token plaintext. `updateProviderTokens(id, aad, tokenColumns)` runs `UPDATE accounts SET "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, "tokenType", "updatedAt" ... WHERE id RETURNING *`. `updatePasswordHash(id, hash)` runs `UPDATE accounts SET "passwordHash", "updatedAt" ... RETURNING *`. Switch core Accounts.ts `updateProviderTokens` (645-667) and `updateCredentialHash` (600-625) to them, so neither pass-through-decrypts the other columns and a stale row heals on the next OAuth sign-in. This mirrors the `Sessions.reauthenticate` targeted-UPDATE precedent.
5. Lazy re-encrypt, after KRS-002: when decrypt reports `staleKid: Some`, re-encrypt under `currentKey` and CAS-write the column (`UPDATE accounts SET "accessToken" = ${fresh} WHERE id = ${id} AND "accessToken" = ${old}`). A single statement needs no transaction, so this respects BEH-EA-035. Gate it on an `AccountsRepositoryConfig` Context.Reference with `reencryptOnRead` defaulting to true.
6. In core Accounts.ts, map `AccountTokenUndecryptable` in `findProviderTokens` (631-641) to a new typed `ProviderTokensUnreadable` on `AccountsShape.findProviderTokens`, so @awthaq/oauth's scoped refresh port (BE-002) can treat it as "re-consent required" instead of dying.
7. Register ADR `spec/decisions/017-encryption-at-rest-key-rotation.md` (plus spec/decisions/index.yaml), as ticket 22 requires.

Files: `packages/sql/src/Repositories.ts`, `packages/core/src/Accounts.ts`, `packages/oauth/src/OAuth.ts (refresh-port consumer)`, `packages/ports/src/KeyProvider.ts + Encryption.ts (via KRS-002)`, `spec/decisions/017-encryption-at-rest-key-rotation.md`, `spec/decisions/index.yaml`, `packages/sql/test/Repositories.test.ts`, `packages/core/test/Accounts.test.ts`

Tests (write first):

- First failing test, packages/sql/test/Repositories.test.ts: "a tampered accessToken ciphertext fails findById with AccountTokenUndecryptable, not a defect". Tamper via a raw `UPDATE accounts SET "accessToken" = ...`.
- "listByUser returns every row when one row's token is undecryptable, nulling only that column"
- "findByProviderSubject still resolves the identity row when its token ciphertext is unreadable"
- "updateProviderTokens overwrites an undecryptable token without reading it"
- After KRS-002: "a row written under a retired kid still decrypts while that kid stays in the keyset" and "findById rewrites a stale-kid ciphertext under the current key"
- packages/core/test/Accounts.test.ts: "findProviderTokens fails ProviderTokensUnreadable for an undecryptable row"

Acceptance:

- No decrypt-path `orDie` remains in packages/sql/src/Repositories.ts.
- A key rotation that retains the old kid leaves every account readable, and rows migrate to the current kid on read.
- One bad row never kills listByUser or OAuth sign-in.

Spec refs: BEH-EA-034, BEH-EA-043, ADR (new): encryption-at-rest key rotation

Depends on: KRS-002

**Recommended status:** `ready-for-agent`

#### ESR-004: Decrypt failures are collapsed to fiber defects, so one unreadable row poisons whole result-set operations

`medium` · `api` · `sql` · [.issues/medium/ESR-004-effect-sql-repository-specialist.md](../../.issues/medium/ESR-004-effect-sql-repository-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **SMS-002-secrets-management-specialist**)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:225`: Same `Effect.orDie` at Repositories.ts:227. The list-path skip-and-log policy it asks for is folded into SMS-002's `degrade` policy.

  ```
          : encryption
              .decrypt(value, tokenAad(providerId, userId, field))
              .pipe(Effect.map(Redacted.value), Effect.orDie);
  ```

**No fix:** Closed into SMS-002-secrets-management-specialist; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

#### KRS-003: Reads of old-key ciphertext rows die as defects instead of a typed error

`medium` · `correctness` · `sql` · [.issues/medium/KRS-003-key-rotation-specialist.md](../../.issues/medium/KRS-003-key-rotation-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **SMS-002-secrets-management-specialist**)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:225`: Same `Effect.orDie`. Its lazy re-encrypt-on-read ask is SMS-002's step 5 (after KRS-002).

  ```
          : encryption
              .decrypt(value, tokenAad(providerId, userId, field))
              .pipe(Effect.map(Redacted.value), Effect.orDie);
  ```

**No fix:** Closed into SMS-002-secrets-management-specialist; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

#### SMS-007-secrets-management-specialist: Spec's model-level Redacted typing for provider tokens is not what shipped

`low` · `docs` · `sql` · [.issues/low/SMS-007-secrets-management-specialist.md](../../.issues/low/SMS-007-secrets-management-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `spec/behaviors/05-persistence-stratum.md:45`: The spec illustration still shows Redacted.

  ```
  class Account extends Model.Class<Account>("Account")({
    id: Model.UuidV7Insert,
    passwordHash: Model.Sensitive(Schema.String),
    accessToken: Model.Sensitive(Schema.Redacted(Schema.String))
  }) {}
  ```

- `packages/sql/src/Models.ts:103`: Shipped: plain strings. Models.ts:77-86 explains why (a Redacted encoded form is not a bindable SQL parameter).

  ```
    accessToken: Model.Sensitive(Schema.NullOr(Schema.String)),
    refreshToken: Model.Sensitive(Schema.NullOr(Schema.String)),
  ```

- `spec/glossary.md:63`: The glossary overclaims for the repository stratum.

  ```
  Effect's wrapper type for a value that must never reach a log line, a span, or a published event in cleartext — passwords, session secrets, and verification tokens are carried as `Redacted` throughout.
  ```

**Fix plan** (effort S): Amend the spec to match the real, deliberate boundary. Do not retype the repository: a `Schema.Redacted` encoded form cannot be bound as a SQL parameter (Models.ts:77-86), and core already re-wraps tokens as `Redacted` at the domain boundary (`ProviderTokenSet.accessToken: Redacted.Redacted<string>`, core Accounts.ts:85-87).

Steps:

1. BEH-EA-034 illustration: change to `accessToken: Model.Sensitive(Schema.NullOr(Schema.String))`. Add one paragraph: rows hold plaintext in memory, the disk holds AES-GCM ciphertext with row+column AAD, `Redacted` exists at the Encryption seam and from core's domain records upward, and JSON exclusion is guaranteed by `Model.Sensitive`.
2. Glossary `Redacted`: qualify "throughout" to "throughout every domain-service and HTTP boundary; repository rows below core hold the plain value only transiently."
3. Run `pnpm run spec:verify:strict`.

Files: `spec/behaviors/05-persistence-stratum.md`, `spec/glossary.md`

Tests (write first):

- No code test. `pnpm run spec:verify:strict` passes.

Acceptance:

- BEH-EA-034 text matches Models.ts.

Spec refs: BEH-EA-034

Depends on: none

**Recommended status:** `ready-for-agent`

#### TS-005-tim-smart: Account token decryption failures are collapsed with Effect.orDie instead of the port's typed error channel

`low` · `correctness` · `sql` · [.issues/low/TS-005-tim-smart.md](../../.issues/low/TS-005-tim-smart.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **SMS-002-secrets-management-specialist**)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:225`: Same `Effect.orDie`. The typed `TokenUndecryptable` it asks for is SMS-002's `AccountTokenUndecryptable`.

  ```
          : encryption
              .decrypt(value, tokenAad(providerId, userId, field))
              .pipe(Effect.map(Redacted.value), Effect.orDie);
  ```

**No fix:** Closed into SMS-002-secrets-management-specialist; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

### Workstream `session-list-liveness-and-pagination`

#### PPS-002: Sessions keyset pagination is not index-aligned: single-column userId index forces sort of the user's full row set

`medium` · `performance` · `sql` · [.issues/medium/PPS-002-postgres-performance-specialist.md](../../.issues/medium/PPS-002-postgres-performance-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high) (canonical for SEA-006, SSMS-008)

**Evidence at HEAD**

- `packages/sql/src/CoreMigrations.ts:231`: Still the only userId index (migration 11 added only sessions_family_id).

  ```
    migration(9, "create_sessions_user_id_index", (sql) =>
      sql.onDialectOrElse({
        pg: () => sql`CREATE INDEX sessions_user_id ON sessions("userId")`,
        sqlite: () => sql`CREATE INDEX sessions_user_id ON sessions(userId)`,
  ```

- `packages/sql/src/Repositories.ts:438`: The OR-form cursor with an unindexed sort key.

  ```
              : sql`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                    AND "supersededAt" IS NULL
                    AND ("createdAt" > ${request.cursorCreatedAt}
                         OR ("createdAt" = ${request.cursorCreatedAt} AND id > ${request.cursorId}))
                    ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
  ```

**Fix plan** (effort S): Add a partial composite index that matches the page query's filter and order, and rewrite the cursor as a row-value comparison.

Steps:

1. Add a new CoreMigrations migration at the next free id (18 at HEAD; coordinate ordering with the other workstreams): `create_sessions_user_created_live_index` running `CREATE INDEX IF NOT EXISTS sessions_user_created_live ON sessions("userId", "createdAt", id) WHERE "supersededAt" IS NULL`. Use the same DDL for both dialects (quoted form, as migration 13 does). `IF NOT EXISTS` keeps SSMS-006's out-of-band CONCURRENTLY runbook possible.
2. Keep `sessions_user_id`. `deleteAllByUser`/`deleteAllForUserExcept` also delete tombstoned rows, which the partial index excludes.
3. Rewrite the cursor branch as `AND ("createdAt", id) > (${request.cursorCreatedAt}, ${request.cursorId})`. Postgres and SQLite ≥3.15 both support row values; node:sqlite bundles a newer SQLite.
4. SMS-002(session)'s expiry predicate stays a residual filter on the index scan. That is acceptable.

Files: `packages/sql/src/CoreMigrations.ts`, `packages/sql/src/Repositories.ts`, `packages/sql/test/Repositories.test.ts`

Tests (write first):

- First failing test, packages/sql/test/Repositories.test.ts: "listByUser's page query is served by sessions_user_created_live with no temp B-tree sort". Run `EXPLAIN QUERY PLAN` on the exact statement and assert it contains `sessions_user_created_live` and not `USE TEMP B-TREE FOR ORDER BY`.
- The existing "BEH-EA-036: Sessions.listByUser pages by (createdAt, id), never an offset" stays green, including same-millisecond tie-breaks.
- Optional pg: an EXPLAIN assertion in Repositories.postgres.test.ts.

Acceptance:

- No sort node for the session page query on either dialect.
- Keyset semantics unchanged.

Spec refs: BEH-EA-036

Depends on: none

**Recommended status:** `ready-for-agent`

#### SMS-002-session-management-specialist: Session list returns expired sessions and nothing ever reaps dead rows

`medium` · `correctness` · `sql` · [.issues/medium/SMS-002-session-management-specialist.md](../../.issues/medium/SMS-002-session-management-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:435`: RRS-003 added a tombstone filter, but there is still no expiry predicate.

  ```
              ? sql`SELECT * FROM sessions WHERE "userId" = ${request.userId}
                    AND "supersededAt" IS NULL
                    ORDER BY "createdAt" ASC, id ASC LIMIT ${request.limit}`
  ```

- `packages/core/src/Sessions.ts:572`: The memory list filters no expiry either.

  ```
              Array.from(HashMap.values(s))
                .filter((row) => row.userId === userId && Option.isNone(row.supersededAt))
  ```

- `spec/behaviors/07-sessions.md:98`: The spec says *live*. `grep -ri 'purge|retention|sweep' packages/*/src` finds no session reaper; Retention (ticket 30/CSG-003) is unimplemented.

  ```
  REQUIREMENT: `Sessions` MUST expose a list of a user's own live sessions
  ```

**Fix plan** (effort S): Filter expired rows out of the device list in both layers. Delegate physical deletion to ticket 30's `Retention.sweep` (CSG-003, cross-slice) rather than inventing a second reaper.

Steps:

1. Give `SessionsRepositoryShape.listByUser` a required `now: DateTime.Utc` (caller clock, so TestClock controls it, like `tryConsume`/`claim`). Add `AND "absoluteExpiresAt" > ${now} AND "idleExpiresAt" > ${now}` to both branches of the page query, and add `now` to `SessionCursorRequest`.
2. core Sessions.ts: `layerSql.list` passes `yield* DateTime.now`. `layerMemory.list` applies the same two comparisons.
3. Reaper: none here. CSG-003's `Retention.sweep` provides `SessionsRepository.deleteExpiredBefore(cutoff)` and the opt-in `Retention.layerScheduled`. Link this issue from CSG-003.

Files: `packages/sql/src/Repositories.ts`, `packages/core/src/Sessions.ts`, `packages/sql/test/Repositories.test.ts`, `packages/core/test/Sessions.test.ts`, `features/features/02-domain/07-sessions.feature`

Tests (write first):

- First failing test, packages/core/test/Sessions.test.ts (both layers): "an idle-expired session no longer appears in list" (TestClock.adjust past idle) and "an absolute-expired session no longer appears in list".
- Add a BDD scenario under the BEH-EA-054 Rule in features/features/02-domain/07-sessions.feature: "expired sessions are not listed as devices".

Acceptance:

- The device list shows only sessions that `verify` would accept (modulo the secret).
- Physical cleanup is tracked under CSG-003.

Spec refs: BEH-EA-054, BEH-EA-051

Depends on: CSG-003

**Recommended status:** `ready-for-agent`

#### TIR-003: verifyLive consults page 1 of a paginated list - valid sessions beyond 200 rows false-negative

`medium` · `correctness` · `sql` · [.issues/medium/TIR-003-token-introspection-revocation-specialist.md](../../.issues/medium/TIR-003-token-introspection-revocation-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence: high) (fixed by `6629fd2`)

**Evidence at HEAD**

- `packages/jwt/src/Jwt.ts:446`: FIXED part: verifyLive/introspectLive now use a keyed `Sessions.isLive` (commit 6629fd2, TIR-002/FAMS-009/MAPS-006).

  ```
              return yield* sessions.isLive(Users.UserId(sub), Sessions.SessionId(sid));
  ```

- `packages/core/src/Sessions.ts:872`: STILL TRUE: `list` returns only page 1 (the 200 oldest rows, LIST_PAGE_SIZE at :642).

  ```
      const list: SessionsShape["list"] = (userId, current) =>
        repo.listByUser(userId, undefined, LIST_PAGE_SIZE).pipe(
  ```

- `packages/server/src/Session.ts:64`: The finding's secondary claim still holds: GET /session dies for a user whose current session is beyond row 200. The same point-lookup-through-list pattern appears at server Session.ts:102 (revoke ownership check), passkey Passkey.ts:574 (requireFreshSession) and qadi Resolvers.ts:147 (reauth obligation).

  ```
          const items = yield* sessions.list(userId, sessionId);
          const item = items.find((row) => row.current);
          if (item === undefined) {
            return yield* Effect.die(new Error("awthaq: current session missing from its own list"));
  ```

**Fix plan** (effort M): Add a keyed ownership lookup and route every point query through it. Make `list` exhaustive instead of silently truncating at 200.

Steps:

1. Add `readonly findOwned: (userId: UserId, id: SessionId) => Effect.Effect<Option.Option<SessionListItem>>` to `SessionsShape` in core Sessions.ts. Memory layer: `HashMap.get` plus the userId/tombstone/expiry checks `isLive` already does. SQL layer: `repo.findById` plus the same checks. Implement `isLive` as `findOwned(...).pipe(Effect.map(Option.isSome))` to share the logic.
2. Switch the four point-lookup call sites to `findOwned`: server Session.ts `current` (:64-69) and `revoke` (:102-104), passkey Passkey.ts `requireFreshSession` (:574-575), and qadi Resolvers.ts reauth handler (:147-148).
3. Make `Sessions.layerSql.list` exhaustive: loop `repo.listByUser` with `nextCursor` until `None`. Once SMS-002(session) adds the expiry predicate, this is bounded by the live-session count. The loop keeps BEH-EA-054's plain-list contract.

Files: `packages/core/src/Sessions.ts`, `packages/server/src/Session.ts`, `packages/passkey/src/Passkey.ts`, `packages/qadi/src/Resolvers.ts`, `packages/core/test/Sessions.test.ts`, `packages/server/test (session handler tests)`

Tests (write first):

- First failing test, packages/core/test/Sessions.test.ts (layerSql over SQLite): "findOwned resolves the newest session of a user with 201 live sessions" and "list returns all 201 live sessions".
- Server: "GET /session succeeds for a user with >200 sessions" (fails today with the 'current session missing' defect).
- Passkey/qadi: "reauth freshness check finds the current session beyond row 200".

Acceptance:

- No production code calls `sessions.list(...)` just to find one id (grep).
- `list` never truncates silently.

Spec refs: BEH-EA-054, ADR-EA-014

Depends on: none

**Recommended status:** `ready-for-agent`

#### ESR-010: listByUser limit is unvalidated before being bound into LIMIT

`low` · `api` · `sql` · [.issues/low/ESR-010-effect-sql-repository-specialist.md](../../.issues/low/ESR-010-effect-sql-repository-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:328`

  ```
  const SessionCursorRequest = Schema.Struct({
    userId: UserId,
    cursorCreatedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    cursorId: Schema.NullOr(Schema.String),
    limit: Schema.Int,
  });
  ```

- `packages/sql/src/Repositories.ts:450`: Only `undefined` is defaulted. 0, negative and huge limits pass through.

  ```
            limit: limit ?? DEFAULT_PAGE_SIZE,
  ```

**Fix plan** (effort S): Bound the page size by construction: clamp in `listByUser` and enforce the bound in the request schema.

Steps:

1. Add `export const MAX_PAGE_SIZE = 200` in Repositories.ts (matching core's LIST_PAGE_SIZE, which should then import it).
2. In `listByUser`, compute `effectiveLimit = Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)` once and use it for both the query and the `nextCursor` check (today :450 and :453 compute it twice).
3. Set `SessionCursorRequest.limit` to `Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE })))` as defense in depth. After clamping it never fails.

Files: `packages/sql/src/Repositories.ts`, `packages/core/src/Sessions.ts`, `packages/sql/test/Repositories.test.ts`

Tests (write first):

- First failing tests: "listByUser clamps limit 0 to 1 and still returns a nextCursor when more rows exist"; "listByUser with a negative limit does not raise a SqlError"; "listByUser caps limit at MAX_PAGE_SIZE".

Acceptance:

- No caller-supplied limit can yield a SqlError or an unbounded page.

Spec refs: BEH-EA-036

Depends on: none

**Recommended status:** `ready-for-agent`

#### SEA-006: Keyset pagination orders by (createdAt, id) but only a single-column userId index exists

`low` · `performance` · `sql` · [.issues/low/SEA-006-sqlite-embedded-auth-specialist.md](../../.issues/low/SEA-006-sqlite-embedded-auth-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **PPS-002**)

**Evidence at HEAD**

- `packages/sql/src/CoreMigrations.ts:234`: Same root cause as PPS-002 (a single-column index under a (createdAt, id) keyset). Its accounts remark doesn't apply: `AccountsRepository.listByUser` (Repositories.ts:299) has no ORDER BY, so there is no sort to avoid.

  ```
        sqlite: () => sql`CREATE INDEX sessions_user_id ON sessions(userId)`,
  ```

**No fix:** Closed into PPS-002; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

#### SSMS-008: Session pagination lacks a composite index for its filter-plus-order shape

`low` · `performance` · `sql` · [.issues/low/SSMS-008-sql-schema-migration-specialist.md](../../.issues/low/SSMS-008-sql-schema-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **PPS-002**)

**Evidence at HEAD**

- `packages/sql/src/CoreMigrations.ts:233`: Identical recommendation to PPS-002 (a sessions("userId", "createdAt", id) composite).

  ```
        pg: () => sql`CREATE INDEX sessions_user_id ON sessions("userId")`,
  ```

**No fix:** Closed into PPS-002; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

### Workstream `verification-store-hygiene`

#### PPS-003: findByIdentifier cannot use the partial unique index and verification_tokens history grows unboundedly

`medium` · `performance` · `sql` · [.issues/medium/PPS-003-postgres-performance-specialist.md](../../.issues/medium/PPS-003-postgres-performance-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high) (canonical for SSMS-003, ESR-005)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:640`

  ```
      const findByIdentifier = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: VerificationToken,
        execute: (identifier) =>
          sql`SELECT * FROM verification_tokens WHERE identifier = ${identifier} ORDER BY "createdAt" DESC LIMIT 1`,
      });
  ```

- `packages/sql/src/CoreMigrations.ts:173`: The only identifier index is partial. Migration 16 added `verification_tokens_user_id`, which does not help. Latent: `grep -rn findByIdentifier packages/*/src` shows no production caller outside the repository itself, only the two sql test suites.

  ```
          CREATE UNIQUE INDEX verification_tokens_live_identifier
          ON verification_tokens(identifier) WHERE "consumedAt" IS NULL`,
  ```

**Fix plan** (effort S): Scope `findByIdentifier` to the live row so the existing partial unique index serves it with at most one row and no sort. History growth is handled by CSG-003's retention sweep (ticket 30), not a new index.

Steps:

1. Change the query to `SELECT * FROM verification_tokens WHERE identifier = ${identifier} AND "consumedAt" IS NULL` and drop the ORDER BY/LIMIT: the partial unique index guarantees at most one row. Update the shape doc to say "the current live token for identifier, if any".
2. The alternative (a new non-partial `(identifier, "createdAt")` index) is rejected. There is no caller for the "latest including consumed" semantics (ADR-EA-016's `upsertLive`/`tryConsume` replaced it), and it would add a write-amplifying index to every token issue.
3. Update the two tests that call it (Repositories.test.ts:498 and Repositories.postgres.test.ts:233) to the live-row semantics.
4. Unbounded history: covered by CSG-003's `VerificationRepository.deleteExpiredBefore(cutoff)` / `Retention.sweep`. Link this issue from CSG-003.

Files: `packages/sql/src/Repositories.ts`, `packages/sql/test/Repositories.test.ts`, `packages/sql/test/Repositories.postgres.test.ts`

Tests (write first):

- First failing test: "findByIdentifier returns None once the identifier's only token is consumed" (today it returns the consumed row).
- "findByIdentifier's query plan uses verification_tokens_live_identifier" (SQLite EXPLAIN QUERY PLAN).

Acceptance:

- The findByIdentifier plan uses the partial unique index on both dialects.
- No unbounded scan is reachable from the public shape.

Spec refs: BEH-EA-057, ADR-EA-016

Depends on: none

**Recommended status:** `ready-for-agent`

#### SSMS-003: verification findByIdentifier cannot use any index and scans an unbounded history table

`medium` · `performance` · `sql` · [.issues/medium/SSMS-003-sql-schema-migration-specialist.md](../../.issues/medium/SSMS-003-sql-schema-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **PPS-003**)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:644`: Same query and root cause as PPS-003. The "hot auth path" framing is overstated: there is no production caller at HEAD.

  ```
          sql`SELECT * FROM verification_tokens WHERE identifier = ${identifier} ORDER BY "createdAt" DESC LIMIT 1`,
  ```

**No fix:** Closed into PPS-003; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

#### ESR-005: findByIdentifier cannot use the identifier index for consumed history and sorts unindexed

`low` · `performance` · `sql` · [.issues/low/ESR-005-effect-sql-repository-specialist.md](../../.issues/low/ESR-005-effect-sql-repository-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **PPS-003**)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:644`: Same query as PPS-003. Its second option (scope to consumedAt IS NULL) is the plan PPS-003 adopts.

  ```
          sql`SELECT * FROM verification_tokens WHERE identifier = ${identifier} ORDER BY "createdAt" DESC LIMIT 1`,
  ```

**No fix:** Closed into PPS-003; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

#### ESS-010-effect-schema-specialist: Documented latent decode asymmetry in VerificationToken.payload

`low` · `correctness` · `sql` · [.issues/low/ESS-010-effect-schema-specialist.md](../../.issues/low/ESS-010-effect-schema-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/core/src/Verification.ts:170`: layerMemory stores an explicit `null` verbatim.

  ```
            payload: input.payload,
  ```

- `packages/core/src/Verification.ts:271`: layerSql folds null to undefined, so the two layers diverge on explicit null.

  ```
    payload: row.payload === null ? undefined : row.payload,
  ```

**Fix plan** (effort S): Make the divergence unreachable: layerMemory normalizes explicit `null` to `undefined` at issue, matching the SQL encoding. Enforce it with a shared two-layer contract test.

Steps:

1. Verification.ts layerMemory issue (:170): `payload: input.payload === null ? undefined : input.payload`.
2. Update the Models.ts:198-207 comment: remove the 'latent asymmetry' paragraph and state that both layers normalize null to undefined.
3. Optionally tighten `VerificationShape.issue`'s `payload?: unknown` doc to say null is treated as absent.

Files: `packages/core/src/Verification.ts`, `packages/sql/src/Models.ts`, `packages/core/test/Verification.test.ts`

Tests (write first):

- First failing test, packages/core/test/Verification.test.ts, run over both layerMemory and layerSql: "an explicit null payload round-trips as undefined".

Acceptance:

- Both layers return identical `payload` for {omitted, null, object}.

Spec refs: BEH-EA-122

Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream `sql-repository-hygiene`

#### EOTS-008: Hand-written SQL queries bypass the spanPrefix spans that repository CRUD gets

`medium` · `performance` · `sql` · [.issues/medium/EOTS-008-effect-observability-tracing-specialist.md](../../.issues/medium/EOTS-008-effect-observability-tracing-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence: high)

**Evidence at HEAD**

- `node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/src/unstable/sql/Statement.ts:1305`: OVERSTATED: every statement, hand-written ones included, already gets a `sql.execute` client span carrying `db.query.text` (Statement.ts:1333-1334). The claim that they "produce no span at all" is false.

  ```
      return Effect.useSpan(
        "sql.execute",
        { kind: "client" },
  ```

- `node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/src/unstable/sql/SqlModel.ts:112`: TRUE part: only makeRepository methods get named domain spans (Users.insert, ...).

  ```
          Effect.withSpan(`${options.spanPrefix}.insert`, {}, { captureStackTrace: false })
  ```

- `packages/sql/src/Repositories.ts:87`: `grep -c withSpan packages/sql/src/Repositories.ts` returns 0.

  ```
        const findByEmail = SqlSchema.findOneOption({
          Request: Schema.String,
          Result: User,
          execute: (email) => sql`SELECT * FROM users WHERE lower(email) = lower(${email})`,
        });
  ```

**Fix plan** (effort S): Give every hand-written repository method a named span, matching SqlModel's `<spanPrefix>.<method>` convention, so a flame graph shows `Users.findByEmail > sql.execute` rather than an anonymous `sql.execute`.

Steps:

1. Add a tiny helper in Repositories.ts: `const traced = (name: string, attributes?: Record<string, unknown>) => Effect.withSpan(name, { attributes }, { captureStackTrace: false })`.
2. Wrap these methods. Users: findByEmail, verifyEmail. Accounts: findByProviderSubject (attribute providerId only), listByUser, deleteAllByUser, and the insert/update/findById encryption wrappers. Sessions: listByUser, touch, deleteAllForUserExcept, deleteAllByUser, tombstone, markReused, revokeFamily, reauthenticate. VerificationTokens: findByIdentifier, upsertLive, tryConsume, deleteAllByUser. VerificationReservations: claim. AuditLog: insert, list.
3. Never attach email, identifier, secretHash, valueHash, tokens or payload as span attributes (BEH-EA-199; ticket 27's redaction interceptor will assert it). ids (userId/sessionId/accountId) are acceptable, matching SqlModel's `findById` `{ attributes: { id } }`.
4. Coordinate naming with ticket 27's business-logic spans (`awthaq.session.verify` wraps `Sessions.findById`/`touch`).

Files: `packages/sql/src/Repositories.ts`, `packages/sql/test/Repositories.test.ts`

Tests (write first):

- First failing test, packages/sql/test/Repositories.test.ts: "hand-written repository methods emit named spans". Install an in-memory Tracer that collects span names, call findByEmail/touch/tryConsume, and assert that `Users.findByEmail`, `Sessions.touch` and `VerificationTokens.tryConsume` exist, each parenting a `sql.execute` span.
- "no span attribute carries the email or a hash".

Acceptance:

- Every public repository method has a named span.
- No PII or secret appears in span attributes.

Spec refs: BEH-EA-035, BEH-EA-199

Depends on: none

**Recommended status:** `ready-for-agent`

#### ESR-003: Email case-folding relies on lower() whose semantics diverge between SQLite and Postgres and from the app-level normalization

`medium` · `correctness` · `sql` · [.issues/medium/ESR-003-effect-sql-repository-specialist.md](../../.issues/medium/ESR-003-effect-sql-repository-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:90`

  ```
          execute: (email) => sql`SELECT * FROM users WHERE lower(email) = lower(${email})`,
  ```

- `packages/core/src/Users.ts:317`: layerSql passes the raw email (Password.ts:801/892/929 and Passkey.ts:724 pass user input). Writes JS-lowercase (Users.ts:286), and layerMemory looks up `email.toLowerCase()` (Users.ts:141), so on SQLite a non-ASCII mixed-case sign-in misses.

  ```
      const findByEmail: UsersShape["findByEmail"] = (email) =>
        repo.findByEmail(email).pipe(Effect.map(Option.map(toUserRecord)), Effect.orDie);
  ```

**Fix plan** (effort S): Make JS `toLowerCase()` the only fold. Normalize the bound parameter in the repository and keep `lower(email)` on the column side so the existing `users_email_unique` expression index still serves the lookup. Stored values are already JS-lowercased, so column-side `lower()` is a no-op for them on every dialect.

Steps:

1. Repositories.ts `findByEmail`: `execute: (email) => sql`SELECT * FROM users WHERE lower(email) = ${email.toLowerCase()}``.
2. core Users.ts layerSql `findByEmail`: pass `email.toLowerCase()` as well, for symmetry with layerMemory and so the domain service owns normalization.
3. No migration: the index stays `lower(email)`.
4. BEH-EA-041 text: state that normalization is JS `String.prototype.toLowerCase()` at the domain boundary and the database index never sees a non-normalized value.

Files: `packages/sql/src/Repositories.ts`, `packages/core/src/Users.ts`, `packages/sql/test/Repositories.test.ts`, `packages/core/test/Users.test.ts`, `spec/behaviors/06-domain-users-accounts.md`

Tests (write first):

- First failing test, packages/core/test/Users.test.ts (layerSql over SQLite): "findByEmail('MÜLLER@EXAMPLE.COM') finds a user created as 'Müller@example.com'". It fails today because SQLite's lower() folds ASCII only.
- The existing "BEH-EA-041: findByEmail matches case-insensitively" stays green.

Acceptance:

- Lookups behave identically on SQLite, Postgres and memory for non-ASCII emails.

Spec refs: BEH-EA-041

Depends on: none

**Recommended status:** `ready-for-agent`

#### MA-008: Identity brands are declared twice (core and sql); drift is silently bridged by string-typed re-wrap constructors

`low` · `architecture` · `sql` · [.issues/low/MA-008-michael-arnaldi.md](../../.issues/low/MA-008-michael-arnaldi.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high) (canonical for ESS-011-effect-schema-specialist)

**Evidence at HEAD**

- `packages/core/src/Users.ts:48`

  ```
  export type UserId = string & Brand.Brand<"UserId">;
  export const UserId = Brand.nominal<UserId>();
  ```

- `packages/sql/src/Models.ts:21`: There are two independent declarations. core already depends on @awthaq/sql (core/package.json:29), so core can alias sql's type directly with no new package.

  ```
  export const UserId = Schema.String.pipe(Schema.brand("UserId"));
  export type UserId = typeof UserId.Type;
  ```

**Fix plan** (effort S): Declare each id type once, in @awthaq/sql, the lower stratum core already imports. Core re-exports the type and keeps a nominal constructor over it, so a key rename on either side breaks every bridge at compile time.

Steps:

1. core Users.ts: `export type UserId = SqlModels.UserId` (replacing the local `string & Brand.Brand<"UserId">`), keeping `export const UserId = Brand.nominal<UserId>()`. Do the same for AccountId (Accounts.ts:28), SessionId (Sessions.ts:31) and VerificationTokenId.
2. Add a type-level test (ESS-011's ask) in packages/core/test/Brands.test.ts: `expectTypeOf<Users.UserId>().toEqualTypeOf<SqlModels.UserId>()`, and likewise for the other three ids.
3. Update the Models.ts:9-15 header comment: core aliases these types rather than redeclaring them.

Files: `packages/core/src/Users.ts`, `packages/core/src/Accounts.ts`, `packages/core/src/Sessions.ts`, `packages/core/src/Verification.ts`, `packages/sql/src/Models.ts`, `packages/core/test/Brands.test.ts (new)`

Tests (write first):

- packages/core/test/Brands.test.ts: "core ids are the same types as @awthaq/sql's branded schemas" (expectTypeOf).

Acceptance:

- `pnpm run typecheck` fails if either brand key changes.
- No `as` is introduced.

Spec refs: BEH-EA-033

Depends on: none

**Recommended status:** `ready-for-agent`

#### PPS-008: SELECT * on every hand-written lookup pulls full wide rows including ciphertext and audit columns

`low` · `performance` · `sql` · [.issues/low/PPS-008-postgres-performance-specialist.md](../../.issues/low/PPS-008-postgres-performance-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence: medium)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:296`: True, but not worth actioning. Every `Result` is a full `Model.Class` select variant that requires all columns, so projecting would mean parallel partial schemas per query (doubling drift surface). The rows are narrow (≤17 scalar columns, no blobs), callers consume most columns (decryptRow needs both token columns), and the hot session verify path is SqlModel's own findById.

  ```
      const listByUser = SqlSchema.findAll({
        Request: UserId,
        Result: Account,
        execute: (userId) => sql`SELECT * FROM accounts WHERE "userId" = ${userId}`,
      });
  ```

**No fix:** Not actionable; the rationale is in the evidence notes.

**Recommended status:** `wontfix`

#### ESS-011-effect-schema-specialist: core/sql brand bridging is runtime-unchecked by design

`info` · `architecture` · `sql` · [.issues/info/ESS-011-effect-schema-specialist.md](../../.issues/info/ESS-011-effect-schema-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **MA-008**)

**Evidence at HEAD**

- `packages/sql/src/Models.ts:11`: Same double declaration as MA-008. Its type-level-test ask is folded into MA-008's plan. The AdminApi.ListQuery side remark belongs to the admin slice.

  ```
  // own `UserId`/`SessionId`/`AccountId`/`VerificationTokenId` — the two are
  // structurally compatible (a `Brand<Keys>`'s uniqueness comes from the
  // literal string key, not a runtime symbol), and it is core's eventual
  ```

**No fix:** Closed into MA-008; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

### Workstream `user-identity-lifecycle`

#### SAM-003: User model cannot represent anonymous or phone-only Supabase users

`high` · `correctness` · `sql` · [.issues/high/SAM-003-supabase-auth-migration-specialist.md](../../.issues/high/SAM-003-supabase-auth-migration-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/CoreMigrations.ts:58`

  ```
        pg: () => sql`
          CREATE TABLE users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            "emailVerified" BOOLEAN NOT NULL,
  ```

- `packages/sql/src/Models.ts:40`: Still non-null and phone-less. `grep -rn phoneVerified packages` finds nothing. Only `metadata` (AOMS-002) was added.

  ```
  export class User extends Model.Class<User>("User")({
    id: Model.UuidV7Insert(UserId),
    email: Schema.String,
  ```

**Fix plan** (effort XL): Implement ticket 09's decision: a `UserIdentity` tagged union (Email | Phone | Anonymous) at the domain layer, flattened to nullable email/phone columns plus phoneVerified in SQL, with a `promoteIdentity` upgrade path. Ticket 09's migration ids 10-12 are already taken; use the next free ids.

Steps:

1. Models.ts `User`: `email: Schema.NullOr(Schema.String)`, `phone: Schema.NullOr(Schema.String)` (constructor default null), and `phoneVerified` built with TS-001's dialect boolean field, excluded from update/jsonUpdate like emailVerified.
2. CoreMigrations (next free ids, 18+ at HEAD). (a) `add_users_phone_columns`: `phone TEXT`, and `"phoneVerified" BOOLEAN NOT NULL DEFAULT false` on pg / `phoneVerified INTEGER NOT NULL DEFAULT 0` on sqlite. (b) `make_users_email_nullable`: pg runs `ALTER TABLE users ALTER COLUMN email DROP NOT NULL`. sqlite rebuilds the table: CREATE users_new with every current column including metadata/phone/phoneVerified (plus status/tenantId if those workstreams landed first), INSERT SELECT, DROP, RENAME, then recreate `users_email_unique` on lower(email). (c) `create_users_phone_unique_index`: `CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL`.
3. Repositories.ts UsersRepository: add `findByPhone`, and `promoteIdentity(id, {email}|{phone})` as a targeted UPDATE ... RETURNING that maps UniqueViolation to the domain error in core.
4. core Users.ts: add `UserIdentity`. `UserRecord` gets `identity` in place of email/emailVerified. `create({ identity, name })`, `promoteIdentity`, and a `PhoneAlreadyExists` error. `toUserRecord` folds the columns into the union.
5. Update every `users.create(` / `.email` call site across oauth (retire OAuth.ts's synthetic `${providerId}:${subject}` email), password, passkey, organization, server Account.ts, admin, migrate-auth0, migrate-better-auth and next/client DTOs.
6. Spec: revise BEH-EA-041/042 (the identity union; phone parity), plus the matching feature scenarios in features/features/02-domain/06-users-accounts.feature.

Files: `packages/sql/src/Models.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/sql/src/Repositories.ts`, `packages/core/src/Users.ts`, `packages/oauth/src/OAuth.ts`, `packages/password/src/Password.ts`, `packages/passkey/src/Passkey.ts`, `packages/organization/src/Organization.ts`, `packages/server/src/Account.ts`, `packages/migrate-auth0/src/*`, `packages/migrate-better-auth/src/*`, `spec/behaviors/06-domain-users-accounts.md`, `features/features/02-domain/06-users-accounts.feature`

Tests (write first):

- First failing tests, packages/core/test/Users.test.ts (both layers): "create an Anonymous user with no email or phone", "create a Phone user; a second create with the same phone fails PhoneAlreadyExists", "promoteIdentity upgrades Anonymous→Email in place, keeping the UserId".
- packages/sql/test/Repositories.test.ts: "the email-nullable migration preserves existing rows and the lower(email) unique index on SQLite" (insert under the old schema, migrate, assert).
- oauth: "a provider profile with no email creates an Anonymous user, not a synthetic email".

Acceptance:

- Anonymous and phone-only users are representable and importable.
- The email uniqueness semantics of BEH-EA-041 are unchanged for Email identities.
- No synthetic-email fallback remains.

Spec refs: BEH-EA-041, BEH-EA-042, BEH-EA-046

Depends on: TS-001-tim-smart

**Recommended status:** `ready-for-agent`

#### SCP-001: No user deactivation state: SCIM active:false is unrepresentable, only hard delete exists

`high` · `architecture` · `sql` · [.issues/high/SCP-001-scim-provisioning-specialist.md](../../.issues/high/SCP-001-scim-provisioning-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Models.ts:40`: There is no status/active/suspended/banned field. `grep -rn setStatus packages` finds nothing.

  ```
  export class User extends Model.Class<User>("User")({
    id: Model.UuidV7Insert(UserId),
    email: Schema.String,
  ```

- `.scratch/resolve-ready-for-human-findings/issues/19-admin-api-surface-expansion.md:61`: A sibling decision (ticket 19, BAM-005, admin slice) adds an overlapping sign-in gate on the same record (`banned`/`bannedReason`/`bannedUntil`). Implement both together.

  ```
  - **`banned` as a real, core-level gate, not just an admin-side flag.**
  ```

**Fix plan** (effort M): Implement ticket 09's decision: `status: "active" | "suspended"` with a dedicated `Users.setStatus` (never a generic write), composed with `Sessions.revokeAll` at the caller. Co-design the sign-in gate and migration with ticket 19's `banned` fields (BAM-005) so there is one gate and one migration.

Steps:

1. Models.ts `User`: `status: Schema.Literals(["active", "suspended"])`, FieldExcept update/jsonUpdate, constructor default "active". If BAM-005 lands in the same pass, also add `banned` (dialect bool), `bannedReason` (NullOr String) and `bannedUntil` (NullOr dialect DateTime).
2. CoreMigrations (next free id): `add_users_status_columns` adds `status TEXT NOT NULL DEFAULT 'active'` (plus the ban columns if co-landing). Every existing row becomes active, and no backfill is needed.
3. Repositories.ts UsersRepository: `setStatus(id, status)` as a targeted `UPDATE users SET status = ..., "updatedAt" = ... WHERE id = ... RETURNING *`.
4. core Users.ts: add `UserRecord.status` and `Users.setStatus(id, status)`. `delete` is unchanged. Add a single `Users.assertCanSignIn(user)` helper (failing a typed `UserSuspended`/`UserBanned`) and call it from every `Sessions.issue` caller ticket 19 enumerates: password signIn, passkey authenticateVerify, the oauth callback, and magic-link when it lands.
5. The caller composes `setStatus(id, "suspended")` with `Sessions.revokeAll(id)` (the admin/SCIM handler), inside `SqlTransaction.withTransaction`.
6. SCIM external-id tombstones stay in ticket 08's packages/scim, not here.
7. Spec: add a new BEH in 06-domain-users-accounts.md, 'Suspension is never deletion', plus feature scenarios.

Files: `packages/sql/src/Models.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/sql/src/Repositories.ts`, `packages/core/src/Users.ts`, `packages/password/src/Password.ts`, `packages/passkey/src/Passkey.ts`, `packages/oauth/src/OAuth.ts`, `spec/behaviors/06-domain-users-accounts.md`, `features/features/02-domain/06-users-accounts.feature`

Tests (write first):

- First failing test, packages/core/test/Users.test.ts (both layers): "setStatus(suspended) persists and is not reachable via updateProfile".
- packages/password/test: "a suspended user's correct-password signIn is refused with UserSuspended and issues no session". Mirror it for passkey and oauth.
- "reactivating (setStatus active) restores sign-in; accounts and sessions history retained".

Acceptance:

- A deactivated user keeps every row but cannot obtain a session.
- Only `setStatus` writes `status`.

Spec refs: BEH-EA-042, BEH-EA-046, BEH-EA-053

Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream `tenancy-residency`

#### DRS-001: No tenant/org/shard key exists on any core table — residency-by-tenant partitioning is impossible without schema change

`high` · `architecture` · `sql` · [.issues/high/DRS-001-data-residency-sharding-specialist.md](../../.issues/high/DRS-001-data-residency-sharding-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high) (canonical for SSMS-009)

**Evidence at HEAD**

- `packages/sql/src/CoreMigrations.ts:58`: `grep -rn tenantId packages` finds nothing. The core table count has grown to 6 since the audit: auth_audit_log, migration 13, also lacks a tenancy column.

  ```
        pg: () => sql`
          CREATE TABLE users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
  ```

**Fix plan** (effort XL): Implement ticket 18's decision: an opaque, nullable, indexed tenant column on every core table, stamped from an ambient `TenantContext` Context.Reference (default `Option.none()`, zero-cost for single-tenant), with optional Postgres RLS policies underneath.

Steps:

1. core: add a new module `packages/core/src/Tenant.ts` with `TenantContext = Context.Reference<Option.Option<string>>`, default `Option.none()` (the SessionConfig pattern, ADR-EA-011).
2. CoreMigrations (next free id): `add_tenant_columns`. Add a nullable tenant column plus a single-column index to users, accounts, sessions, verification_tokens, verification_reservations and auth_audit_log. Ticket 18 wrote `tenant_id`; this repo uses quoted camelCase everywhere (`"userId"`, `"familyId"`), so use `"tenantId"` and note the deviation in the ADR.
3. Models.ts: `tenantId: Schema.NullOr(Schema.String)` with a constructor default of null and FieldExcept update/jsonUpdate on every model. Stamp it in one choke point, the sql repositories' insert paths (`repo.insert` wrappers, `upsertLive`, `claim`, `AuditLog.insert`), which read `TenantContext` ambiently. Core service signatures don't change.
4. Postgres RLS: a pg-only opt-in migration set, `CoreMigrations.rlsMigrations` (sqlite: none). Run `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY; ALTER TABLE <t> FORCE ROW LEVEL SECURITY; CREATE POLICY awthaq_tenant ON <t> USING ("tenantId" = current_setting('awthaq.tenant_id', true) OR current_setting('awthaq.tenant_id', true) IS NULL)`. FORCE is needed because the app role usually owns the tables and owners bypass RLS otherwise.
5. Add a `TenantScope.withTenant(effect)` combinator in @awthaq/sql that wraps the caller's `sql.withTransaction` and first issues `SELECT set_config('awthaq.tenant_id', ${tenantId}, true)` (transaction-local, pool-safe). Document that non-transactional queries see no setting and pass the `IS NULL` clause, which is fail-open by design for single-tenant compatibility.
6. organization plugin (cross-slice): a `TenantResolver` port and `Organization.tenantMiddleware` providing `TenantContext` per request.
7. Write ADR `spec/decisions/0NN-tenancy-column-and-rls.md` and add a BEH-EA-033/035 addendum.

Files: `packages/core/src/Tenant.ts (new)`, `packages/sql/src/CoreMigrations.ts`, `packages/sql/src/Models.ts`, `packages/sql/src/Repositories.ts`, `packages/sql/src/TenantScope.ts (new)`, `packages/organization/src/Organization.ts`, `spec/decisions/0NN-tenancy-column-and-rls.md`

Tests (write first):

- First failing test, packages/sql/test/Repositories.test.ts: "inserts stamp tenantId from TenantContext and NULL when unset" (for every repository).
- Postgres (test:pg): "with RLS migrations applied, a query inside TenantScope.withTenant('t1') cannot read t2's session rows".
- core: "single-tenant deployment behavior unchanged". The existing suites pass with no TenantContext provided.

Acceptance:

- Every core row carries the tenant attribution when a tenant is in context.
- Zero behavior change when no tenant is provided.
- RLS fails closed across tenants on Postgres when enabled.

Spec refs: BEH-EA-033, BEH-EA-035, ADR-EA-005, ADR-EA-011, ADR (new): tenancy column & RLS

Depends on: none

**Recommended status:** `ready-for-agent`

#### DRS-005: Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding

`medium` · `performance` · `sql` · [.issues/medium/DRS-005-data-residency-sharding-specialist.md](../../.issues/medium/DRS-005-data-residency-sharding-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:90`

  ```
          execute: (email) => sql`SELECT * FROM users WHERE lower(email) = lower(${email})`,
  ```

- `packages/sql/src/Repositories.ts:293`: The login lookups carry no tenant predicate, and both unique indexes (CoreMigrations.ts:93, :215) are global. Ticket 18 adds a tenant column but is silent on identity uniqueness scope.

  ```
          sql`SELECT * FROM accounts WHERE "providerId" = ${request.providerId} AND subject = ${request.subject} AND issuer = ${request.issuer}`,
  ```

**Fix plan** (effort S): After the uniqueness-scope decision: document the users and accounts tables as the global identity directory, and let tenant-scoped routing apply only to sessions/verification/audit (recommended option A). Under option B, prefix the unique indexes with the tenant column instead.

Steps:

1. (A) Document in the DRS-001 ADR that users/accounts are the global identity directory: email and (providerId, subject, issuer) are unique across tenants. This is consistent with ticket 18's tenant = Organization row and the membership model, under which one user belongs to many orgs. Sign-in lookups are directory reads. Under sharding, the directory stays unsharded (or replicated read-only), and the tenant-stamped sessions/verification/audit tables are what partition.
2. (A) Add `("tenantId", "userId")` composite indexes on sessions/verification_tokens in DRS-001's migration so tenant-routed reads prune.
3. (B, only if chosen) Replace users_email_unique with `UNIQUE (COALESCE("tenantId", ''), lower(email))` and accounts' unique with a tenant-prefixed one. findByEmail/findByProviderSubject add `"tenantId" IS NOT DISTINCT FROM ${TenantContext}`.

Files: `spec/decisions/0NN-tenancy-column-and-rls.md`, `packages/sql/src/CoreMigrations.ts`

Tests (write first):

- (A) No behavior test. Use an EXPLAIN assertion that the tenant-scoped session list uses the (tenantId, userId) index.
- (B) "the same email can register in two tenants; sign-in resolves per TenantContext".

Acceptance:

- The identity uniqueness scope is written down in an ADR, and the login path's shard behavior is explicit.

Spec refs: BEH-EA-041, BEH-EA-043, ADR (new): tenancy column & RLS

Depends on: DRS-001

**Needs decision:** see *Decisions needed* above.

**Recommended status:** `ready-for-human`

#### SAM-006: SQL stratum has no authorization hook: dropping RLS removes the database-level backstop

`medium` · `security` · `sql` · [.issues/medium/SAM-006-supabase-auth-migration-specialist.md](../../.issues/medium/SAM-006-supabase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence: medium)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:76`: True at HEAD: there is no row-scoping, and `grep -rn 'ROW LEVEL' packages spec` finds nothing.

  ```
  export const UsersRepositoryLive: Layer.Layer<UsersRepository, never, SqlClient.SqlClient> =
  ```

- `.scratch/resolve-ready-for-human-findings/issues/18-multi-tenant-composition-oauth-connections.md:97`: The structural DB backstop (Postgres RLS on core tables) is already decided under DRS-001, so that half is covered. The Supabase cutover-protocol documentation is not.

  ```
  - **Structural isolation, not just convention** — directly answering
  ```

**Fix plan** (effort S): The RLS backstop ships with DRS-001's opt-in RLS migrations. What remains here is documentation of the Supabase hybrid window and the recommended least-privilege database role.

Steps:

1. Write a 'Migrating from Supabase: RLS and qadi' section (packages/sql/README.md or docs/migrations/supabase.md). Keep the existing Supabase RLS active through the qadi rollout, driving both from one policy catalog. Exit criteria are qadi call-site coverage of every data path plus audit-log review. Then disable app-table RLS, and optionally keep awthaq's own DRS-001 RLS on the auth tables.
2. Recommend that the app connect as a non-owner role with only the DML grants it needs, and that migrations run as the owner role. RLS is then enforced even without FORCE, and ad-hoc scripts using the app role are scoped.
3. Add a note in ADR-EA-009 (authorization delegated to qadi) that DB-level isolation is opt-in defense in depth, not the primary control.

Files: `packages/sql/README.md or docs/migrations/supabase.md`, `spec/decisions/009-authorization-delegated-to-qadi.md`

Tests (write first):

- No code test (docs). DRS-001's RLS tests cover the mechanism.

Acceptance:

- The cutover protocol and role recommendation are documented and linked from the README.

Spec refs: ADR-EA-009

Depends on: DRS-001

**Recommended status:** `ready-for-agent`

#### CSG-009: No residency, region, or subprocessor hooks; data location is undocumented deployer choice

`info` · `architecture` · `sql` · [.issues/info/CSG-009-compliance-soc2-gdpr-specialist.md](../../.issues/info/CSG-009-compliance-soc2-gdpr-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: medium)

**Evidence at HEAD**

- `packages/sql/src/CoreMigrations.ts:222`: No region or placement hooks exist.

  ```
    migration(8, "create_accounts_user_id_index", (sql) =>
      sql.onDialectOrElse({
        pg: () => sql`CREATE INDEX accounts_user_id ON accounts("userId")`,
  ```

- `packages/sql/README.md:3`: There is no deployer-facing statement of the data-location model anywhere (spec/overview.md, docs/ and the README have none).

  ```
  > **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet.
  ```

**Fix plan** (effort S): Document the data-location model. Point multi-region at the seams that exist or are decided: the injected SqlClient, DRS-001's tenant column, and ADR-EA-005's `LayerMap.Service` for per-tenant/per-region SqlClient routing. Don't add per-table logic.

Steps:

1. Add a 'Data location & residency' section to packages/sql/README.md (rewritten under ESR-008) and a short paragraph in spec/overview.md's persistence section. It should say that storage location is whatever database the deployer's SqlClient points at. Multi-region is expressed as a `LayerMap.Service` keyed by region/tenant that yields a SqlClient, selected from DRS-001's `TenantContext`. The encryption boundary is cross-referenced to CSG-006.
2. Cross-link the GDPR erasure (ec065a7 / ErasureRegistry) and retention (CSG-003) mechanisms. research/00-questions.md:74's 'deletion cascades' open question is now answered and should be marked so.

Files: `packages/sql/README.md`, `spec/overview.md`, `research/00-questions.md`

Tests (write first):

- `pnpm run spec:verify:strict` passes. No code test.

Acceptance:

- A deployer can answer 'where does my users' data live and how do I pin it to a region' from the docs.

Spec refs: ADR-EA-005

Depends on: DRS-001

**Recommended status:** `ready-for-agent`

#### SSMS-009: No tenant column anywhere in the core schema

`info` · `architecture` · `sql` · [.issues/info/SSMS-009-sql-schema-migration-specialist.md](../../.issues/info/SSMS-009-sql-schema-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **DRS-001**)

**Evidence at HEAD**

- `packages/sql/src/CoreMigrations.ts:59`: Same gap as DRS-001. The isolation model it asks to be recorded as an ADR is decided in ticket 18 (shared schema plus tenant column), and that ADR is part of DRS-001's plan.

  ```
          CREATE TABLE users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
  ```

**No fix:** Closed into DRS-001; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

### Workstream `read-replica-routing`

#### RRC-001: No replica-routing hooks, staleness classification, or read-your-writes guardrail exists anywhere in the persistence layer

`high` · `architecture` · `sql` · [.issues/high/RRC-001-read-replica-consistency-specialist.md](../../.issues/high/RRC-001-read-replica-consistency-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:5`: `grep -rn ReadRouting packages` finds nothing, so ticket 28 is unimplemented.

  ```
  // Each repository is a `Context.Service` built with `SqlModel.makeRepository`
  // over the ambient `SqlClient` (BEH-EA-035) — none opens its own
  // transaction; the calling domain service (in `@awthaq/core`'s
  ```

- `packages/sql/src/Repositories.ts:418`: Implementation note: the client is captured once at layer construction. A call-time `provideService(SqlClient, replica)` would therefore NOT reroute the query; ReadRouting must resolve both clients at construction.

  ```
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* SqlModel.makeRepository(Session, {
  ```

**Fix plan** (effort XL): Implement ticket 28's decision: an opt-in, default-off `ReadRouting` module (a `ReplicaSqlClient` Context.Reference plus a fiber-scoped `CurrentCausalToken`), and a per-method staleness classification in which only display/history listings are replica-eligible.

Steps:

1. Add `packages/sql/src/ReadRouting.ts`. It defines `ReplicaSqlClient: Context.Reference<Option.Option<SqlClient.SqlClient>>` (default `Option.none()`, meaning use the primary); `ReadRouting.replica(layer)`; `CausalToken = Schema.String.pipe(Schema.brand("CausalToken"))`; `CurrentCausalToken: Context.Reference<Option.Option<CausalToken>>`; `captureToken(effect)`, which after a successful commit on pg reads `pg_current_wal_insert_lsn()` and sets the token via `Effect.provideService` for the rest of the fiber; and `forRead(primary, replica)(query)`, which with a token checks `pg_last_wal_replay_lsn() >= token` on the replica and otherwise falls back to the primary.
2. Correct ticket 28's method list against HEAD. `SessionsRepository.findByTokenHash` does not exist. PRIMARY-pinned: every write; Users.findById/findByEmail; Accounts.findById/findByProviderSubject/listByUser (unlink's last-account check depends on it); Sessions.findById/touch/tombstone/markReused/reauthenticate; Verification.*; VerificationReservations.claim. REPLICA-eligible: `SessionsRepository.listByUser` (device list only, once TIR-003 moves the point lookups to keyed `findOwned`), `AuditLogRepository.list`, and organization listing reads (cross-slice).
3. In each affected repository `Layer.effect`, resolve `primary = yield* SqlClient.SqlClient` and `replica = yield* ReplicaSqlClient` at construction. Build the replica-eligible SqlSchema queries against `Option.getOrElse(replica, () => primary)` wrapped in `forRead`.
4. Document the single-primary read-your-writes assumption in the Repositories.ts header and in a BEH-EA-035 addendum. Codify RRC-007's 'carry results via RETURNING, never re-read' rule there too.
5. Add ADR `spec/decisions/0NN-read-replica-routing.md` recording ticket 28's points 1-4, including the deferred cross-request causal-token header.

Files: `packages/sql/src/ReadRouting.ts (new)`, `packages/sql/src/Repositories.ts`, `packages/sql/src/index.ts`, `spec/behaviors/05-persistence-stratum.md`, `spec/decisions/0NN-read-replica-routing.md`

Tests (write first):

- First failing test, packages/sql/test/ReadRouting.test.ts: "with no replica provided, every repository reads the primary" (a counting SqlClient wrapper). Then "with a replica provided, Sessions.listByUser reads the replica while Sessions.findById reads the primary", and "a CurrentCausalToken ahead of the replica's replay LSN forces a primary read" (pg; stub the LSN query via a fake client on SQLite).
- See RRC-008 for the lag-injection suite.

Acceptance:

- The default behavior is byte-identical.
- No session/verification/credential read can reach a replica.
- The ADR is recorded.

Spec refs: BEH-EA-035, ADR-EA-014, ADR (new): read-replica routing

Depends on: TIR-003

**Recommended status:** `ready-for-agent`

#### RRC-008: No staleness or lag-injection coverage: SQL contract suites run single-client semantics only

`low` · `testing` · `sql` · [.issues/low/RRC-008-read-replica-consistency-specialist.md](../../.issues/low/RRC-008-read-replica-consistency-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/test/Repositories.test.ts:27`: There is a single client per suite (pg likewise at Repositories.postgres.test.ts:52), and no lag/staleness wrapper exists in packages/test.

  ```
  const SqlLive = SqliteClient.layer({ filename: ":memory:" });
  ```

**Fix plan** (effort M): Land a lag-injecting replica test double together with ReadRouting, and cover the four causal handoffs.

Steps:

1. In @awthaq/test, add `LaggingReplica.layer(primaryLayer, { lag })`. It is a SqlClient that answers reads from a snapshot taken `lag` writes ago (e.g. a second SQLite file copied at a checkpoint), provided as `ReplicaSqlClient`.
2. Contract tests under a lagging replica: issue→verify, rotation→next verify, revoke→verify (each must read the primary and succeed or fail correctly), and membership write→qadi read (organization slice). Also add the device-list case: a revoked session disappears once `CurrentCausalToken` is set by the revoke.

Files: `packages/test/src/LaggingReplica.ts (new)`, `packages/sql/test/ReadRouting.test.ts`, `packages/core/test/Sessions.test.ts`

Tests (write first):

- "verify after revoke fails even when a lagging replica still has the row"; "rotated secret verifies on the very next request under replica lag"; "device list reflects a just-revoked session within the same fiber".

Acceptance:

- Every ADR-EA-014 'authoritative next read' path is proven under injected lag.

Spec refs: ADR-EA-014, BEH-EA-054

Depends on: RRC-001

**Recommended status:** `ready-for-agent`

#### RRC-007: Verification write path is replica-friendly by construction: single-statement issue/consume with RETURNING carrying all needed state

`info` · `architecture` · `sql` · [.issues/info/RRC-007-read-replica-consistency-specialist.md](../../.issues/info/RRC-007-read-replica-consistency-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:684`: A positive observation that still holds. Nothing to fix; codifying the pattern is folded into RRC-001's BEH-EA-035 addendum.

  ```
        execute: (request) => sql`
          UPDATE verification_tokens
          SET "consumedAt" = ${request.now}
          WHERE identifier = ${request.identifier}
            AND "valueHash" = ${request.valueHash}
            AND "expiresAt" > ${request.now}
            AND "consumedAt" IS NULL
          RETURNING *
  ```

**No fix:** Not actionable; the rationale is in the evidence notes.

**Recommended status:** `wontfix`

### Workstream `retention-sweeps`

#### ALF-010: No retention policy or mechanism exists for any audit data

`low` · `compliance` · `sql` · [.issues/low/ALF-010-audit-logging-forensics-specialist.md](../../.issues/low/ALF-010-audit-logging-forensics-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence: high) (fixed by `6bd3f1d`)

**Evidence at HEAD**

- `packages/sql/src/CoreMigrations.ts:303`: FIXED part: a durable audit table now exists (6bd3f1d, ALF-001).

  ```
    migration(13, "create_auth_audit_log", (sql) =>
      sql.onDialectOrElse({
        pg: () =>
          sql`
          CREATE TABLE auth_audit_log (
  ```

- `packages/sql/src/Repositories.ts:860`: FIXED part: a time-range query API exists. STILL TRUE: `AuditLogRepositoryShape` has only insert/list, with no purge. There is no occurredAt index (only eventTag and actorUserId, :315-317). admin_impersonation has no purge (ImpersonationRecords.ts).

  ```
              ...(r.occurredAfter === null ? [] : [sql`"occurredAt" >= ${r.occurredAfter}`]),
              ...(r.occurredBefore === null ? [] : [sql`"occurredAt" <= ${r.occurredBefore}`]),
  ```

**Fix plan** (effort M): Extend ticket 30's `Retention` service (CSG-003) with per-event-class audit retention. The default is retain-forever (forensics-safe), and operators opt in to purge windows. Add the missing occurredAt index.

Steps:

1. Repositories.ts AuditLogRepository: add `deleteOccurredBefore(cutoff: DateTime.Utc, eventTags: ReadonlyArray<string> | null): Effect<number, SqlError>` as a single DELETE.
2. CoreMigrations (next free id): `CREATE INDEX IF NOT EXISTS auth_audit_log_occurred_at ON auth_audit_log ("occurredAt")`. This serves both the range `list` and the sweep.
3. core Retention (CSG-003): `RetentionConfig.auditLog: { default: Option<Duration>, byEventTag: ReadonlyRecord<string, Duration> }`, defaulting to `{ default: Option.none(), byEventTag: {} }` (keep indefinitely). `Retention.sweep` issues one delete per configured tag plus one for the default over the remaining tags.
4. admin plugin (cross-slice): `ImpersonationRecords.deleteEndedBefore(cutoff)`, registered as a retention contribution with the same config shape (key `admin.impersonation`).
5. Spec: add a BEH-EA-100 addendum on retention classes, and note in ticket 30's planned ADR that audit rows are purged only by explicit operator config.

Files: `packages/sql/src/Repositories.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/core/src/Retention.ts (CSG-003)`, `packages/admin/src/ImpersonationRecords.ts`, `spec/behaviors/13-events.md`

Tests (write first):

- First failing test, packages/sql/test/Repositories.test.ts: "AuditLog.deleteOccurredBefore removes only rows older than the cutoff for the given tags".
- core: "Retention.sweep with no audit config deletes no audit rows"; "a 90-day auth.user.signInFailed window purges only that tag".

Acceptance:

- Operators can bound audit retention per event class.
- The default keeps everything.
- Range queries are indexed.

Spec refs: BEH-EA-100

Depends on: CSG-003

**Recommended status:** `ready-for-agent`

### Workstream `two-factor-recovery-codes`

#### BCR-002: No bulk-invalidate, list, or count primitives anywhere in the Verification stack

`high` · `architecture` · `sql` · [.issues/high/BCR-002-backup-codes-recovery-specialist.md](../../.issues/high/BCR-002-backup-codes-recovery-specialist.md) · current status `ready-for-agent`

**Verdict:** PARTIAL (confidence: medium)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:698`: True at HEAD: no prefix-invalidate or count primitive. `deleteAllByUser` came with BCR-003 (704cdd4).

  ```
        findById: repo.findById,
        delete: repo.delete,
        findByIdentifier,
        upsertLive,
        tryConsume,
        deleteAllByUser,
  ```

- `.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md:38`: The later MFA decision (ticket 05) puts recovery codes in their own plugin table, not verification_tokens. The premise that Verification must carry backup codes no longer holds; the need moves to that table's repository.

  ```
     - **Recovery codes**: table `two_factor_recovery_code` (`id`, `userId`, `codeHash`, `usedAt` nullable) — hashed via the existing `PasswordHasher` port (same primitive, no new dependency), 10 codes minted at `confirm` time, each single-use
  ```

- `packages/two-factor/src/index.ts:3`: The two-factor plugin is still a placeholder.

  ```
  // TOTP-based two-factor authentication with a divert hook and hashed recovery codes.
  ```

**Fix plan** (effort M): Don't add prefix/count primitives to VerificationRepository. Implement bulk-replace and count on the `two_factor_recovery_code` repository when the two-factor plugin is built (ticket 05). Verification history purging comes from CSG-003's `deleteExpiredBefore`.

Steps:

1. In the two-factor plugin build (ticket 05 cluster: AOMS-003/THS-001/ARF-005/BAM-007), give `RecoveryCodesRepository` the operations `replaceAll(userId, codeHashes)` (one `DELETE FROM two_factor_recovery_code WHERE "userId" = ...` then a batch INSERT; the caller wraps both in `SqlTransaction.withTransaction`, per BEH-EA-035/058), `countUnused(userId)` (`SELECT count(*) ... WHERE "usedAt" IS NULL`), and `consume(userId, codeHash, now)` as a single CAS UPDATE.
2. Plugin service: `TwoFactor.regenerateRecoveryCodes` must call `replaceAll` inside one transaction, never delete-then-insert across two transactions. `TwoFactor.recoveryCodeStatus` returns `{ remaining }` for low-remaining warnings.
3. Register the table in the plugin's own `migrations` and its `ErasureRegistry` contribution (ticket 30/DRS-002 pattern).
4. Comment on BCR-002 that the Verification-stack premise is superseded by ticket 05, then close it with the two-factor build.

Files: `packages/two-factor/src/* (new)`, `packages/two-factor/test/* (new)`

Tests (write first):

- packages/two-factor/test/RecoveryCodes.test.ts: "regenerating recovery codes invalidates every old code atomically" (assert no old code consumes afterwards, and a failure mid-insert leaves the old set intact), and "countUnused decrements on each successful consume".

Acceptance:

- Regeneration is one transaction.
- A remaining-count is available to clients.
- No new Verification primitives are added.

Spec refs: BEH-EA-058

Depends on: AOMS-003

**Recommended status:** `ready-for-agent`

#### BCR-009: Backup codes must be long-lived but expiresAt is NOT NULL and expiry fails as replay

`low` · `correctness` · `sql` · [.issues/low/BCR-009-backup-codes-recovery-specialist.md](../../.issues/low/BCR-009-backup-codes-recovery-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence: medium)

**Evidence at HEAD**

- `packages/sql/src/Models.ts:225`: True, but only relevant if backup codes are stored as verification tokens.

  ```
    expiresAt: Schema.DateTimeUtcFromString.pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  ```

- `.scratch/resolve-ready-for-human-findings/issues/05-mfa-two-factor-subsystem.md:38`: Ticket 05's decision gives recovery codes their own table with no expiresAt, so the TTL problem never arises. Verification tokens are meant to expire. The low-remaining warning ask is carried by BCR-002's `countUnused`.

  ```
     - **Recovery codes**: table `two_factor_recovery_code` (`id`, `userId`, `codeHash`, `usedAt` nullable)
  ```

**No fix:** Not actionable; the rationale is in the evidence notes.

**Recommended status:** `wontfix`

### Workstream `sql-docs-operations`

#### CSG-006: Core PII columns are plaintext at rest with no documented encryption boundary

`medium` · `compliance` · `sql` · [.issues/medium/CSG-006-compliance-soc2-gdpr-specialist.md](../../.issues/medium/CSG-006-compliance-soc2-gdpr-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Models.ts:142`

  ```
    ipAddress: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
    userAgent: Schema.NullOr(Schema.String).pipe(Model.FieldExcept(["update", "jsonUpdate"])),
  ```

- `packages/sql/src/Repositories.ts:76`: Only AccountsRepositoryLive requires Encryption (Repositories.ts:192-196). email, name, ipAddress, userAgent and metadata are plaintext, and no deployer doc states the boundary.

  ```
  export const UsersRepositoryLive: Layer.Layer<UsersRepository, never, SqlClient.SqlClient> =
  ```

**Fix plan** (effort M): Document the encryption boundary now. Depending on the decision, add opt-in application-level encryption for the non-lookup PII columns (ipAddress, userAgent, users.metadata) through the existing Encryption port, with row AAD.

Steps:

1. Docs (always): add a README 'Encryption at rest' section. Only accounts.accessToken/refreshToken are app-encrypted (AES-256-GCM, AAD `providerId:userId:field`). Password/session/verification secrets are hash-only. Every other column relies on the deployer's disk/DB encryption, which is a stated deployer responsibility for SOC 2/GDPR, along with TLS to the DB.
2. (Option B) Add a `SqlPiiEncryption` Context.Reference, default `{ sessions: false, userMetadata: false }`. When enabled, SessionsRepositoryLive/UsersRepositoryLive also require `Encryption` and encrypt/decrypt `ipAddress`/`userAgent` (AAD `session:<id>:<field>`) and `metadata` (AAD `user:<id>:metadata`) exactly as AccountsRepositoryLive does. This reuses SMS-002's typed-undecryptable degrade policy.
3. (Option C, deferred) Deterministic or blind-index encryption of email would change the lower(email) uniqueness semantics (ESR-003/DRS-005). Don't plan it without a customer.

Files: `packages/sql/README.md`, `packages/sql/src/Repositories.ts (option B)`, `packages/sql/test/Repositories.test.ts (option B)`

Tests (write first):

- (B) "with SqlPiiEncryption.sessions enabled, the raw sessions.ipAddress column is ciphertext and listByUser returns plaintext".

Acceptance:

- The boundary is documented.
- (B) An operator can switch on PII column encryption without code changes.

Spec refs: BEH-EA-034

Depends on: SMS-002-secrets-management-specialist

**Needs decision:** see *Decisions needed* above.

**Recommended status:** `ready-for-human`

#### ESR-008: Package README and quality-metrics JSON contradict the shipped implementation

`medium` · `docs` · `sql` · [.issues/medium/ESR-008-effect-sql-repository-specialist.md](../../.issues/medium/ESR-008-effect-sql-repository-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/README.md:3`

  ```
  > **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
  ```

- `.quality-metrics/sql.json:42`: Stale. The package now has 4 src files and about 1,538 LOC (wc -l). The collector that produced it is not in the repo: scripts/ has only generate-quality-dashboard.mjs, which reads this file.

  ```
        "fileCount": 1,
        "totalLoc": 9,
  ```

- `packages/sql/src/index.ts:10`: The index header is also partly stale: CoreMigrations is exported on line 13 but not described.

  ```
  // Planned next: migration records/linker input (BEH-EA-037/038).
  ```

**Fix plan** (effort M): Rewrite the package README as the operations home for the persistence stratum. The docs-only findings in this slice (ERAS-006, PPS-004, PPS-009, SSMS-006, NAM-007, CSG-006, CSG-009, SAM-006) land as sections of it. Refresh or delete the stale metrics JSON.

Steps:

1. Rewrite packages/sql/README.md. Cover: what ships (Models, Repositories: Users/Accounts/Sessions/Verification/VerificationReservations/AuditLog, and CoreMigrations with 17 migrations); how to run migrations (until BE-003's CLI lands); supported dialects and drivers (ERAS-006); Postgres client configuration (PPS-004); the encryption boundary (CSG-006); data location (CSG-009); the migration runbook for populated tables (SSMS-006); JSON-as-TEXT (PPS-009); and the Auth.js/Supabase migration notes (NAM-007, SAM-006).
2. Update the packages/sql/src/index.ts header: describe CoreMigrations and drop 'Planned next'.
3. Regenerate .quality-metrics/sql.json with the external audit collector, or delete it so the dashboard shows 'no data' rather than false data. Note in the commit that the collector is not in-repo.

Files: `packages/sql/README.md`, `packages/sql/src/index.ts`, `.quality-metrics/sql.json`

Tests (write first):

- `pnpm lint` passes. scripts/package-smoke.mjs still passes.

Acceptance:

- The README describes shipped behavior only, and every docs finding in this slice links to its section.

Spec refs: BEH-EA-033, BEH-EA-035, BEH-EA-037

Depends on: none

**Recommended status:** `ready-for-agent`

#### NAM-007: Existing Auth.js sessions cannot be migrated — forced global re-authentication

`medium` · `dx` · `sql` · [.issues/medium/NAM-007-nextauth-authjs-migration-specialist.md](../../.issues/medium/NAM-007-nextauth-authjs-migration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence: medium) (fixed by `19a3e00`)

**Evidence at HEAD**

- `packages/ports/src/LegacySessionBridge.ts:3`: FIXED in mechanism (19a3e00): a generic legacy-session bridge port exists, so forced global re-login is no longer the only option. An Auth.js `sessions.sessionToken` lookup fits `resolve(rawToken)`.

  ```
  // BAM-003 (.issues/high): an optional, additive fallback `Sessions.verify`
  // consults only on a primary-store miss (a malformed token, or an id it
  // doesn't recognize) — the exact shape a "still-live better-auth session"
  // takes once effect-auth's own `id.secret` parsing rejects it outright.
  ```

- `packages/ports/src/PasswordHasher.ts:43`: FIXED in mechanism (60947ff): dual-format password verification exists, and migrate-auth0 ships a BcryptVerifier. STILL MISSING: an Auth.js-specific runbook/recipe. `grep -ri 'auth.js|nextauth' packages spec` finds only OAuth prose.

  ```
  // `LegacyPasswordVerifiers` below closes the "Known non-goal" this comment
  ```

**Fix plan** (effort S): Publish an Auth.js migration runbook built on the now-existing ports. No new package unless demand appears.

Steps:

1. Write docs/migrations/authjs.md (linked from the README). Cover: users/accounts ETL (Auth.js `provider` + `providerAccountId` → `providerId` + `subject`, with `issuer = ''` for non-OIDC and the provider issuer for OIDC); sessions, either dropped with a forced re-login or bridged with a ~30-line `LegacySessionBridge` implementation reading Auth.js's `sessions` table by `sessionToken` and checking `expires`, then minting an awthaq session (show the Layer); and Credentials-provider bcrypt hashes via `LegacyPasswordVerifiers` plus migrate-auth0's `BcryptVerifier`, with rehashOnLogin (Password.ts:850) upgrading them.
2. If a second Auth.js adopter appears, promote the recipe to `@awthaq/migrate-authjs`, mirroring migrate-better-auth. That is out of scope now.

Files: `docs/migrations/authjs.md (new)`, `packages/sql/README.md`

Tests (write first):

- Optional: a doc-snippet typecheck, i.e. put the bridge recipe in an examples/ file compiled by `pnpm run typecheck`.

Acceptance:

- An Auth.js adopter can migrate without forced re-login by following the doc.

Spec refs: BEH-EA-049, BEH-EA-050

Depends on: none

**Recommended status:** `ready-for-agent`

#### PPS-004: Zero connection-pool configuration for the shared PgClient anywhere in the repo

`medium` · `dx` · `sql` · [.issues/medium/PPS-004-postgres-performance-specialist.md](../../.issues/medium/PPS-004-postgres-performance-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/test/Repositories.postgres.test.ts:52`

  ```
    const SqlLive = PgClient.layer({ url: Redacted.make(postgresUrl ?? "") });
  ```

- `spec/overview.md:132`: This is the only wiring example, with no pool settings.

  ```
      Layer.provideMerge(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })))),
  ```

- `node_modules/.pnpm/@effect+sql-pg@4.0.0-rc.116_effect@4.0.0-rc.116/node_modules/@effect/sql-pg/src/PgClient.ts:139`: The pinned client exposes maxConnections/minConnections/idleTimeout/connectionTTL (:156-160) and `prepare`, which must be false under pgbouncer transaction pooling. None of it is documented for awthaq deployers.

  ```
     * Caches prepared statements by name. Enabled by default. Disable it for
     * poolers that cannot preserve named statements between queries.
     */
    readonly prepare?: boolean | undefined
  ```

**Fix plan** (effort S): Ship a documented, ops-ready PgClient recipe and update the spec example. Distinguishable pool-exhaustion errors are an upstream @effect/sql-pg concern and are out of scope.

Steps:

1. README 'Postgres client configuration': `PgClient.layerConfig({ url, maxConnections, minConnections, idleTimeout, connectionTTL, prepare })`. Size maxConnections as (server max_connections − headroom) / app instances. Under pgbouncer transaction mode, set `prepare: false` and do not rely on session state; DRS-001's `set_config(..., true)` is transaction-local and safe. Set `statement_timeout` at the role level (`ALTER ROLE <app> SET statement_timeout = '5s'`), since that works regardless of pooler.
2. Update spec/overview.md:132 to show maxConnections/idleTimeout in the example.
3. Optionally export a convenience config-driven layer from @awthaq/sql. Recommended only if the docs alone prove insufficient; don't build it speculatively.

Files: `packages/sql/README.md`, `spec/overview.md`

Tests (write first):

- `pnpm run spec:verify:strict` passes.

Acceptance:

- Deployers have explicit pool/timeout/pgbouncer guidance.

Depends on: none

**Recommended status:** `ready-for-agent`

#### PPS-006: No prepared-statement reuse: every hot statement is an unnamed template executed fresh

`low` · `performance` · `sql` · [.issues/low/PPS-006-postgres-performance-specialist.md](../../.issues/low/PPS-006-postgres-performance-specialist.md) · current status `needs-triage`

**Verdict:** INVALID (confidence: high)

**Evidence at HEAD**

- `node_modules/.pnpm/@effect+sql-pg@4.0.0-rc.116_effect@4.0.0-rc.116/node_modules/@effect/sql-pg/src/PgClient.ts:139`: The pinned @effect/sql-pg rc.116 auto-prepares and caches every statement by name by default (`run(query, params, prepare = true)`, :281). The tagged templates compile to stable SQL text, so hot statements are already reused. No `.prepare(` call is needed.

  ```
     * Caches prepared statements by name. Enabled by default. Disable it for
     * poolers that cannot preserve named statements between queries.
     */
    readonly prepare?: boolean | undefined
    /** How many statements a connection keeps prepared. Defaults to `100`. */
    readonly preparedStatementCacheSize?: number | undefined
  ```

- `packages/sql/node_modules/@effect/sql-sqlite-node/src/SqliteClient.ts:99`: The SQLite driver also caches prepared statements (a Cache at :160).

  ```
    readonly prepareCacheSize?: number | undefined
  ```

**No fix:** No work needed; the evidence refutes the claim.

**Recommended status:** `wontfix`

#### SSMS-006: Transactional, forward-only Migrator leaves no online index-creation path for post-GA migrations

`low` · `architecture` · `sql` · [.issues/low/SSMS-006-sql-schema-migration-specialist.md](../../.issues/low/SSMS-006-sql-schema-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/src/unstable/sql/Migrator.ts:308`: The whole pending batch runs in one transaction. Migrator.make's options (loader/schemaDirectory/table) have no per-migration non-transactional flag, so CREATE INDEX CONCURRENTLY is impossible through it.

  ```
        sql.withTransaction(run),
  ```

- `packages/sql/src/CoreMigrations.ts:233`: Indexes are created plainly, without IF NOT EXISTS, so an out-of-band pre-build would make the recorded migration fail.

  ```
        pg: () => sql`CREATE INDEX sessions_user_id ON sessions("userId")`,
  ```

**Fix plan** (effort S): Document an expand-phase runbook and adopt `IF NOT EXISTS` for every new index migration, so an operator can pre-build with CONCURRENTLY out of band and the recorded migration becomes a no-op.

Steps:

1. Convention: from now on, every new index migration uses `CREATE [UNIQUE] INDEX IF NOT EXISTS`. PPS-002, ALF-010 and SAM-003 already follow it in this plan. Add a comment block at the top of CoreMigrations.ts stating the convention.
2. README 'Migrating a populated database' runbook: (1) run `CREATE INDEX CONCURRENTLY IF NOT EXISTS <same name> ...` manually on the primary; (2) deploy, and Migrator records the migration while the `IF NOT EXISTS` no-ops; (3) for new NOT NULL columns, expand (nullable plus backfill) and then contract.
3. Don't fork Migrator. A non-transactional migration flag is an upstream Effect feature request, which this plan notes but does not include.

Files: `packages/sql/src/CoreMigrations.ts (comment)`, `packages/sql/README.md`

Tests (write first):

- packages/sql/test/Repositories.test.ts: "an index pre-created out of band does not break the recorded migration" (pre-create the PPS-002 index, then run coreMigrations and expect success).

Acceptance:

- A documented, tested zero-downtime index path exists.

Spec refs: BEH-EA-037

Depends on: none

**Recommended status:** `ready-for-agent`

#### ERAS-006: SQL repositories are structurally driver-neutral, but no edge-viable SqlClient story exists or is documented

`info` · `architecture` · `sql` · [.issues/info/ERAS-006-edge-runtime-auth-specialist.md](../../.issues/info/ERAS-006-edge-runtime-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high) (canonical for NAM-011)

**Evidence at HEAD**

- `packages/sql/package.json:31`: The boundary is drawn correctly, since the drivers are devDependencies. Nothing documents it, though.

  ```
    "devDependencies": {
      "@effect/platform-node": "catalog:",
      "@effect/sql-pg": "catalog:",
      "@effect/sql-sqlite-node": "catalog:",
  ```

- `../effect/packages/sql/libsql/src/LibsqlClient.ts:189`: Effect v4 ships sqlite-dialect edge drivers (sql-libsql, sql-d1 at D1Client.ts:202, sql-sqlite-do) and a WASM pg (sql-pglite, dialect 'pg'). CoreMigrations' sqlite branch therefore already covers them in principle, but this is untested and undocumented.

  ```
      const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
  ```

**Fix plan** (effort M): Document the edge/origin split and the driver matrix, and prove one HTTP-capable sqlite-dialect driver against the contract suite so the documentation isn't aspirational.

Steps:

1. README 'Runtimes & drivers' section. Edge (Workers/Vercel Edge) handles stateless verification (JWT via @awthaq/jwt) and presence checks. Origin (Node) handles SqlClient-backed sessions/users/credentials/migrations, unless an HTTP driver is used. The matrix: @effect/sql-pg and sql-sqlite-node (Node); sql-libsql (Turso, HTTP) and sql-d1 (Cloudflare) with the sqlite dialect; sql-pglite (WASM). MySQL is not supported (CoreMigrations `orElse` dies).
2. Add a dev-only contract run of packages/sql/test's shared cases against `@effect/sql-libsql` with a local file/in-memory URL, as a new devDependency. This proves that the sqlite-dialect migrations and repositories work over a non-node:sqlite driver. Check specifically whether `sql.withTransaction` (used by Migrator.ts:308) works on libsql, and document D1's lack of interactive transactions as a known limitation if the contract run can't cover D1.
3. Add an ADR or overview note on the edge/origin boundary (ERAS-006's ask).

Files: `packages/sql/README.md`, `packages/sql/package.json (devDependency @effect/sql-libsql)`, `packages/sql/test/Repositories.libsql.test.ts (new)`, `spec/overview.md`

Tests (write first):

- packages/sql/test/Repositories.libsql.test.ts: "coreMigrations and the repository contract pass on @effect/sql-libsql".

Acceptance:

- A documented, tested edge-capable persistence path exists, or a documented limitation.

Spec refs: ADR-EA-004, ADR-EA-014

Depends on: none

**Recommended status:** `ready-for-agent`

#### NAM-011: Edge-runtime core is WebCrypto-clean, but SQL persistence ships Node-only drivers

`info` · `architecture` · `sql` · [.issues/info/NAM-011-nextauth-authjs-migration-specialist.md](../../.issues/info/NAM-011-nextauth-authjs-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **ERAS-006**)

**Evidence at HEAD**

- `packages/sql/package.json:31`: Its title ('SQL persistence ships Node-only drivers') is overstated: the drivers are devDependencies, not shipped runtime deps. The real gap is the undocumented edge/HTTP-driver story, which is ERAS-006. The MySQL/PlanetScale remark is covered by ERAS-006's driver matrix.

  ```
    "devDependencies": {
      "@effect/platform-node": "catalog:",
      "@effect/sql-pg": "catalog:",
      "@effect/sql-sqlite-node": "catalog:",
  ```

**No fix:** Closed into ERAS-006; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

#### PPS-009: jsonb is used nowhere: opaque JSON payloads are stored as TEXT in Postgres

`info` · `architecture` · `sql` · [.issues/info/PPS-009-postgres-performance-specialist.md](../../.issues/info/PPS-009-postgres-performance-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/CoreMigrations.ts:155`: Still TEXT. auth_audit_log.payload (:313) and users.metadata (:347) follow the same choice.

  ```
            payload TEXT NOT NULL
  ```

- `packages/sql/src/CoreMigrations.ts:298`: The choice is reasoned in code comments but not in an ADR.

  ```
    // (ALF-001/ESA-001/ESS-002/CSG-004/EP-002): BEH-EA-100's durable audit
    // table. `payload` is an opaque JSON envelope, the same
    // `verification_tokens.payload` precedent migration 4 already
  ```

**Fix plan** (effort S): Record 'opaque JSON is TEXT on every dialect' as a deliberate decision. Plan no jsonb migration until a server-side query need exists.

Steps:

1. Add a short 'Consequences' paragraph to ADR-EA-004 (database-neutral models), or a new mini-ADR. Opaque, app-validated JSON columns (verification_tokens.payload, auth_audit_log.payload, users.metadata, organization metadata) are TEXT on both dialects via `Schema.fromJsonString`. A pg-only JSONB+GIN branch is added only when a feature must query payload contents server-side.
2. Reference it from the README 'Schema conventions' section (ESR-008).

Files: `spec/decisions/004-database-neutral-models.md`, `packages/sql/README.md`

Tests (write first):

- `pnpm run spec:verify:strict` passes.

Acceptance:

- The decision is discoverable, so it isn't re-reported as a bug.

Spec refs: ADR-EA-004

Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream `sql-contract-test-coverage`

#### SEA-004: All SQLite tests run :memory:, so the WAL configuration production gets is never exercised

`low` · `testing` · `sql` · [.issues/low/SEA-004-sqlite-embedded-auth-specialist.md](../../.issues/low/SEA-004-sqlite-embedded-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/test/Repositories.test.ts:27`

  ```
  const SqlLive = SqliteClient.layer({ filename: ":memory:" });
  ```

- `packages/sql/node_modules/@effect/sql-sqlite-node/src/SqliteClient.ts:150`: WAL is a no-op on :memory:, so production's journal mode is never exercised.

  ```
        if (options.disableWAL !== true) {
          db.exec("PRAGMA journal_mode = WAL")
  ```

**Fix plan** (effort M): Run the SQLite contract cases against a temp-file database as well, and add a two-connection contention test for the CAS primitives.

Steps:

1. Using ESR-009's extracted `contractCases(SqlLive)` helper, add a second SQLite describe block. It uses `SqliteClient.layer({ filename: <tmpdir>/awthaq-<uuid>.db })` (WAL active), a scoped temp dir via `@effect/platform-node` FileSystem, and deletes the file at scope close.
2. Contention tests: two independent SqliteClient layers on the same file, both running coreMigrations once. Race `SessionsRepository.touch` with the same expectedSecretHash (exactly one `Some`) and `VerificationReservationsRepository.claim` (exactly one `true`). Configure a busy timeout if the driver exposes it, and assert no `SQLITE_BUSY` leaks as a defect.

Files: `packages/sql/test/Repositories.test.ts`, `packages/sql/test/Repositories.file.test.ts (new)`

Tests (write first):

- "file-backed WAL database: journal_mode is wal" (`PRAGMA journal_mode`); "two connections racing touch: exactly one rotates"; "two connections racing claim: exactly one wins".

Acceptance:

- The CAS/claim atomicity is proven across connections on a WAL file.

Spec refs: BEH-EA-052, BEH-EA-063

Depends on: ESR-009

**Recommended status:** `ready-for-agent`

#### SEA-005: TEXT timestamp ordering correctness rests on an implicit fixed-width ISO encoding invariant

`low` · `correctness` · `sql` · [.issues/low/SEA-005-sqlite-embedded-auth-specialist.md](../../.issues/low/SEA-005-sqlite-embedded-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence: high)

**Evidence at HEAD**

- `packages/sql/src/Repositories.ts:440`: On SQLite, TEXT comparison is correct only for fixed-width ISO-8601 Z strings, and nothing asserts that invariant. TS-001's factory keeps SQLite on string encoding, so the invariant persists.

  ```
                    AND ("createdAt" > ${request.cursorCreatedAt}
                         OR ("createdAt" = ${request.cursorCreatedAt} AND id > ${request.cursorId}))
  ```

- `packages/sql/src/Repositories.ts:526`: Hand-encoded call sites, like this one and verifyEmail's `encodedNow` at :94, are exactly where a divergent format could slip in.

  ```
          sql`UPDATE sessions SET "reusedAt" = ${Schema.encodeSync(Schema.DateTimeUtcFromString)(reusedAt)} WHERE "id" = ${id}`.pipe(
  ```

**Fix plan** (effort S): Pin the encoding invariant with contract tests. STRICT tables are rejected: they enforce only the TEXT type, not the format, and need table rebuilds.

Steps:

1. Add a test helper that reads raw timestamp columns (`SELECT "createdAt", "expiresAt", "reusedAt" ...`) after exercising every write path (insert, touch, tombstone, markReused, reauthenticate, upsertLive, tryConsume, claim, AuditLog.insert, verifyEmail). Assert each against `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`.
2. Add an ordering test: insert sessions at timestamps spanning a second boundary and a .999→.000 rollover, and assert that listByUser order equals epoch order.
3. Route hand-encoded sites through one shared `encodeUtc` helper, or through TS-001's dialect field, so there is a single encoder.

Files: `packages/sql/test/Repositories.test.ts`, `packages/sql/src/Repositories.ts`

Tests (write first):

- "every persisted SQLite timestamp is fixed-width ISO-8601 UTC with milliseconds"; "keyset order equals epoch order across second and millisecond rollovers".

Acceptance:

- Any encoding drift fails the suite loudly.

Spec refs: BEH-EA-036

Depends on: none

**Recommended status:** `ready-for-agent`

### Workstream `migration-wiring`

#### SSMS-005: No shipped wiring ever runs coreMigrations

`medium` · `dx` · `sql` · [.issues/medium/SSMS-005-sql-schema-migration-specialist.md](../../.issues/medium/SSMS-005-sql-schema-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence: high) (duplicate of **BE-003**)

**Evidence at HEAD**

- `packages/sql/src/index.ts:10`: True at HEAD. `grep -rn coreMigrations packages/*/src` finds only its definition, and packages/cli/src/index.ts is an empty placeholder. Ticket 07 (BE-003, cross-slice) already decided that `migration apply` concatenates `CoreMigrations.coreMigrations` ahead of `Auth.make(...).migrations`.

  ```
  // Planned next: migration records/linker input (BEH-EA-037/038).
  ```

- `packages/core/src/Migrations.ts:55`: IMPORTANT for BE-003's implementer: plugin migrations are numbered from 1 and use the same default tracking table (`effect_sql_migrations`, Migrator.ts:111) as coreMigrations' ids 1-17. Migrator skips any id ≤ the latest applied (Migrator.ts:251), so running both separately would silently skip plugin migrations 1-17. Array-index ids also shift when a plugin is added mid-order. The combined runner must use one concatenated, stable id space or separate tracking tables per owner.

  ```
    Migrator.make({})({
      loader: Effect.succeed(
        migrations.map((m, i): Migrator.ResolvedMigration => [i + 1, m.name, Effect.succeed(m.up)]),
      ),
    });
  ```

**No fix:** Closed into BE-003; its remaining asks are folded into that plan.

**Recommended status:** `resolved`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| NAM-011 | info | DUPLICATE → ERAS-006 | Its title ('SQL persistence ships Node-only drivers') is overstated: the drivers are devDependencies, not shipped runtime deps. | `packages/sql/package.json:31` |
| SEA-006 | low | DUPLICATE → PPS-002 | Same root cause as PPS-002 (a single-column index under a (createdAt, id) keyset). | `packages/sql/src/CoreMigrations.ts:234` |
| SSMS-009 | info | DUPLICATE → DRS-001 | Same gap as DRS-001. | `packages/sql/src/CoreMigrations.ts:59` |
| ESS-011-effect-schema-specialist | info | DUPLICATE → MA-008 | Same double declaration as MA-008. | `packages/sql/src/Models.ts:11` |
| BCR-009 | low | WONTFIX-CANDIDATE | True, but only relevant if backup codes are stored as verification tokens. | `packages/sql/src/Models.ts:225` |
| ESR-004 | medium | DUPLICATE → SMS-002-secrets-management-specialist | Same `Effect.orDie` at Repositories.ts:227. | `packages/sql/src/Repositories.ts:225` |
| KRS-003 | medium | DUPLICATE → SMS-002-secrets-management-specialist | Same `Effect.orDie`. | `packages/sql/src/Repositories.ts:225` |
| TS-005-tim-smart | low | DUPLICATE → SMS-002-secrets-management-specialist | Same `Effect.orDie`. | `packages/sql/src/Repositories.ts:225` |
| PPS-008 | low | WONTFIX-CANDIDATE | True, but not worth actioning. | `packages/sql/src/Repositories.ts:296` |
| SSMS-008 | low | DUPLICATE → PPS-002 | Identical recommendation to PPS-002 (a sessions("userId", "createdAt", id) composite). | `packages/sql/src/CoreMigrations.ts:233` |
| PPS-006 | low | INVALID | The pinned @effect/sql-pg rc.116 auto-prepares and caches every statement by name by default (`run(query, params, prepare = true)`, :281). | `node_modules/.pnpm/@effect+sql-pg@4.0.0-rc.116_effect@4.0.0-rc.116/node_modules/@effect/sql-pg/src/PgClient.ts:139` |
| SSMS-003 | medium | DUPLICATE → PPS-003 | Same query and root cause as PPS-003. | `packages/sql/src/Repositories.ts:644` |
| ESR-005 | low | DUPLICATE → PPS-003 | Same query as PPS-003. | `packages/sql/src/Repositories.ts:644` |
| RRC-007 | info | WONTFIX-CANDIDATE | A positive observation that still holds. | `packages/sql/src/Repositories.ts:684` |
| ESR-007 | low | ALREADY-FIXED (b8d6177) | b8d6177 (TS-002) replaced the unconditional literal with a dialect branch. | `packages/sql/src/Repositories.ts:103` |
| SSMS-007 | low | ALREADY-FIXED (b8d6177) | The pg branch now writes TRUE, which was this finding's own first recommended option (commit b8d6177, TS-002). | `packages/sql/src/Repositories.ts:105` |
| SSMS-005 | medium | DUPLICATE → BE-003 | True at HEAD. | `packages/core/src/Migrations.ts:55` |

## Cross-slice notes

- **BE-003 (cli):** SSMS-005 duplicates it. Its implementer must avoid the tracking-id collision between `coreMigrations` (ids 1-17) and `Migrations.run`'s index-numbered plugin migrations, which share `effect_sql_migrations`. Migrator skips any id ≤ the latest applied, so running both separately would silently skip plugin migrations.
- **KRS-002 (ports):** a prerequisite for SMS-002-secrets' rotation half and lazy re-encryption.
- **CSG-003 (retention):** owns the session reaper (SMS-002-session), verification-history purge (PPS-003) and the base `Retention` service that ALF-010 extends.
- **BAM-005 (admin, ticket 19):** the `banned` gate overlaps SCP-001's `status`, so co-implement them.
- **Two-factor build (ticket 05: AOMS-003/THS-001/ARF-005):** BCR-002's primitives land there.
- **TS-001 defect class in plugin stores:** admin ImpersonationRecords, jwt RevocationStore/SigningKeyRecords, organization *Records, passkey PasskeyCredentials/ChallengeStore and migrate-better-auth LegacySessionBridgeLive all use `DateTimeUtcFromString`/`BooleanFromBit` and will fail pg decode the same way.
- **Ticket 27 (observability)** wrongly assumed hand-written queries get named spans. EOTS-008 fills that gap.
- **Ticket 28 (read replica)** names a non-existent `SessionsRepository.findByTokenHash`. RRC-001's plan corrects the primary-pinned list against HEAD.
