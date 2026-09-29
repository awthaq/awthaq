# Slice 06-server-api — validation & fix plan

- **Validated at:** `ec065a7` (HEAD) on 2026-09-29
- **Manifest:** `.plan/_manifests/06-server-api.tsv` (60 issues, packages `server` + `api`)
- **Companion:** `.plan/slices/06-server-api.json` (machine-readable, same content)

## Counts (verdict × level)

| Verdict | high | medium | low | info | Total |
|---|---|---|---|---|---|
| CONFIRMED | 1 | 10 | 10 | 0 | 21 |
| PARTIAL | 2 | 3 | 6 | 0 | 11 |
| ALREADY-FIXED | 0 | 3 | 2 | 1 | 6 |
| INVALID | 0 | 0 | 0 | 0 | 0 |
| DUPLICATE | 1 | 10 | 6 | 3 | 20 |
| WONTFIX-CANDIDATE | 0 | 0 | 0 | 2 | 2 |
| **Total** | 4 | 26 | 24 | 6 | 60 |

## Summary

The HTTP stratum is in better shape than the 2026-09-19 audit suggests. CSRF is now attached to every mutating group (409334e), and account deletion is transactional and uses `revokeAll` (e940a12, ec065a7). Those two commits close seven findings outright (CDS-004, CDS-005, PDR-007, TS-004, CSG-007, TRBS-008, and the transaction halves of SEA-001/SSMS-002). Four real problem clusters remain. (1) **Session-secret rotation is lossy.** The new secret is delivered only on a *successful* Path A response. Path-B-only routes discard it (PIL-005). Validation also found that any handler returning a typed error at a touch boundary drops it, because `deliverRotation` is chained on the handler's success. No client reads `set-auth-token` (MNA-005). With 'no grace window' already decided, each of these is a silent logout. (2) **The per-request verify cache** is not single-flight, and it is keyed on the request *wrapper*, which HttpRouter's prefix mounts replace (TS-003, NHS-006). (3) **The account lifecycle is incomplete for GDPR.** Several plugin tables are unswept, erasure taps are opt-in, audit and impersonation retention is undecided, and there is no data export (CSG-001, CSG-005). (4) **Contract honesty and hygiene.** Nothing expires the session cookie on sign-out (CSS-002). OptionalAuthentication advertises a 401 it cannot produce (EHA-006). Decision 24's bearer exemption was never implemented, so bearer clients get 403 on every mutating core endpoint (MNA-008). There is no CORS posture, the HMAC code is duplicated, and signing secrets are neither Config-loaded nor length-checked. Three clusters are cross-slice duplicates: core-group composition (MW-002), M2M principals (MAPS-003), and the observability substrate (MW-001).

## Workstreams

### `gdpr-erasure-export` — GDPR erasure completeness + data-subject export

- **IDs:** CSG-001, DRS-002, SEA-001, SSMS-002, TS-004-tim-smart, CSG-007, TRBS-008, CSG-005
- **Order hint:** 1 · **Effort:** XL
- **Depends on:** hook-registry-scoping (ELC-001, slice 02)
- **Why grouped:** One root cause: there is no complete, domain-level account lifecycle for personal data. The transactional cascade exists (e940a12) and passkey/membership taps exist (ec065a7), but the cascade lives in the HTTP handler, several plugin tables are unswept, the taps are opt-in, audit retention is undecided, and there is no Art. 15/20 export.
- **Ordered steps:**
  1. CSG-001 steps 1-3: Users.eraseAccount in core (decision 30) plus a one-call handler.
  2. CSG-001 step 4: organization team membership/invitation/active-context taps (coordinate with DRS-008).
  3. CSG-001 step 5: wire erasure layers by default (examples, TestAuth, README).
  4. SEA-001: the FK-less invariant in spec plus a SQL rollback test.
  5. After the decision: audit/impersonation pseudonymization (CSG-001 step 6).
  6. After the decision: CSG-005 export endpoint over a DataExport registry.
- **Test plan:** packages/core/test/AccountErasure.test.ts (cascade + rollback on sqlite), OrganizationErasure additions, the AuthHttp DELETE /user and GET /user/export wire tests.
- **Acceptance:** No PII row survives DELETE /user in a default composition; the cascade is atomic on SQL; the user can export all their data as JSON.

### `per-request-session-cache` — Per-request session-resolution cache: atomic, keyed on request.source

- **IDs:** TS-003-tim-smart, ECF-005, NHS-006, ELC-007, PCS-006
- **Order hint:** 2 · **Effort:** M
- **Depends on:** —
- **Why grouped:** Four findings describe one small module-level cache: non-atomic get-or-create (TS-003/ECF-005), wrapper-identity keying (NHS-006), and documentation of its requirement and staleness (ELC-007/PCS-006). It must land before the rotation-delivery rework, which lives in the same owner branch.
- **Ordered steps:**
  1. TS-003: Deferred-based single-flight get-or-create in one Effect.sync, keyed on request.source.
  2. NHS-006: rewrite the invariant comment and add the re-wrap test.
  3. ELC-007 + PCS-006: doc comments and the BEH-EA-070 staleness note.
- **Test plan:** Concurrent single-flight, modify()-re-wrap hit, interruption no-hang (packages/server/test/Authentication.test.ts).
- **Acceptance:** Sessions.verify runs at most once per underlying request and credential under any interleaving or wrapper re-creation.

### `wire-constant-single-source` — Single source for session cookie name and rotation header

- **IDs:** CSS-007, EHA-008, MW-009, BE-009
- **Order hint:** 2 · **Effort:** S
- **Depends on:** httpapi-surface-consolidation (MW-002, slice 01) adds the same core->api dependency; coordinate
- **Why grouped:** Four findings about the same duplicated literal. The CSRF-name half is refuted. It is a prerequisite for rotation delivery (ROTATED_TOKEN_HEADER) and the CORS preset.
- **Ordered steps:**
  1. CSS-007: api owns SESSION_COOKIE_NAME + ROTATED_TOKEN_HEADER; core derives from them; tests use the constants.
- **Test plan:** core/test/Sessions.test.ts equality assertion; knip + madge clean.
- **Acceptance:** One literal in src; the rename is one line.

### `session-rotation-delivery` — Rotated-secret delivery on every path + bearer client capture

- **IDs:** PIL-005, MNA-005, CTA-006, PIL-009, NHS-007, MAPS-008
- **Order hint:** 3 · **Effort:** L
- **Depends on:** per-request-session-cache, wire-constant-single-source, observability-substrate (MW-001, slice 02) for the redaction step only
- **Why grouped:** Rotation (ticket 01, no grace window) is only safe if the new secret always reaches the client. Today it is lost on Path B (PIL-005), on typed-error responses (new, found during validation), and on bearer clients that do not read set-auth-token (MNA-005). The exposure hygiene (MAPS-008) and the orDie concern (NHS-007) touch the same code.
- **Ordered steps:**
  1. PIL-005: move delivery into an appendPreResponseHandler inside the memoized verify; pass scheme from Path A/B; delete deliverRotation.
  2. NHS-007: non-fatal recovery in the pre-response handler.
  3. MAPS-008: Cache-Control: no-store; redact set-auth-token in AuthHttp logger/tracer presets.
  4. MNA-005: Api.ROTATED_TOKEN_HEADER, client BearerTokenStore + bearerTransformClient, docs.
- **Test plan:** The Path-B rotation Set-Cookie test (qadi), the rotation-on-error-response test, exactly-once delivery, client capture (packages/client/test).
- **Acceptance:** A client never loses a rotated secret, whatever the route style or handler outcome; the shipped bearer client survives rotations with zero app code.

### `bearer-credential-extensibility` — Bearer credential seam: JWT re-entry (decision 33) + multi-contributor registry

- **IDs:** MAPS-001, JR-004, AGA-003, VB-008, MAPS-004
- **Order hint:** 4 · **Effort:** L
- **Depends on:** per-request-session-cache, session-rotation-delivery, m2m-identity (MAPS-003, slice 09) for the api-key contributor
- **Why grouped:** Several findings share one root: Authentication resolves only opaque session secrets, so minted JWTs cannot re-enter (MAPS-001, JR-004, AGA-003, VB-008), and no seam exists for new credential types (MAPS-004).
- **Ordered steps:**
  1. MAPS-001 per decision 33: BearerCredentialResolver, shape routing, jwt acceptAsBearer, signJWT audience, README.
  2. MAPS-004 (after decision): generalize to a claims()-keyed registry; jwt is the first contributor, api-key the second.
- **Test plan:** Authentication.test.ts routing tests; jwt AuthHttp acceptAsBearer on/off/foreign-audience tests.
- **Acceptance:** A JWT is accepted as bearer only when opted in; any plugin can add a bearer credential type with a Layer.

### `csrf-hardening` — CSRF: bearer exemption (decision 24 §2) + time-bound tokens

- **IDs:** MNA-008, CDS-006, CDS-005, CDS-004, PDR-007
- **Order hint:** 5 · **Effort:** M
- **Depends on:** hmac-secret-hygiene
- **Why grouped:** CSRF is now attached everywhere (409334e), which closed CDS-004/CDS-005/PDR-007. The decided bearer exemption was skipped, so native clients get 403 today (MNA-008), and tokens never expire (CDS-006).
- **Ordered steps:**
  1. MNA-008: authorization-header exemption plus a spec sub-requirement (ship first; it is a live break).
  2. CDS-006: iat-signed tokens, maxAge, proactive re-mint.
- **Test plan:** Csrf.test.ts bearer-pass / cookie-still-rejected; the AuthHttp bearer sign-out 204 test; TestClock expiry tests.
- **Acceptance:** Bearer clients are unaffected by CSRF; cookie flows are protected; no token is valid past maxAge.

### `hmac-secret-hygiene` — Shared HMAC primitive + signing-secret policy

- **IDs:** ACS-005, ACS-007, SMS-004-secrets-management-specialist
- **Order hint:** 5 · **Effort:** M
- **Depends on:** —
- **Why grouped:** The HMAC code is hand-rolled and duplicated (ACS-005), there is no key-length floor (ACS-007), and there is no Config-backed loading (SMS-004). All three concern the same secrets.
- **Ordered steps:**
  1. ACS-005: packages/ports/src/Hmac.ts with RFC 4231 + oracle property tests; replace all copies.
  2. ACS-007: requireMinSecretBytes at CSRF (and passkey, slice 10) layer build.
  3. SMS-004: Csrf.layerConfig reading AWTHAQ_CSRF_SECRET/ORIGINS.
- **Test plan:** ports Hmac tests; Csrf weak-secret and layerConfig tests.
- **Acceptance:** One HMAC implementation; no weak or literal secrets on the default path.

### `session-cookie-expiry` — Expire __Host-session when the caller's own session ends

- **IDs:** CSS-002, IC-002, NSA-004, SMS-005-session-management-specialist
- **Order hint:** 6 · **Effort:** M
- **Depends on:** —
- **Why grouped:** Four findings describe the same missing Set-Cookie expiry on signOut/revokeAll/revoke-self/deleteUser.
- **Ordered steps:**
  1. CSS-002: an expireSessionCookie helper (appendPreResponseHandler + HttpServerResponse.expireCookie) called from the four handlers.
  2. Update the api comment and spec BEH-EA-055; hand the Next test and recipe to slice 11.
- **Test plan:** AuthHttp.test.ts Set-Cookie Max-Age=0 assertions on each endpoint, plus the negative case.
- **Acceptance:** Every self-ending endpoint expires the cookie with valid __Host- attributes.

### `session-handler-hardening` — Session/account handler correctness and typing

- **IDs:** GC-005, GC-003, EHA-009, GC-008
- **Order hint:** 7 · **Effort:** M
- **Depends on:** session-cookie-expiry
- **Why grouped:** The same two handler modules: ownership in the algebra (GC-005, which also fixes the 200-row revoke cap), a single brand re-entry point (GC-003), the race returning 500 (EHA-009), and untagged defects (GC-008).
- **Ordered steps:**
  1. GC-005: Sessions.revokeOwned (+ repo deleteOwned), single-call revoke handler.
  2. GC-003: internal/CurrentUser.ts replaces both currentUserPrincipal copies and 12 casts.
  3. GC-008: HandlerInvariantViolation tagged defect.
  4. EHA-009: typed 401 + cookie expiry on the missing-current-row race.
- **Test plan:** Sessions revokeOwned tests (both layers), AuthHttp 201-sessions revoke, the race-to-401 test, the tagged-defect test.
- **Acceptance:** No list-then-act, no plain Error, no casts outside CurrentUser; the race answers 401.

### `optional-auth-contract` — Authentication middleware wire contract (OpenAPI, ordering, challenges)

- **IDs:** EHA-006, NHS-010, JR-007
- **Order hint:** 8 · **Effort:** M
- **Depends on:** bearer-credential-extensibility (sequence only: both edit the bearer handler)
- **Why grouped:** The declared contract is dishonest or incomplete in three ways: an impossible 401 on OptionalAuthentication (EHA-006), a positional coupling of the anonymous fallback (NHS-010), and no WWW-Authenticate challenge (JR-007).
- **Ordered steps:**
  1. EHA-006: error-free OptionalAuthentication with in-handler cookie, then bearer, then anonymous fallback.
  2. NHS-010: comment fixes plus the key-order test.
  3. JR-007: WWW-Authenticate via a pre-response handler on the final 401.
- **Test plan:** OpenAPI 401-absence test, the BEH-EA-068 regression suite, WWW-Authenticate header tests.
- **Acceptance:** OpenAPI matches behavior; reordering keys fails a test; 401s carry RFC-compliant challenges.

### `authn-failure-observability` — Observable session-verification failures

- **IDs:** EOTS-003
- **Order hint:** 9 · **Effort:** S
- **Depends on:** per-request-session-cache, observability-substrate (MW-001, slice 02)
- **Why grouped:** EOTS-003's remaining half is silent verify failures in resolveSession. It should use MW-001's field vocabulary and metrics once they exist.
- **Ordered steps:**
  1. EOTS-003: debug log with reason/scheme (no credential or id); metric when Observability.ts lands.
- **Test plan:** Captured-Logger tests: logged with reason; no credential material; nothing for empty credentials.
- **Acceptance:** Credential-stuffing against sessions is visible in logs and metrics without leaking secrets.

### `cors-posture` — Documented default-deny CORS + blessed preset sharing CSRF origins

- **IDs:** AGA-002, CDS-008
- **Order hint:** 10 · **Effort:** M
- **Depends on:** wire-constant-single-source, csrf-hardening
- **Why grouped:** AGA-002 and CDS-008 describe the same gap.
- **Ordered steps:**
  1. AGA-002: AuthHttp.cors built from CsrfConfig.allowedOrigins, exposing set-auth-token and allowing x-csrf-token; a spec BEH; a README recipe.
- **Test plan:** Preflight allowed/denied, expose-headers, CSRF-still-enforced tests.
- **Acceptance:** Cross-origin works with one layer; the CORS and CSRF allowlists cannot diverge.

### `api-contract-tests` — Direct tests + precise schemas for the contract stratum

- **IDs:** ETVS-003, MW-008
- **Order hint:** 11 · **Effort:** M
- **Depends on:** —
- **Why grouped:** @awthaq/api has no tests (ETVS-003), and SessionDto dates are untyped strings (MW-008).
- **Ordered steps:**
  1. ETVS-003: packages/api/test/{Api,Contracts}.test.ts; wire BEH-EA-025..029 BDD where cheap.
  2. MW-008: DateTimeUtcFromString for SessionDto timestamps.
- **Test plan:** The new api test files.
- **Acceptance:** The api package has direct tests; the date contract is enforced and documented.

### `qadi-attribute-typing` — Typed attribute names for qadi policies

- **IDs:** AAPS-003
- **Order hint:** 12 · **Effort:** M
- **Depends on:** attributeresolver-registry (AAPS-002, slice 08)
- **Why grouped:** AAPS-003's actionable part lives in @awthaq/qadi and ../qadi, on top of decision 14.
- **Ordered steps:**
  1. AAPS-003: UserAttributes registry + typed helper; unknown-name diagnostic in ../qadi.
- **Test plan:** Type-level typo test; qadi evaluator diagnostic test.
- **Acceptance:** Attribute-name typos are caught at compile time or produce a distinct diagnostic.

### `httpapi-surface-consolidation` — (cross-slice) Fold core groups into Auth.make — canonical MW-002, slice 01

- **IDs:** AVS-002, BE-006, EHA-004
- **Order hint:** 99 · **Effort:** n/a (see MW-002)
- **Depends on:** —
- **Why grouped:** AVS-002, BE-006 and EHA-004 duplicate MW-002; decision 26 is the plan. No work in this slice.
- **Ordered steps:**
  1. See MW-002 in slice 01.
- **Test plan:** See MW-002.
- **Acceptance:** See MW-002.

### `m2m-identity` — (cross-slice) M2M principals + api-key — canonical MAPS-003, slice 09

- **IDs:** OCM-003
- **Order hint:** 99 · **Effort:** n/a (see MAPS-003)
- **Depends on:** —
- **Why grouped:** OCM-003 duplicates MAPS-003; decision 10 is the plan. The Api.ts scopes field is noted there.
- **Ordered steps:**
  1. See MAPS-003 in slice 09.
- **Test plan:** See MAPS-003.
- **Acceptance:** See MAPS-003.

### `observability-substrate` — (cross-slice) Observability substrate — canonical MW-001, slice 02

- **IDs:** NHS-008
- **Order hint:** 99 · **Effort:** n/a (see MW-001)
- **Depends on:** —
- **Why grouped:** NHS-008 duplicates MW-001; decision 27 is the plan.
- **Ordered steps:**
  1. See MW-001 in slice 02.
- **Test plan:** See MW-001.
- **Acceptance:** See MW-001.

## Decisions needed

### CSG-005 — No data-subject access or portability export path in the HTTP surface

- (a) Core-only export now (user, accounts, sessions); plugin sections later.
- (b) A `DataExport` aggregating registry (ADR-EA-012) that plugins contribute sections to, mirroring the erasure contract. Built-in core sections plus passkey/organization contributions.
- (c) Reuse Hooks (a new observe/veto point). This is a poor fit, because hooks cannot return data.

**Recommendation:** (b). It is the richer, configurable option and gives every current and future PII-holding plugin one obvious place to declare its data. Decision 30 explicitly left export undecided ('noted as a natural next step').

### MAPS-004 — Auth scheme chain is a closed two-key record - no seam for new credentials

- (a) A registry of bearer resolvers keyed by a claims() predicate (recommended).
- (b) Keep decision 33's single Context.Reference; later contributors must wrap the previous resolver by hand. This is fragile, and the last provider silently wins.
- (c) Add a third HttpApiSecurity scheme (e.g. an x-api-key header) to Api.Authentication. This requires editing the contract for every new credential type, and spec/models/07 hints at it.

**Recommendation:** (a). Decision 33 fixed the JWT case but did not address multiple bearer contributors, and decision 10 (api-key) needs a second one. A registry is the flexible option and uses an extension-point kind the repo already has (ADR-EA-012).

### CSG-001 — Erasure cascade covers only core tables; plugin-owned PII survives account deletion

- (a) Pseudonymize: keep admin_impersonation and AuditLog rows for SOC2 retention, but replace the erased userId/email with an irreversible tombstone (e.g. HMAC(userId, per-deployment salt)) inside the same transaction. This meets GDPR Art. 17 and keeps the audit trail's shape.
- (b) Hard-delete the rows that name the user, which loses the audit trail.
- (c) Retain unchanged under a documented Art. 17(3)(b)/(e) legal-obligation exemption, configurable per deployment.

**Recommendation:** (a) pseudonymization by default, with (c) available as an explicit ErasureConfig opt-in (the richer, configurable option). The mechanical steps 1-5 do not depend on this decision and can start now.

Existing decisions followed, not re-litigated: #30 (erasure via core `Users.eraseAccount`; the landed `Hooks.BeforeUserDelete` veto point provides the registry semantics), #33 (JWT-as-bearer), #24 §2 (CSRF bearer exemption), #26 (Auth.make core groups, via MW-002), #10 (M2M, via MAPS-003), #27 (observability, via MW-001), #16 and upstream-hardening ticket 01 (rotation always-on, **no grace window** — this rules out the grace-window options in PIL-005 and PIL-009).

## Per-issue dossiers

### Workstream `gdpr-erasure-export`

#### CSG-001 — Erasure cascade covers only core tables; plugin-owned PII survives account deletion

`high` · `compliance` · `server` · [.issues/high/CSG-001-compliance-soc2-gdpr-specialist.md](../../.issues/high/CSG-001-compliance-soc2-gdpr-specialist.md) · current status `ready-for-agent`

**Verdict:** PARTIAL (confidence high) — canonical for DRS-002

Much of the finding is fixed at HEAD: the transaction (e940a12), revokeAll (ec065a7), the verification sweep (704cdd4), and passkey + org-membership taps (ec065a7, opt-in). Still open: team membership, invitations (plaintext email), active context, impersonation/audit retention, taps not wired by default, and the cascade still living in the HTTP handler (decision 30).

**Evidence at HEAD:**

- `packages/server/src/Account.ts:103` — Cascade is transactional since e940a12.

  ```ts
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* accounts.deleteAllByUser(userId);
  ```

- `packages/server/src/Account.ts:112` — Sentinel SessionId("") replaced by revokeAll in ec065a7; verification tokens swept since 704cdd4 (BCR-003).

  ```ts
                yield* sessions.revokeAll(userId);
                yield* verification.deleteAllByUser(userId);
  ```

- `packages/server/src/Account.ts:95` — Remaining PII gaps self-documented at HEAD. Also: organization_active_context (no userId column) and AuditLog rows (actorUserId + full event payload, packages/core/src/AuditLog.ts:44-49).

  ```ts
        // `organization_membership`) inside this same transaction. Still
        // open, deliberately scoped out (see CSG-001's own resolution
        // comment): `organization_team_membership`, `organization_invitation`,
        // and `admin_impersonation` (the last a genuine audit-retention
        // tension, not a mechanical gap).
  ```

- `packages/organization/src/Organization.ts:2393` — Plugin erasure taps are separate opt-in layers; `grep -rln beforeUserDeleteErasure examples packages/test/src README.md` finds no wiring, so a default composition still leaves passkey/membership PII behind.

  ```ts
   * `Organization.beforeUserDeleteErasure` once, application-wide — the
  ```

- `packages/server/src/Account.ts:100` — Cascade still lives in the HTTP handler, not in a core domain service (decision 30 asks for Users.eraseAccount).

  ```ts
        deleteUser: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          const userId = Users.UserId(principal.ref.id);
  ```

**Fix plan** (effort **L**): Finish the erasure cascade per decision 30: move it into a core domain service, populate the remaining plugin taps, make the taps part of every default composition, and settle audit-record retention.

Steps:
1. Follow .scratch/resolve-ready-for-human-findings/issues/30-data-retention-gdpr-erasure.md: add `Users.eraseAccount(userId)` in packages/core (in `Users.ts`, or a sibling `packages/core/src/AccountErasure.ts` if adding Accounts/Sessions/Verification to the Users layer's requirements creates a layer cycle). It runs accounts.deleteAllByUser, verification.deleteAllByUser, users.delete (which fires Hooks.BeforeUserDelete), then sessions.revokeAll, all inside one `SqlTransaction.withTransaction`, piped through `Effect.orDie` for SqlError as today. Running users.delete before revokeAll is deliberate, so taps can still see the user's live session ids (needed for organization_active_context). The transaction keeps the order unobservable.
2. Keep `Hooks.BeforeUserDelete` (a veto point, so a failing tap aborts the transaction) as the contribution mechanism that decision 30 calls 'ErasureRegistry'. The landed code (ec065a7) already gives it the same abort-on-failure semantics, and spec/behaviors/12-hooks.md:133 prescribes it. Do not add a second registry.
3. Shrink packages/server/src/Account.ts `deleteUser` to `currentUser` extraction plus one `Users.eraseAccount(userId)` call, and drop its direct Accounts/Sessions/Verification/SqlTransaction requirements.
4. @awthaq/organization: add `TeamMembershipRecords.deleteAllByUser`, an `InvitationRecords` sweep (rows where inviterId = userId OR email = the deleted user's email; the BeforeUserDelete input already carries both), and an `organization_active_context` sweep keyed by the user's live session ids (read via Sessions.list before revokeAll runs). Extend `Organization.beforeUserDeleteErasure` to call all three. Coordinate with DRS-008 (slice 10), which may add a userId column instead.
5. Make erasure the default rather than opt-in: wire `Passkey.beforeUserDeleteErasure` and `Organization.beforeUserDeleteErasure` into examples/memory-server/index.ts, packages/test/src/TestAuth.ts, and the README quickstart now. Once ELC-001 (module-scoped tap registry, slice 02) is fixed, merge each into its plugin's own `.layer`.
6. admin_impersonation and AuditLog rows: implement whichever option the decision picks (the recommendation is pseudonymization, see decision_options).
7. Add an ADR (spec/decisions/017-retention-and-erasure.md, the next free number) recording eraseAccount + BeforeUserDelete as the erasure contract. Cross-reference it from spec/behaviors/12-hooks.md.

Files: `packages/core/src/Users.ts (or new packages/core/src/AccountErasure.ts)`, `packages/server/src/Account.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/TeamMembershipRecords.ts (or the file holding team membership records)`, `packages/organization/src/InvitationRecords.ts`, `packages/admin/src/*.ts (impersonation record pseudonymization)`, `packages/core/src/AuditLog.ts`, `examples/memory-server/index.ts`, `packages/test/src/TestAuth.ts`, `README.md`, `spec/decisions/017-retention-and-erasure.md (new)`

Tests (write first):
- packages/core/test/AccountErasure.test.ts (new, write first): 'eraseAccount removes user, accounts, sessions, verification rows and runs every BeforeUserDelete tap'; 'a failing tap rolls back every prior delete' against Sessions/Accounts layerSql on sqlite :memory: with SqlTransaction.layerSql.
- packages/organization/test/OrganizationErasure.test.ts: add 'Users.delete sweeps team memberships', '...sweeps invitations sent by or addressed to the user', '...sweeps active context rows for the user's sessions'.
- packages/server/test/AuthHttp.test.ts (Account describe, ~:336): DELETE /user through the composed router with passkey+organization erasure layers wired leaves zero rows in every PII table.
- BDD: add a scenario to the account/erasure feature if one exists (features/features/**) or record the gap in spec/traceability.md.

Acceptance:
- After DELETE /user, no row referencing the userId or the user's email remains in users, accounts, sessions, verification_tokens, passkey_credential, organization_membership, organization_team_membership, organization_invitation, or organization_active_context.
- admin_impersonation/audit rows follow the decided policy.
- A tap failure leaves the database unchanged (the test proves rollback on SQL).
- Account.ts no longer requires SqlTransaction/Accounts/Sessions/Verification directly.
- pnpm check passes.

Spec refs: BEH-EA-022, BEH-EA-024, BEH-EA-035

Depends on: ELC-001, DRS-008

Decision needed — see **Decisions needed** above.

**Recommended status:** `ready-for-human`

#### DRS-002 — Account deletion (GDPR erasure) is non-transactional and leaves PII across plugin tables

`high` · `compliance` · `server` · [.issues/high/DRS-002-data-residency-sharding-specialist.md](../../.issues/high/DRS-002-data-residency-sharding-specialist.md) · current status `ready-for-agent`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSG-001**

Same source line and root cause as CSG-001. DRS-002's own 2026-09-20 comment calls itself 'Duplicate source/evidence of CSG-001'. The non-transactional half was fixed in e940a12. The remaining PII-table gaps and decision 30 (Users.eraseAccount) are carried by CSG-001's plan.

**Evidence at HEAD:**

- `packages/server/src/Account.ts:103` — Cascade is transactional since e940a12.

  ```ts
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* accounts.deleteAllByUser(userId);
  ```

- `packages/server/src/Account.ts:95` — Remaining PII gaps self-documented at HEAD. Also: organization_active_context (no userId column) and AuditLog rows (actorUserId + full event payload, packages/core/src/AuditLog.ts:44-49).

  ```ts
        // `organization_membership`) inside this same transaction. Still
        // open, deliberately scoped out (see CSG-001's own resolution
        // comment): `organization_team_membership`, `organization_invitation`,
        // and `admin_impersonation` (the last a genuine audit-retention
        // tension, not a mechanical gap).
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### CSG-005 — No data-subject access or portability export path in the HTTP surface

`medium` · `compliance` · `api` · [.issues/medium/CSG-005-compliance-soc2-gdpr-specialist.md](../../.issues/medium/CSG-005-compliance-soc2-gdpr-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/api/src/Account.ts:27` — Only updateProfile/deleteUser; no export/access endpoint anywhere (session/subject groups are read-only views of their own rows).

  ```ts
  export const AccountGroup = HttpApiGroup.make("account")
    .add(
      HttpApiEndpoint.patch("updateProfile", "/user", {
        payload: UpdateProfilePayload,
        success: AccountDto,
      }),
    )
    .add(HttpApiEndpoint.delete("deleteUser", "/user"))
  ```

**Fix plan** (effort **L**): Add a GDPR Art. 15/20 self-service export: GET /auth/user/export under Authentication, aggregating core data plus plugin-contributed sections.

Steps:
1. Declare `exportData` in packages/api/src/Account.ts: `HttpApiEndpoint.get("exportData", "/user/export", { success: AccountExportDto })`. `AccountExportDto` is `{ generatedAt: DateTimeUtcFromString, user: AccountDto, accounts: Array<{providerId, subject?, createdAt}> (never tokens), sessions: Array<SessionDto>, sections: Record<string, Schema.Unknown> }`.
2. Per the decision below, add the plugin-contribution mechanism in @awthaq/core, e.g. `DataExport` as an ADR-EA-012 aggregating registry of `{ id, collect: (userId) => Effect<unknown> }` contributions, frozen at first read and ordered by dependency order.
3. Add `Users.exportAccount(userId)` in core (a sibling of eraseAccount), collecting the core sections plus every registered contribution. Have passkey (credential metadata, no public keys) and organization (memberships, teams, invitations) contribute.
4. Handler in packages/server/src/Account.ts: `exportData` calls `Users.exportAccount` and sets `Content-Disposition: attachment; filename="account-export.json"` via HttpEffect.appendPreResponseHandler.
5. Rate-limit the endpoint (RateLimits) and publish an `auth.user.dataExported` AuthEvent so the AuditLog records it.

Files: `packages/api/src/Account.ts`, `packages/server/src/Account.ts`, `packages/core/src/Users.ts (or AccountExport.ts)`, `packages/core/src/AuthEvents.ts`, `packages/passkey/src/Passkey.ts`, `packages/organization/src/Organization.ts`, `spec/behaviors (new BEH for data export)`

Tests (write first):
- packages/server/test/AuthHttp.test.ts: 'GET /user/export returns the caller's user, accounts (without tokens), sessions, and plugin sections; requires authentication (401 without)'.
- packages/core/test/AccountExport.test.ts: 'contributions appear under their id; a failing contribution fails the export (no partial export)'.

Acceptance:
- An authenticated user can download a single JSON document with every stored personal-data category.
- No secrets (password hashes, OAuth tokens, session secret hashes, passkey public keys) are included.
- An AuditLog row records the export.

Spec refs: BEH-EA-031, new BEH-EA id (next free after BEH-EA-220)

Depends on: CSG-001

Decision needed — see **Decisions needed** above.

**Recommended status:** `ready-for-human`

#### SEA-001 — Zero referential integrity: no FK constraints, no foreign_keys pragma, untransactional deleteUser cascade

`medium` · `correctness` · `server` · [.issues/medium/SEA-001-sqlite-embedded-auth-specialist.md](../../.issues/medium/SEA-001-sqlite-embedded-auth-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) — fixed by `e940a12` — canonical for SSMS-002

The transaction half is ALREADY-FIXED (e940a12). The FK/pragma half is real but is spec-sanctioned design, so the fix documents and tests it rather than adding constraints.

**Evidence at HEAD:**

- `packages/server/src/Account.ts:103` — Cascade is transactional since e940a12.

  ```ts
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* accounts.deleteAllByUser(userId);
  ```

- `packages/sql/src/CoreMigrations.ts:84` — accounts.userId (and sessions.userId at :117) carry no REFERENCES; grep for REFERENCES/FOREIGN KEY/foreign_keys under packages/*/src: 0 hits.

  ```ts
            "userId" TEXT NOT NULL,
  ```

- `spec/behaviors/12-hooks.md:133` — Spec explicitly prefers hook-driven erasure over DB-level cascades across plugins — so the FK half is a documentation gap, not a missing constraint.

  ```ts
  `archive/design/plugins-as-layers.md` §8 shows exactly this pattern: the `Invite` plugin purges its own `acme.invite_invitation` rows for a deleted user by tapping `BeforeUserDelete`, a point core defines, rather than by declaring a foreign key into `users` and relying on a database-level cascade the linker would have to know about.
  ```

**Fix plan** (effort **S**): The untransactional cascade is fixed (e940a12). What remains is making the FK-less design an explicit, tested invariant, not adding FKs, since spec/behaviors/12-hooks.md:133 deliberately prefers hook-driven erasure to DB-level cascades.

Steps:
1. Document in spec/behaviors/05-persistence-stratum.md (next to BEH-EA-035) that child tables carry no FOREIGN KEY by design: every whole-user delete goes through the transactional `Users.eraseAccount` (CSG-001), and cross-plugin cleanup goes through Hooks.BeforeUserDelete. Because of this, `PRAGMA foreign_keys` is intentionally irrelevant.
2. Add the rollback regression test below. It proves the transaction works on SQL, which is the property the finding's crash scenarios need.
3. Optional defense in depth (recommended, S): make `Sessions.layerSql` `verify` refuse a session whose user row is missing, via a cheap `users.findById` only on the throttled-touch path. Otherwise document why it is unnecessary now that orphaned sessions cannot arise.

Files: `spec/behaviors/05-persistence-stratum.md`, `packages/core/test/AccountErasure.test.ts`

Tests (write first):
- packages/core/test/AccountErasure.test.ts: 'a BeforeUserDelete tap failing after accounts were deleted rolls back — accounts, sessions, and the user row are all still present' (sqlite :memory: + SqlTransaction.layerSql).

Acceptance:
- The rollback test passes on SQL and fails if withTransaction is removed (mutation-check).
- The spec states the FK-less invariant explicitly.

Spec refs: BEH-EA-035, BEH-EA-040

Depends on: CSG-001

**Recommended status:** `ready-for-agent`

#### SSMS-002 — Zero FK constraints and the shipped whole-user cascade runs without a transaction

`medium` · `correctness` · `server` · [.issues/medium/SSMS-002-sql-schema-migration-specialist.md](../../.issues/medium/SSMS-002-sql-schema-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **SEA-001** — fixed by `e940a12`

Same two claims as SEA-001 (zero FKs + untransactional cascade). The cascade was wrapped in SqlTransaction by e940a12. The FK-less invariant documentation and test are planned under SEA-001.

**Evidence at HEAD:**

- `packages/server/src/Account.ts:103` — Cascade is transactional since e940a12.

  ```ts
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* accounts.deleteAllByUser(userId);
  ```

- `packages/sql/src/CoreMigrations.ts:84` — accounts.userId (and sessions.userId at :117) carry no REFERENCES; grep for REFERENCES/FOREIGN KEY/foreign_keys under packages/*/src: 0 hits.

  ```ts
            "userId" TEXT NOT NULL,
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### TS-004 — deleteUser performs three cross-repository writes with no transaction boundary despite the repo's own SqlTransaction port

`medium` · `architecture` · `server` · [.issues/medium/TS-004-tim-smart.md](../../.issues/medium/TS-004-tim-smart.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `e940a12`

AccountHandlers now requires SqlTransaction.SqlTransaction (Account.ts:46) and wraps the cascade in withTransaction (e940a12), exactly as the recommended fix asked.

**Evidence at HEAD:**

- `packages/server/src/Account.ts:103` — Cascade is transactional since e940a12.

  ```ts
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* accounts.deleteAllByUser(userId);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### CSG-007 — deleteUser revokes sessions via sentinel empty SessionId instead of revokeAll

`low` · `correctness` · `server` · [.issues/low/CSG-007-compliance-soc2-gdpr-specialist.md](../../.issues/low/CSG-007-compliance-soc2-gdpr-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `ec065a7`

The sentinel `revokeOthers(userId, SessionId(""))` was replaced by `sessions.revokeAll(userId)` in ec065a7.

**Evidence at HEAD:**

- `packages/server/src/Account.ts:112` — Sentinel SessionId("") replaced by revokeAll in ec065a7; verification tokens swept since 704cdd4 (BCR-003).

  ```ts
                yield* sessions.revokeAll(userId);
                yield* verification.deleteAllByUser(userId);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### TRBS-008 — deleteUser still uses the retired SessionId(\"\") revokeOthers trick instead of revokeAll

`low` · `api` · `server` · [.issues/low/TRBS-008-token-revocation-blacklist-specialist.md](../../.issues/low/TRBS-008-token-revocation-blacklist-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `ec065a7`

Same fix as CSG-007 (ec065a7).

**Evidence at HEAD:**

- `packages/server/src/Account.ts:112` — Sentinel SessionId("") replaced by revokeAll in ec065a7; verification tokens swept since 704cdd4 (BCR-003).

  ```ts
                yield* sessions.revokeAll(userId);
                yield* verification.deleteAllByUser(userId);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `per-request-session-cache`

#### TS-003 — Per-request verify cache uses an unguarded module-level WeakMap get-or-create, so concurrent first access can orphan memoized verifications (and re-trigger secret rotation)

`medium` · `correctness` · `server` · [.issues/medium/TS-003-tim-smart.md](../../.issues/medium/TS-003-tim-smart.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for ECF-005

Low practical exposure today, because Path A and Path B run sequentially, but the race re-triggers exactly the rotation bug ticket 03 exists to prevent.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:129` — get -> (yield) Ref.make -> (yield) set: not atomic; two fibers can each create and register a Ref, the second set wins.

  ```ts
  const perRequestCache = (request: HttpServerRequest.HttpServerRequest) =>
    Option.fromNullishOr(sessionResolutionCache.get(request)).pipe(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Ref.make(HashMap.empty<string, Effect.Effect<ResolvedSession, Api.Unauthenticated>>()).pipe(
            Effect.tap((ref) => Effect.sync(() => sessionResolutionCache.set(request, ref))),
          ),
  ```

- `packages/server/src/Authentication.ts:166` — Read of the per-credential entry; the insert happens later at :194 (`yield* Ref.update(cache, HashMap.set(raw, memoized))`) after a yield — check-then-set gap.

  ```ts
      const existing = HashMap.get(yield* Ref.get(cache), raw);
      if (Option.isSome(existing)) {
        return yield* existing.value;
      }
  ```

- `packages/server/src/Authentication.ts:184` — PlatformError now dies (NHS-002 fixed), but SessionNotFound/SessionExpired are mapped to Unauthenticated with no log, span annotation, metric or event.

  ```ts
      const memoized = yield* Effect.cached(
        raw === ""
          ? Effect.fail(new Api.Unauthenticated())
          : sessions
              .verify(Redacted.make(raw))
              .pipe(
                Effect.catchTag("PlatformError", Effect.die),
                Effect.mapError(() => new Api.Unauthenticated()),
  ```

**Fix plan** (effort **M**): Make per-request memoization single-flight by construction and key it on `request.source`, as Effect's own per-request state is keyed.

Steps:
1. Replace `sessionResolutionCache` with `WeakMap<object, Map<string, Deferred.Deferred<ResolvedSession, Api.Unauthenticated>>>`, keyed on `request.source` (typed `object`, HttpServerRequest.ts:77).
2. Do get-or-create for both the per-request Map and the per-credential Deferred in ONE `Effect.sync` block (JS is single-threaded, so this is atomic). Create the Deferred with `Deferred.makeUnsafe()` and return `{ deferred, owner }`.
3. The owner runs `sessions.verify(...)` with the existing catchTag(PlatformError, die) + mapError, and completes the Deferred via `Deferred.into` (../effect/packages/effect/src/Deferred.ts:909) inside `Effect.uninterruptibleMask`/`onExit`. If the owner is interrupted before completing, delete the entry so later callers retry instead of hanging. Non-owners `Deferred.await`.
4. Remove the Ref/HashMap/Effect.cached machinery. No module-level mutable state remains beyond the WeakMap.

Files: `packages/server/src/Authentication.ts`

Tests (write first):
- packages/server/test/Authentication.test.ts (write first): 'two concurrent resolveSession calls for one request+credential call Sessions.verify exactly once' (counting Sessions double, `Effect.all([...], { concurrency: "unbounded" })`).
- 'an interrupted first resolver does not wedge a second caller' (TestClock + Fiber.interrupt).

Acceptance:
- Sessions.verify runs at most once per (request.source, credential) under any interleaving.
- No hang on interruption.
- Existing Authentication/SubjectExtractor tests pass unchanged.

Spec refs: BEH-EA-052, BEH-EA-153

Depends on: —

**Recommended status:** `ready-for-agent`

#### ELC-007 — Per-request session-resolution memoization lives in a module-level WeakMap with an ambient HttpServerRequest requirement

`low` · `architecture` · `server` · [.issues/low/ELC-007-effect-layer-context-architect.md](../../.issues/low/ELC-007-effect-layer-context-architect.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

Refuted parts: 'silently degrades to per-call' is wrong, because resolveSession's R includes HttpServerRequest, so omitting it is a type error. The FiberRef recommendation is impossible in Effect v4. The valid part (lifetime is GC-coupled to object identity) is addressed by keying on request.source.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:123` — Per-request cache keyed on the HttpServerRequest *wrapper* object, not request.source.

  ```ts
  const sessionResolutionCache = new WeakMap<
    HttpServerRequest.HttpServerRequest,
    Ref.Ref<HashMap.HashMap<string, Effect.Effect<ResolvedSession, Api.Unauthenticated>>>
  >();
  ```

- `../effect/packages/effect/src/unstable/http/internal/preResponseHandler.ts:6` — Effect's own per-request state uses the same module-level WeakMap idiom, but keyed on `request.source` (stable across modify()).

  ```ts
  export const requestPreResponseHandlers = new WeakMap<object, PreResponseHandler>()
  
  /** @internal */
  export const appendPreResponseHandlerUnsafe = (request: HttpServerRequest, handler: PreResponseHandler): void => {
    const prev = requestPreResponseHandlers.get(request.source)
  ```

**Fix plan** (effort **S**): Documentation only. The module-level WeakMap is Effect v4's own idiom (there is no FiberRef in v4), and the ambient HttpServerRequest requirement is already visible in resolveSession's R type.

Steps:
1. In resolveSession's and resolvePrincipal's doc comments, state that `HttpServerRequest` is a hard requirement in R (a caller that does not provide it fails to type-check; nothing degrades silently), and that lifetime is tied to the underlying request object, as Effect's own pre-response handlers are.
2. Keying on `request.source` is done under TS-003/NHS-006.

Files: `packages/server/src/Authentication.ts`

Tests (write first):
- No new behavior test (doc change); TS-003/NHS-006 tests cover the cache.

Acceptance:
- The doc comments state the requirement and the lifetime model.

Spec refs: BEH-EA-153

Depends on: TS-003-tim-smart

**Recommended status:** `ready-for-agent`

#### NHS-006 — Per-request session cache relies on framework-internal request object identity

`low` · `architecture` · `server` · [.issues/low/NHS-006-node-http-server-integration-specialist.md](../../.issues/low/NHS-006-node-http-server-integration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence medium)

Confidence is medium on real-world impact: a miss only happens when Path B and Path A see different wrappers, e.g. a global router middleware versus a prefixed route. On a miss, the second verify presents the pre-rotation secret and fails (SessionNotFound), which is a silent logout.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:123` — Per-request cache keyed on the HttpServerRequest *wrapper* object, not request.source.

  ```ts
  const sessionResolutionCache = new WeakMap<
    HttpServerRequest.HttpServerRequest,
    Ref.Ref<HashMap.HashMap<string, Effect.Effect<ResolvedSession, Api.Unauthenticated>>>
  >();
  ```

- `packages/server/src/Authentication.ts:116` — The stated invariant ('mutated in place rather than replaced') does not hold for prefixed routes — see HttpRouter.ts:249-252.

  ```ts
   * request by the router (confirmed via `effect`'s own `HttpRouter.ts`/
   * `HttpApiBuilder.ts`), and is mutated in place rather than replaced
   * (`@qadi/http`'s own `RequirePermission.ts` writes `request.payload`
   * directly) — so its identity is stable for a request's whole lifetime
  ```

- `../effect/packages/effect/src/unstable/http/HttpRouter.ts:249` — Prefixed routes get a NEW HttpServerRequest wrapper (modify keeps `this.source`, HttpServerRequest.ts:503-504) — code outside vs inside the route sees different identities.

  ```ts
  function sliceRequestUrl(request: HttpServerRequest.HttpServerRequest, prefix: string) {
    const prefexLen = prefix.length
    return request.modify({ url: request.url.length <= prefexLen ? "/" : request.url.slice(prefexLen) })
  }
  ```

- `../effect/packages/effect/src/unstable/http/internal/preResponseHandler.ts:6` — Effect's own per-request state uses the same module-level WeakMap idiom, but keyed on `request.source` (stable across modify()).

  ```ts
  export const requestPreResponseHandlers = new WeakMap<object, PreResponseHandler>()
  
  /** @internal */
  export const appendPreResponseHandlerUnsafe = (request: HttpServerRequest, handler: PreResponseHandler): void => {
    const prev = requestPreResponseHandlers.get(request.source)
  ```

**Fix plan** (effort **S**): Key the per-request cache on `request.source`, not the HttpServerRequest wrapper, so re-wrapping (HttpRouter prefix mounts) cannot fork it. Fix the doc comment's false 'mutated in place, never replaced' invariant.

Steps:
1. Covered by TS-003's step 1 (key on `request.source`). Rewrite the doc comment at Authentication.ts:96-122 to cite Effect's own `requestPreResponseHandlers` WeakMap (internal/preResponseHandler.ts:6), which uses the same pattern, and HttpRouter's `sliceRequestUrl` re-wrap as the reason for keying on `.source`.

Files: `packages/server/src/Authentication.ts`

Tests (write first):
- packages/server/test/Authentication.test.ts: 'resolveSession called with request and with request.modify({ url }) shares one verify' (counting Sessions double).

Acceptance:
- The cache hits across wrapper re-creation for the same underlying request.
- The doc comment matches the real invariant.

Spec refs: BEH-EA-153

Depends on: TS-003-tim-smart

**Recommended status:** `ready-for-agent`

#### PCS-006 — Per-request session memoization extends a verify outcome across the request's lifetime

`low` · `correctness` · `server` · [.issues/low/PCS-006-permission-caching-specialist.md](../../.issues/low/PCS-006-permission-caching-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:184` — PlatformError now dies (NHS-002 fixed), but SessionNotFound/SessionExpired are mapped to Unauthenticated with no log, span annotation, metric or event.

  ```ts
      const memoized = yield* Effect.cached(
        raw === ""
          ? Effect.fail(new Api.Unauthenticated())
          : sessions
              .verify(Redacted.make(raw))
              .pipe(
                Effect.catchTag("PlatformError", Effect.die),
                Effect.mapError(() => new Api.Unauthenticated()),
  ```

**Fix plan** (effort **S**): Document the bounded mid-request revocation window as a deliberate staleness budget.

Steps:
1. Add to resolveSession's doc comment that a session revoked mid-request keeps resolving for the remainder of that request (bounded by request lifetime); streaming or long uploads inherit this window. Invalidation on revoke-of-current is deliberately not done.
2. Add a sentence to spec/behaviors/09-authentication-middleware.md under BEH-EA-070.

Files: `packages/server/src/Authentication.ts`, `spec/behaviors/09-authentication-middleware.md`

Tests (write first):
- None (documentation).

Acceptance:
- The staleness budget is stated at the call site and in the spec.

Spec refs: BEH-EA-070

Depends on: —

**Recommended status:** `ready-for-agent`

#### ECF-005 — Per-request verify memoization has a check-then-set gap; single-flight holds only per constructed wrapper

`low` · `correctness` · `server` · [.issues/low/ECF-005-effect-concurrency-fiber-specialist.md](../../.issues/low/ECF-005-effect-concurrency-fiber-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **TS-003-tim-smart**

The same non-atomic get-or-create, one level down (the per-credential Effect.cached wrapper). TS-003's single Effect.sync get-or-create of a Deferred fixes both levels.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:166` — Read of the per-credential entry; the insert happens later at :194 (`yield* Ref.update(cache, HashMap.set(raw, memoized))`) after a yield — check-then-set gap.

  ```ts
      const existing = HashMap.get(yield* Ref.get(cache), raw);
      if (Option.isSome(existing)) {
        return yield* existing.value;
      }
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `wire-constant-single-source`

#### CSS-007 — Session cookie name exists as two independent literals — aligned 'by construction, not by convention'

`low` · `api` · `api` · [.issues/low/CSS-007-cookie-security-specialist.md](../../.issues/low/CSS-007-cookie-security-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high) — canonical for EHA-008, MW-009, BE-009

Overstated: drift would NOT be silent today. Authentication.test.ts:149-150 sends core's name to api's scheme, and core/test/Sessions.test.ts:587 pins the literal, so CI would fail. The duplication is still real and worth removing.

**Evidence at HEAD:**

- `packages/api/src/Api.ts:97` — Independent literal in api; core has its own at packages/core/src/Sessions.ts:152.

  ```ts
  /**
   * BEH-EA-065: cookie name matches `@awthaq/core`'s `Sessions.SESSION_COOKIE_NAME`
   * exactly (`api` cannot import `core`, so the literal is repeated here rather
   * than shared — both are `"__Host-session"` by construction, not by convention).
   */
  export const SessionCookie = HttpApiSecurity.apiKey({ key: "__Host-session", in: "cookie" });
  ```

- `packages/core/src/Sessions.ts:151` — Second literal. core (stratum 4) MAY depend on api (stratum 1) per spec/overview.md:41, but packages/core/package.json has no @awthaq/api dependency today.

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

- `packages/server/test/Authentication.test.ts:149` — Implicit drift guard: this BEH-EA-065 test sends core's cookie name to Api.Authentication (keyed by api's literal) — a rename on either side fails CI. Plus packages/core/test/Sessions.test.ts:587 pins core's literal. So 'nothing fails' is overstated.

  ```ts
          const result = yield* client.required.whoAmI({
            headers: { cookie: `${Sessions.SESSION_COOKIE_NAME}=${Redacted.value(token)}` },
  ```

**Fix plan** (effort **S**): Make the session cookie name (and the rotation header name) one constant owned by the contract stratum, with core deriving from it. core (stratum 4) may depend on api (stratum 1).

Steps:
1. packages/api/src/Api.ts: `export const SESSION_COOKIE_NAME = "__Host-session";` (the literal type is inferred; no `as`), `SessionCookie = HttpApiSecurity.apiKey({ key: SESSION_COOKIE_NAME, in: "cookie" })`, and `export const ROTATED_TOKEN_HEADER = "set-auth-token";`. Delete the 'by construction' comment.
2. packages/core/package.json: add `"@awthaq/api": "workspace:*"`. packages/core/src/Sessions.ts: `export const SESSION_COOKIE_NAME = Api.SESSION_COOKIE_NAME;`. This matches MW-002/decision 26, which adds the same core -> api dependency for AuthCore. Coordinate with that workstream.
3. Replace the 26 hard-coded `__Host-session` literals in tests (packages/**/test, features/step-definitions) with the constant.
4. Run `pnpm knip` and the madge cycle guard (the new dependency is downward and acyclic).

Files: `packages/api/src/Api.ts`, `packages/core/src/Sessions.ts`, `packages/core/package.json`, `packages/core/tsconfig*.json (project reference to api)`

Tests (write first):
- packages/core/test/Sessions.test.ts:587: change to `assert.strictEqual(Sessions.SESSION_COOKIE_NAME, Api.SessionCookie.key)` (write first, failing until core imports api).

Acceptance:
- Exactly one `"__Host-session"` literal in packages/*/src.
- Renaming it is a one-line change that every consumer follows.

Spec refs: BEH-EA-055, BEH-EA-065

Depends on: —

**Recommended status:** `ready-for-agent`

#### BE-009 — Session cookie name duplicated as literals across the api/core stratum boundary

`low` · `dx` · `api` · [.issues/low/BE-009-bereket-engida.md](../../.issues/low/BE-009-bereket-engida.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSS-007**

Same as CSS-007.

**Evidence at HEAD:**

- `packages/api/src/Api.ts:97` — Independent literal in api; core has its own at packages/core/src/Sessions.ts:152.

  ```ts
  /**
   * BEH-EA-065: cookie name matches `@awthaq/core`'s `Sessions.SESSION_COOKIE_NAME`
   * exactly (`api` cannot import `core`, so the literal is repeated here rather
   * than shared — both are `"__Host-session"` by construction, not by convention).
   */
  export const SessionCookie = HttpApiSecurity.apiKey({ key: "__Host-session", in: "cookie" });
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### EHA-008 — Security-critical cookie name duplicated as independent literals between api and core

`low` · `security` · `api` · [.issues/low/EHA-008-effect-http-api-specialist.md](../../.issues/low/EHA-008-effect-http-api-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSS-007**

The session-cookie half is the same as CSS-007. The CSRF half is invalid: CSRF names exist once, in api, and server imports them.

**Evidence at HEAD:**

- `packages/api/src/Api.ts:97` — Independent literal in api; core has its own at packages/core/src/Sessions.ts:152.

  ```ts
  /**
   * BEH-EA-065: cookie name matches `@awthaq/core`'s `Sessions.SESSION_COOKIE_NAME`
   * exactly (`api` cannot import `core`, so the literal is repeated here rather
   * than shared — both are `"__Host-session"` by construction, not by convention).
   */
  export const SessionCookie = HttpApiSecurity.apiKey({ key: "__Host-session", in: "cookie" });
  ```

- `packages/api/src/Api.ts:105` — CSRF names have ONE source: server imports them (packages/server/src/Csrf.ts:148 `request.cookies[Api.CSRF_COOKIE_NAME]`, :173 `Api.CSRF_HEADER_NAME`). The CSRF half of the duplication claim is wrong.

  ```ts
  /** BEH-EA-080: the CSRF cookie/header names are fixed, never per-plugin configurable. */
  export const CSRF_COOKIE_NAME = "__Host-csrf";
  export const CSRF_HEADER_NAME = "x-csrf-token";
  export const CsrfCookie = HttpApiSecurity.apiKey({ key: CSRF_COOKIE_NAME, in: "cookie" });
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### MW-009 — Cookie/CSRF names duplicated across strata by construction, not by convention

`low` · `architecture` · `api` · [.issues/low/MW-009-matias-woloski.md](../../.issues/low/MW-009-matias-woloski.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSS-007**

The CSRF-name duplication claim is refuted (Csrf.ts:148/:173 import Api.CSRF_*). The session-cookie part is the same as CSS-007.

**Evidence at HEAD:**

- `packages/api/src/Api.ts:97` — Independent literal in api; core has its own at packages/core/src/Sessions.ts:152.

  ```ts
  /**
   * BEH-EA-065: cookie name matches `@awthaq/core`'s `Sessions.SESSION_COOKIE_NAME`
   * exactly (`api` cannot import `core`, so the literal is repeated here rather
   * than shared — both are `"__Host-session"` by construction, not by convention).
   */
  export const SessionCookie = HttpApiSecurity.apiKey({ key: "__Host-session", in: "cookie" });
  ```

- `packages/api/src/Api.ts:105` — CSRF names have ONE source: server imports them (packages/server/src/Csrf.ts:148 `request.cookies[Api.CSRF_COOKIE_NAME]`, :173 `Api.CSRF_HEADER_NAME`). The CSRF half of the duplication claim is wrong.

  ```ts
  /** BEH-EA-080: the CSRF cookie/header names are fixed, never per-plugin configurable. */
  export const CSRF_COOKIE_NAME = "__Host-csrf";
  export const CSRF_HEADER_NAME = "x-csrf-token";
  export const CsrfCookie = HttpApiSecurity.apiKey({ key: CSRF_COOKIE_NAME, in: "cookie" });
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `session-rotation-delivery`

#### MNA-005 — Bearer rotation rides an unread set-auth-token header; native sessions silently expire within an hour

`medium` · `api` · `server` · [.issues/medium/MNA-005-mobile-native-auth-specialist.md](../../.issues/medium/MNA-005-mobile-native-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for CTA-006, PIL-009

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:233` — Rotation delivery: cookie via Set-Cookie (orDie), bearer via custom set-auth-token header; no Cache-Control, no shared constant for the header name.

  ```ts
    return scheme === "cookie"
      ? HttpServerResponse.setCookie(
          response,
          Sessions.SESSION_COOKIE_NAME,
          token,
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        ).pipe(Effect.orDie)
      : Effect.succeed(HttpServerResponse.setHeader(response, "set-auth-token", token));
  ```

- `packages/client/src/AuthClient.ts:150` — Client has no bearer-token store and no response hook; `set-auth-token` appears only in packages/server/src/Authentication.ts (grep across packages/features/spec/docs).

  ```ts
    /** Always overwrites — the result of a real sign-in/sign-out/refresh. */
    readonly set: (session: Session | null) => Effect.Effect<void>;
  ```

**Fix plan** (effort **M**): Ship a first-class bearer-client contract: a shared header constant, a client-side token store, and a transform that attaches the bearer and captures rotations on every response.

Steps:
1. packages/api/src/Api.ts: `export const ROTATED_TOKEN_HEADER = "set-auth-token";` (the server uses it; see PIL-005).
2. packages/client/src/AuthClient.ts: add a `BearerTokenStore` service `{ get: Effect<Option<Redacted<string>>>; set: (token: Redacted<string>) => Effect<void>; clear: Effect<void> }`, with a `BearerTokenStoreMemory` layer. Platform storage (Keychain/Keystore) remains the app's responsibility and must be documented.
3. Add `bearerTransformClient`, applied via `HttpApiClient.make(api, { transformClient })`: `HttpClient.mapRequestEffect` adds `Authorization: Bearer <token>` from the store, and `HttpClient.tap` on every response persists `ROTATED_TOKEN_HEADER` when present.
4. Make an idle-expired or revoked bearer surface as typed `Unauthenticated` (it already does), and document 're-authenticate on Unauthenticated' as the client contract. The CLI-specific UX lives in CTA-001 (slice 09).
5. Document in packages/client/README.md and the native recipe (MNA-009 docs, spec slice): set-auth-token must be preserved by proxies, and cross-origin deployments must expose it (AGA-002's CORS preset does this).

Files: `packages/api/src/Api.ts`, `packages/client/src/AuthClient.ts`, `packages/client/src/index.ts`, `packages/client/README.md`

Tests (write first):
- packages/client/test/AuthClient.test.ts (write first): 'bearerTransformClient persists set-auth-token from a response and sends it on the next request' (fake HttpClient layer).
- 'a response without the header leaves the stored token unchanged'.

Acceptance:
- A bearer client that uses the shipped transform survives unlimited touchEvery rotations with no code of its own.
- The header name has one source of truth.

Spec refs: BEH-EA-066, BEH-EA-052, BEH-EA-174

Depends on: PIL-005, CSS-007

**Recommended status:** `ready-for-agent`

#### PIL-005 — Path-B-only routes discard secret rotation, forcing hourly re-logins

`medium` · `dx` · `server` · [.issues/medium/PIL-005-pilcrow.md](../../.issues/medium/PIL-005-pilcrow.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Validation also found a second, unreported loss path. Because deliverRotation is chained with flatMap on the handler's success (Authentication.ts:273-286), and HttpApiBuilder wraps handler failures as HandlerError (HttpApiBuilder.ts:953, :963-966), a typed-error response at a touch boundary (e.g. POST /session/revoke answering 404) drops the rotated cookie and silently logs the user out.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:202` — resolvePrincipal (Path B entry point) drops the rotated secret.

  ```ts
   * BEH-EA-153 requires exactly that reuse. Discards `rotated`: a caller with
   * no response to deliver a rotated token through has nowhere to put it.
  ```

- `packages/qadi/src/SubjectExtractor.ts:80` — Path B calls resolvePrincipal, which discards `rotated`; nothing on this path writes Set-Cookie/set-auth-token.

  ```ts
            const principal = yield* Authentication.resolvePrincipal(
              sessions,
              principalResolver,
              credential,
            ).pipe(
  ```

- `packages/server/src/Authentication.ts:273` — deliverRotation (:286) runs only inside flatMap on a *successful* handler response — a handler that fails with a typed error (HttpApiBuilder wraps it as HandlerError) skips delivery, so the rotated secret is lost and the client is logged out.

  ```ts
                Effect.provideService(httpEffect, Api.CurrentPrincipal, principal).pipe(
                  Effect.flatMap((response) =>
  ```

- `../effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:953` — Handler failures are wrapped and re-failed (:963-966) — the security middleware's post-success flatMap never sees them.

  ```ts
      handler = Effect.mapError(handler, (error) => new HandlerError(error))
  ```

- `packages/core/src/Sessions.ts:192` — No grace window — a settled decision (.scratch/upstream-hardening/issues/01-session-token-rotation.md:79 'Old secret — immediate invalidation, no grace window.'). Grace-window fix options are ruled out.

  ```ts
     * secret's hash is overwritten in the same atomic write, so it stops
     * verifying immediately — no grace window. A concurrent second `verify`
  ```

**Fix plan** (effort **M**): Deliver rotated secrets from inside the memoized verify via `HttpEffect.appendPreResponseHandler`, so every path delivers: Path A, Path B, and responses whose handler failed with a typed error.

Steps:
1. Give resolveSession/resolvePrincipal a `scheme: "cookie" | "bearer"` argument. qadi's `extractCredential` (packages/qadi/src/SubjectExtractor.ts:37-50) returns `{ scheme, credential }`.
2. In the owner branch of the memoized verify (TS-003), when `rotated` is Some, register exactly one `HttpEffect.appendPreResponseHandler`. For cookie: `HttpServerResponse.setCookie(res, Api.SessionCookie.key, token, SESSION_COOKIE_ATTRIBUTES)`. For bearer: `setHeader(res, Api.ROTATED_TOKEN_HEADER, token)` plus `Cache-Control: no-store` (MAPS-008). Recover a cookie-encoding failure by logging a warning and returning the undecorated response (never orDie, which closes NHS-007).
3. Delete `deliverRotation` and its calls from AuthenticationLive/OptionalAuthenticationLive (Authentication.ts:224-241, :286, :343). PostAuthResponseHook.decorate stays on the success path.
4. Do NOT add a grace window or a verify-without-rotation mode. Ticket 01 ('no grace window') and decision 16 ('Sessions.verify itself is not touched — no rotation skip-mode') already settled this.
5. spec: add a rotation-delivery requirement under BEH-EA-052 (delivery happens on every response to a request whose verify rotated, including error responses and Path B routes). Cross-reference it from BEH-EA-153.

Files: `packages/server/src/Authentication.ts`, `packages/qadi/src/SubjectExtractor.ts`, `packages/api/src/Api.ts (ROTATED_TOKEN_HEADER)`, `spec/behaviors/07-sessions.md`, `spec/behaviors/20-qadi-bridge-path-b.md`

Tests (write first):
- packages/qadi/test/SubjectExtractor.test.ts (write first): 'Path-B-only route: a verify that rotates (TestClock past touchEvery) sets __Host-session to the rotated token on the response'.
- packages/server/test/Authentication.test.ts: 'a handler failing with a typed error after a rotating verify still carries Set-Cookie with the rotated token' (this currently fails: the rotation is lost via Authentication.ts:273-286).
- 'Path A + Path B on one request emit exactly one Set-Cookie for the rotation'.
- 'bearer rotation sets set-auth-token and Cache-Control: no-store'.

Acceptance:
- No request whose verify rotated ever returns without delivering the new secret, whatever the route style or handler outcome.
- Exactly one delivery per rotation.

Spec refs: BEH-EA-052, BEH-EA-153, BEH-EA-066

Depends on: TS-003-tim-smart, CSS-007

**Recommended status:** `ready-for-agent`

#### CTA-006 — Token rotation reaches native clients only as a response header no client captures

`medium` · `correctness` · `server` · [.issues/medium/CTA-006-cli-tool-auth-specialist.md](../../.issues/medium/CTA-006-cli-tool-auth-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MNA-005**

Same gap (no client captures set-auth-token). The CLI-specific re-auth UX and exit-code asks belong with CTA-001/CTA-003 (slice 09 / spec). The CLI package is still a placeholder.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:233` — Rotation delivery: cookie via Set-Cookie (orDie), bearer via custom set-auth-token header; no Cache-Control, no shared constant for the header name.

  ```ts
    return scheme === "cookie"
      ? HttpServerResponse.setCookie(
          response,
          Sessions.SESSION_COOKIE_NAME,
          token,
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        ).pipe(Effect.orDie)
      : Effect.succeed(HttpServerResponse.setHeader(response, "set-auth-token", token));
  ```

- `packages/client/src/AuthClient.ts:150` — Client has no bearer-token store and no response hook; `set-auth-token` appears only in packages/server/src/Authentication.ts (grep across packages/features/spec/docs).

  ```ts
    /** Always overwrites — the result of a real sign-in/sign-out/refresh. */
    readonly set: (session: Session | null) => Effect.Effect<void>;
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### MAPS-008 — Bearer rotation delivers the raw long-lived session secret via a response header

`low` · `security` · `server` · [.issues/low/MAPS-008-microservices-auth-propagation-specialist.md](../../.issues/low/MAPS-008-microservices-auth-propagation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:233` — Rotation delivery: cookie via Set-Cookie (orDie), bearer via custom set-auth-token header; no Cache-Control, no shared constant for the header name.

  ```ts
    return scheme === "cookie"
      ? HttpServerResponse.setCookie(
          response,
          Sessions.SESSION_COOKIE_NAME,
          token,
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        ).pipe(Effect.orDie)
      : Effect.succeed(HttpServerResponse.setHeader(response, "set-auth-token", token));
  ```

- `../effect/packages/effect/src/unstable/http/Headers.ts:416` — Effect's default redacted header names (used by HttpMiddleware.logger/tracer) do not include set-auth-token — the rotated long-lived secret would be logged verbatim by any request logger.

  ```ts
    defaultValue: () => [
      "authorization",
      "cookie",
      "set-cookie",
      "x-api-key"
    ]
  ```

**Fix plan** (effort **S**): Reduce the exposure of the rotated long-lived secret in transit and in logs. Header delivery itself stays, as ticket 01 decided.

Steps:
1. Every response carrying a rotation (Set-Cookie or set-auth-token) also carries `Cache-Control: no-store` (PIL-005 step 2).
2. When MW-001's `AuthHttp.requestLogger`/`AuthHttp.tracer` re-exports land, provide `Headers.CurrentRedactedNames` with the Effect defaults plus `set-auth-token` and `x-jwt-token`, and document that a host-supplied logger must do the same.
3. Document the header-logging hazard in packages/server/README.md and the native recipe.

Files: `packages/server/src/Authentication.ts`, `packages/server/src/AuthHttp.ts`, `packages/server/README.md`

Tests (write first):
- packages/server/test/Authentication.test.ts: 'bearer rotation response has Cache-Control: no-store'.
- packages/server/test/AuthHttp.test.ts: 'AuthHttp.requestLogger redacts set-auth-token' (capture Logger).

Acceptance:
- No shipped logger or trace path emits the rotated secret.
- Rotated responses are non-cacheable.

Spec refs: BEH-EA-052, BEH-EA-199

Depends on: PIL-005, MW-001

**Recommended status:** `ready-for-agent`

#### NHS-007 — Rotation delivery can defect an otherwise-successful authenticated response

`low` · `correctness` · `server` · [.issues/low/NHS-007-node-http-server-integration-specialist.md](../../.issues/low/NHS-007-node-http-server-integration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

Overstated: the orDie is practically unreachable, because the name and attributes are fixed constants and the token is `${uuid}.${hex}`, so Cookies validation cannot fail. The proxy-stripping concern is valid and documented under MNA-005.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:233` — Rotation delivery: cookie via Set-Cookie (orDie), bearer via custom set-auth-token header; no Cache-Control, no shared constant for the header name.

  ```ts
    return scheme === "cookie"
      ? HttpServerResponse.setCookie(
          response,
          Sessions.SESSION_COOKIE_NAME,
          token,
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        ).pipe(Effect.orDie)
      : Effect.succeed(HttpServerResponse.setHeader(response, "set-auth-token", token));
  ```

**Fix plan** (effort **S**): Folded into PIL-005: rotation delivery moves into a pre-response handler that recovers encoding failures (log and continue) instead of orDie. Header-stripping guidance ships with MNA-005's docs.

Steps:
1. No separate change beyond PIL-005 step 2 (non-fatal recovery) and MNA-005 step 5 (proxy guidance).

Files: `packages/server/src/Authentication.ts`

Tests (write first):
- Covered by PIL-005's tests; add 'a failing cookie encode on rotation still returns the handler's response (warning logged)' by injecting an invalid attribute in a unit test of the pre-response handler.

Acceptance:
- Rotation delivery can never turn a successful response into a 500.

Spec refs: BEH-EA-052

Depends on: PIL-005

**Recommended status:** `ready-for-agent`

#### PIL-009 — Bearer rotation has no catch-up path for clients that miss the header

`info` · `api` · `server` · [.issues/info/PIL-009-pilcrow.md](../../.issues/info/PIL-009-pilcrow.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MNA-005**

Its documentation option is covered by MNA-005's docs step. Its grace-window option is ruled out by upstream-hardening ticket 01 ('no grace window'), which must not be re-litigated.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:233` — Rotation delivery: cookie via Set-Cookie (orDie), bearer via custom set-auth-token header; no Cache-Control, no shared constant for the header name.

  ```ts
    return scheme === "cookie"
      ? HttpServerResponse.setCookie(
          response,
          Sessions.SESSION_COOKIE_NAME,
          token,
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        ).pipe(Effect.orDie)
      : Effect.succeed(HttpServerResponse.setHeader(response, "set-auth-token", token));
  ```

- `packages/core/src/Sessions.ts:192` — No grace window — a settled decision (.scratch/upstream-hardening/issues/01-session-token-rotation.md:79 'Old secret — immediate invalidation, no grace window.'). Grace-window fix options are ruled out.

  ```ts
     * secret's hash is overwritten in the same atomic write, so it stops
     * verifying immediately — no grace window. A concurrent second `verify`
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `bearer-credential-extensibility`

#### MAPS-001 — Propagated JWTs cannot re-enter the awthaq boundary - bearer resolves only opaque session tokens

`high` · `architecture` · `server` · [.issues/high/MAPS-001-microservices-auth-propagation-specialist.md](../../.issues/high/MAPS-001-microservices-auth-propagation-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) — canonical for JR-004, AGA-003, VB-008

The decision is already made (.scratch/resolve-ready-for-human-findings/issues/33-stateless-jwt-session-strategy.md); nothing is implemented at HEAD (no BearerCredentialResolver in packages/). The depends_on entries are for sequencing only: TS-003/PIL-005 restructure the same resolveSession/authenticate code.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:299` — Both schemes funnel into authenticate -> resolveSession -> Sessions.verify (opaque id.secret only); no BearerCredentialResolver seam exists.

  ```ts
      const handle: HttpApiMiddleware.HttpApiMiddlewareSecurity<
        { readonly cookie: typeof Api.SessionCookie; readonly bearer: typeof Api.BearerToken },
        Api.CurrentPrincipal,
        typeof Api.Unauthenticated,
        never
      >["cookie"] = (httpEffect, { credential }) => authenticate("cookie", httpEffect, credential);
      const bearer: typeof handle = (httpEffect, { credential }) =>
        authenticate("bearer", httpEffect, credential);
  ```

- `packages/server/src/Authentication.ts:184` — PlatformError now dies (NHS-002 fixed), but SessionNotFound/SessionExpired are mapped to Unauthenticated with no log, span annotation, metric or event.

  ```ts
      const memoized = yield* Effect.cached(
        raw === ""
          ? Effect.fail(new Api.Unauthenticated())
          : sessions
              .verify(Redacted.make(raw))
              .pipe(
                Effect.catchTag("PlatformError", Effect.die),
                Effect.mapError(() => new Api.Unauthenticated()),
  ```

**Fix plan** (effort **L**): Implement decision 33 (stateless JWT-as-bearer): an optional `BearerCredentialResolver` seam in Authentication, opted into by @awthaq/jwt via JwtConfig.acceptAsBearer, with audience scoping for downstream-only tokens.

Steps:
1. packages/server/src/Authentication.ts: add `BearerCredentialResolverShape { resolve: (credential) => Effect<Api.Principal, Api.Unauthenticated> }` and `BearerCredentialResolver = Context.Reference(... { defaultValue: () => ({ resolve: () => Effect.fail(new Api.Unauthenticated()) }) })`, as a sibling of PostAuthResponseHook. Because it is a Reference, AuthenticationLive's R is unchanged.
2. In both AuthenticationLive and OptionalAuthenticationLive, the `bearer` handler routes on shape: `Redacted.value(credential).split(".").length === 3` goes to `BearerCredentialResolver.resolve` (resolved per request, like PostAuthResponseHook), anything else to resolveSession. The JWT branch skips rotation delivery but still runs `PostAuthResponseHook.decorate`. The cookie scheme is unchanged. (If MAPS-004's registry is decided, implement this seam as that registry, with JWT as the first contributor.)
3. packages/jwt/src/Jwt.ts: add `acceptAsBearer: boolean` (default false) to JwtConfig. Add `BearerCredentialResolverLive` (jwt.verify, then claimsToPrincipal, the inverse of principalClaims: sub -> PrincipalRef, sid -> sessionId, act -> actingAs), wired only when acceptAsBearer is set. Use bare `jwt.verify`, not verifyLive (the revocation lag is documented).
4. Add an optional `audience?: string` to `signJWT` options, so downstream-only propagation tokens are rejected at the origin by the existing aud check.
5. packages/jwt/README.md: document acceptAsBearer and its revocation-lag bound, the `Sessions.layerMemory + acceptAsBearer` stateless recipe (NAM-001), `signJWT({ audience })` for non-reentrant propagation tokens, and the rule that by default minted tokens are never accepted by the issuing API. This closes the documentation asks of JR-004, VB-008 and AGA-003.
6. Flag spec/models/08-jwt-bearer.md drift for the spec slice (MAPS-009/VB-007); do not silently rewrite it.

Files: `packages/server/src/Authentication.ts`, `packages/jwt/src/Jwt.ts`, `packages/jwt/README.md`, `spec/behaviors/09-authentication-middleware.md`

Tests (write first):
- packages/server/test/Authentication.test.ts (write first): 'BEH-EA-066: a 3-segment bearer is routed to BearerCredentialResolver; the default resolver fails Unauthenticated'; 'an overriding resolver's Principal becomes CurrentPrincipal'; 'an opaque id.secret bearer still goes through Sessions.verify'.
- packages/jwt/test/AuthHttp.test.ts: 'acceptAsBearer=true: a minted JWT authenticates GET /auth/session'; 'acceptAsBearer=false (default): the same JWT answers 401'; 'a token minted with signJWT({ audience: "other" }) answers 401 even with acceptAsBearer'.

Acceptance:
- With acceptAsBearer on, a JWT minted by /jwt/token authenticates against the issuing API without a session-store round trip.
- Default behavior is unchanged (a JWT bearer answers 401).
- Downstream-audience tokens never re-enter.
- AuthenticationLive's R type is unchanged.

Spec refs: BEH-EA-066, BEH-EA-065, BEH-EA-072

Depends on: TS-003-tim-smart, PIL-005

**Recommended status:** `ready-for-agent`

#### MAPS-004 — Auth scheme chain is a closed two-key record - no seam for new credentials

`medium` · `architecture` · `api` · [.issues/medium/MAPS-004-microservices-auth-propagation-specialist.md](../../.issues/medium/MAPS-004-microservices-auth-propagation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Decision 33 introduces a seam for JWTs only. Nothing covers a second bearer credential type, which api-key (decision 10) will be.

**Evidence at HEAD:**

- `packages/api/src/Api.ts:110` — Closed two-key record; ordering from declaration key order (mandated by BEH-EA-072).

  ```ts
  /**
   * BEH-EA-028/065/072: cookie is tried before bearer because it is declared
   * first — the record's own key order is the entire strategy chain.
   */
  export class Authentication extends HttpApiMiddleware.Service<
    Authentication,
    { provides: CurrentPrincipal }
  >()("Authentication", {
    security: { cookie: SessionCookie, bearer: BearerToken },
  ```

- `packages/server/src/Authentication.ts:299` — Both schemes funnel into authenticate -> resolveSession -> Sessions.verify (opaque id.secret only); no BearerCredentialResolver seam exists.

  ```ts
      const handle: HttpApiMiddleware.HttpApiMiddlewareSecurity<
        { readonly cookie: typeof Api.SessionCookie; readonly bearer: typeof Api.BearerToken },
        Api.CurrentPrincipal,
        typeof Api.Unauthenticated,
        never
      >["cookie"] = (httpEffect, { credential }) => authenticate("cookie", httpEffect, credential);
      const bearer: typeof handle = (httpEffect, { credential }) =>
        authenticate("bearer", httpEffect, credential);
  ```

**Fix plan** (effort **M**): Generalize decision 33's single BearerCredentialResolver into an ordered, plugin-contributed registry of bearer resolvers, so jwt and api-key (and later SCIM) can each claim bearer credentials without editing @awthaq/api or @awthaq/server.

Steps:
1. packages/server/src/Authentication.ts: define `BearerResolverContribution { id: string; claims: (raw: string) => boolean; resolve: (credential) => Effect<Api.Principal, Api.Unauthenticated> }`, and `BearerCredentialResolvers` as an ADR-EA-012 aggregating registry (contributions appended by Layer, frozen at first read, ordered by dependency order then id).
2. The bearer handler asks each contribution in order via `claims`. The first match resolves; if none match, resolveSession runs. Resolution happens per request, as PostAuthResponseHook's does.
3. @awthaq/jwt contributes `{ id: "jwt", claims: three segments }` when acceptAsBearer is set; @awthaq/api-key (MAPS-003) contributes `{ id: "api-key", claims: startsWith(config.prefix) }`.
4. Keep Api.ts's `security` record closed (cookie and bearer). API keys ride `Authorization: Bearer`, so BEH-EA-072's 'declaration order is the entire chain' still holds. Update spec/models/07-api-keys.md:70-71 ('a third scheme') to say 'a bearer-credential resolver contribution'.

Files: `packages/server/src/Authentication.ts`, `packages/jwt/src/Jwt.ts`, `spec/models/07-api-keys.md`, `spec/behaviors/09-authentication-middleware.md`

Tests (write first):
- packages/server/test/Authentication.test.ts: 'two contributions: the first whose claims() matches resolves'; 'no contribution matches: falls through to Sessions.verify'; 'a claiming contribution that fails yields Unauthenticated without trying later ones'.

Acceptance:
- A plugin can add a bearer credential type with a Layer alone, with no fork of api/server.
- Cookie-first ordering (BEH-EA-072) is unchanged.

Spec refs: BEH-EA-066, BEH-EA-072

Depends on: MAPS-001, MAPS-003

Decision needed — see **Decisions needed** above.

**Recommended status:** `ready-for-human`

#### AGA-003 — Authentication cannot actually be offloaded: the origin rejects the only edge-verifiable credential it mints

`medium` · `architecture` · `server` · [.issues/medium/AGA-003-api-gateway-auth-specialist.md](../../.issues/medium/AGA-003-api-gateway-auth-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MAPS-001**

The same root cause as MAPS-001. Decision 33 picked the 'opt-in JWT-validation scheme with its own audience' branch of AGA-003's recommendation, so an RFC 7662 introspection endpoint is not planned.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:299` — Both schemes funnel into authenticate -> resolveSession -> Sessions.verify (opaque id.secret only); no BearerCredentialResolver seam exists.

  ```ts
      const handle: HttpApiMiddleware.HttpApiMiddlewareSecurity<
        { readonly cookie: typeof Api.SessionCookie; readonly bearer: typeof Api.BearerToken },
        Api.CurrentPrincipal,
        typeof Api.Unauthenticated,
        never
      >["cookie"] = (httpEffect, { credential }) => authenticate("cookie", httpEffect, credential);
      const bearer: typeof handle = (httpEffect, { credential }) =>
        authenticate("bearer", httpEffect, credential);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### JR-004 — Role-separation seam: the server mints aud-scoped JWTs it will never itself accept; bearer transport is opaque session tokens only

`medium` · `architecture` · `server` · [.issues/medium/JR-004-justin-richer.md](../../.issues/medium/JR-004-justin-richer.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MAPS-001**

The same one-way trust gap (the server mints JWTs it never accepts). Decision 33 covers both the opt-in validation scheme and the audience contract documentation that JR-004 asks for.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:184` — PlatformError now dies (NHS-002 fixed), but SessionNotFound/SessionExpired are mapped to Unauthenticated with no log, span annotation, metric or event.

  ```ts
      const memoized = yield* Effect.cached(
        raw === ""
          ? Effect.fail(new Api.Unauthenticated())
          : sessions
              .verify(Redacted.make(raw))
              .pipe(
                Effect.catchTag("PlatformError", Effect.die),
                Effect.mapError(() => new Api.Unauthenticated()),
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### VB-008 — Bearer scheme consumes raw session secrets; minted JWTs have no in-repo consumer

`info` · `api` · `api` · [.issues/info/VB-008-vittorio-bertocci.md](../../.issues/info/VB-008-vittorio-bertocci.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MAPS-001**

Documentation ask ('this server never accepts its own JWTs') is covered by MAPS-001's README step. The 'api keys need real scopes' half is MAPS-003's decision 10 (slice 09).

**Evidence at HEAD:**

- `packages/api/src/Api.ts:110` — Closed two-key record; ordering from declaration key order (mandated by BEH-EA-072).

  ```ts
  /**
   * BEH-EA-028/065/072: cookie is tried before bearer because it is declared
   * first — the record's own key order is the entire strategy chain.
   */
  export class Authentication extends HttpApiMiddleware.Service<
    Authentication,
    { provides: CurrentPrincipal }
  >()("Authentication", {
    security: { cookie: SessionCookie, bearer: BearerToken },
  ```

- `packages/api/src/Api.ts:27` — No scopes field on either M2M principal.

  ```ts
  export class ApiKeyPrincipal extends Schema.TaggedClass<ApiKeyPrincipal>()("ApiKey", {
    ref: PrincipalRef,
  }) {}
  
  export class ServicePrincipal extends Schema.TaggedClass<ServicePrincipal>()("Service", {
    ref: PrincipalRef,
  }) {}
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `csrf-hardening`

#### CDS-004 — No-payload mutating POSTs bypass the JSON content-type gate — SameSite-only defense for logout and kill-switch endpoints

`medium` · `security` · `api` · [.issues/medium/CDS-004-csrf-defense-specialist.md](../../.issues/medium/CDS-004-csrf-defense-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `409334e`

The session group now carries CsrfProtection, whose double-submit check runs regardless of payload or content-type, which is exactly the recommended fix. A suggested (non-blocking) regression test for the orchestrator: POST /auth/session/sign-out with a session cookie but no CSRF pair gets 403.

**Evidence at HEAD:**

- `packages/api/src/Session.ts:59` — Commit 409334e attached CsrfProtection to SessionGroup (and AccountGroup, Admin, Organization, Passkey*, Password groups).

  ```ts
    // CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `CsrfProtection`
    // declared last (outermost, runs first — see `AuthorizedSubject.ts`'s
    // header on declaration order) so a forged request is rejected before
    // `Authentication` does any credential work.
    .middleware(Authentication)
    .middleware(CsrfProtection);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### CDS-005 — siteCheck passes same-site and header-less requests — safe only while the double-submit leg actually runs

`medium` · `security` · `server` · [.issues/medium/CDS-005-csrf-defense-specialist.md](../../.issues/medium/CDS-005-csrf-defense-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `409334e`

The finding's own recommended fix: 'Treat CDS-001 as the gating fix; once attached, the same-site acceptance is defensible'. CDS-001 was resolved by 409334e, which attached CsrfProtection to every mutating group, so the double-submit leg now backs siteCheck. The optional subdomain-trust documentation note can ride MNA-008's Csrf.ts header update.

**Evidence at HEAD:**

- `packages/server/src/Csrf.ts:122` — Unchanged, but the double-submit leg now runs on every mutating core/plugin group (409334e), which is the gating fix the finding names.

  ```ts
      const secFetchSite = Headers.get(headers, "sec-fetch-site");
      if (Option.isSome(secFetchSite)) {
        return secFetchSite.value !== "cross-site";
      }
  ```

- `packages/api/src/Session.ts:59` — Commit 409334e attached CsrfProtection to SessionGroup (and AccountGroup, Admin, Organization, Passkey*, Password groups).

  ```ts
    // CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `CsrfProtection`
    // declared last (outermost, runs first — see `AuthorizedSubject.ts`'s
    // header on declaration order) so a forged request is rejected before
    // `Authentication` does any credential work.
    .middleware(Authentication)
    .middleware(CsrfProtection);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### CDS-006 — CSRF token is not bound to the session and never expires

`low` · `security` · `server` · [.issues/low/CDS-006-csrf-defense-specialist.md](../../.issues/low/CDS-006-csrf-defense-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/server/src/Csrf.ts:91` — No issued-at, no expiry, no binding.

  ```ts
  const mint = Effect.fnUntraced(function* (
    crypto: Crypto.Crypto,
    secret: Redacted.Redacted<string>,
  ) {
    const token = toHex(yield* crypto.randomBytes(32));
    const signature = yield* sign(crypto, secret, token);
    return `${token}.${signature}`;
  });
  ```

**Fix plan** (effort **M**): Time-bound the double-submit token: sign `<iat>.<random>`, reject tokens older than a configurable max age, and re-mint proactively so the window never bites mid-session.

Steps:
1. packages/server/src/Csrf.ts: change the token format to `<iatSeconds>.<randomHex>.<hmac>`, with the HMAC over `${iat}.${random}`. `isValid` checks the signature (constant time) and `now - iat <= maxAge` (plus 60s skew for future iat).
2. CsrfConfigShape gains `maxAge?: Duration.Input` (default 24h, per the auditor). Re-mint on ANY request (safe or unsafe) once age exceeds maxAge/2, so active users always hold a fresh token. A token past maxAge is invalid (403 on unsafe requests), and the fresh cookie rides that response.
3. Do NOT bind the token to the session: the session secret rotates every touchEvery, so binding would cause hourly 403 storms. Document this rejection in the Csrf.ts header.

Files: `packages/server/src/Csrf.ts`, `spec/behaviors/10-csrf.md`

Tests (write first):
- packages/server/test/Csrf.test.ts (write first, TestClock): 'a token older than maxAge is rejected on POST'; 'a token older than maxAge/2 is re-minted on a GET'; 'a token with a tampered iat fails signature'.

Acceptance:
- No CSRF token is accepted beyond maxAge.
- Active users never hit a 403 from expiry.

Spec refs: BEH-EA-075

Depends on: ACS-005

**Recommended status:** `ready-for-agent`

#### MNA-008 — __Host-csrf cookie set without Secure - same prefix violation class, currently latent

`low` · `security` · `server` · [.issues/low/MNA-008-mobile-native-auth-specialist.md](../../.issues/low/MNA-008-mobile-native-auth-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

Refuted half: HttpApiBuilder.securitySetCookie defaults `secure: true`, and Csrf.ts passes no `secure` key, so __Host-csrf is emitted with Secure. The live half: since 409334e attached CsrfProtection everywhere, without the decided bearer exemption, a cookie-less bearer client gets 403 on sign-out/revoke/delete-user, which breaks native flows today.

**Evidence at HEAD:**

- `packages/server/src/Csrf.ts:153` — No `secure` key passed — securitySetCookie's default `secure: true` applies.

  ```ts
          if (!cookieIsValid) {
            const fresh = yield* mint(crypto, config.secret).pipe(Effect.orDie);
            yield* HttpApiBuilder.securitySetCookie(Api.CsrfCookie, fresh, {
              httpOnly: false,
              sameSite: "strict",
              path: "/",
            });
          }
  ```

- `../effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:599` — securitySetCookie defaults secure: true; Csrf.ts passes no `secure` key, so __Host-csrf IS emitted with Secure.

  ```ts
    HttpEffect.appendPreResponseHandler((_req, response) =>
      Effect.orDie(
        Response.setCookie(response, self.key, stringOrRedacted(value), {
          secure: true,
          httpOnly: true,
          ...options
        })
  ```

- `packages/server/src/Csrf.ts:162` — No `authorization`-header exemption: decision 24 §2 (bearer exemption) was never implemented, so a cookie-less bearer client POSTing /auth/session/sign-out etc. fails the double-submit check (:174-181) with 403.

  ```ts
          if (!UNSAFE_METHODS.has(request.method)) {
            return yield* httpEffect;
          }
  
          const siteOk = yield* siteCheck(request.headers, config.allowedOrigins);
          if (!siteOk) {
            return yield* Effect.fail(new Api.CsrfRejected());
          }
  ```

**Fix plan** (effort **S**): The Secure-attribute claim is invalid, but the consequence it predicts for bearer clients is live: implement decision 24 §2's bearer exemption in CsrfProtectionLive.

Steps:
1. packages/server/src/Csrf.ts: at the top of the middleware, if the request carries a non-empty `authorization` header, skip both minting and enforcement and run `httpEffect`, per .scratch/resolve-ready-for-human-findings/issues/24-client-csrf-middleware-attachment.md §2. A cross-site page cannot set Authorization without a CORS preflight, so this is outside the CSRF threat model. Document it in Csrf.ts's header.
2. spec/behaviors/10-csrf.md: add the bearer exemption as a sub-requirement of BEH-EA-077. Note that `Auth.make(..., { csrf })` (decision 24 §1) is still unimplemented and tracked with APS-001/PDR-002.
3. Optionally assert `Secure` on __Host-csrf in a wire test, to lock in the default that makes this finding's first half moot.

Files: `packages/server/src/Csrf.ts`, `spec/behaviors/10-csrf.md`

Tests (write first):
- packages/server/test/Csrf.test.ts (write first): 'an unsafe request with Authorization: Bearer and no CSRF cookie/header passes'; 'a cookie-only unsafe request without the pair is still rejected 403'.
- packages/server/test/AuthHttp.test.ts: 'POST /auth/session/sign-out with only a bearer token answers 204' (currently 403); 'the minted __Host-csrf Set-Cookie includes Secure'.

Acceptance:
- Native and bearer clients can call every mutating core endpoint without CSRF plumbing.
- Browser cookie flows are still fully protected.

Spec refs: BEH-EA-077, BEH-EA-075, BEH-EA-066

Depends on: —

**Recommended status:** `ready-for-agent`

#### PDR-007 — Spec mandates CSRF composition (BEH-EA-073..080 MUSTs) while shipped contracts cannot satisfy it

`info` · `compliance` · `api` · [.issues/info/PDR-007-philippe-de-ryck.md](../../.issues/info/PDR-007-philippe-de-ryck.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `409334e`

The docs-vs-code divergence is gone: BEH-EA-073..080 now run on real shipped contracts (session, account, admin, organization, passkey, password groups). The remaining Auth.make {csrf} work (BEH-EA-079) is tracked by PDR-002/APS-001, not here.

**Evidence at HEAD:**

- `packages/api/src/Session.ts:59` — Commit 409334e attached CsrfProtection to SessionGroup (and AccountGroup, Admin, Organization, Passkey*, Password groups).

  ```ts
    // CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `CsrfProtection`
    // declared last (outermost, runs first — see `AuthorizedSubject.ts`'s
    // header on declaration order) so a forged request is rejected before
    // `Authentication` does any credential work.
    .middleware(Authentication)
    .middleware(CsrfProtection);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `hmac-secret-hygiene`

#### SMS-004 — CSRF and challenge-cookie HMAC secrets ship without any Config/env loading layer

`medium` · `security` · `server` · [.issues/medium/SMS-004-secrets-management-specialist.md](../../.issues/medium/SMS-004-secrets-management-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/server/src/Csrf.ts:24` — No Config-backed layer and no length floor; contrast packages/ports/src/KeyProvider.ts:74-80 (`layerEnv` reading `Config.Redacted("AWTHAQ_ENCRYPTION_KEY")`, dies unless 32 bytes).

  ```ts
  export interface CsrfConfigShape {
    /** BEH-EA-075: signs the double-submit cookie; never a default in production. */
    readonly secret: Redacted.Redacted<string>;
    /** BEH-EA-074: compared against `Origin` when `Sec-Fetch-Site` is absent. */
    readonly allowedOrigins: ReadonlyArray<string>;
  }
  ```

**Fix plan** (effort **S**): Ship Config-backed layers for the CSRF secret and origins (mirroring KeyProvider.layerEnv), so the obvious path never puts a literal secret in source.

Steps:
1. packages/server/src/Csrf.ts: `export const layerConfig = Layer.effect(CsrfConfig, Effect.gen(function* () { const secret = yield* Config.Redacted("AWTHAQ_CSRF_SECRET"); const allowedOrigins = yield* Config.Array(Config.String("AWTHAQ_CSRF_ALLOWED_ORIGINS")) /* check exact v4 Config combinator names in ../effect */; yield* requireMinSecretBytes(secret); return { secret, allowedOrigins }; }))`. Do not annotate the type.
2. Use it in examples/memory-server and the README quickstart. Mirror it with `ChallengeStore.layerConfig` (AWTHAQ_CHALLENGE_COOKIE_SECRET) in slice 10.
3. Document the env vars next to AWTHAQ_ENCRYPTION_KEY.

Files: `packages/server/src/Csrf.ts`, `examples/memory-server/index.ts`, `README.md`

Tests (write first):
- packages/server/test/Csrf.test.ts (write first): 'layerConfig reads AWTHAQ_CSRF_SECRET via ConfigProvider.fromMap'; 'missing secret fails with ConfigError'; 'short secret dies WeakSigningSecret'.

Acceptance:
- An app can wire CSRF with zero secret literals in source.
- Misconfiguration fails at boot.

Spec refs: BEH-EA-075, BEH-EA-126

Depends on: ACS-007

**Recommended status:** `ready-for-agent`

#### ACS-005 — RFC 2104 HMAC-SHA256 hand-rolled and duplicated across plugins

`low` · `correctness` · `server` · [.issues/low/ACS-005-applied-cryptography-specialist.md](../../.issues/low/ACS-005-applied-cryptography-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/server/src/Csrf.ts:59` — Second copy at packages/passkey/src/ChallengeStore.ts:207; constantTimeEqual also in Csrf.ts:38 (string/codePointAt), ChallengeStore.ts:230 and core Sessions.ts:50 (bytes); toHex in Csrf.ts:35, Sessions.ts:33, Verification.ts:54, Password.ts:184. Effect's Crypto has no HMAC primitive.

  ```ts
  const hmacSha256: (
    crypto: Crypto.Crypto,
    key: Uint8Array,
    message: Uint8Array,
  ) => Effect.Effect<Uint8Array, PlatformError.PlatformError> = Effect.fnUntraced(
    function* (crypto, key, message) {
      let blockKey = key.length > SHA256_BLOCK_SIZE ? yield* crypto.digest("SHA-256", key) : key;
  ```

**Fix plan** (effort **M**): Hoist HMAC-SHA256, constant-time equality and hex encoding into one tested module in @awthaq/ports, and use it from server, passkey and core.

Steps:
1. Add packages/ports/src/Hmac.ts with `hmacSha256(crypto, key, message)`, `constantTimeEqualBytes(a, b)`, `constantTimeEqualString(a, b)` (encode, then compare bytes; replaces Csrf's codePointAt variant) and `toHex(bytes)`. Export it from packages/ports/src/index.ts.
2. Replace the copies in packages/server/src/Csrf.ts:35-81, packages/passkey/src/ChallengeStore.ts:207-235, packages/core/src/Sessions.ts:33-57, packages/core/src/Verification.ts:54 and packages/password/src/Password.ts:184.

Files: `packages/ports/src/Hmac.ts (new)`, `packages/ports/src/index.ts`, `packages/server/src/Csrf.ts`, `packages/passkey/src/ChallengeStore.ts`, `packages/core/src/Sessions.ts`, `packages/core/src/Verification.ts`, `packages/password/src/Password.ts`

Tests (write first):
- packages/ports/test/Hmac.test.ts (write first): RFC 4231 test cases 1-7 for HMAC-SHA256; property test (fast-check) against node:crypto createHmac as an oracle; constantTimeEqual agrees with timingSafeEqual on equal-length inputs and returns false on length mismatch.

Acceptance:
- One HMAC implementation in the repo.
- RFC 4231 vectors pass.
- All existing CSRF/passkey/session tests stay green.

Spec refs: BEH-EA-075, BEH-EA-056

Depends on: —

**Recommended status:** `ready-for-agent`

#### ACS-007 — No minimum length enforced on HMAC signing secrets

`low` · `security` · `server` · [.issues/low/ACS-007-applied-cryptography-specialist.md](../../.issues/low/ACS-007-applied-cryptography-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/server/src/Csrf.ts:24` — No Config-backed layer and no length floor; contrast packages/ports/src/KeyProvider.ts:74-80 (`layerEnv` reading `Config.Redacted("AWTHAQ_ENCRYPTION_KEY")`, dies unless 32 bytes).

  ```ts
  export interface CsrfConfigShape {
    /** BEH-EA-075: signs the double-submit cookie; never a default in production. */
    readonly secret: Redacted.Redacted<string>;
    /** BEH-EA-074: compared against `Origin` when `Sec-Fetch-Site` is absent. */
    readonly allowedOrigins: ReadonlyArray<string>;
  }
  ```

**Fix plan** (effort **S**): Enforce a 32-byte minimum on HMAC signing secrets at layer construction, dying loudly like KeyProvider.layerEnv.

Steps:
1. packages/ports/src/Hmac.ts: add `requireMinSecretBytes(secret: Redacted<string>, min = 32)`, returning `Effect<void, never>` that dies with a tagged `WeakSigningSecret` defect when UTF-8 length < 32.
2. Call it at the start of CsrfProtectionLive's Layer.effect (and in ChallengeStore's layer, slice 10).
3. Update test fixtures that use short secrets (e.g. packages/server/test/Csrf.test.ts:73 `"test-csrf-secret"`) to 32+ byte values.

Files: `packages/server/src/Csrf.ts`, `packages/ports/src/Hmac.ts`, `packages/passkey/src/ChallengeStore.ts`

Tests (write first):
- packages/server/test/Csrf.test.ts (write first): 'building CsrfProtectionLive with a 16-byte secret dies with WeakSigningSecret'; 'a 32-byte secret builds'.

Acceptance:
- No composition can run CSRF/challenge signing with a key under 32 bytes.

Spec refs: BEH-EA-075

Depends on: ACS-005

**Recommended status:** `ready-for-agent`

### Workstream `session-cookie-expiry`

#### CSS-002 — No cookie expiry anywhere: sign-out, revoke-all, and account deletion leave the dead __Host-session in the browser jar

`medium` · `security` · `server` · [.issues/medium/CSS-002-cookie-security-specialist.md](../../.issues/medium/CSS-002-cookie-security-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for IC-002, NSA-004, SMS-005-session-management-specialist

**Evidence at HEAD:**

- `packages/server/src/Session.ts:84` — No Set-Cookie emitted; repo-wide grep for maxAge: 0 / Max-Age=0 / expireCookie under packages/ returns nothing.

  ```ts
        signOut: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          yield* sessions
            .revoke(Sessions.SessionId(principal.sessionId))
            .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
        }),
  ```

- `packages/server/src/Session.ts:120` — Same for revokeAll.

  ```ts
        revokeAll: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          const userId = Users.UserId(principal.ref.id);
          yield* sessions.revokeAll(userId);
        }),
  ```

- `packages/api/src/Session.ts:53` — Deliberately no cookie clearing.

  ```ts
    // Upstream-hardening map, ticket 02: completes the `revoke`/
    // `revokeOthers`/`revokeAll` naming symmetry — kills every session for
    // the caller, no exceptions, including the caller's own current
    // session. No payload, no response cookie-clearing, matching
    // `signOut`'s existing precedent.
    .add(HttpApiEndpoint.post("revokeAll", "/session/revoke-all"))
  ```

- `packages/server/src/Account.ts:103` — Cascade is transactional since e940a12.

  ```ts
          yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                yield* accounts.deleteAllByUser(userId);
  ```

**Fix plan** (effort **M**): Expire __Host-session on every response that ends the caller's own session: signOut, revokeAll, revoke when the target is the current session, deleteUser, and the EHA-009 'current row missing' path.

Steps:
1. Add an internal helper in packages/server (e.g. `src/internal/SessionCookie.ts`): `expireSessionCookie = HttpEffect.appendPreResponseHandler((_req, res) => HttpServerResponse.expireCookie(res, Api.SessionCookie.key, { path: "/", secure: true, httpOnly: true, sameSite: "strict" }).pipe(Effect.catch(() => Effect.succeed(res))))`. Effect's expireCookie (HttpServerResponse.ts:657) emits an empty value, Max-Age=0 and an epoch Expires. __Host- requires Secure and Path=/ on the expiring write too.
2. Call it in Session.ts `signOut`, `revokeAll`, `revoke` (only when `targetId === principal.sessionId`), and Account.ts `deleteUser`.
3. Update the stale comment at packages/api/src/Session.ts:53-58 ('no response cookie-clearing').
4. spec: add under BEH-EA-055 that sign-out, revoke-all and account deletion MUST expire the session cookie.
5. Next adapter (slice 11): once this lands, withNextCookies' 'cleared one after sign-out' promise holds. Add the WithNextCookies test and README sign-out recipe that NSA-004/IC-002 ask for there (BO-002).

Files: `packages/server/src/Session.ts`, `packages/server/src/Account.ts`, `packages/server/src/internal/SessionCookie.ts (new)`, `packages/api/src/Session.ts`, `spec/behaviors/07-sessions.md`

Tests (write first):
- packages/server/test/AuthHttp.test.ts (write first): 'POST /session/sign-out responds with Set-Cookie __Host-session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict'; same for POST /session/revoke-all, for POST /session/revoke with the caller's own id, and for DELETE /user; 'revoking another session does NOT expire the caller's cookie'.
- BDD: extend the sessions feature's sign-out scenario if it is wired (features/features/**/07-sessions*.feature).

Acceptance:
- Every self-ending endpoint expires the cookie with attributes a browser accepts for a __Host- cookie.
- Revoking a different session leaves the cookie intact.

Spec refs: BEH-EA-031, BEH-EA-055, BEH-EA-054

Depends on: —

**Recommended status:** `ready-for-agent`

#### IC-002 — signOut revokes the session but never clears the cookie; no cookie-clearing exists anywhere

`medium` · `dx` · `server` · [.issues/medium/IC-002-iain-collins.md](../../.issues/medium/IC-002-iain-collins.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSS-002**

The same missing cookie expiry. The withNextCookies test it asks for is listed in CSS-002 step 5, which hands off to slice 11.

**Evidence at HEAD:**

- `packages/server/src/Session.ts:84` — No Set-Cookie emitted; repo-wide grep for maxAge: 0 / Max-Age=0 / expireCookie under packages/ returns nothing.

  ```ts
        signOut: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          yield* sessions
            .revoke(Sessions.SessionId(principal.sessionId))
            .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
        }),
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### NSA-004 — Sign-out never clears the session cookie, so the promised post-sign-out cookie bridge has nothing to bridge

`medium` · `correctness` · `server` · [.issues/medium/NSA-004-nextjs-server-actions-auth-specialist.md](../../.issues/medium/NSA-004-nextjs-server-actions-auth-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSS-002**

The same root cause. The README sign-out recipe belongs to the next-adapter work (slice 11, BO-002/IC-004).

**Evidence at HEAD:**

- `packages/server/src/Session.ts:84` — No Set-Cookie emitted; repo-wide grep for maxAge: 0 / Max-Age=0 / expireCookie under packages/ returns nothing.

  ```ts
        signOut: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          yield* sessions
            .revoke(Sessions.SessionId(principal.sessionId))
            .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
        }),
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### SMS-005 — signOut/revokeAll never clear the session cookie from the browser

`low` · `api` · `api` · [.issues/low/SMS-005-session-management-specialist.md](../../.issues/low/SMS-005-session-management-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CSS-002**

The same fix, including revoke-of-current (CSS-002 step 2).

**Evidence at HEAD:**

- `packages/api/src/Session.ts:53` — Deliberately no cookie clearing.

  ```ts
    // Upstream-hardening map, ticket 02: completes the `revoke`/
    // `revokeOthers`/`revokeAll` naming symmetry — kills every session for
    // the caller, no exceptions, including the caller's own current
    // session. No payload, no response cookie-clearing, matching
    // `signOut`'s existing precedent.
    .add(HttpApiEndpoint.post("revokeAll", "/session/revoke-all"))
  ```

- `packages/server/src/Session.ts:84` — No Set-Cookie emitted; repo-wide grep for maxAge: 0 / Max-Age=0 / expireCookie under packages/ returns nothing.

  ```ts
        signOut: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          yield* sessions
            .revoke(Sessions.SessionId(principal.sessionId))
            .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
        }),
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `session-handler-hardening`

#### GC-003 — Brand re-entry into the domain is by unchecked nominal casts in the imperative shell

`medium` · `architecture` · `server` · [.issues/medium/GC-003-giulio-canti.md](../../.issues/medium/GC-003-giulio-canti.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

The nominal casts are confirmed (12 sites in packages/server/src). The cited redundant `input.supersedes as SessionId` no longer exists at HEAD. Branding the whole PrincipalRef.id at the contract is not recommended, because PrincipalRef is polymorphic (user/apikey/service ids).

**Evidence at HEAD:**

- `packages/server/src/Session.ts:33` — Duplicated verbatim in packages/server/src/Account.ts:19-28; every handler then re-brands with Users.UserId(...)/Sessions.SessionId(...) (12 call sites in packages/server/src). The `as SessionId` in Sessions.ts cited by GC-003 no longer exists (grep: 0 hits).

  ```ts
  const currentUserPrincipal: Effect.Effect<Api.UserPrincipal, never, Api.CurrentPrincipal> =
    Effect.gen(function* () {
      const principal = yield* Api.CurrentPrincipal;
      if (principal._tag !== "User") {
        return yield* Effect.die(
          new Error(`awthaq: session group reached with a non-User principal: ${principal._tag}`),
        );
      }
  ```

- `packages/core/src/Users.ts:48` — Brand.nominal: no runtime check.

  ```ts
  export type UserId = string & Brand.Brand<"UserId">;
  export const UserId = Brand.nominal<UserId>();
  ```

**Fix plan** (effort **S**): Re-establish brands once per request in one shared helper, not at 12 call sites, and delete the duplicated currentUserPrincipal.

Steps:
1. Add packages/server/src/internal/CurrentUser.ts: `currentUser` is an Effect<{ principal: Api.UserPrincipal; userId: Users.UserId; sessionId: Sessions.SessionId }, never, Api.CurrentPrincipal>. It is the single place where `Users.UserId(...)`/`Sessions.SessionId(...)` are applied to a principal that came from a verified session, and it dies with the tagged defect from GC-008 for a non-User principal.
2. Replace both `currentUserPrincipal` copies (Session.ts:33-42, Account.ts:19-28) and every handler-local cast with `currentUser`. `payload.id` in `revoke` stays the one wire-to-domain cast (or decode it with a branded schema, see the next step).
3. Optional, recommended: in packages/api, declare `RevokePayload.id` as `Schema.String.pipe(Schema.brand("SessionId"))`. Effect's Brand<"SessionId"> is the same nominal brand core uses, so the decoded value is already a SessionId and no cast is needed.

Files: `packages/server/src/internal/CurrentUser.ts (new)`, `packages/server/src/Session.ts`, `packages/server/src/Account.ts`, `packages/api/src/Session.ts`

Tests (write first):
- Existing packages/server/test/AuthHttp.test.ts session/account suites must stay green (refactor).
- Type-level: add a `// @ts-expect-error` check in a test showing a plain string is not accepted where UserId is required (guards against regression).

Acceptance:
- `grep -c 'UserId(\|SessionId(' packages/server/src/*.ts` is 0 outside internal/CurrentUser.ts.
- No duplicated currentUserPrincipal remains.

Spec refs: BEH-EA-031

Depends on: —

**Recommended status:** `ready-for-agent`

#### GC-005 — Sessions.revoke shape forces a check-then-act composition in the shell

`medium` · `api` · `server` · [.issues/medium/GC-005-giulio-canti.md](../../.issues/medium/GC-005-giulio-canti.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Validation adds a concrete bug to this 'shape' finding: `sessions.list(userId)` is capped at LIST_PAGE_SIZE = 200 in the SQL layer (Sessions.ts:642, :873), so revoking an owned session outside the first page answers 404. This relates to PIL-003 (slice 01).

**Evidence at HEAD:**

- `packages/server/src/Session.ts:99` — Ownership enforced by list-then-check in the shell; `list` is capped (Sessions.ts:642 `const LIST_PAGE_SIZE = 200;`, :873), so an owned session beyond the first page is wrongly reported SessionNotFound.

  ```ts
          const principal = yield* currentUserPrincipal;
          const userId = Users.UserId(principal.ref.id);
          const targetId = Sessions.SessionId(payload.id);
          const owned = yield* sessions.list(userId);
          if (!owned.some((row) => row.id === targetId)) {
            return yield* Effect.fail(new SessionContract.SessionNotFound());
          }
  ```

**Fix plan** (effort **M**): Add an owning revoke to the Sessions algebra, so ownership and enumeration-safety are enforced in the domain operation. This also fixes the 200-row list cap that wrongly 404s owned sessions.

Steps:
1. packages/sql/src/Repositories.ts: add `deleteOwned(id: SessionId, userId: UserId): Effect<boolean, SqlError>` to SessionsRepositoryShape (`DELETE FROM sessions WHERE id = ? AND "userId" = ?`, returning whether a row was affected), for both dialects.
2. packages/core/src/Sessions.ts: add `revokeOwned(userId, id): Effect<void, SessionNotFound>` to SessionsShape. It fails SessionNotFound for both unknown and foreign ids. Implement it in layerMemory (one Ref.modify checking row.userId) and layerSql (deleteOwned), and publish `auth.session.revoked` exactly as `revoke` does.
3. packages/server/src/Session.ts `revoke` handler: a single `sessions.revokeOwned(userId, targetId).pipe(Effect.catchTag("SessionNotFound", () => Effect.fail(new SessionContract.SessionNotFound())))`, dropping the list/some check.
4. Keep bare `revoke` for already-authorized contexts (admin, signOut).

Files: `packages/sql/src/Repositories.ts`, `packages/core/src/Sessions.ts`, `packages/server/src/Session.ts`

Tests (write first):
- packages/core/test/Sessions.test.ts (write first, both layers): 'revokeOwned revokes an owned session'; 'revokeOwned on another user's session fails SessionNotFound and leaves it live'; 'revokeOwned on an unknown id fails SessionNotFound'.
- packages/server/test/AuthHttp.test.ts: 'revoke succeeds for an owned session older than the first 200 list rows' (issue 201 sessions).

Acceptance:
- Ownership is enforced atomically in core.
- The handler is a single call.
- BEH-EA-086 enumeration-safety is preserved.
- No 200-row cap on revoke.

Spec refs: BEH-EA-054, BEH-EA-086, BEH-EA-031

Depends on: —

**Recommended status:** `ready-for-agent`

#### EHA-009 — Session 'current' handler defects to a 500 on a concurrent-revoke race

`low` · `correctness` · `server` · [.issues/low/EHA-009-effect-http-api-specialist.md](../../.issues/low/EHA-009-effect-http-api-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/server/src/Session.ts:60` — Concurrent revoke between middleware verify and list -> plain-Error defect -> 500. Also nominal brand casts at :62-63.

  ```ts
        current: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          const userId = Users.UserId(principal.ref.id);
          const sessionId = Sessions.SessionId(principal.sessionId);
          const items = yield* sessions.list(userId, sessionId);
          const item = items.find((row) => row.current);
          if (item === undefined) {
            return yield* Effect.die(new Error("awthaq: current session missing from its own list"));
  ```

**Fix plan** (effort **S**): Answer a concurrently-revoked current session with a typed 401 and an expired cookie, not a 500 defect.

Steps:
1. packages/api/src/Session.ts: declare `error: Api.Unauthenticated` on the `current` endpoint (it is already in the group's documented errors through the middleware, and getErrorSchemas dedupes).
2. packages/server/src/Session.ts `current`: when the current row is missing, run `expireSessionCookie` (CSS-002) and `Effect.fail(new Api.Unauthenticated())`.

Files: `packages/api/src/Session.ts`, `packages/server/src/Session.ts`

Tests (write first):
- packages/server/test/AuthHttp.test.ts or a unit test with a Sessions double whose `list` omits the current row (simulating the race): 'GET /session answers 401 Unauthenticated and expires the cookie'.

Acceptance:
- The race yields a 401 with a typed body; the client session atom clears (BEH-EA-174/23-react).

Spec refs: BEH-EA-031, BEH-EA-067

Depends on: CSS-002

**Recommended status:** `ready-for-agent`

#### GC-008 — Untagged plain Error defect in the session handler breaks the catchable-error convention

`low` · `dx` · `server` · [.issues/low/GC-008-giulio-canti.md](../../.issues/low/GC-008-giulio-canti.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

Overstated: the flagged site is not 'the one plain Error in the request path'. There are 5 in packages/server/src alone and about 70 across packages (e.g. organization 22, password 5, passkey 5).

**Evidence at HEAD:**

- `packages/server/src/Session.ts:60` — Concurrent revoke between middleware verify and list -> plain-Error defect -> 500. Also nominal brand casts at :62-63.

  ```ts
        current: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          const userId = Users.UserId(principal.ref.id);
          const sessionId = Sessions.SessionId(principal.sessionId);
          const items = yield* sessions.list(userId, sessionId);
          const item = items.find((row) => row.current);
          if (item === undefined) {
            return yield* Effect.die(new Error("awthaq: current session missing from its own list"));
  ```

- `packages/server/src/Account.ts:62` — Plain-Error defects in server: Session.ts:38, :67; Account.ts:24, :63, :118 (5 sites) — and ~70 more across packages (grep `die(new Error`). The Session.ts:67 site is not 'the one'.

  ```ts
              Effect.catchTag("UserNotFound", () =>
                Effect.die(new Error(`awthaq: authenticated user missing: ${userId}`)),
              ),
  ```

**Fix plan** (effort **S**): Replace plain-Error defects in @awthaq/server with one tagged defect class. The repo-wide sweep is out of scope for this slice.

Steps:
1. Add `HandlerInvariantViolation extends Data.TaggedError("HandlerInvariantViolation")<{ readonly invariant: "NonUserPrincipal" | "AuthenticatedUserMissing"; readonly message: string }>` in packages/server/src/internal/Defects.ts.
2. Use it for Session.ts:38 (via CurrentUser), Account.ts:24 and :63, and :118 (moving to core with CSG-001's eraseAccount). Session.ts:67 disappears with EHA-009.
3. Record the other ~70 `die(new Error(...))` sites across packages as a follow-up for the orchestrator. Do not sweep them here.

Files: `packages/server/src/internal/Defects.ts (new)`, `packages/server/src/Session.ts`, `packages/server/src/Account.ts`

Tests (write first):
- packages/server/test: 'a non-User principal reaching the session group dies with HandlerInvariantViolation' (provide a CurrentPrincipal of ApiKey via a test middleware; assert Cause.dieOption is the tagged error).

Acceptance:
- packages/server/src contains no `new Error(`.

Spec refs: BEH-EA-027

Depends on: GC-003, EHA-009

**Recommended status:** `ready-for-agent`

### Workstream `optional-auth-contract`

#### EHA-006 — OptionalAuthentication advertises a 401 that its implementation can never produce

`low` · `api` · `api` · [.issues/low/EHA-006-effect-http-api-specialist.md](../../.issues/low/EHA-006-effect-http-api-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Verify during implementation that security handlers may require ParsedSearchParams (securityDecode's R). The handlers already require HttpServerRequest via resolveSession.

**Evidence at HEAD:**

- `packages/api/src/Api.ts:133` — Declares Unauthenticated purely for the per-scheme handler shape.

  ```ts
  export class OptionalAuthentication extends HttpApiMiddleware.Service<
    OptionalAuthentication,
    { provides: CurrentPrincipal }
  >()("OptionalAuthentication", {
    security: { cookie: SessionCookie, bearer: BearerToken },
    error: Unauthenticated,
  }) {}
  ```

- `packages/server/src/Authentication.ts:370` — Unauthenticated can never escape OptionalAuthenticationLive; the fallback's correctness depends on bearer being the LAST declared scheme.

  ```ts
          Effect.catchTag("Unauthenticated", () =>
            Effect.provideService(httpEffect, Api.CurrentPrincipal, Api.anonymousPrincipal),
          ),
  ```

- `../effect/packages/effect/src/unstable/httpapi/HttpApiEndpoint.ts:285` — Middleware-declared errors are folded into every endpoint's documented error responses (used by HttpApi.reflect -> OpenAPI).

  ```ts
  export function getErrorSchemas(endpoint: Top): Array<Schema.Top> {
    const schemas = new Set<Schema.Top>(endpoint.error)
    const transform = endpoint.disableCodecs ? identity : transformResponseSchema
    for (const middleware of endpoint.middlewares) {
      const key = middleware as any as HttpApiMiddleware.AnyService
      for (const schema of key.error) {
        schemas.add(transform(schema))
      }
  ```

**Fix plan** (effort **M**): Give OptionalAuthentication no error type, so the OpenAPI document stops advertising an impossible 401. The cookie handler resolves cookie, then bearer, then anonymous itself.

Steps:
1. packages/api/src/Api.ts: remove `error: Unauthenticated` from OptionalAuthentication (`error` is optional, HttpApiMiddleware.ts:335) and update its doc comment.
2. packages/server/src/Authentication.ts OptionalAuthenticationLive: the `cookie` handler (E = never) tries the cookie credential. On Unauthenticated it decodes the bearer itself via `HttpApiBuilder.securityDecode(Api.BearerToken)` (HttpApiBuilder.ts:528) and tries that. On Unauthenticated again it provides `Api.anonymousPrincipal`. The `bearer` entry is then never reached, but remains declared so OpenAPI still documents both schemes.
3. Rotation delivery and PostAuthResponseHook stay on the success paths only (as today).

Files: `packages/api/src/Api.ts`, `packages/server/src/Authentication.ts`

Tests (write first):
- packages/server/test/AuthHttp.test.ts (write first): 'OpenAPI for GET /auth/subject (OptionalAuthentication) lists no 401 response; GET /auth/session (Authentication) still lists 401'.
- packages/server/test/Authentication.test.ts: the existing BEH-EA-068 tests (anonymous, valid cookie, valid bearer, invalid cookie + valid bearer) stay green.

Acceptance:
- The generated OpenAPI never documents 401 for OptionalAuthentication endpoints.
- BEH-EA-029/068 behavior is unchanged.

Spec refs: BEH-EA-029, BEH-EA-068, BEH-EA-084

Depends on: —

**Recommended status:** `ready-for-agent`

#### JR-007 — No RFC 6750/7235 challenge: 401s carry no WWW-Authenticate header and no insufficient_scope concept exists anywhere

`low` · `compliance` · `api` · [.issues/low/JR-007-justin-richer.md](../../.issues/low/JR-007-justin-richer.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/api/src/Api.ts:62` — Plain typed 401; repo-wide grep for WWW-Authenticate / invalid_token / insufficient_scope under packages/ returns nothing.

  ```ts
  /** BEH-EA-027/067: no scheme resolved a live session. */
  export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
    "Unauthenticated",
    {},
    { httpApiStatus: 401 },
  ) {}
  ```

**Fix plan** (effort **S**): Emit RFC 6750/7235 challenges on 401s from Authentication while keeping the typed JSON body.

Steps:
1. In AuthenticationLive's `bearer` handler (the last scheme, whose failure is the middleware's final failure), on Unauthenticated register `HttpEffect.appendPreResponseHandler((_, res) => Effect.succeed(res.status === 401 ? HttpServerResponse.setHeader(res, "www-authenticate", value) : res))`. `value` is `Bearer error="invalid_token"` when a non-empty bearer credential was presented, otherwise `Bearer realm="awthaq"`. Then re-fail.
2. Leave insufficient_scope for when scope enforcement exists (MAPS-003/qadi). Note it in spec as a planned mapping.

Files: `packages/server/src/Authentication.ts`, `spec/behaviors/09-authentication-middleware.md`

Tests (write first):
- packages/server/test/AuthHttp.test.ts (write first): 'invalid bearer: 401 with WWW-Authenticate: Bearer error="invalid_token"'; 'no credential: 401 with WWW-Authenticate: Bearer realm="awthaq"'; 'invalid cookie only: 401 with the realm challenge'.

Acceptance:
- Every Authentication 401 carries a WWW-Authenticate header.
- The typed JSON body is unchanged.

Spec refs: BEH-EA-067, BEH-EA-088

Depends on: —

**Recommended status:** `ready-for-agent`

#### NHS-010 — Auth strategy order is encoded as security-record key order in two synced places

`low` · `api` · `api` · [.issues/low/NHS-010-node-http-server-integration-specialist.md](../../.issues/low/NHS-010-node-http-server-integration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

Refuted parts: the order is not encoded in 'two synced places'. Effect iterates only the declaration's `security` record, and the Live record is looked up by key. An 'ordered tuple' is not expressible with HttpApiMiddleware's record API, and BEH-EA-072 mandates declaration order. The real coupling is that OptionalAuthenticationLive's fallback assumes bearer is last.

**Evidence at HEAD:**

- `packages/api/src/Api.ts:110` — Closed two-key record; ordering from declaration key order (mandated by BEH-EA-072).

  ```ts
  /**
   * BEH-EA-028/065/072: cookie is tried before bearer because it is declared
   * first — the record's own key order is the entire strategy chain.
   */
  export class Authentication extends HttpApiMiddleware.Service<
    Authentication,
    { provides: CurrentPrincipal }
  >()("Authentication", {
    security: { cookie: SessionCookie, bearer: BearerToken },
  ```

- `../effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts:941` — Effect v4 (rc.116, same code in node_modules/.pnpm/effect@4.0.0-rc.116): chain order comes ONLY from the declaration's `security` record; the key order of the object returned by AuthenticationLive is irrelevant (looked up by key).

  ```ts
    const entries = Object.entries(key.security).map(([securityKey, security]) => ({
      decode: securityDecode(security),
      middleware: service[securityKey]
    }))
  ```

- `packages/server/src/Authentication.ts:362` — OptionalAuthenticationLive: the anonymous fallback is attached to the `bearer` handler specifically (continues at :370-372 with `Effect.catchTag("Unauthenticated", ...)` -> anonymousPrincipal).

  ```ts
      const bearer: typeof cookie = (httpEffect, { credential }) =>
        authenticate("bearer", httpEffect, credential).pipe(
  ```

**Fix plan** (effort **S**): Remove the one real positional coupling (OptionalAuthentication's fallback hard-wired to the last-declared `bearer` key) and pin the order with a wired test. Ordering stays the security record's declaration order, as BEH-EA-072 requires.

Steps:
1. Covered by EHA-006's restructure: the anonymous fallback moves into a handler that tries both credentials itself, so it no longer depends on which key is last.
2. Correct the Api.ts:110-113 / Authentication.ts comments to say that only the DECLARATION's key order matters. Effect looks handlers up by key (HttpApiBuilder.ts:941-944), so the Live record's order is irrelevant.
3. Wire the existing BDD scenario 'The security record's declared key order is the only ordering mechanism' (features/features/01-contract-and-persistence/04-contract-stratum.feature:121, currently @skip @unwired), or add an equivalent unit test asserting `Object.keys(Api.Authentication.security)` equals ["cookie", "bearer"].

Files: `packages/api/src/Api.ts`, `packages/server/src/Authentication.ts`, `features/features/01-contract-and-persistence/04-contract-stratum.feature`, `features/step-definitions/*`

Tests (write first):
- packages/api/test/Api.test.ts (ETVS-003): 'Authentication and OptionalAuthentication declare security keys in order cookie, bearer'.

Acceptance:
- Reordering keys fails a test.
- No Live-side code depends on key position.

Spec refs: BEH-EA-072, BEH-EA-065

Depends on: EHA-006

**Recommended status:** `ready-for-agent`

### Workstream `authn-failure-observability`

#### EOTS-003 — Failed authentication attempts are completely unobservable

`high` · `security` · `server` · [.issues/high/EOTS-003-effect-observability-tracing-specialist.md](../../.issues/high/EOTS-003-effect-observability-tracing-specialist.md) · current status `ready-for-agent`

**Verdict:** PARTIAL (confidence high) — fixed by `f5eb570`

The auth.user.signInFailed event (f5eb570, ALF-003) closed the password half. The session-verify half at Authentication.ts:184-192 is still silent.

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:184` — PlatformError now dies (NHS-002 fixed), but SessionNotFound/SessionExpired are mapped to Unauthenticated with no log, span annotation, metric or event.

  ```ts
      const memoized = yield* Effect.cached(
        raw === ""
          ? Effect.fail(new Api.Unauthenticated())
          : sessions
              .verify(Redacted.make(raw))
              .pipe(
                Effect.catchTag("PlatformError", Effect.die),
                Effect.mapError(() => new Api.Unauthenticated()),
  ```

- `packages/core/src/AuthEvents.ts:56` — Password half fixed by f5eb570 (ALF-003): published at packages/password/src/Password.ts:828 and :843.

  ```ts
  export interface UserSignInFailedEvent {
    readonly _tag: "auth.user.signInFailed";
    readonly strategy: string;
    readonly reason: "invalidCredentials" | "emailNotVerified";
  }
  ```

**Fix plan** (effort **S**): The password half is fixed (f5eb570). Make session-verify failures observable in resolveSession without leaking credentials or session ids.

Steps:
1. In resolveSession's owner branch, before `mapError`, add `Effect.tapError((e) => Effect.logDebug("awthaq: session verification failed").pipe(Effect.annotateLogs({ "auth.event": "session.verify.failed", "auth.outcome": "failure", "auth.failure.reason": e._tag, "auth.scheme": scheme })))`. Never log the credential or the session id: EOTS-004 (slice 01) treats the id as the public half of the bearer credential.
2. Skip logging for the empty-credential case (raw === ""), which is ordinary anonymous traffic.
3. When MW-001's `packages/core/src/Observability.ts` lands, increment `awthaq_session_verify_failed_total` tagged by reason (expired / idle-expired / not-found), using the decision 27 field vocabulary, and annotate the current span with `auth.outcome=failure`.
4. Do not add a per-request AuthEvent for verify failures (too noisy). Reuse is already evented as auth.session.reuse.

Files: `packages/server/src/Authentication.ts`

Tests (write first):
- packages/server/test/Authentication.test.ts (write first): 'an unknown session cookie logs session.verify.failed with reason SessionNotFound and no credential material' (a test Logger capturing entries; assert that neither the raw token nor the id appears).
- 'no credential at all logs nothing'.

Acceptance:
- Every failed non-empty verify produces one structured debug log (and, once MW-001 lands, a metric).
- No Redacted value or session id reaches logs (the BEH-EA-199 interceptor, EOTS-002).

Spec refs: BEH-EA-067, BEH-EA-199

Depends on: MW-001, TS-003-tim-smart

**Recommended status:** `ready-for-agent`

### Workstream `cors-posture`

#### AGA-002 — No CORS or preflight handling exists and the safe default-deny posture is undocumented

`medium` · `architecture` · `server` · [.issues/medium/AGA-002-api-gateway-auth-specialist.md](../../.issues/medium/AGA-002-api-gateway-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for CDS-008

**Evidence at HEAD:**

- `packages/server/src/AuthHttp.ts:25` — No CORS preset; grep for HttpMiddleware.cors / CORS / preflight across packages, spec, docs: 0 hits. Effect ships HttpRouter.cors (../effect/packages/effect/src/unstable/http/HttpRouter.ts:1165).

  ```ts
  export const routes: typeof HttpApiBuilder.layer = HttpApiBuilder.layer;
  ```

**Fix plan** (effort **M**): Document the default-deny CORS posture, and ship a blessed CORS preset whose origin allowlist is the same value as CsrfConfig.allowedOrigins.

Steps:
1. packages/server/src/AuthHttp.ts: add `cors`, a Layer built with `Layer.unwrap` over `CsrfConfig` that returns `HttpRouter.cors({ allowedOrigins: config.allowedOrigins, credentials: true, allowedMethods: ["GET","POST","PATCH","DELETE"], allowedHeaders: ["content-type", Api.CSRF_HEADER_NAME, "authorization"], exposedHeaders: [Api.ROTATED_TOKEN_HEADER] })` (HttpRouter.ts:1165). With one source for origins, the edge policy and the CSRF site check cannot drift.
2. spec/behaviors/10-csrf.md: add a BEH (next free id) stating that the library ships no CORS by default (same-origin, default-deny), that AuthHttp.cors is the only supported way to open cross-origin access, and that opening CORS never relaxes CsrfProtection.
3. README: a cross-origin SPA recipe using AuthHttp.cors.

Files: `packages/server/src/AuthHttp.ts`, `spec/behaviors/10-csrf.md`, `README.md`

Tests (write first):
- packages/server/test/AuthHttp.test.ts (write first): 'preflight OPTIONS from an allowed origin: 204 with Access-Control-Allow-Origin = origin, Allow-Credentials true, Allow-Headers including x-csrf-token'; 'from a disallowed origin: no ACAO'; 'Access-Control-Expose-Headers includes set-auth-token'; 'with AuthHttp.cors installed, a cross-site POST without the CSRF pair is still 403'.

Acceptance:
- A cross-origin deployment works with one layer and the same origin list as CSRF.
- The posture is documented in spec.

Spec refs: BEH-EA-073, BEH-EA-074, BEH-EA-083

Depends on: CSS-007, MNA-008

**Recommended status:** `ready-for-agent`

#### CDS-008 — No CORS configuration or documented posture exists anywhere in the library

`info` · `architecture` · `server` · [.issues/info/CDS-008-csrf-defense-specialist.md](../../.issues/info/CDS-008-csrf-defense-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **AGA-002**

Same finding at info level. Its extra ask ('adopt CORS and CsrfProtection together') is AGA-002's last test.

**Evidence at HEAD:**

- `packages/server/src/AuthHttp.ts:25` — No CORS preset; grep for HttpMiddleware.cors / CORS / preflight across packages, spec, docs: 0 hits. Effect ships HttpRouter.cors (../effect/packages/effect/src/unstable/http/HttpRouter.ts:1165).

  ```ts
  export const routes: typeof HttpApiBuilder.layer = HttpApiBuilder.layer;
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `api-contract-tests`

#### ETVS-003 — Five packages ship vitest configs with no tests; contract stratum @awthaq/api untested directly

`medium` · `testing` · `api` · [.issues/medium/ETVS-003-effect-testing-vitest-specialist.md](../../.issues/medium/ETVS-003-effect-testing-vitest-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/api/vitest.config.ts:3` — packages/api has no test/ directory (also api-key, cli, magic-link, two-factor); the contract-stratum BDD feature is `@skip @unwired` (features/features/01-contract-and-persistence/04-contract-stratum.feature:7).

  ```ts
  export default defineConfig({
    test: {
      name: "api",
      include: ["test/**/*.test.ts"],
    },
  });
  ```

**Fix plan** (effort **M**): Give @awthaq/api a direct test suite for its security-relevant contract. The placeholder-package half goes to the tooling slice.

Steps:
1. Create packages/api/test/Api.test.ts covering: Principal decode/encode for all four tags; rejection of an undeclared tag; `actingAs` optionality; Unauthenticated/CsrfRejected/InvalidCredentials/RateLimited statuses (via HttpApiSchema status annotations); CurrentPrincipal having no default (`Effect.serviceOption(Api.CurrentPrincipal)` is None); Authentication/OptionalAuthentication security key order (NHS-010); CsrfProtection requiredForClient.
2. Create packages/api/test/Contracts.test.ts covering: AuthCoreApi group/endpoint inventory (session: current/list/signOut/revoke/revokeOthers/revokeAll; account: updateProfile/deleteUser); middleware attached to SessionGroup/AccountGroup (CsrfProtection last); SessionDto/SubjectDto round-trip.
3. Where cheap, wire the matching BEH-EA-025..029 scenarios in features/features/01-contract-and-persistence/04-contract-stratum.feature (currently @skip @unwired; see AH-003).
4. Hand-off, not in this slice: vitest.config.ts in the placeholder packages (api-key, cli, magic-link, two-factor), and a CI guard for 'src without test'. These belong to the tooling slice (13).

Files: `packages/api/test/Api.test.ts (new)`, `packages/api/test/Contracts.test.ts (new)`, `features/step-definitions/*`

Tests (write first):
- The files above are the tests. They must pass under `pnpm --filter @awthaq/api test`.

Acceptance:
- packages/api has a test directory that exercises every exported schema and middleware declaration.
- `pnpm run test` includes it.

Spec refs: BEH-EA-025, BEH-EA-027, BEH-EA-028, BEH-EA-029, BEH-EA-030, BEH-EA-031

Depends on: —

**Recommended status:** `ready-for-agent`

#### MW-008 — SessionDto date fields typed as unconstrained Schema.String — format is convention, not contract

`low` · `api` · `api` · [.issues/low/MW-008-matias-woloski.md](../../.issues/low/MW-008-matias-woloski.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/api/src/Session.ts:18` — Dates are unconstrained strings; Effect v4 ships Schema.DateTimeUtcFromString (../effect/packages/effect/src/Schema.ts:10972). No client/react/next code reads these fields today.

  ```ts
  export class SessionDto extends Schema.Class<SessionDto>("SessionDto")({
    id: Schema.String,
    createdAt: Schema.String,
    lastActiveAt: Schema.String,
    expiresAt: Schema.String,
    userAgent: Schema.NullOr(Schema.String),
    current: Schema.Boolean,
  }) {}
  ```

**Fix plan** (effort **S**): Make SessionDto's timestamps a real contract: Schema.DateTimeUtcFromString on the wire (an ISO string) that decodes to DateTime.Utc.

Steps:
1. packages/api/src/Session.ts: `createdAt`, `lastActiveAt` and `expiresAt` become `Schema.DateTimeUtcFromString`. If the generated JSON schema lacks `format: "date-time"`, annotate it (check Schema's jsonSchema annotation API in ../effect).
2. packages/server/src/Session.ts `toDto`: pass `item.createdAt` etc. directly (DateTime.Utc) and drop DateTime.formatIso.
3. Check consumers: none read these fields today (grep in client/react/next). Update any test asserting the string form.

Files: `packages/api/src/Session.ts`, `packages/server/src/Session.ts`

Tests (write first):
- packages/api/test/Contracts.test.ts (write first): 'SessionDto rejects a non-ISO createdAt'; 'encodes DateTime.Utc to an ISO-8601 string'; 'OpenAPI schema for SessionDto.createdAt is a string with format date-time'.

Acceptance:
- An invalid timestamp cannot type-check or encode.
- OpenAPI clients see format: date-time.

Spec refs: BEH-EA-031, BEH-EA-054

Depends on: ETVS-003

**Recommended status:** `ready-for-agent`

### Workstream `qadi-attribute-typing`

#### AAPS-003 — Attribute contract is stringly-typed end to end

`medium` · `api` · `api` · [.issues/medium/AAPS-003-abac-attribute-policy-specialist.md](../../.issues/medium/AAPS-003-abac-attribute-policy-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence medium)

The claim is accurate about the evaluator and producer contract. Its SubjectDto evidence is the least actionable part: the wire DTO cannot be statically keyed, because attributes depend on which plugins are installed. The fix lives mostly in slice 08 and ../qadi.

**Evidence at HEAD:**

- `packages/api/src/Subject.ts:47` — Open record at the wire — correct for a composition-dependent attribute set; the typing gap is on the producer/evaluator side (qadi).

  ```ts
  export class SubjectDto extends Schema.Class<SubjectDto>("SubjectDto")({
    id: Schema.String,
    roles: Schema.Array(Schema.String),
    permissions: Schema.Array(Schema.String),
    attributes: Schema.Record(Schema.String, Schema.Unknown),
  }) {}
  ```

**Fix plan** (effort **M**): Add typing on the producer and evaluator side (in @awthaq/qadi and ../qadi). The isomorphic SubjectDto stays an open record, because its attribute set depends on the composition.

Steps:
1. packages/qadi/src/Resolvers.ts: export a const-keyed `UserAttributes` registry (`{ email: Schema.String, emailVerified: Schema.Boolean, name: Schema.String }`), `type UserAttributeName = keyof typeof UserAttributes`, and a typed `userAttr<N extends UserAttributeName>(name: N)` helper for policy authors. Do the same in @awthaq/organization's OrganizationQadi.attributes (slice 08).
2. Build on decision 14's `attributeResolverRegistry` (AAPS-002): derive each contribution's declared `names` from its registry keys.
3. In ../qadi (the user's qadi repo): have the evaluator report a distinct 'unknown attribute name' diagnostic when a policy references a name that no registered resolver declares, so a typo is no longer indistinguishable from an absent value.
4. Keep `SubjectDto.attributes` as `Schema.Record(String, Unknown)`. AAPS-008 (slice 08) owns the question of which attributes the DTO exposes.

Files: `packages/qadi/src/Resolvers.ts`, `packages/qadi/src/AttributeResolvers.ts`, `../qadi/packages/core/src/AttributeResolver.ts`

Tests (write first):
- packages/qadi/test/Resolvers.test.ts: 'userAttr("emailVerifed") is a type error' (@ts-expect-error); 'UserAttributes schemas decode the resolver output'.
- ../qadi: an evaluator test for the unknown-name diagnostic.

Acceptance:
- A policy typo against a known producer fails to compile, or at least produces a distinct diagnostic.

Spec refs: BEH-EA-161, BEH-EA-142

Depends on: AAPS-002

**Recommended status:** `ready-for-agent`

### Workstream `httpapi-surface-consolidation`

#### AVS-002 — Seven parallel standalone `HttpApi` values; core groups not yet folded into Auth.make's composed api

`medium` · `architecture` · `api` · [.issues/medium/AVS-002-api-design-versioning-specialist.md](../../.issues/medium/AVS-002-api-design-versioning-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MW-002**

Same gap as MW-002 (slice 01, high, ready-for-agent). Decision 26 (.scratch/resolve-ready-for-human-findings/issues/26-httpapi-surface-consolidation.md) prescribes the fix: composeApi seeds core session/account groups, Auth.make gets an `extraGroups` option for qadi's subject group, and there is a new `AuthHttp.coreHandlers`. Not implemented at HEAD. AVS-002's changeset/deprecation-policy ask belongs to AVS-009 (slice 13).

**Evidence at HEAD:**

- `packages/core/src/Auth.ts:390` — Only plugin groups are folded; core session/account groups are not (MW-002 / decision 26 unimplemented).

  ```ts
  const composeApi = (
    order: ReadonlyArray<AuthPlugin.Any>,
  ): HttpApi.HttpApi<"auth", HttpApiGroup.Constraint> => {
    const contributions = order.flatMap((plugin) =>
      Object.values(plugin.contract.groups).map((group) => ({ plugin, group })),
    );
  ```

- `packages/api/src/AuthCore.ts:16` — Standalone core HttpApi still served separately.

  ```ts
  export const AuthCoreApi = HttpApi.make("auth").add(SessionGroup).add(AccountGroup);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### BE-006 — Core and plugin routes split across two HttpApi contracts

`medium` · `dx` · `api` · [.issues/medium/BE-006-bereket-engida.md](../../.issues/medium/BE-006-bereket-engida.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MW-002**

Same gap as MW-002 (slice 01, high, ready-for-agent). Decision 26 (.scratch/resolve-ready-for-human-findings/issues/26-httpapi-surface-consolidation.md) prescribes the fix: composeApi seeds core session/account groups, Auth.make gets an `extraGroups` option for qadi's subject group, and there is a new `AuthHttp.coreHandlers`. Not implemented at HEAD.

**Evidence at HEAD:**

- `packages/core/src/Auth.ts:390` — Only plugin groups are folded; core session/account groups are not (MW-002 / decision 26 unimplemented).

  ```ts
  const composeApi = (
    order: ReadonlyArray<AuthPlugin.Any>,
  ): HttpApi.HttpApi<"auth", HttpApiGroup.Constraint> => {
    const contributions = order.flatMap((plugin) =>
      Object.values(plugin.contract.groups).map((group) => ({ plugin, group })),
    );
  ```

- `packages/api/src/AuthCore.ts:16` — Standalone core HttpApi still served separately.

  ```ts
  export const AuthCoreApi = HttpApi.make("auth").add(SessionGroup).add(AccountGroup);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

#### EHA-004 — Core session/account groups never composed: Auth.make's served api has no session endpoints

`medium` · `architecture` · `api` · [.issues/medium/EHA-004-effect-http-api-specialist.md](../../.issues/medium/EHA-004-effect-http-api-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MW-002**

Same gap as MW-002 (slice 01, high, ready-for-agent). Decision 26 (.scratch/resolve-ready-for-human-findings/issues/26-httpapi-surface-consolidation.md) prescribes the fix: composeApi seeds core session/account groups, Auth.make gets an `extraGroups` option for qadi's subject group, and there is a new `AuthHttp.coreHandlers`. Not implemented at HEAD.

**Evidence at HEAD:**

- `packages/core/src/Auth.ts:390` — Only plugin groups are folded; core session/account groups are not (MW-002 / decision 26 unimplemented).

  ```ts
  const composeApi = (
    order: ReadonlyArray<AuthPlugin.Any>,
  ): HttpApi.HttpApi<"auth", HttpApiGroup.Constraint> => {
    const contributions = order.flatMap((plugin) =>
      Object.values(plugin.contract.groups).map((group) => ({ plugin, group })),
    );
  ```

- `packages/api/src/AuthCore.ts:16` — Standalone core HttpApi still served separately.

  ```ts
  export const AuthCoreApi = HttpApi.make("auth").add(SessionGroup).add(AccountGroup);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `m2m-identity`

#### OCM-003 — M2M principals carry no scopes — the scopes-to-permissions binding is unimplementable

`medium` · `architecture` · `api` · [.issues/medium/OCM-003-oauth2-client-credentials-m2m-specialist.md](../../.issues/medium/OCM-003-oauth2-client-credentials-m2m-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MAPS-003**

The same root cause as MAPS-003 (dead ApiKey/Service principal cases; slice 09). Decision 10 (.scratch/resolve-ready-for-human-findings/issues/10-machine-service-identity-m2m.md) prescribes scopes on the M2M principals plus `ApiKey.subjectForPrincipal` mapping scopes to AuthSubject.permissions. The MAPS-003 implementer must add `scopes: Schema.Array(Schema.String)` to ApiKeyPrincipal/ServicePrincipal in packages/api/src/Api.ts:27-33 (and extend packages/api/test/Api.test.ts, ETVS-003). Related: AAPS-009.

**Evidence at HEAD:**

- `packages/api/src/Api.ts:27` — No scopes field on either M2M principal.

  ```ts
  export class ApiKeyPrincipal extends Schema.TaggedClass<ApiKeyPrincipal>()("ApiKey", {
    ref: PrincipalRef,
  }) {}
  
  export class ServicePrincipal extends Schema.TaggedClass<ServicePrincipal>()("Service", {
    ref: PrincipalRef,
  }) {}
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `observability-substrate`

#### NHS-008 — No request-id/correlation middleware or access logging at the serving stratum

`low` · `dx` · `server` · [.issues/low/NHS-008-node-http-server-integration-specialist.md](../../.issues/low/NHS-008-node-http-server-integration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **MW-001**

MW-001's decision (.scratch/resolve-ready-for-human-findings/issues/27-observability-substrate.md) adds `AuthHttp.tracer`/`AuthHttp.requestLogger` as re-exports of HttpMiddleware.tracer/logger: W3C traceparent correlation plus a structured access log. That is exactly the serving-stratum hook NHS-008 asks for. Also overlaps EOTS-006 and MAPS-007. If X-Request-Id echo is still wanted after MW-001, it should be a follow-up there.

**Evidence at HEAD:**

- `packages/server/src/index.ts:10` — No logging/tracing/request-id surface.

  ```ts
  export * as Account from "./Account.ts";
  export * as Authentication from "./Authentication.ts";
  export * as AuthHttp from "./AuthHttp.ts";
  export * as Csrf from "./Csrf.ts";
  export * as Session from "./Session.ts";
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `resolved`

### Workstream `none`

#### AGA-006 — No trusted-header identity seam exists — correctly so for this architecture

`info` · `architecture` · `server` · [.issues/info/AGA-006-api-gateway-auth-specialist.md](../../.issues/info/AGA-006-api-gateway-auth-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence high)

The finding endorses the current posture: no trusted-header identity seam. Its recommended fix is 'Keep the seam closed'. Nothing to action. Any future gateway forwarding must use the signed-token route (MAPS-001/MAPS-004).

**Evidence at HEAD:**

- `packages/server/src/Authentication.ts:299` — Both schemes funnel into authenticate -> resolveSession -> Sessions.verify (opaque id.secret only); no BearerCredentialResolver seam exists.

  ```ts
      const handle: HttpApiMiddleware.HttpApiMiddlewareSecurity<
        { readonly cookie: typeof Api.SessionCookie; readonly bearer: typeof Api.BearerToken },
        Api.CurrentPrincipal,
        typeof Api.Unauthenticated,
        never
      >["cookie"] = (httpEffect, { credential }) => authenticate("cookie", httpEffect, credential);
      const bearer: typeof handle = (httpEffect, { credential }) =>
        authenticate("bearer", httpEffect, credential);
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `wontfix`

#### TS-007 — No streaming HTTP responses anywhere on the server surface — every response is a buffered DTO

`info` · `architecture` · `server` · [.issues/info/TS-007-tim-smart.md](../../.issues/info/TS-007-tim-smart.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence high)

The auditor says so: 'Honest absence, not a defect'. No route ships a payload that needs streaming. If CSG-005's export or a CSV route lands, it should use HttpServerResponse.stream then. No standing work.

**Evidence at HEAD:**

- `packages/server/src/Session.ts:15` — Buffered DTO responses; no streaming anywhere, and no route that would need it (no export route exists).

  ```ts
  const toDto = (item: Sessions.SessionListItem): SessionContract.SessionDto =>
    new SessionContract.SessionDto({
      id: item.id,
  ```

**No fix in this slice** — see verdict/notes above.

**Recommended status:** `wontfix`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| EHA-008 | low | DUPLICATE | Duplicate of CSS-007. The session-cookie half is the same as CSS-007. The CSRF half is invalid: CSRF names exist once, in api, and server imports them. | `packages/api/src/Api.ts:97` |
| PDR-007 | info | ALREADY-FIXED (`409334e`) | The docs-vs-code divergence is gone: BEH-EA-073..080 now run on real shipped contracts (session, account, admin, organization, passkey, password groups). The remaining Auth.make {csrf} work (BEH-EA-079) is tracked by PDR-002/APS-001, not here. | `packages/api/src/Session.ts:59` |
| VB-008 | info | DUPLICATE | Duplicate of MAPS-001. Documentation ask ('this server never accepts its own JWTs') is covered by MAPS-001's README step. The 'api keys need real scopes' half is MAPS-003's decision 10 (slice 09). | `packages/api/src/Api.ts:110` |
| OCM-003 | medium | DUPLICATE | Duplicate of MAPS-003. The same root cause as MAPS-003 (dead ApiKey/Service principal cases; slice 09). Decision 10 (.scratch/resolve-ready-for-human-findings/issues/10-machine-service-identity-m2m.md) prescribes scopes on the M2M principals plus `ApiKey.subjectForPrincipal` mapping scopes to AuthSubject.permissions. The MAPS-003 implementer must add `scopes: Schema.Array(Schema.String)` to ApiKeyPrincipal/ServicePrincipal in packages/api/src/Api.ts:27-33 (and extend packages/api/test/Api.test.ts, ETVS-003). Related: AAPS-009. | `packages/api/src/Api.ts:27` |
| MW-009 | low | DUPLICATE | Duplicate of CSS-007. The CSRF-name duplication claim is refuted (Csrf.ts:148/:173 import Api.CSRF_*). The session-cookie part is the same as CSS-007. | `packages/api/src/Api.ts:97` |
| BE-009 | low | DUPLICATE | Duplicate of CSS-007. Same as CSS-007. | `packages/api/src/Api.ts:97` |
| AVS-002 | medium | DUPLICATE | Duplicate of MW-002. Same gap as MW-002 (slice 01, high, ready-for-agent). Decision 26 (.scratch/resolve-ready-for-human-findings/issues/26-httpapi-surface-consolidation.md) prescribes the fix: composeApi seeds core session/account groups, Auth.make gets an `extraGroups` option for qadi's subject group, and there is a new `AuthHttp.coreHandlers`. Not implemented at HEAD. AVS-002's changeset/deprecation-policy ask belongs to AVS-009 (slice 13). | `packages/core/src/Auth.ts:390` |
| BE-006 | medium | DUPLICATE | Duplicate of MW-002. Same gap as MW-002 (slice 01, high, ready-for-agent). Decision 26 (.scratch/resolve-ready-for-human-findings/issues/26-httpapi-surface-consolidation.md) prescribes the fix: composeApi seeds core session/account groups, Auth.make gets an `extraGroups` option for qadi's subject group, and there is a new `AuthHttp.coreHandlers`. Not implemented at HEAD. | `packages/core/src/Auth.ts:390` |
| CDS-004 | medium | ALREADY-FIXED (`409334e`) | The session group now carries CsrfProtection, whose double-submit check runs regardless of payload or content-type, which is exactly the recommended fix. A suggested (non-blocking) regression test for the orchestrator: POST /auth/session/sign-out with a session cookie but no CSRF pair gets 403. | `packages/api/src/Session.ts:59` |
| SMS-005 | low | DUPLICATE | Duplicate of CSS-002. The same fix, including revoke-of-current (CSS-002 step 2). | `packages/api/src/Session.ts:53` |
| EHA-004 | medium | DUPLICATE | Duplicate of MW-002. Same gap as MW-002 (slice 01, high, ready-for-agent). Decision 26 (.scratch/resolve-ready-for-human-findings/issues/26-httpapi-surface-consolidation.md) prescribes the fix: composeApi seeds core session/account groups, Auth.make gets an `extraGroups` option for qadi's subject group, and there is a new `AuthHttp.coreHandlers`. Not implemented at HEAD. | `packages/core/src/Auth.ts:390` |
| DRS-002 | high | DUPLICATE | Duplicate of CSG-001. Same source line and root cause as CSG-001. DRS-002's own 2026-09-20 comment calls itself 'Duplicate source/evidence of CSG-001'. The non-transactional half was fixed in e940a12. The remaining PII-table gaps and decision 30 (Users.eraseAccount) are carried by CSG-001's plan. | `packages/server/src/Account.ts:103` |
| SSMS-002 | medium | DUPLICATE (`e940a12`) | Duplicate of SEA-001. Same two claims as SEA-001 (zero FKs + untransactional cascade). The cascade was wrapped in SqlTransaction by e940a12. The FK-less invariant documentation and test are planned under SEA-001. | `packages/server/src/Account.ts:103` |
| TS-004 | medium | ALREADY-FIXED (`e940a12`) | AccountHandlers now requires SqlTransaction.SqlTransaction (Account.ts:46) and wraps the cascade in withTransaction (e940a12), exactly as the recommended fix asked. | `packages/server/src/Account.ts:103` |
| CSG-007 | low | ALREADY-FIXED (`ec065a7`) | The sentinel `revokeOthers(userId, SessionId(""))` was replaced by `sessions.revokeAll(userId)` in ec065a7. | `packages/server/src/Account.ts:112` |
| TRBS-008 | low | ALREADY-FIXED (`ec065a7`) | Same fix as CSG-007 (ec065a7). | `packages/server/src/Account.ts:112` |
| CDS-008 | info | DUPLICATE | Duplicate of AGA-002. Same finding at info level. Its extra ask ('adopt CORS and CsrfProtection together') is AGA-002's last test. | `packages/server/src/AuthHttp.ts:25` |
| ECF-005 | low | DUPLICATE | Duplicate of TS-003-tim-smart. The same non-atomic get-or-create, one level down (the per-credential Effect.cached wrapper). TS-003's single Effect.sync get-or-create of a Deferred fixes both levels. | `packages/server/src/Authentication.ts:166` |
| JR-004 | medium | DUPLICATE | Duplicate of MAPS-001. The same one-way trust gap (the server mints JWTs it never accepts). Decision 33 covers both the opt-in validation scheme and the audience contract documentation that JR-004 asks for. | `packages/server/src/Authentication.ts:184` |
| CTA-006 | medium | DUPLICATE | Duplicate of MNA-005. Same gap (no client captures set-auth-token). The CLI-specific re-auth UX and exit-code asks belong with CTA-001/CTA-003 (slice 09 / spec). The CLI package is still a placeholder. | `packages/server/src/Authentication.ts:233` |
| PIL-009 | info | DUPLICATE | Duplicate of MNA-005. Its documentation option is covered by MNA-005's docs step. Its grace-window option is ruled out by upstream-hardening ticket 01 ('no grace window'), which must not be re-litigated. | `packages/server/src/Authentication.ts:233` |
| AGA-006 | info | WONTFIX-CANDIDATE | The finding endorses the current posture: no trusted-header identity seam. Its recommended fix is 'Keep the seam closed'. Nothing to action. Any future gateway forwarding must use the signed-token route (MAPS-001/MAPS-004). | `packages/server/src/Authentication.ts:299` |
| AGA-003 | medium | DUPLICATE | Duplicate of MAPS-001. The same root cause as MAPS-001. Decision 33 picked the 'opt-in JWT-validation scheme with its own audience' branch of AGA-003's recommendation, so an RFC 7662 introspection endpoint is not planned. | `packages/server/src/Authentication.ts:299` |
| CDS-005 | medium | ALREADY-FIXED (`409334e`) | The finding's own recommended fix: 'Treat CDS-001 as the gating fix; once attached, the same-site acceptance is defensible'. CDS-001 was resolved by 409334e, which attached CsrfProtection to every mutating group, so the double-submit leg now backs siteCheck. The optional subdomain-trust documentation note can ride MNA-008's Csrf.ts header update. | `packages/server/src/Csrf.ts:122` |
| TS-007 | info | WONTFIX-CANDIDATE | The auditor says so: 'Honest absence, not a defect'. No route ships a payload that needs streaming. If CSG-005's export or a CSV route lands, it should use HttpServerResponse.stream then. No standing work. | `packages/server/src/Session.ts:15` |
| IC-002 | medium | DUPLICATE | Duplicate of CSS-002. The same missing cookie expiry. The withNextCookies test it asks for is listed in CSS-002 step 5, which hands off to slice 11. | `packages/server/src/Session.ts:84` |
| NSA-004 | medium | DUPLICATE | Duplicate of CSS-002. The same root cause. The README sign-out recipe belongs to the next-adapter work (slice 11, BO-002/IC-004). | `packages/server/src/Session.ts:84` |
| NHS-008 | low | DUPLICATE | Duplicate of MW-001. MW-001's decision (.scratch/resolve-ready-for-human-findings/issues/27-observability-substrate.md) adds `AuthHttp.tracer`/`AuthHttp.requestLogger` as re-exports of HttpMiddleware.tracer/logger: W3C traceparent correlation plus a structured access log. That is exactly the serving-stratum hook NHS-008 asks for. Also overlaps EOTS-006 and MAPS-007. If X-Request-Id echo is still wanted after MW-001, it should be a follow-up there. | `packages/server/src/index.ts:10` |
