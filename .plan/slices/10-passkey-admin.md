# Slice 10-passkey-admin — validation & fix plan

- **Validated at:** `ec065a7` (HEAD) on 2026-09-29
- **Manifest:** `.plan/_manifests/10-passkey-admin.tsv` — 61 issues (`packages/admin`, `packages/passkey`)
- **Machine-readable twin:** `.plan/slices/10-passkey-admin.json`

## Counts (verdict × level)

| Verdict | high | medium | low | info | total |
|---|---|---|---|---|---|
| CONFIRMED | 3 | 19 | 11 | 1 | 34 |
| PARTIAL | 0 | 5 | 1 | 0 | 6 |
| ALREADY-FIXED | 0 | 2 | 1 | 0 | 3 |
| INVALID | 0 | 0 | 0 | 0 | 0 |
| DUPLICATE | 1 | 7 | 7 | 3 | 18 |
| WONTFIX-CANDIDATE | 0 | 0 | 0 | 0 | 0 |
| **total** | 4 | 33 | 20 | 4 | 61 |

## Summary

**Admin.** The impersonation core is sound in shape (fail-closed gate, dual identity, durable row) but four defects cluster around what the gate and the episode lifecycle *don't* see: the predicate only receives the caller (no target, no tenant — IDS-001/MTI-006/IDS-002), a nonexistent target still gets a live session and audit row (IDS-003), episodes never close on hard expiry so `list({active:true})` reports dead sessions (IDS-004 ×3), and revocation is hostage to audit-row bookkeeping and can even die with a defect after a target's `revokeAll` (IDS-007). In browsers, `impersonate` overwrites the admin's only `__Host-session` cookie, so BEH-EA-216's "no handback" stop logs the admin out (APS-006 ×4 — a real contract decision). The ticket-19 surface expansion (BAM-005/EP-003) is decided but entirely unimplemented. `auth.session.revoked` now exists (45325bb) but core Sessions primitives still revoke silently (TIR-008).

**Passkey.** Recent commits closed three findings: migrations shipped (58ef46a → WPS-012) and CB-001's config-gated UV (1f2df3a → BPAS-005/TC-005); the durable AuditLog (6bd3f1d) makes counter-anomaly events persistent (partially addressing WPS-006/HSK-004); ec065a7 (GDPR erasure) and 0441226 (browser client, BPAS-002) fixed none of this slice — the client even mirrors the server's gaps (drops transports, no Signals, hand-guards `Schema.Unknown`). What remains: the WebAuthn user handle is re-randomized three times per enrolment and never matches what the authenticator bound (BPAS-003 ×5); the "log + step-up" counter policy is unreachable because SimpleWebAuthn 14.0.1 throws first on every non-zero regression (CB-004); `authenticate/options` leaks account existence via `allowCredentials` and the verify path has a timing oracle (TC-001 ×3, TSS-004); ChallengeStore has sibling-scope destruction, unbounded growth and non-constant-time compares (WPS-003, WPS-005, BPAS-008 ×4); plus origin/crossOrigin/timeout policy gaps and contract-typing gaps. Two audit claims were overstated and are marked PARTIAL: SimpleWebAuthn *does* check `crossOrigin` for authentication when `topOrigin` is present (CB-003), and Android-origin sign-in is not blocked because `authenticateVerify` never calls `originMatchesRpId` (MNA-007).

## Workstreams

### `admin-impersonation-gate-target` — Target-aware, tenant-scoped impersonation gate

- **IDs closed:** IDS-001, MTI-006, IDS-003, APS-009, IDS-002
- **Order hint:** 1 · **Effort:** M · **Depends on workstreams:** —
- **Cross-slice prerequisites:** DRS-001
- **Why grouped:** All five stem from the gate/impersonate path never looking at the target: the predicate cannot see it (IDS-001/MTI-006), its existence is never checked (IDS-003/APS-009), and its tenant is never recorded or compared (IDS-002). One signature change to AdminConfig plus a Users lookup and a tenant column close them together; the ordering (gate before existence check) must be designed once to avoid a user-id oracle.

**Ordered steps**

1. IDS-001: widen canImpersonate to ({ admin, target }) and add canManageEpisode for forceStop/list; update BEH-EA-212/217/219 and every test/BDD config.
2. IDS-003 (+APS-009): acquire Users in Admin.make, check target existence AFTER the gate (404 AdminTargetNotFound, no denied event), constrain path params.
3. IDS-002: once DRS-001 (ticket 18 TenantContext) lands, add tenantId to admin_impersonation, stamp ambiently, scope list/forceStop; cross-tenant only via canAdministerTenants (ticket 19).

**Test plan**

- Admin.test.ts: target-refusing predicate; forceStop/list filtered by canManageEpisode; unknown target 404 with no session/row/event; tenant scoping in ImpersonationRecords.test.ts (both layers).
- AuthHttp.test.ts: unknown target → 404 for admins, 403 for non-admins.
- BDD: 'an admin cannot impersonate a protected account', 'unknown target refused'.

**Acceptance**

- canImpersonate receives admin+target; defaults still deny everything.
- No session/audit row is ever minted for a nonexistent user.
- Episodes are tenant-stamped and list/forceStop stay within the caller's tenant unless superadmin.

### `admin-impersonation-lifecycle` — Impersonation episode lifecycle: expiry, stop robustness, paginated history

- **IDs closed:** IDS-004, JR-011, ESA-008, IDS-007, ESS-006
- **Order hint:** 2 · **Effort:** M · **Depends on workstreams:** admin-impersonation-gate-target
- **Why grouped:** All touch ImpersonationRecords' state machine and its read path: episodes never close on hard expiry (IDS-004 + dups), revocation is hostage to row bookkeeping (IDS-007), and list is unbounded (ESS-006). They share one set of migrations and one list signature change.

**Ordered steps**

1. IDS-004: expiresAt column + closeExpired (lazy on reads + exported sweep) + stopped{expired} events.
2. IDS-007: revoke-first, idempotent revocation; forceStop requires an episode row (any state) as actingAs proof; never orDie SessionNotFound.
3. ESS-006: keyset pagination on (startedAt, id) in both layers and on the wire (ImpersonationPage).

**Test plan**

- Admin.test.ts: TestClock past maxDuration ⇒ list active empty, row endedBy expired, one event.
- Admin.test.ts: stop after row already ended still revokes; forceStop after target revokeAll does not die.
- ImpersonationRecords.test.ts: stable pagination with equal timestamps (both layers).

**Acceptance**

- No hard-expired episode is ever reported active.
- Revocation never depends on audit-row state and never produces a defect.
- History reads are bounded by limit.

### `passkey-user-handle` — Stable per-user WebAuthn user handle and Signals

- **IDs closed:** BPAS-003, HSK-001, TC-002, WPS-002, CB-005, BPAS-006
- **Order hint:** 3 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** Five findings are one defect (random handle per ceremony step, persisted value never the bound one). BPAS-006's Signals API needs that stable handle (signalAllAcceptedCredentials is keyed by it).

**Ordered steps**

1. passkey_user_handle table + PasskeyUserHandles service (getOrCreate).
2. Use it in all registration ceremonies; store exactly it; check assertion userHandle; erase with the user.
3. Server signals surface + client Signals helpers (BPAS-006).

**Test plan**

- Passkey.test: stored handle == options.user.id and shared across a user's credentials; mismatching userHandle rejected.
- PasskeyClient.test: signalAllAcceptedCredentials after delete.

**Acceptance**

- One handle per user everywhere; credential managers can be told about deletions.

### `session-revocation-events` — Observable session revocation

- **IDs closed:** TIR-008
- **Order hint:** 3 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** Core Sessions primitives are the only place every revocation passes through; publishing there covers sign-out, deletion, admin and password paths at once.

**Ordered steps**

1. Widen auth.session.revoked (sessionId, scope, reason).
2. Publish from Sessions.revoke/revokeOthers/revokeAll in both layers with a required reason.
3. Remove Password's manual publish; pass reasons from all callers.

**Test plan**

- Sessions.test.ts (both layers): each primitive publishes exactly one event.

**Acceptance**

- Every revocation produces one event and one AuditLog row.

### `passkey-challenge-store-hardening` — ChallengeStore correctness and hygiene

- **IDs closed:** BPAS-008, CB-007, WPS-008, HSK-010, WPS-009, WPS-003, WPS-005
- **Order hint:** 4 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** All in ChallengeStore.ts or its only caller pattern: comparison discipline, documented per-backend guarantees, sibling-scope destruction, and unbounded growth.

**Ordered steps**

1. BPAS-008: constant-time compare in memory/sql.
2. WPS-009: guarantees field + conformance suite.
3. WPS-003: explicit ceremony discriminator in RegisterVerifyPayload + client.
4. WPS-005: reclaim expired on issue, sweepExpired, expiresAt index, rate-limit authenticate/options.

**Test plan**

- ChallengeStore conformance suite over all three layers.
- Passkey.test: conditional verify leaves modal challenge usable.
- Expired rows reclaimed on next issue.

**Acceptance**

- No === compare; guarantees enforced by tests; no cross-scope destruction; bounded storage.

### `passkey-counter-anomaly-policy` — Counter anomaly: make the decided 'log + step-up' policy real

- **IDs closed:** CB-004, WPS-006, HSK-004, BPAS-009
- **Order hint:** 4 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** CB-004 proves the anomaly branch is unreachable against the real library; WPS-006/HSK-004/BPAS-009 are the missing enforcement/flag/typed-error around that same branch.

**Ordered steps**

1. Port: disable library counter throw (counter 0), return newCounter.
2. Plugin: flag credential (counterAnomalyAt), publish event, step-up (require UV on next use), counterAnomalyPolicy flag|reject raising PasskeyCounterAnomaly.
3. Un-skip REQ-EA-381 under reject.

**Test plan**

- WebAuthn.test: real regressed assertion verifies with newCounter.
- Passkey real-port test: flag vs reject; flagged credential needs UV next time.

**Acceptance**

- Non-zero regressions reach the policy; PasskeyCounterAnomaly is raised under reject; REQ-EA-381 active.

### `session-delivery` — Shared session delivery (cookie vs bearer)

- **IDs closed:** WPS-004
- **Order hint:** 4 · **Effort:** M · **Depends on workstreams:** —
- **Cross-slice prerequisites:** MNA-001
- **Why grouped:** Implements ticket 17's delivery decision once so passkey/password/admin stop hand-rolling Set-Cookie; reconciles BEH-EA-131 with reality. Prerequisite for the admin cookie contract.

**Ordered steps**

1. SessionDelivery helper honoring X-Awthaq-Token-Delivery.
2. Route passkey/password/admin through it.
3. Amend BEH-EA-131 and REQ-EA-362.

**Test plan**

- AuthHttp: bearer opt-in returns token and no cookie.

**Acceptance**

- No direct SessionCookie securitySetCookie in plugin src.

### `admin-impersonation-cookie-contract` — Browser cookie contract for impersonation (decision needed)

- **IDs closed:** APS-006, IDS-005, JR-006, CSS-003, BAM-012
- **Order hint:** 5 · **Effort:** M · **Depends on workstreams:** session-delivery
- **Cross-slice prerequisites:** DTWS-002
- **Why grouped:** Four findings describe the same defect — impersonate overwrites the only __Host-session cookie, so BEH-EA-216's no-handback stop logs browser admins out while their session lives on orphaned. BAM-012 is the documentation that must describe whichever contract is chosen.

**Ordered steps**

1. Decide APS-006 options (recommended A: dedicated __Host-impersonation cookie declared first in the Authentication security record).
2. Implement through WPS-004's shared SessionDelivery helper (impersonation variant).
3. Clear the impersonation cookie on stopImpersonating; amend BEH-EA-213/216 and BEH-EA-065/072.
4. Make AdminSteps.ts use a real cookie jar; then write BAM-012's README/migration section.

**Test plan**

- AuthHttp.test.ts single-jar round trip: impersonate → act as target → stop → authenticated as admin again.
- Server test: a non-actingAs session in __Host-impersonation never authenticates.

**Acceptance**

- A browser admin returns to their own session after stopImpersonating without re-login.
- BEH-EA-216's 'no replacement session' remains literally true.

### `passkey-enumeration-safety` — Enumeration safety of the anonymous authenticate ceremony

- **IDs closed:** TC-001, CB-006, WPS-007, TSS-004
- **Order hint:** 5 · **Effort:** M · **Depends on workstreams:** passkey-challenge-store-hardening
- **Why grouped:** BEH-EA-136's envelope must cover the options half (allowCredentials oracle) and timing (unknown-credential early return).

**Ordered steps**

1. Deterministic HMAC decoy descriptors for unknown emails (username-first stays first-class per passkey user story 20).
2. Rate-limit authenticate/options (shared with WPS-005).
3. Decoy signature verification on unknown credential ids (TSS-004).

**Test plan**

- Passkey.test: unknown email yields stable non-empty descriptors; unknown credential still calls verifyAuthentication.

**Acceptance**

- Response content and cost do not reveal registered emails/credential ids.

### `passkey-ceremony-policy` — Ceremony policy: origins, cross-origin, UV, timeouts

- **IDs closed:** CB-003, MNA-007, CB-009, TC-003, HSK-007, BPAS-005, TC-005
- **Order hint:** 6 · **Effort:** M · **Depends on workstreams:** passkey-challenge-store-hardening
- **Why grouped:** All govern what a ceremony accepts or requests (origin tuple, crossOrigin, UV exemption, timeout/hints, resident-key requirement). BPAS-005/TC-005 are already fixed by CB-001 (1f2df3a) and listed for bookkeeping.

**Ordered steps**

1. One shared origin policy (web suffix check + exact android:apk-key-hash origins) for all three ceremonies (MNA-007).
2. crossOrigin/topOrigin rejection unless allowedTopOrigins (CB-003).
3. Conditional create disabled under required UV (CB-009, after WPS-003).
4. ceremonyTimeout ≤ TTL, hints, extensions through the port (TC-003).
5. Document conditional-create CTAP2 requirement (HSK-007).

**Test plan**

- Passkey.test: android origin accepted when configured; crossOrigin rejected; conditional options refused under required UV; options carry configured timeout.
- WebAuthn.test: timeout/hints echoed.

**Acceptance**

- Every ceremony applies the same, documented origin and UV policy; browser and server timers aligned.

### `passkey-wire-contract` — Passkey wire contract fidelity

- **IDs closed:** HSK-003, AVS-003, AVS-006, WPS-010, HSK-008
- **Order hint:** 6 · **Effort:** M · **Depends on workstreams:** —
- **Why grouped:** Contract/DTO shape work on PasskeyApi.ts and the client mirror, plus the test fixtures that should prove it.

**Ordered steps**

1. Transports end-to-end + DTO transports/aaguid (HSK-003).
2. Typed options schemas instead of Schema.Unknown; drop client guards (AVS-003).
3. HttpApiEndpoint.delete + consistent ids (AVS-006).
4. Duplicate-id guard, typed error, 409 (WPS-010).
5. Real-port fixtures and tests (HSK-008).

**Test plan**

- Real-port plugin test with packed attestation, AAGUID label, transports.
- OpenAPI declares structured options schema.
- Duplicate id refused identically in both layers.

**Acceptance**

- Contract fully typed; transports/aaguid round-trip; both credential layers behave identically.

### `admin-surface-expansion` — Admin API surface expansion (ticket 19)

- **IDs closed:** BAM-005, EP-003
- **Order hint:** 7 · **Effort:** XL · **Depends on workstreams:** admin-impersonation-gate-target
- **Cross-slice prerequisites:** DRS-001
- **Why grouped:** Both resolved by wayfinder ticket 19: user CRUD + session admin + core ban gate (BAM-005), plus the optional superadmin tenant slice (EP-003). XL — decompose into: (1) ban fields + UserBanned gate at sign-in sites, (2) user/session admin endpoints, (3) deleteUser/setUserPassword/setUserEmail, (4) Admin.layerWithTenants + organization suspension.

**Ordered steps**

1. Per-capability fail-closed predicates in AdminConfig.
2. Users ban fields + migration + UserBanned checks in password/passkey/oauth sign-in.
3. Admin endpoints + events + README (no setRole).
4. Organization suspended flag + Admin.layerWithTenants (after DRS-001).

**Test plan**

- Admin tests per capability (deny by default, gate, effect).
- Ban blocks every sign-in path; unban restores.
- Tenant slice: suspension enforced by organization access checks.

**Acceptance**

- All ticket-19 capabilities shipped behind fail-closed predicates; setRole documented as out of scope.

### `admin-api-tier` — Separable admin API tier (decision needed)

- **IDs closed:** AR-003
- **Order hint:** 8 · **Effort:** L · **Depends on workstreams:** admin-surface-expansion
- **Why grouped:** Deployment topology of the (growing) admin surface; independent of the impersonation logic.

**Ordered steps**

1. Decide options (recommended A).
2. adminContract + adminApi in Auth.make; AuthHttp mount options; AdminAuthentication middleware slot.

**Test plan**

- AuthHttp: separate mount serves admin only on the admin layer.

**Acceptance**

- Default unchanged; admin can be served/firewalled separately with its own auth middleware.

### `admin-audit-integrity` — Tamper-evident impersonation audit (decision needed)

- **IDs closed:** ALF-005
- **Order hint:** 9 · **Effort:** L · **Depends on workstreams:** admin-impersonation-lifecycle
- **Why grouped:** Standalone integrity property of the durable audit tables (admin_impersonation and core audit_log should share one primitive).

**Ordered steps**

1. Decide options (recommended C now + shared HMAC hash chain A).
2. Triggers in migrations; AuditChain helper; verifyChain.

**Test plan**

- SQL-layer test: raw UPDATE/DELETE rejected; verifyChain detects a rewritten row.

**Acceptance**

- Illegal mutations fail at the DB; tampering is detectable.

### `jwt-act-claim` — RFC 8693 act claim

- **IDs closed:** JR-005
- **Order hint:** 10 · **Effort:** S · **Depends on workstreams:** —
- **Why grouped:** Isolated to Jwt principalClaims.

**Ordered steps**

1. Emit act.sub; update verifier/decoder and docs.

**Test plan**

- Jwt test: impersonation JWT carries act.sub.

**Acceptance**

- RFC 8693-aware verifiers can read the actor.

### `session-assurance` — Session authentication assurance (amr) for qadi (decision needed)

- **IDs closed:** HSK-005
- **Order hint:** 10 · **Effort:** L · **Depends on workstreams:** —
- **Why grouped:** Cross-cutting core change; should be designed together with the TwoFactor plugin (ticket 05).

**Ordered steps**

1. Decide option (recommended A).
2. AuthenticationRecord on sessions, principal, subject attributes; plugins populate it.

**Test plan**

- qadi policy requiring hwk allows hardware-key session only.

**Acceptance**

- Policies can require hardware-bound passkeys.

### `plugin-contract-docs` — dependsOn semantics

- **IDs closed:** JH-007
- **Order hint:** 11 · **Effort:** S · **Depends on workstreams:** —
- **Why grouped:** Spec/convention drift in the plugin contract.

**Ordered steps**

1. Fix BEH-EA-008 example/text.
2. Optional readsTables composition check.

**Test plan**

- Auth.test.ts: undeclared cross-plugin table read refused.

**Acceptance**

- Spec and convention agree.

### `package-and-test-hygiene` — Dependency classification and typed HTTP test decoding

- **IDs closed:** MTS-010, TTE-009
- **Order hint:** 12 · **Effort:** S · **Depends on workstreams:** —
- **Why grouped:** Mechanical hygiene in admin/test packages; no behavior change.

**Ordered steps**

1. Move test-only deps to devDependencies + smoke check.
2. Replace .json() casts with contract-schema decoding.

**Test plan**

- package-smoke assertion; mutation check on a DTO field.

**Acceptance**

- Manifests publish-true; no json casts in admin/passkey tests.

### `passkey-docs` — Passkey documentation truthfulness

- **IDs closed:** TC-007, WPS-012
- **Order hint:** 13 · **Effort:** S · **Depends on workstreams:** —
- **Cross-slice prerequisites:** DTWS-001, DTWS-002
- **Why grouped:** WPS-012 is already fixed (58ef46a) and grouped here only for bookkeeping; TC-007 is the passkey-specific remainder of DTWS-001/002.

**Ordered steps**

1. Rewrite passkey README (incl. Recovery section), BEH banner and model 'What is missing'.

**Test plan**

- spec:verify:strict.

**Acceptance**

- No passkey doc claims non-existence; Recovery section present.

## Decisions needed

### APS-006 — Impersonation cookie overwrite strands the admin's own live session with no handback

- A. Distinct impersonation cookie: impersonate sets `__Host-impersonation` (same attributes) and leaves `__Host-session` untouched; `Api.Authentication`/`OptionalAuthentication` gain a first security entry `{ impersonation, cookie, bearer }` whose handler only accepts sessions carrying `actingAs`; stopImpersonating/forceStop-of-own-episode clears `__Host-impersonation` (Max-Age=0). The admin's own cookie is never destroyed, BEH-EA-216's no-handback semantics survive verbatim, and bearer clients are unaffected.
- B. Handback: record the admin's own session id on the episode row and have stopImpersonating re-issue a superseding admin session + Set-Cookie (contradicts BEH-EA-216 'MUST NOT issue any replacement session'; re-mints admin credentials from an impersonation session — weaker).
- C. Body-only delivery: impersonate returns the token in the body (no Set-Cookie) for the client to swap itself — impossible for httpOnly-cookie browser apps without JS token handling (security regression).
- D. Document-only: state that in cookie mode stopImpersonating == logout, and make the admin UI re-authenticate.

**Recommendation:** Option A. It is the only option that keeps BEH-EA-213's 'caller's session untouched' and BEH-EA-216's 'no handback' literally true for browser clients, costs one extra security-record entry (BEH-EA-071/072 already make the security record the whole strategy chain), and composes with ticket 17's opt-in bearer delivery for native clients. Ship it together with WPS-004's shared session-delivery helper so admin/passkey/password all deliver through one code path.

### AR-003 — Admin API shares the public surface — no separate tier, scheme, or network boundary

- A. Contract-level tier: AuthPlugin contract groups may be tagged `tier: "admin"`; Auth.make exposes `api` (public) and `adminApi` separately, AuthHttp serves admin groups under a configurable prefix/port (default: same server, `/admin` prefix) so operators can firewall it; add an optional `AdminAuthentication` middleware slot (BEH-EA-071 already allows per-group schemes) that hosts can bind to mTLS/service principals, with canImpersonate as the in-handler backstop.
- B. Middleware-only: keep one HttpApi, add a pluggable `AdminAuthentication` middleware layered in front of Authentication on admin groups (no separate serving).
- C. Won't fix: document that admin endpoints share the public surface and that network isolation is the host's reverse-proxy job.

**Recommendation:** A (richest, and BEH-EA-071 already sanctions per-group schemes). The admin surface is about to grow ~14 endpoints (BAM-005/EP-003), which raises the value of being able to firewall it. Default behavior stays identical (same server, same auth) so no deployment is forced to split.

### ALF-005 — Zero tamper-evidence on the one durable audit table — history is rewritable by anyone with SQL access

- A. In-DB hash chain: add `prevHash`/`rowHash` columns to admin_impersonation (and core audit_log), rowHash = HMAC(key, prevHash || canonical row); writes serialized per table (single-writer transaction / advisory lock); `verifyChain` Effect + scheduled job alerting on breaks; endEpisode appends a closing link instead of mutating hashed columns.
- B. External append-only sink: an `AuditExportSink` port (subscriber over AuthEvents/AuditLog) shipping rows to a write-once destination (S3 object-lock, SIEM) the app cannot rewrite.
- C. DB-level controls only: migrations add a Postgres trigger rejecting UPDATE of immutable columns and all DELETEs, plus documented REVOKE guidance; SQLite gets triggers too.
- D. Document as a deployment responsibility (won't fix in library).

**Recommendation:** C now + A for both admin_impersonation and core audit_log in one shared primitive (so the durable AuditLog from ticket 1 gets the same guarantee), and B as an optional port once a real consumer exists. C is cheap and blocks the casual rewrite; A makes forgery by a DBA detectable, which is the finding's actual threat model.

### HSK-005 — Passkey sign-in emits no assurance signal, so a qadi-level 'hardware key required' policy is unimplementable

- A. Session-level authentication record: Sessions.issue accepts `authentication: { methods: ReadonlyArray<string> (amr, RFC 8176 values: "hwk"/"swk"/"user"/"pwd"/"otp"/"fed"), userVerified: boolean, credential?: { provider: "passkey", deviceType, aaguid } }`, persisted on the session row, surfaced on SessionView/UserPrincipal and mapped into the qadi subject attributes by the SubjectResolver; `reauthenticate`/TwoFactor append methods.
- B. Event-only: include the assurance data in auth.user.signedIn and let hosts build their own store.
- C. Defer until TwoFactor (ticket 05) lands and design amr once for both.

**Recommendation:** A, designed now so TwoFactor (ticket 05) appends to the same `methods` list instead of inventing its own. It is the only option that lets a qadi policy require `amr contains hwk` / `credential.deviceType == singleDevice`; hosts that don't care pay nothing (field defaults).

## Per-issue dossiers

### Workstream `admin-impersonation-gate-target`

#### IDS-001 — canImpersonate never sees the target, so no host can refuse impersonating a more privileged account

`high` · `security` · `admin` · [.issues/high/IDS-001-impersonation-delegation-specialist.md](../../.issues/high/IDS-001-impersonation-delegation-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED — confidence high

**Canonical for:** MTI-006

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:43` — the predicate's only input is the caller

```ts
  readonly canImpersonate: (subject: AuthSubject) => Effect.Effect<boolean>;
```

- `packages/admin/src/Admin.ts:278` — targetUserId is in scope (line 267) but never passed

```ts
        const allowed = yield* adminConfig.canImpersonate(subjectOf(caller));
```

- `packages/admin/src/Admin.ts:70` — identity-only caller subject

```ts
const subjectOf = (principal: Api.UserPrincipal): AuthSubject =>
  makeSubject({ id: principal.ref.id });
```

- `packages/admin/src/Admin.ts:333` — forceStop (333) and list (357) use the same caller-only gate; neither sees the episode's target

```ts
        const allowed = yield* adminConfig.canImpersonate(subjectOf(caller));
```

- `spec/behaviors/27-admin-impersonation.md:69` — BEH-EA-212 fixes the caller-only signature in the spec too — must be amended

```text
interface AdminConfigShape {
  readonly maxDuration: Duration.Duration
  readonly canImpersonate: (subject: AuthSubject) => Effect.Effect<boolean>
}
```

**Fix plan** — Make the impersonation gate target-aware: `canImpersonate({ admin, target })` for impersonate, and episode-aware predicates for forceStop/list, all fail-closed.

Steps:
1. packages/admin/src/Admin.ts: change `AdminConfigShape.canImpersonate` to `(input: { readonly admin: AuthSubject; readonly target: AuthSubject }) => Effect.Effect<boolean>`; default stays `() => Effect.succeed(false)`.
2. Add `canManageEpisode: (input: { readonly admin: AuthSubject; readonly episode: ImpersonationRecords.ImpersonationRecord }) => Effect.Effect<boolean>` with a default that delegates to `canImpersonate({ admin, target: makeSubject({ id: episode.targetUserId }) })` — forceStop evaluates it for the named episode (after `findBySessionId`), list filters rows through it (Effect.filter, concurrency bounded), so a host scoping impersonation by tenant/privilege gets the same scoping on stop/list for free.
3. Build the target subject with the same identity-only `makeSubject({ id })` (a new `subjectOfUserId` helper next to `subjectOf`) — layering stays as documented in the module header; hosts enrich by closing over their own resolver.
4. Order in impersonate: self-check → nested-check → gate(admin, target) → target-existence (IDS-003) → issue. Evaluating the gate BEFORE the existence check keeps non-admins from using 404-vs-403 as a user-id oracle.
5. forceStop: look up the episode first (`records.findBySessionId`), 404 when absent, then gate via `canManageEpisode`, publishing `impersonationDenied` only on a real gate rejection.
6. Update spec/behaviors/27-admin-impersonation.md BEH-EA-212 (signature + rationale), BEH-EA-217, BEH-EA-219; add a BDD scenario 'an admin cannot impersonate an account the host's predicate protects (e.g. a more privileged account)'.
7. Update every canImpersonate call site in tests (packages/admin/test/*.ts, features/step-definitions/AdminSteps.ts / AdminWorld) to the new input shape.

Files: `packages/admin/src/Admin.ts`, `packages/admin/test/Admin.test.ts`, `packages/admin/test/AuthHttp.test.ts`, `features/step-definitions/AdminSteps.ts`, `features/features/09-admin-and-impersonation/27-admin-impersonation.feature`, `spec/behaviors/27-admin-impersonation.md`, `spec/traceability.md`

Tests (write first):
- packages/admin/test/Admin.test.ts: 'IDS-001: canImpersonate receives the target and can refuse a protected target' — config `canImpersonate: ({ target }) => Effect.succeed(target.id !== "superadmin-2")`; impersonating superadmin-2 fails AdminImpersonationDenied and publishes impersonationDenied; impersonating an ordinary user succeeds.
- 'IDS-001: forceStop/list are filtered by canManageEpisode' — two episodes, predicate allows only one target; list returns one row, forceStop on the other returns AdminImpersonationDenied.

Acceptance:
- The gate predicate observably receives both the admin and the target subject.
- A host predicate that refuses a target blocks impersonate, and (by default) forceStop/list of that target's episodes.
- Default config still denies everything (fail-closed).

Spec refs: BEH-EA-212, BEH-EA-213, BEH-EA-217, BEH-EA-219 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### MTI-006 — Admin impersonation is structurally tenant-blind: the gate predicate never sees the target

`high` · `security` · `admin` · [.issues/high/MTI-006-multi-tenant-isolation-specialist.md](../../.issues/high/MTI-006-multi-tenant-isolation-specialist.md) · current status `ready-for-agent`

**Verdict:** DUPLICATE of **IDS-001** — confidence high

**Assessment:** Identical root cause (the gate predicate never sees the target). Its tenant half (list/forceStop global across tenants) is carried by IDS-002, and IDS-001's canManageEpisode covers the per-episode scoping.

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:43` — the predicate's only input is the caller

```ts
  readonly canImpersonate: (subject: AuthSubject) => Effect.Effect<boolean>;
```

- `packages/admin/src/Admin.ts:333` — forceStop (333) and list (357) use the same caller-only gate; neither sees the episode's target

```ts
        const allowed = yield* adminConfig.canImpersonate(subjectOf(caller));
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### IDS-002 — No tenant or organization scoping anywhere in the impersonation path

`medium` · `security` · `admin` · [.issues/medium/IDS-002-impersonation-delegation-specialist.md](../../.issues/medium/IDS-002-impersonation-delegation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/admin/src/ImpersonationRecords.ts:43` — no tenant dimension on the audit row

```ts
export interface ImpersonationRecord {
  readonly id: string;
  readonly adminUserId: UserId;
  readonly targetUserId: UserId;
  readonly sessionId: string;
  readonly reason: string;
  readonly startedAt: DateTime.Utc;
```

- `packages/admin/src/Admin.ts:356` — list returns every episode in the deployment (records.list(input) at :365)

```ts
      const list: AdminShape["list"] = Effect.fnUntraced(function* (caller, input) {
        const allowed = yield* adminConfig.canImpersonate(subjectOf(caller));
        if (!allowed) {
```

- `packages/organization/src/OrganizationRecords.ts:5` — the only 'impersonat' mention in packages/organization/src is a comment; no tenant seam exists

```ts
// `ImpersonationRecords.ts` builds `admin_impersonation` — directly against
```

**Fix plan** — Stamp the ambient tenant (ticket 18's TenantContext) on every episode and scope list/forceStop to it; cross-tenant access only through the superadmin predicate from ticket 19.

Steps:
1. Prerequisite (cross-slice DRS-001, wayfinder ticket 18): `TenantContext: Context.Reference<Option<string>>` in @awthaq/core.
2. packages/admin/src/Admin.ts adminMigrations: new migration `add_admin_impersonation_tenant_id` adding nullable `tenantId TEXT` + index (both dialects).
3. packages/admin/src/ImpersonationRecords.ts: `ImpersonationRecord.tenantId: Option<string>`; `create` reads `TenantContext` and stamps it; `list`/`findBySessionId`/`endEpisode` take the ambient tenant and filter `tenantId IS NOT DISTINCT FROM ?` (memory layer: Option equality) — Option.none() (single-tenant apps) keeps today's behavior.
4. Admin.ts: the gate input (IDS-001) carries `tenantId` so a host predicate can compare tenant affinity; forceStop/list outside the caller's tenant require the ticket-19 `canAdministerTenants` predicate.
5. AdminApi.ImpersonationRecordDto gains `tenantId: Schema.NullOr(Schema.String)`.
6. spec: amend BEH-EA-215 (record shape), BEH-EA-217/219 (tenant scoping).

Files: `packages/admin/src/Admin.ts`, `packages/admin/src/ImpersonationRecords.ts`, `packages/admin/src/AdminApi.ts`, `packages/admin/test/ImpersonationRecords.test.ts`, `packages/admin/test/Admin.test.ts`, `spec/behaviors/27-admin-impersonation.md`

Tests (write first):
- packages/admin/test/ImpersonationRecords.test.ts (both layers): 'IDS-002: list/endEpisode only see the ambient tenant's episodes' — create under TenantContext 'org-a' and 'org-b', list under 'org-a' returns one row.
- packages/admin/test/Admin.test.ts: forceStop of another tenant's episode fails AdminImpersonationNotFound unless canAdministerTenants passes.

Acceptance:
- Every new admin_impersonation row carries the ambient tenant id (NULL when none).
- list/forceStop never cross tenants unless the superadmin predicate allows it; single-tenant deployments see no behavior change.

Spec refs: BEH-EA-215, BEH-EA-217, BEH-EA-219 · Effort: **M** · Depends on: IDS-001, DRS-001

**Recommended status:** `ready-for-agent`

#### IDS-003 — Impersonating a nonexistent user succeeds: session and audit row minted for a phantom target

`medium` · `correctness` · `admin` · [.issues/medium/IDS-003-impersonation-delegation-specialist.md](../../.issues/medium/IDS-003-impersonation-delegation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Canonical for:** APS-009

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:287` — no Users lookup precedes issuance

```ts
        const issued = yield* sessions
          .issue({
            userId: targetUserId,
            actingAs: { type: caller.ref.type, id: caller.ref.id },
            absoluteDuration: adminConfig.maxDuration,
          })
          .pipe(Effect.orDie);
```

- `packages/admin/src/Admin.ts:259` — Admin.make never acquires Users.Users — there is no way to check target existence

```ts
      const sessions = yield* Sessions.Sessions;
      const events = yield* AuthEvents.AuthEvents;
      const records = yield* ImpersonationRecords.ImpersonationRecords;
      const adminConfig = yield* AdminConfig;
```

- `spec/behaviors/27-admin-impersonation.md:198` — the spec already names 'unknown target user' as a validation failure — no code implements it

```text
             `auth.admin.impersonationDenied` specifically when
             `canImpersonate` resolves `false` — never for
             `AdminSelfImpersonationRefused`, `AdminAlreadyImpersonating`,
             or an unknown target user, which are ordinary validation
             failures, not authorization-bypass attempts.
```

- `packages/admin/src/AdminApi.ts:58` — unconstrained path params; handler brands with Users.UserId(params.userId) at Admin.ts:161

```ts
export const UserIdParams = Schema.Struct({ userId: Schema.String });
export type UserIdParams = typeof UserIdParams.Type;

export const SessionIdParams = Schema.Struct({ sessionId: Schema.String });
```

**Fix plan** — Refuse impersonation of a nonexistent target with a typed 404, after the gate, and tighten the path-param schemas.

Steps:
1. packages/admin/src/AdminApi.ts: add `AdminTargetNotFound` (Schema.TaggedError, httpApiStatus 404) and add it to the impersonate endpoint's error list.
2. packages/admin/src/AdminApi.ts: constrain `UserIdParams.userId`/`SessionIdParams.sessionId` with a non-empty, bounded-length (<=255) check (Schema.check(Schema.makeFilter(...)) like ReasonSchema); no UUID shape assumption since UserId is app-supplied in tests ('target-1').
3. packages/admin/src/Admin.ts make: `const users = yield* Users.Users;`.
4. impersonate: after the gate passes (IDS-001 ordering), `yield* users.findById(targetUserId).pipe(Effect.catchTag("UserNotFound", () => Effect.fail(new AdminApi.AdminTargetNotFound())))` — no impersonationDenied event on this path (BEH-EA-218).
5. AdminShape.impersonate error union gains AdminTargetNotFound; update spec BEH-EA-213/218 to name it.
6. BDD: scenario 'impersonating an unknown user id is refused as not found and mints no session or audit row'.

Files: `packages/admin/src/Admin.ts`, `packages/admin/src/AdminApi.ts`, `packages/admin/test/Admin.test.ts`, `packages/admin/test/AuthHttp.test.ts`, `features/features/09-admin-and-impersonation/27-admin-impersonation.feature`, `features/step-definitions/AdminSteps.ts`, `spec/behaviors/27-admin-impersonation.md`

Tests (write first):
- packages/admin/test/Admin.test.ts: 'IDS-003: impersonating a nonexistent user fails AdminTargetNotFound and writes no session, no audit row, no impersonationStarted event' — assert records.list() empty and no event on the stream (fails today: succeeds).
- packages/admin/test/AuthHttp.test.ts: POST /admin/impersonate/does-not-exist → 404; POST /admin/impersonate/ (empty) → 400.

Acceptance:
- A gate-passing admin gets 404 AdminTargetNotFound for an unknown target; a non-admin still gets 403 (no existence oracle).
- No session row, admin_impersonation row, or impersonationStarted event is created for an unknown target.

Spec refs: BEH-EA-213, BEH-EA-218 · Effort: **S** · Depends on: IDS-001

**Recommended status:** `ready-for-agent`

#### APS-009 — Admin path parameters are raw unvalidated strings; impersonate accepts nonexistent target users

`low` · `correctness` · `admin` · [.issues/low/APS-009-auth-pentest-specialist.md](../../.issues/low/APS-009-auth-pentest-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **IDS-003** — confidence high

**Assessment:** Its substantive half (phantom-target sessions/audit rows) is IDS-003; the param-constraint half is folded into IDS-003's fix steps. Its own note that forceStop's arbitrary sessionId is contained by endEpisode's uniform 404 still holds at Admin.ts:341-347.

**Evidence at HEAD**

- `packages/admin/src/AdminApi.ts:58` — unconstrained path params; handler brands with Users.UserId(params.userId) at Admin.ts:161

```ts
export const UserIdParams = Schema.Struct({ userId: Schema.String });
export type UserIdParams = typeof UserIdParams.Type;

export const SessionIdParams = Schema.Struct({ sessionId: Schema.String });
```

- `packages/admin/src/Admin.ts:287` — no Users lookup precedes issuance

```ts
        const issued = yield* sessions
          .issue({
            userId: targetUserId,
            actingAs: { type: caller.ref.type, id: caller.ref.id },
            absoluteDuration: adminConfig.maxDuration,
          })
          .pipe(Effect.orDie);
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

### Workstream `admin-impersonation-lifecycle`

#### ESS-006 — Admin impersonation history query is unpaginated and unstreamed: SELECT * ordered, whole table per call

`medium` · `performance` · `admin` · [.issues/medium/ESS-006-effect-stream-specialist.md](../../.issues/medium/ESS-006-effect-stream-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/admin/src/ImpersonationRecords.ts:249` — unbounded, unpaginated, deployment-wide

```ts
    const listAllQuery = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ImpersonationRow,
      execute: () => sql`SELECT * FROM admin_impersonation ORDER BY startedAt DESC`,
    });
```

- `packages/admin/src/ImpersonationRecords.ts:171` — memory layer sorts the whole map per call

```ts
    const list: ImpersonationRecordsShape["list"] = (input) =>
      Ref.get(state).pipe(
        Effect.map((s) => applyActiveFilter(newestFirst(Array.from(HashMap.values(s))), input)),
      );
```

- `spec/behaviors/05-persistence-stratum.md:85` — keyset pattern + Cursor/Page types already exist in packages/sql/src/Repositories.ts:38-48

```text
REQUIREMENT: No repository's public interface MAY accept an offset
             parameter; every paginated query MUST accept an opaque cursor
             derived from `(createdAt, id)` and return the next cursor
             alongside the page.
```

**Fix plan** — Keyset-paginate the impersonation history on (startedAt, id), newest-first, in both layers and on the wire.

Steps:
1. packages/admin/src/ImpersonationRecords.ts: `list(input?: { active?: boolean; cursor?: { startedAt: DateTime.Utc; id: string }; limit?: number }) => Effect<{ items; nextCursor: Option<Cursor> }>`; SQL: `WHERE (startedAt, id) < (?, ?)` expanded as `startedAt < ? OR (startedAt = ? AND id < ?)` `ORDER BY startedAt DESC, id DESC LIMIT ?+1`; memory layer mirrors.
2. Migration `create_admin_impersonation_started_at_index` on (startedAt, id).
3. AdminApi.ts: ListQuery gains `cursor` (opaque base64url of startedAt|id, decoded with a Schema transform — no casts) and `limit` (1..200, default 50); success becomes `ImpersonationPage { items: ImpersonationRecordDto[]; nextCursor: string | null }`.
4. Optionally expose `ImpersonationRecords.stream` (Stream.paginateEffect over list) for exports.
5. Update BEH-EA-219 text (paged history).

Files: `packages/admin/src/ImpersonationRecords.ts`, `packages/admin/src/AdminApi.ts`, `packages/admin/src/Admin.ts`, `packages/admin/test/ImpersonationRecords.test.ts`, `packages/admin/test/AuthHttp.test.ts`, `spec/behaviors/27-admin-impersonation.md`

Tests (write first):
- packages/admin/test/ImpersonationRecords.test.ts (both layers): 'ESS-006: list pages newest-first with a stable cursor across equal startedAt' — 5 rows at the same TestClock instant, limit 2 → 3 pages, no dupes/gaps.

Acceptance:
- No list call loads more than limit+1 rows.
- Pages are stable under equal timestamps (id tiebreak).

Spec refs: BEH-EA-219, BEH-EA-036 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### IDS-004 — endedBy="expired" is declared but nothing ever sets it; audit trail reports dead episodes as active

`medium` · `compliance` · `admin` · [.issues/medium/IDS-004-impersonation-delegation-specialist.md](../../.issues/medium/IDS-004-impersonation-delegation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Canonical for:** JR-011, ESA-008

**Evidence at HEAD**

- `packages/admin/src/ImpersonationRecords.ts:32` — self-documented gap; grep of packages/admin/src for "expired" finds only type/schema literals (AdminApi.ts:79, ImpersonationRecords.ts:41/190/239)

```ts
 * BEH-EA-217: the three ways an impersonation episode ends. `"expired"` is
 * declared for completeness with this closed set — like `@awthaq/passkey`'s
 * own `PasskeyCounterAnomaly` tag, it names a value no code path in this
 * plugin produces yet: nothing here observes a session's hard expiry and
 * calls `endEpisode(id, "expired")` on its behalf, so a naturally-expired
 * episode stays reported as `active` (BEH-EA-219) until a real
 * `stopImpersonating`/`forceStop` call ends it. Any future hard-expiry
```

- `spec/behaviors/27-admin-impersonation.md:142` — hard-expiry observation is a MUST-path with no implementation

```text
REQUIREMENT: `impersonate` MUST insert one `admin_impersonation` row per
             episode at the same time it issues the session (BEH-EA-213).
             `endedAt`/`endedBy` MUST be populated exactly once, by
             whichever of `stopImpersonating` (BEH-EA-216), `forceStop`
             (BEH-EA-217), or hard-expiry observation sets them first.
```

**Fix plan** — Record each episode's hard expiry and close expired episodes as endedBy="expired" — lazily on every read and via an exported sweep — publishing the stopped event from the same path.

Steps:
1. Migration `add_admin_impersonation_expires_at`: `expiresAt` (TIMESTAMPTZ/TEXT) — backfill not needed pre-release; make it NOT NULL for new rows.
2. ImpersonationRecords.create takes `expiresAt` (Admin.impersonate passes `issued.session.absoluteExpiresAt`).
3. New `ImpersonationRecords.closeExpired(now) => Effect<ReadonlyArray<ImpersonationRecord>>`: SQL `UPDATE admin_impersonation SET endedAt = expiresAt, endedBy = 'expired' WHERE endedAt IS NULL AND expiresAt <= ? RETURNING *`; memory layer mirrors atomically in Ref.modify.
4. Admin.list and Admin.forceStop/stopImpersonating call `closeExpired` first (lazy reconciliation) and publish `auth.admin.impersonationStopped { endedBy: "expired" }` for each returned row.
5. Export `Admin.sweepExpiredEpisodes` (an Effect a host can `Effect.schedule`) for deployments that want closure without a read.
6. Delete the 'no code path produces it yet' paragraph in ImpersonationRecords.ts:32-40; update BEH-EA-215/219; BDD scenario 'an impersonation that runs past its hard expiry is closed as expired'.

Files: `packages/admin/src/ImpersonationRecords.ts`, `packages/admin/src/Admin.ts`, `packages/admin/test/ImpersonationRecords.test.ts`, `packages/admin/test/Admin.test.ts`, `features/features/09-admin-and-impersonation/27-admin-impersonation.feature`, `features/step-definitions/AdminSteps.ts`, `spec/behaviors/27-admin-impersonation.md`

Tests (write first):
- packages/admin/test/Admin.test.ts: 'IDS-004: an episode past maxDuration is reported ended (expired) by list({active:true})' — impersonate, TestClock.adjust(maxDuration + 1s), list active → [] and the full list row has endedBy 'expired'; one impersonationStopped{endedBy:'expired'} event (fails today).

Acceptance:
- list({active:true}) never returns an episode whose session hard-expired.
- Each expired episode is closed exactly once and emits exactly one stopped event with endedBy "expired".

Spec refs: BEH-EA-215, BEH-EA-218, BEH-EA-219 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### ESA-008 — The 'expired' ended-by path is declared but never produced, so durable impersonation audit episodes are never closed by expiry

`low` · `compliance` · `admin` · [.issues/low/ESA-008-event-sourcing-audit-trail-specialist.md](../../.issues/low/ESA-008-event-sourcing-audit-trail-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **IDS-004** — confidence high

**Assessment:** Same missing hard-expiry observer as IDS-004; IDS-004's fix also publishes the stopped event with endedBy "expired" as ESA-008 asks.

**Evidence at HEAD**

- `packages/admin/src/ImpersonationRecords.ts:41` — "expired" has no producer; AuthEvents.ts:134 declares it on the stopped event too

```ts
export type EndedBy = "self" | "forcedByAdmin" | "expired";
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### IDS-007 — Both stop paths refuse to revoke when the audit row is missing or already ended

`low` · `correctness` · `admin` · [.issues/low/IDS-007-impersonation-delegation-specialist.md](../../.issues/low/IDS-007-impersonation-delegation-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:316` — stopImpersonating: no Set-Cookie on the way out; episode close gates the revoke

```ts
          yield* records
            .endEpisode(caller.sessionId, "self")
            .pipe(
              Effect.catchTag("ImpersonationRecordNotFound", () =>
                Effect.fail(new AdminApi.AdminImpersonationNotFound()),
              ),
            );
          yield* sessions.revoke(Sessions.SessionId(caller.sessionId)).pipe(Effect.orDie);
```

- `packages/admin/src/Admin.ts:341` — row-close gates revoke; a revoke of an already-deleted session (e.g. target's revokeAll on password reset) dies (orDie) after the row was closed

```ts
        yield* records
          .endEpisode(sessionId, "forcedByAdmin")
          .pipe(
            Effect.catchTag("ImpersonationRecordNotFound", () =>
              Effect.fail(new AdminApi.AdminImpersonationNotFound()),
            ),
          );
        yield* sessions.revoke(Sessions.SessionId(sessionId)).pipe(Effect.orDie);
```

- `packages/core/src/Sessions.ts:545` — Sessions.revoke fails SessionNotFound for a missing row (SQL layer likewise at :855-864) — Admin turns that into a defect

```ts
            if (!HashMap.has(s, id)) {
              return [
                Result.fail(new SessionNotFound({ message: `awthaq: no such session: ${id}` })),
                s,
              ] as const;
            }
```

**Fix plan** — Make revocation the primary, idempotent act on both stop paths and record the episode end best-effort, without letting forceStop revoke sessions that are not provably impersonation sessions.

Steps:
1. stopImpersonating: caller.actingAs is already proof — revoke first: `sessions.revoke(...).pipe(Effect.catchTag("SessionNotFound", () => Effect.void))`, then `records.endEpisode(caller.sessionId, "self").pipe(Effect.catchTag("ImpersonationRecordNotFound", () => Effect.logWarning(...)))`, then publish impersonationStopped.
2. forceStop: `records.findBySessionId(sessionId)` (returns ended rows too); None → AdminImpersonationNotFound (the row is the only proof the session carries actingAs); Some → gate (IDS-001 canManageEpisode) → revoke idempotently (catch SessionNotFound) → endEpisode only if still open → publish.
3. Never `Effect.orDie` a SessionNotFound from revoke in Admin.ts (today a target's password reset revokeAll deletes the impersonation session and forceStop then dies after closing the row).
4. Amend BEH-EA-216/217 text: revocation precedes and does not depend on episode bookkeeping.

Files: `packages/admin/src/Admin.ts`, `packages/admin/test/Admin.test.ts`, `spec/behaviors/27-admin-impersonation.md`

Tests (write first):
- packages/admin/test/Admin.test.ts: 'IDS-007: stopImpersonating still revokes when the audit row was already ended' — end the row via records.endEpisode directly, then stopImpersonating succeeds and the session no longer verifies (fails today: 404, session stays live).
- 'IDS-007: forceStop after the target's revokeAll does not die' — impersonate, sessions.revokeAll(target), forceStop succeeds (fails today with a defect).

Acceptance:
- stopImpersonating on an actingAs session always ends with that session revoked.
- forceStop never produces a defect for an already-revoked session and never revokes a session with no episode row.

Spec refs: BEH-EA-216, BEH-EA-217 · Effort: **S** · Depends on: IDS-001

**Recommended status:** `ready-for-agent`

#### JR-011 — Naturally-expired impersonation episodes stay 'active' forever: the expired EndedBy value has no producing code path

`info` · `docs` · `admin` · [.issues/info/JR-011-justin-richer.md](../../.issues/info/JR-011-justin-richer.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **IDS-004** — confidence high

**Assessment:** Same missing hard-expiry observer as IDS-004.

**Evidence at HEAD**

- `packages/admin/src/ImpersonationRecords.ts:32` — self-documented gap; grep of packages/admin/src for "expired" finds only type/schema literals (AdminApi.ts:79, ImpersonationRecords.ts:41/190/239)

```ts
 * BEH-EA-217: the three ways an impersonation episode ends. `"expired"` is
 * declared for completeness with this closed set — like `@awthaq/passkey`'s
 * own `PasskeyCounterAnomaly` tag, it names a value no code path in this
 * plugin produces yet: nothing here observes a session's hard expiry and
 * calls `endEpisode(id, "expired")` on its behalf, so a naturally-expired
 * episode stays reported as `active` (BEH-EA-219) until a real
 * `stopImpersonating`/`forceStop` call ends it. Any future hard-expiry
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

### Workstream `passkey-user-handle`

#### BPAS-003 — webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle

`medium` · `correctness` · `passkey` · [.issues/medium/BPAS-003-biometric-platform-authenticator-specialist.md](../../.issues/medium/BPAS-003-biometric-platform-authenticator-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Canonical for:** HSK-001, TC-002, WPS-002, CB-005

**Assessment:** Confirmed: three independently random handles per enrolment (591, 615, 692); only the verify-time one is persisted and it never matches the authenticator's bound handle. Follows the passkey design's own intent (per-user random handle, user story 23).

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:591` — the handle the authenticator actually binds (conditional path repeats this at :615)

```ts
          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          return yield* webAuthn.registrationOptions({
            rpId: config.rpId,
            rpName: config.rpName,
            challenge: Redacted.value(challenge),
            userId: webauthnUserId,
```

- `packages/passkey/src/Passkey.ts:692` — a third random handle, minted at verify time, is what gets persisted

```ts
          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          const record = yield* credentials.create({
            id: verified.credentialId,
            userId,
            webauthnUserId,
```

- `packages/passkey/src/Passkey.ts:761` — authenticateVerify identifies by credential id only; the assertion's userHandle is forwarded (Passkey.ts:177) but never compared

```ts
          const storedOpt = yield* credentials.findById(input.credential.id);
```

- `packages/ports/src/WebAuthn.ts:93` — the port's own contract says per-user; .scratch/passkey/spec.md user story 23 asks for a per-user random webauthnUserID

```ts
  /** Base64url-encoded `webauthnUserId` handle — a per-user, non-PII handle distinct from the internal user id (BEH-EA-anchored in `@awthaq/passkey`'s own `passkey_credential` table). */
```

**Fix plan** — Mint one random WebAuthn user handle per user, persist it in a plugin table, send it in every registration ceremony, store exactly it on the credential, and cross-check assertion userHandle.

Steps:
1. New migration in Passkey.ts passkeyMigrations: `passkey_user_handle (userId TEXT PRIMARY KEY, webauthnUserId TEXT NOT NULL UNIQUE, createdAt ...)`; add the table to `tables`.
2. New service `PasskeyUserHandles` (layerMemory/layerSql, like PasskeyCredentials): `getOrCreate(userId) => Effect<string>` (INSERT … ON CONFLICT(userId) DO NOTHING then SELECT, atomic), `findUserByHandle(handle) => Effect<Option<UserId>>`, `deleteByUser(userId)`.
3. Passkey.ts registerOptions/registerOptionsConditional/registerVerify: use `handles.getOrCreate(userId)` instead of crypto.randomBytes; credentials.create stores that value.
4. authenticateVerify: when `input.credential.response.userHandle` is present, require it to equal `stored.webauthnUserId`, else Api.InvalidCredentials (BEH-EA-136 collapse); same in reauthenticateVerify (PasskeyVerificationFailed).
5. Passkey.beforeUserDeleteErasure: also delete the user's handle row (GDPR, ec065a7's cascade).
6. Add `PasskeyCredentials.findByWebauthnUserId` only if a real consumer needs it (usernameless user resolution already goes by credential id).

Files: `packages/passkey/src/Passkey.ts`, `packages/passkey/src/PasskeyUserHandles.ts`, `packages/passkey/src/index.ts`, `packages/passkey/test/Passkey.test.ts`, `packages/passkey/test/PasskeyUserHandles.test.ts`, `packages/passkey/test/PasskeyErasure.test.ts`, `spec/behaviors/17-passkey.md`

Tests (write first):
- packages/passkey/test/Passkey.test.ts: 'BPAS-003: the stored webauthnUserId equals options.user.id, and two credentials of one user share it' (fails today).
- 'BPAS-003: an assertion whose userHandle differs from the stored handle is InvalidCredentials'.

Acceptance:
- For any user, every registration options response and every stored credential carry the same handle.
- A mismatching assertion userHandle fails sign-in; erasure removes the handle.

Spec refs: BEH-EA-130, BEH-EA-131, BEH-EA-136 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### BPAS-006 — WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers

`medium` · `dx` · `passkey` · [.issues/medium/BPAS-006-biometric-platform-authenticator-specialist.md](../../.issues/medium/BPAS-006-biometric-platform-authenticator-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:879` — server deletes; nothing tells the credential manager

```ts
          yield* accounts.unlink(accountOpt.value.id).pipe(
            Effect.catchTags({
              AccountNotFound: () => Effect.fail(new PasskeyApi.PasskeyCredentialNotFound()),
              LastAccountRefusal: () => Effect.fail(new PasskeyApi.PasskeyLastCredential()),
            }),
          );
          yield* credentials.delete(id, userId).pipe(Effect.orDie);
```

- `packages/client/src/passkey/PasskeyClient.ts:142` — the shipped client (0441226, BPAS-002) has no Signals API usage — grep for signalAllAcceptedCredentials/signalUnknownCredential finds nothing

```ts
const toRegistrationCredentialInput = (
  credential: RegistrationResponseJSON,
): PasskeyApi.RegistrationCredentialInput => ({
  id: credential.id,
```

**Fix plan** — Add WebAuthn L3 Signals to the client, fed by an enumeration-safe server surface keyed on the (now stable) user handle.

Steps:
1. Server: `GET /passkey/credentials` response gains `{ rpId, userHandle, credentials }` envelope (or a new `GET /passkey/credentials/signals` returning `{ rpId, userId: webauthnUserId, allAcceptedCredentialIds, name, displayName }`) — authenticated, so no enumeration concern.
2. packages/client/src/passkey/PasskeyClient.ts: `signals` helpers — after deletePasskey and after any successful sign-in, call `PublicKeyCredential.signalAllAcceptedCredentials` (feature-detected, fire-and-forget, errors swallowed); `signalCurrentUserDetails` after profile rename; `signalUnknownCredential` only in the usernameless flow on InvalidCredentials, opt-in (a bad signature would otherwise hide a valid passkey).
3. Expose in getClientCapabilities whether signals are supported.

Files: `packages/passkey/src/Passkey.ts`, `packages/passkey/src/PasskeyApi.ts`, `packages/client/src/passkey/PasskeyClient.ts`, `packages/client/test/PasskeyClient.test.ts`

Tests (write first):
- packages/client/test/PasskeyClient.test.ts: 'BPAS-006: deletePasskey calls signalAllAcceptedCredentials with the remaining ids and the stable user handle' (fake PublicKeyCredential; fails today).

Acceptance:
- After delete, the browser is signalled with the remaining accepted ids for the stable user handle.
- Unsupported browsers are unaffected (no throw).

Spec refs: BEH-EA-134 · Effort: **M** · Depends on: BPAS-003

**Recommended status:** `ready-for-agent`

#### HSK-001 — Persisted webauthnUserId is never the user handle the authenticator bound

`medium` · `correctness` · `passkey` · [.issues/medium/HSK-001-hardware-security-key-specialist.md](../../.issues/medium/HSK-001-hardware-security-key-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **BPAS-003** — confidence high

**Assessment:** Same root cause: per-ceremony random user handle; persisted value never the bound one; assertion userHandle unchecked.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:591` — the handle the authenticator actually binds (conditional path repeats this at :615)

```ts
          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          return yield* webAuthn.registrationOptions({
            rpId: config.rpId,
            rpName: config.rpName,
            challenge: Redacted.value(challenge),
            userId: webauthnUserId,
```

- `packages/passkey/src/Passkey.ts:692` — a third random handle, minted at verify time, is what gets persisted

```ts
          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          const record = yield* credentials.create({
            id: verified.credentialId,
            userId,
            webauthnUserId,
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### TC-002 — WebAuthn user handle is random per ceremony step, never a stable per-user value

`medium` · `correctness` · `passkey` · [.issues/medium/TC-002-tim-cappalli.md](../../.issues/medium/TC-002-tim-cappalli.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **BPAS-003** — confidence high

**Assessment:** Same root cause: per-ceremony random user handle; persisted value never the bound one; assertion userHandle unchecked.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:591` — the handle the authenticator actually binds (conditional path repeats this at :615)

```ts
          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          return yield* webAuthn.registrationOptions({
            rpId: config.rpId,
            rpName: config.rpName,
            challenge: Redacted.value(challenge),
            userId: webauthnUserId,
```

- `packages/passkey/src/Passkey.ts:692` — a third random handle, minted at verify time, is what gets persisted

```ts
          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          const record = yield* credentials.create({
            id: verified.credentialId,
            userId,
            webauthnUserId,
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### WPS-002 — Stored webauthnUserId is fabricated at verify time, never the handle the authenticator saw, and is never validated

`medium` · `correctness` · `passkey` · [.issues/medium/WPS-002-webauthn-passkeys-specialist.md](../../.issues/medium/WPS-002-webauthn-passkeys-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **BPAS-003** — confidence high

**Assessment:** Same root cause: per-ceremony random user handle; persisted value never the bound one; assertion userHandle unchecked.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:692` — a third random handle, minted at verify time, is what gets persisted

```ts
          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          const record = yield* credentials.create({
            id: verified.credentialId,
            userId,
            webauthnUserId,
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### CB-005 — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored

`low` · `correctness` · `passkey` · [.issues/low/CB-005-christiaan-brand.md](../../.issues/low/CB-005-christiaan-brand.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **BPAS-003** — confidence high

**Assessment:** Same root cause: per-ceremony random user handle; persisted value never the bound one; assertion userHandle unchecked.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:692` — a third random handle, minted at verify time, is what gets persisted

```ts
          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          const record = yield* credentials.create({
            id: verified.credentialId,
            userId,
            webauthnUserId,
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

### Workstream `session-revocation-events`

#### TIR-008 — No auth.session.revoked event - revocation is invisible to subscribers

`medium` · `architecture` · `admin` · [.issues/medium/TIR-008-token-introspection-revocation-specialist.md](../../.issues/medium/TIR-008-token-introspection-revocation-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (commit `45325bb`) — confidence high

**Assessment:** PARTIAL: an `auth.session.revoked` tag now exists (45325bb) for password-change/reset bulk revocation. The core claim — Sessions.revoke/revokeOthers/revokeAll themselves are silent, so sign-out, account deletion and admin revocations reach no subscriber (and no AuditLog row) — still holds.

**Evidence at HEAD**

- `packages/core/src/AuthEvents.ts:90` — added by 45325bb (ALF-004) — but only @awthaq/password publishes it (Password.ts:1033/1139)

```ts
export interface SessionRevokedEvent {
  readonly _tag: "auth.session.revoked";
  readonly userId: UserId;
  readonly reason: "passwordChanged" | "passwordReset";
}
```

- `packages/core/src/Sessions.ts:230` — revoke/revokeOthers/revokeAll (230-234) publish nothing in either layer (memory impl 536-554, SQL 855-870)

```ts
  readonly revoke: (id: SessionId) => Effect.Effect<void, SessionNotFound>;
```

- `packages/server/src/Session.ts:86` — sign-out revokes silently; so do Account.ts:112 (delete → revokeAll) and Admin stop/forceStop

```ts
        yield* sessions
          .revoke(Sessions.SessionId(principal.sessionId))
          .pipe(Effect.catchTag("SessionNotFound", () => Effect.void));
```

**Fix plan** — Publish revocation from the Sessions primitives themselves with a per-row identity and a cause, so every revocation path is observable and durably audited.

Steps:
1. packages/core/src/AuthEvents.ts: widen SessionRevokedEvent to `{ _tag: "auth.session.revoked"; userId; sessionId: Option<string> | string | null (per-row when known); scope: "one" | "others" | "all"; reason: "signOut" | "passwordChanged" | "passwordReset" | "userDeleted" | "impersonationStopped" | "admin" | "reuseDetected" }` (use a nullable `sessionId` field — stay Schema-friendly).
2. packages/core/src/Sessions.ts: `revoke(id, reason)`, `revokeOthers(userId, keep, reason)`, `revokeAll(userId, reason)` gain a required `reason` parameter; both layers publish after the delete succeeds (layers already hold `events`). Keep BEH-EA-098 (publish never awaits subscribers).
3. Update callers: server Session.ts signOut ('signOut'), server Account.ts ('userDeleted'), password Password.ts (drop its own manual publish — now emitted by Sessions, avoid double events), admin Admin.ts ('impersonationStopped'/'admin'), Sessions reuse-family revocation ('reuseDetected').
4. packages/core/src/AuditLog.ts actorOf: keep `auth.session.revoked` mapped to event.userId (exhaustive switch forces review).
5. spec/behaviors/13-events.md: register the widened event (BEH-EA-101 registry).

Files: `packages/core/src/AuthEvents.ts`, `packages/core/src/Sessions.ts`, `packages/core/src/AuditLog.ts`, `packages/server/src/Session.ts`, `packages/server/src/Account.ts`, `packages/password/src/Password.ts`, `packages/admin/src/Admin.ts`, `packages/core/test/Sessions.test.ts`, `spec/behaviors/13-events.md`

Tests (write first):
- packages/core/test/Sessions.test.ts (both layers): 'TIR-008: revoke publishes auth.session.revoked with sessionId and reason' — subscribe to events.stream, revoke, expect one event (fails today).
- packages/password/test: changePassword still yields exactly one revoked event (no double publish).

Acceptance:
- Every Sessions revocation primitive publishes exactly one auth.session.revoked event carrying userId, reason and (for single revoke) sessionId.
- AuditLog contains a row for sign-out, account deletion and admin stop paths.

Spec refs: BEH-EA-097, BEH-EA-098, BEH-EA-100, BEH-EA-101 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `passkey-challenge-store-hardening`

#### WPS-003 — Dual-scope challenge probe in registerVerify destroys the non-matching sibling challenge

`medium` · `correctness` · `passkey` · [.issues/medium/WPS-003-webauthn-passkeys-specialist.md](../../.issues/medium/WPS-003-webauthn-passkeys-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/passkey/src/ChallengeStore.ts:95` — layerSql popByScope (156-159) deletes by scope alone too

```ts
      // BEH-EA-132: popped unconditionally in one atomic step — gone whether or not it turns out to match.
      const popped = yield* Ref.modify(
        state,
        (s) => [HashMap.get(s, scope), HashMap.remove(s, scope)] as const,
      );
```

- `packages/passkey/src/Passkey.ts:652` — probes the ordinary scope first; consume pops it whether or not it matches, then the conditional scope is tried (664-671)

```ts
          const consumedOrdinary = yield* challengeStore.consume(
            registrationScope(sessionId),
            clientData.challenge,
          );
```

**Fix plan** — Stop probing both registration scopes: the verify payload names its ceremony, and only that scope is consumed.

Steps:
1. packages/passkey/src/PasskeyApi.ts: `RegisterVerifyPayload = Schema.Struct({ credential: RegistrationCredentialSchema, ceremony: Schema.optional(Schema.Literals(["modal", "conditional"])) })` (absent ⇒ "modal").
2. packages/passkey/src/Passkey.ts registerVerify: consume exactly `ceremony === "conditional" ? conditionalScope(sessionId) : registrationScope(sessionId)`; drop the fall-through second consume (652-673).
3. packages/client/src/passkey/PasskeyClient.ts: registerPasskeyConditional sends `ceremony: "conditional"`.
4. Keep BEH-EA-132 semantics: the addressed scope is deleted on every attempt.

Files: `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/src/Passkey.ts`, `packages/client/src/passkey/PasskeyClient.ts`, `packages/passkey/test/Passkey.test.ts`, `packages/client/test/PasskeyClient.test.ts`

Tests (write first):
- packages/passkey/test/Passkey.test.ts: 'WPS-003: completing a conditional ceremony leaves a concurrently-issued modal challenge usable' — issue both options, verify conditional, then verify modal succeeds (fails today with PasskeyChallengeInvalid).

Acceptance:
- A conditional-create verify never consumes the ordinary registration challenge and vice versa.

Spec refs: BEH-EA-130, BEH-EA-132 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### WPS-005 — Expired challenges are never reclaimed; abandoned authenticate ceremonies grow storage without bound

`medium` · `performance` · `passkey` · [.issues/medium/WPS-005-webauthn-passkeys-specialist.md](../../.issues/medium/WPS-005-webauthn-passkeys-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:717` — a fresh scope per anonymous call

```ts
          const ceremonyId = toBase64Url(yield* crypto.randomBytes(16).pipe(Effect.orDie));
          const challenge = yield* challengeStore.issue(authenticateScope(ceremonyId));
```

- `packages/passkey/src/ChallengeStore.ts:156` — the only DELETE in the store; layerMemory removes only on consume of that exact scope (94-99); nothing reclaims expired rows

```ts
        execute: (scope) => sql`
          DELETE FROM passkey_challenge WHERE scope = ${scope}
          RETURNING scope, value, expiresAt
        `,
```

**Fix plan** — Reclaim expired challenges opportunistically on issue, expose an explicit sweep, and throttle the anonymous options endpoint.

Steps:
1. ChallengeStore.layerMemory.issue: inside the same Ref.update, drop entries whose expiresAt <= now (O(n) but bounded by live entries), or keep a min-heap if profiling warrants.
2. ChallengeStore.layerSql.issue: after the upsert, `DELETE FROM passkey_challenge WHERE expiresAt <= ${now}` (cheap with an index); new migration `create_passkey_challenge_expires_at_index`.
3. Add `sweepExpired: Effect<number>` to ChallengeStoreShape (cookie: succeed(0)) so hosts can schedule it.
4. Passkey.layer: register `RateLimits.rule({ group: "passkey.authenticate", endpoint: "authenticateOptions", key: "ip", ... })` (and authenticateVerify) so unauthenticated minting is bounded (coordinate with JH-005 which makes rule enforcement opt-in).

Files: `packages/passkey/src/ChallengeStore.ts`, `packages/passkey/src/Passkey.ts`, `packages/passkey/test/ChallengeStore.test.ts`

Tests (write first):
- packages/passkey/test/ChallengeStore.test.ts (memory + sql): 'WPS-005: an expired, never-consumed challenge is reclaimed by the next issue' — issue scope A, TestClock.adjust(6 min), issue scope B, assert row count 1 (fails today: 2).

Acceptance:
- Storage holds no challenge older than TTL after any issue/sweep.
- authenticate/options is rate-limited per IP.

Spec refs: BEH-EA-132, BEH-EA-107 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### BPAS-008 — Challenge value compared with === in memory/SQL stores while the cookie store uses constantTimeEqual

`low` · `security` · `passkey` · [.issues/low/BPAS-008-biometric-platform-authenticator-specialist.md](../../.issues/low/BPAS-008-biometric-platform-authenticator-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Canonical for:** CB-007, WPS-008, HSK-010

**Assessment:** Real but low exploitability (256-bit CSPRNG value, popped before compare, one timing sample per challenge) — hygiene fix.

**Evidence at HEAD**

- `packages/passkey/src/ChallengeStore.ts:104` — layerMemory; layerSql does the same at :183

```ts
      return popped.value.value === challenge;
```

- `packages/passkey/src/ChallengeStore.ts:183` — layerSql

```ts
          return popped.value.value === challenge;
```

- `packages/passkey/src/ChallengeStore.ts:230` — the helper exists in the same module, used only by layerCookie (:298)

```ts
const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};
```

**Fix plan** — Route the memory/SQL final comparison through the module's constantTimeEqual over decoded bytes.

Steps:
1. packages/passkey/src/ChallengeStore.ts: add `const challengeMatches = (stored: string, presented: string): boolean` that base64url-decodes both with Encoding.decodeBase64Url (Result failure ⇒ false) and calls constantTimeEqual.
2. Use it in layerMemory.consume (:104) and layerSql.consume (:183).

Files: `packages/passkey/src/ChallengeStore.ts`, `packages/passkey/test/ChallengeStore.test.ts`

Tests (write first):
- packages/passkey/test/ChallengeStore.test.ts (memory + sql): 'consume rejects a non-base64url presented value' and 'consume rejects a same-length value differing in the last byte' — both pass today semantically; add them first as regression guards, then refactor.

Acceptance:
- No `=== challenge` comparison remains in ChallengeStore.ts.
- Existing ChallengeStore tests stay green.

Spec refs: BEH-EA-132 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### CB-007 — Challenge comparison is non-constant-time in memory and SQL layers but constant-time in the cookie layer

`low` · `security` · `passkey` · [.issues/low/CB-007-christiaan-brand.md](../../.issues/low/CB-007-christiaan-brand.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **BPAS-008** — confidence high

**Assessment:** Same === vs constantTimeEqual inconsistency.

**Evidence at HEAD**

- `packages/passkey/src/ChallengeStore.ts:104` — layerMemory; layerSql does the same at :183

```ts
      return popped.value.value === challenge;
```

- `packages/passkey/src/ChallengeStore.ts:230` — the helper exists in the same module, used only by layerCookie (:298)

```ts
const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### WPS-008 — Memory/SQL challenge comparison uses plain === while the cookie layer is constant-time

`low` · `security` · `passkey` · [.issues/low/WPS-008-webauthn-passkeys-specialist.md](../../.issues/low/WPS-008-webauthn-passkeys-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **BPAS-008** — confidence high

**Assessment:** Same === vs constantTimeEqual inconsistency.

**Evidence at HEAD**

- `packages/passkey/src/ChallengeStore.ts:104` — layerMemory; layerSql does the same at :183

```ts
      return popped.value.value === challenge;
```

- `packages/passkey/src/ChallengeStore.ts:230` — the helper exists in the same module, used only by layerCookie (:298)

```ts
const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### WPS-009 — layerCookie violates ChallengeStoreShape's documented issue-replacement contract

`low` · `correctness` · `passkey` · [.issues/low/WPS-009-webauthn-passkeys-specialist.md](../../.issues/low/WPS-009-webauthn-passkeys-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/passkey/src/ChallengeStore.ts:60` — shape-level promise

```ts
  /** Mints a fresh challenge scoped to `scope`, replacing whatever this scope's own prior (unconsumed) challenge was, if any. */
```

- `packages/passkey/src/ChallengeStore.ts:282` — layerCookie stores nothing, so a prior unconsumed value stays valid until its TTL

```ts
    const issue: ChallengeStoreShape["issue"] = Effect.fnUntraced(function* (scope) {
      const random = yield* crypto.randomBytes(RANDOM_BYTES).pipe(Effect.orDie);
      const now = yield* DateTime.now;
      const payload = concatBytes(random, packExpiry(DateTime.addDuration(now, TTL)));
      const signature = yield* sign(scope, payload);
      return Redacted.make(Encoding.encodeBase64Url(concatBytes(payload, signature)));
```

**Fix plan** — State per-backend guarantees in the type and prove them with a cross-backend conformance suite.

Steps:
1. packages/passkey/src/ChallengeStore.ts: add `readonly guarantees: { readonly singleUse: boolean; readonly replacesPriorOnIssue: boolean }` to ChallengeStoreShape (memory/sql: true/true; cookie: false/false) and reword the issue/consume docs to reference it.
2. Passkey.ts: log a warning at layer build (Effect.logWarning) when `guarantees.singleUse` is false, naming BEH-EA-132's statefulness requirement.
3. packages/passkey/test/ChallengeStore.test.ts: one shared `conformance(layer)` suite run against all three layers, asserting each property iff the layer claims it.

Files: `packages/passkey/src/ChallengeStore.ts`, `packages/passkey/src/Passkey.ts`, `packages/passkey/test/ChallengeStore.test.ts`, `spec/behaviors/17-passkey.md`

Tests (write first):
- packages/passkey/test/ChallengeStore.test.ts: 'WPS-009: issuing twice invalidates the first value' run for each layer that claims replacesPriorOnIssue; for layerCookie assert the claim is false (write first — fails to compile until `guarantees` exists).

Acceptance:
- Every ChallengeStore layer advertises its real guarantees and the conformance suite enforces them.

Spec refs: BEH-EA-132 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### HSK-010 — Challenge value comparison is plain === in memory/SQL layers while the cookie layer ships a constantTimeEqual

`info` · `security` · `passkey` · [.issues/info/HSK-010-hardware-security-key-specialist.md](../../.issues/info/HSK-010-hardware-security-key-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **BPAS-008** — confidence high

**Assessment:** Same === vs constantTimeEqual inconsistency.

**Evidence at HEAD**

- `packages/passkey/src/ChallengeStore.ts:104` — layerMemory; layerSql does the same at :183

```ts
      return popped.value.value === challenge;
```

- `packages/passkey/src/ChallengeStore.ts:230` — the helper exists in the same module, used only by layerCookie (:298)

```ts
const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

### Workstream `passkey-counter-anomaly-policy`

#### CB-004 — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first

`medium` · `correctness` · `passkey` · [.issues/medium/CB-004-christiaan-brand.md](../../.issues/medium/CB-004-christiaan-brand.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Assessment:** Confirmed against SimpleWebAuthn 14.0.1 source: every non-zero regression throws inside the library, becomes PasskeyVerificationFailed, and is collapsed to InvalidCredentials; the plugin's counterAnomaly branch is reachable only through the mocked port in Passkey.test.ts:366. The design decision (.scratch/passkey/issues/08: 'flagged as PasskeyCounterAnomaly without hard-locking the account (log + step-up, not an instant kill)') is followed, not re-litigated.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:796` — log-only branch

```ts
          const counterRegressed =
            verified.newCounter <= stored.counter &&
            !(verified.newCounter === 0 && stored.counter === 0);
          if (counterRegressed) {
            yield* events.publish({
              _tag: "auth.passkey.counterAnomaly",
              userId: stored.userId,
              credentialId: stored.id,
```

- `node_modules/.pnpm/@simplewebauthn+server@14.0.1/node_modules/@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.js:186` — the library throws first for every non-zero regression

```js
    if ((counter > 0 || credential.counter > 0) &&
        counter <= credential.counter) {
        // Error out when the counter in the DB is greater than or equal to the counter in the
        // dataStruct. It's related to how the authenticator maintains the number of times its been
        // used for this client. If this happens, then someone's somehow increased the counter
        // on the device without going through this site
        throw new Error(`Response counter value ${counter} was lower than expected ${credential.counter}`);
```

- `packages/ports/src/WebAuthn.ts:272` — …and Passkey.ts:780-782 collapses that into Api.InvalidCredentials before the counter branch can run

```ts
        catch: (cause) =>
          new PasskeyVerificationFailed({
            message: `awthaq: passkey authentication verification failed: ${String(cause)}`,
          }),
```

**Fix plan** — Move counter-regression detection out of the library into the plugin so the decided 'log + step-up' policy actually runs, with an optional strict mode.

Steps:
1. packages/ports/src/WebAuthn.ts verifyAuthentication: pass `credential.counter: 0` to verifyAuthenticationResponse (disables the library's throw — its check is `(counter > 0 || credential.counter > 0) && counter <= credential.counter`) and return `newCounter`; document on StoredCredential/VerifiedAuthentication that counter policy is the caller's job.
2. packages/passkey/src/Passkey.ts: keep the existing counterRegressed computation (0/0 carve-out) in authenticateVerify and reauthenticateVerify; on regression publish auth.passkey.counterAnomaly (durably audited since 6bd3f1d) and persist the anomaly (see WPS-006).
3. PasskeyConfigShape: `counterAnomalyPolicy: "flag" | "reject"` default "flag" (ticket-08 decision); "reject" fails `PasskeyCounterAnomaly` (409) — add it to authenticateVerify/reauthenticateVerify error unions (safe per BEH-EA-136: only reachable after a valid signature from a registered credential).
4. Do NOT advance the stored counter on a regression (recordUsage keeps max(stored, new)).

Files: `packages/ports/src/WebAuthn.ts`, `packages/ports/test/WebAuthn.test.ts`, `packages/passkey/src/Passkey.ts`, `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/test/Passkey.test.ts`, `features/features/05-authentication-methods/17-passkey.feature`, `features/step-definitions/PasskeySteps.ts`, `spec/behaviors/17-passkey.md`

Tests (write first):
- packages/ports/test/WebAuthn.test.ts: 'CB-004: a real assertion with counter 3 against stored counter 5 verifies and reports newCounter 3' (fails today: PasskeyVerificationFailed).
- packages/passkey/test: end-to-end with layerSimpleWebAuthn + ports fixtures: regression ⇒ session issued + counterAnomaly event under 'flag'; PasskeyCounterAnomaly under 'reject'.
- BDD: un-skip REQ-EA-381 as a 'reject' policy scenario and add a 'flag' scenario.

Acceptance:
- A non-zero counter regression reaches the plugin's policy branch (event published).
- 'flag' issues the session; 'reject' answers PasskeyCounterAnomaly.
- REQ-EA-381 is no longer @skip.

Spec refs: BEH-EA-131, BEH-EA-136 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### HSK-004 — Counter-regression (cloned-key) signal is published to a volatile in-memory bus with no enforcement

`medium` · `security` · `passkey` · [.issues/medium/HSK-004-hardware-security-key-specialist.md](../../.issues/medium/HSK-004-hardware-security-key-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **WPS-006** — confidence high

**Assessment:** Same root cause as WPS-006 (log-only, no credential flag/enforcement); its 'volatile in-memory bus' half is already fixed by 6bd3f1d (durable AuditLog).

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:796` — log-only branch

```ts
          const counterRegressed =
            verified.newCounter <= stored.counter &&
            !(verified.newCounter === 0 && stored.counter === 0);
          if (counterRegressed) {
            yield* events.publish({
              _tag: "auth.passkey.counterAnomaly",
              userId: stored.userId,
              credentialId: stored.id,
```

- `packages/core/src/AuditLog.ts:82` — since 6bd3f1d every published AuthEvent is written inline to the durable AuditLog (AuthEvents.ts:367 `yield* auditLog.record(event);`) — the 'volatile bus only' half no longer holds

```ts
    case "auth.passkey.counterAnomaly":
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### WPS-006 — Cloned-authenticator detection is log-only; PasskeyCounterAnomaly is declared but never emitted

`medium` · `security` · `passkey` · [.issues/medium/WPS-006-webauthn-passkeys-specialist.md](../../.issues/medium/WPS-006-webauthn-passkeys-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (commit `6bd3f1d`) — confidence high

**Canonical for:** HSK-004, BPAS-009

**Assessment:** PARTIAL: since 6bd3f1d the anomaly event is durably written to AuditLog inline by AuthEvents.publish, so 'no persistence / lost in multi-instance' no longer holds. Still true: no credential-level flag, no step-up/enforcement, PasskeyCounterAnomaly is never raised, REQ-EA-381 is @skip.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:796` — log-only branch

```ts
          const counterRegressed =
            verified.newCounter <= stored.counter &&
            !(verified.newCounter === 0 && stored.counter === 0);
          if (counterRegressed) {
            yield* events.publish({
              _tag: "auth.passkey.counterAnomaly",
              userId: stored.userId,
              credentialId: stored.id,
```

- `packages/core/src/AuditLog.ts:82` — since 6bd3f1d every published AuthEvent is written inline to the durable AuditLog (AuthEvents.ts:367 `yield* auditLog.record(event);`) — the 'volatile bus only' half no longer holds

```ts
    case "auth.passkey.counterAnomaly":
```

- `packages/passkey/src/PasskeyApi.ts:133` — declared (doc at 124-132 says it deliberately never appears in any endpoint error union)

```ts
export class PasskeyCounterAnomaly extends Schema.TaggedError<PasskeyCounterAnomaly>()(
  "PasskeyCounterAnomaly",
  {},
  { httpApiStatus: 409 },
) {}
```

- `features/features/05-authentication-methods/17-passkey.feature:261`

```text
    @skip
    @REQ-EA-381
    Scenario: A counter regression on an otherwise-verified assertion is reported as its own typed anomaly, not silently accepted
```

**Fix plan** — Persist anomaly state on the credential and let policy act on it; raise PasskeyCounterAnomaly under the strict policy (CB-004).

Steps:
1. Migration: add `counterAnomalyAt` (nullable timestamp) and `counterAnomalyCount INTEGER NOT NULL DEFAULT 0` to passkey_credential.
2. PasskeyCredentials: `flagCounterAnomaly(id, now)`; record fields on PasskeyCredentialRecord; surface `counterAnomalyAt` in PasskeyCredentialDto so users/admins see a possibly-cloned key.
3. Step-up under 'flag': issue the session but record the anomaly, and when a flagged credential is used again, require UV=1 (fail PasskeyUserVerificationRequired if absent) — the concrete, config-driven 'step-up' the ticket-08 decision promised.
4. Update PasskeyApi.PasskeyCounterAnomaly doc (now raised under 'reject') and spec BEH-EA-131/136 text; delete the '@skip' rationale comment in the feature.

Files: `packages/passkey/src/Passkey.ts`, `packages/passkey/src/PasskeyCredentials.ts`, `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/test/Passkey.test.ts`, `packages/passkey/test/PasskeyCredentials.test.ts`, `features/features/05-authentication-methods/17-passkey.feature`, `spec/behaviors/17-passkey.md`

Tests (write first):
- packages/passkey/test/Passkey.test.ts: 'WPS-006: a regressed credential is flagged and its next sign-in demands UV' (fails today).

Acceptance:
- A counter regression sets counterAnomalyAt on the credential and it is visible in the credentials list.
- A flagged credential cannot sign in without UV; 'reject' policy returns PasskeyCounterAnomaly.

Spec refs: BEH-EA-131, BEH-EA-136 · Effort: **M** · Depends on: CB-004

**Recommended status:** `ready-for-agent`

#### BPAS-009 — PasskeyCounterAnomaly declared in the contract but never raised by any endpoint

`info` · `api` · `passkey` · [.issues/info/BPAS-009-biometric-platform-authenticator-specialist.md](../../.issues/info/BPAS-009-biometric-platform-authenticator-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **WPS-006** — confidence high

**Assessment:** 'PasskeyCounterAnomaly declared but never raised' is part of WPS-006; resolved when CB-004/WPS-006 make the 'reject' policy raise it.

**Evidence at HEAD**

- `packages/passkey/src/PasskeyApi.ts:133` — declared (doc at 124-132 says it deliberately never appears in any endpoint error union)

```ts
export class PasskeyCounterAnomaly extends Schema.TaggedError<PasskeyCounterAnomaly>()(
  "PasskeyCounterAnomaly",
  {},
  { httpApiStatus: 409 },
) {}
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

### Workstream `session-delivery`

#### WPS-004 — Plugin sets the session cookie itself, contradicting BEH-EA-131 and un-skipped scenario REQ-EA-362

`medium` · `compliance` · `passkey` · [.issues/medium/WPS-004-webauthn-passkeys-specialist.md](../../.issues/medium/WPS-004-webauthn-passkeys-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Assessment:** Confirmed; password (Password.ts:387/411/486) and admin (Admin.ts:164) repeat the pattern — the spec text lags the delivery convention. Wayfinder ticket 17 (MNA-001, decided, not implemented) already requires a shared, opt-in bearer-vs-cookie delivery for every session-minting response, which is the natural owner of delivery.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:362` — the plugin handler sets the cookie itself

```ts
          const issued = yield* passkey.authenticateVerify(payload);
          yield* HttpApiBuilder.securitySetCookie(
            Api.SessionCookie,
            Redacted.value(issued.token),
            Sessions.SESSION_COOKIE_ATTRIBUTES,
          );
```

- `spec/behaviors/17-passkey.md:68`

```text
REQUIREMENT: A verified authentication assertion MUST create a session
             through the same core `Sessions` capability every other sign-in
             method uses; the passkey plugin MUST NOT set a session cookie
             itself.
```

- `features/step-definitions/PasskeySteps.ts:196` — REQ-EA-362 (not @skip) only checks the cookie name, so the contradiction passes

```ts
    'the session cookie is set by core "Sessions", not by any cookie-setting code in the passkey plugin',
    Effect.fn(function* () {
      const response = (yield* getOutcome("authenticateResponse")) as Response;
      const cookie = cookieFrom(response);
      if (!cookie.startsWith("__Host-session=")) {
```

**Fix plan** — Introduce one shared session-delivery helper (owned by @awthaq/api/server, implementing ticket 17's cookie-or-bearer choice) and route every session-minting handler through it; amend BEH-EA-131 accordingly.

Steps:
1. packages/server (or @awthaq/api if it must be plugin-reachable without a server dep): `SessionDelivery.deliver(issued)` — reads the `X-Awthaq-Token-Delivery` request header (ticket 17): absent ⇒ `securitySetCookie(Api.SessionCookie, …, SESSION_COOKIE_ATTRIBUTES)`; `bearer` ⇒ no cookie, token returned for the DTO's optional `token` field.
2. Replace hand-rolled securitySetCookie calls in passkey (Passkey.ts:363), password (Password.ts:387/411/486) and admin (Admin.ts:164 — or the APS-006 impersonation variant) with the helper.
3. spec/behaviors/17-passkey.md BEH-EA-131: 'MUST NOT set a session cookie itself' → 'MUST deliver the session only through the shared SessionDelivery helper'; same wording for password's BEH.
4. features/step-definitions/PasskeySteps.ts REQ-EA-362: assert delivery via the helper (e.g. bearer opt-in returns token and no Set-Cookie).

Files: `packages/server/src/SessionDelivery.ts`, `packages/api/src/Session.ts`, `packages/passkey/src/Passkey.ts`, `packages/password/src/Password.ts`, `packages/admin/src/Admin.ts`, `spec/behaviors/17-passkey.md`, `features/step-definitions/PasskeySteps.ts`

Tests (write first):
- packages/passkey/test/AuthHttp.test.ts: 'WPS-004: authenticate/verify with X-Awthaq-Token-Delivery: bearer returns the token and sets no cookie' (fails today).

Acceptance:
- No plugin src calls HttpApiBuilder.securitySetCookie(Api.SessionCookie, …) directly (grep).
- BEH-EA-131 text and REQ-EA-362 match the implementation.

Spec refs: BEH-EA-131 · Effort: **M** · Depends on: MNA-001

**Recommended status:** `ready-for-agent`

### Workstream `admin-impersonation-cookie-contract`

#### APS-006 — Impersonation cookie overwrite strands the admin's own live session with no handback

`medium` · `correctness` · `admin` · [.issues/medium/APS-006-auth-pentest-specialist.md](../../.issues/medium/APS-006-auth-pentest-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Canonical for:** IDS-005, JR-006, CSS-003

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:164` — impersonate handler overwrites the single __Host-session cookie with the target's impersonation token

```ts
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
```

- `packages/admin/src/Admin.ts:316` — stopImpersonating: no Set-Cookie on the way out; episode close gates the revoke

```ts
          yield* records
            .endEpisode(caller.sessionId, "self")
            .pipe(
              Effect.catchTag("ImpersonationRecordNotFound", () =>
                Effect.fail(new AdminApi.AdminImpersonationNotFound()),
              ),
            );
          yield* sessions.revoke(Sessions.SessionId(caller.sessionId)).pipe(Effect.orDie);
```

- `packages/api/src/Api.ts:102` — one cookie name for every session, admin and impersonation alike; Authentication's chain is { cookie, bearer } (Api.ts:118)

```ts
export const SessionCookie = HttpApiSecurity.apiKey({ key: "__Host-session", in: "cookie" });
```

- `spec/behaviors/27-admin-impersonation.md:160` — the no-handback contract presumes a token-holding client; a browser cookie jar holds one __Host-session

```text
REQUIREMENT: `stopImpersonating` MUST revoke the caller's own current
             session (which MUST carry `actingAs`, or the call fails) and
             set the matching `admin_impersonation` row's `endedAt`/
             `endedBy: "self"`. It MUST NOT issue any replacement session —
             the caller is expected to already hold their own original
             session's token from before `impersonate` was called.
```

- `features/features/09-admin-and-impersonation/27-admin-impersonation.feature:76` — passes only because AdminSteps.ts keeps the raw admin cookie string aside (setOutcome("adminCookie", ...), AdminSteps.ts:36/81) — a real browser jar would have overwritten it

```text
    Scenario: A successful impersonate call answers with a session cookie for the target, leaving the caller's own session untouched
      Given a signed-in admin with an active session of their own
      When the admin calls "admin.impersonate" for a target user with a valid reason
      Then the response carries a new session cookie, distinct from the admin's own
      And the admin's own original session cookie still authenticates afterward
```

**Fix plan** — Deliver impersonation sessions under a dedicated `__Host-impersonation` cookie that shadows (not replaces) `__Host-session`, and clear it on stop (Option A — pending decision).

Steps:
1. packages/api/src/Api.ts: add `ImpersonationCookie = HttpApiSecurity.apiKey({ key: "__Host-impersonation", in: "cookie" })` and declare it FIRST in both `Authentication` and `OptionalAuthentication` security records: `{ impersonation: ImpersonationCookie, cookie: SessionCookie, bearer: BearerToken }`.
2. packages/core/src/Sessions.ts: export `IMPERSONATION_COOKIE_NAME = "__Host-impersonation"` next to SESSION_COOKIE_NAME (same attributes object).
3. packages/server/src/Authentication.ts: implement the `impersonation` handler over the same session-resolution logic as `cookie`, but fail (fall through) unless the resolved session has `actingAs` Some — an ordinary session presented in that cookie must never authenticate.
4. packages/admin/src/Admin.ts `AdminHandlers.impersonate`: `securitySetCookie(Api.ImpersonationCookie, ...)` instead of `Api.SessionCookie`.
5. packages/admin/src/Admin.ts `AdminHandlers.stopImpersonating`: after `admin.stopImpersonating(caller)`, expire the impersonation cookie (set empty value with `maxAge: 0` via HttpApiBuilder.securitySetCookie or HttpServerResponse cookie removal — check ../effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts for the supported removal API).
6. packages/next/src/WithNextCookies.ts: make sure the forwarded cookie set includes the new name.
7. spec: amend BEH-EA-213/216 to state the cookie-mode contract (impersonation cookie shadows the admin's own cookie; stop clears it); amend BEH-EA-065/072 in spec/behaviors/09-authentication-middleware.md for the new first chain entry.
8. features: update AdminSteps.ts so the test world uses a real cookie jar (merge Set-Cookie into one jar) instead of retaining the raw admin cookie string, so REQ-EA-609/REQ-EA-385-style scenarios test browser semantics.

Files: `packages/api/src/Api.ts`, `packages/core/src/Sessions.ts`, `packages/server/src/Authentication.ts`, `packages/admin/src/Admin.ts`, `packages/next/src/WithNextCookies.ts`, `spec/behaviors/27-admin-impersonation.md`, `spec/behaviors/09-authentication-middleware.md`, `features/step-definitions/AdminSteps.ts`, `features/features/09-admin-and-impersonation/27-admin-impersonation.feature`

Tests (write first):
- packages/admin/test/AuthHttp.test.ts: new test 'BEH-EA-213/216: a browser cookie jar returns to the admin session after stopImpersonating' — maintain a single jar (apply every Set-Cookie), impersonate, assert GET /session resolves the target with actingAs, stopImpersonating, assert GET /session now resolves the admin (fails today: jar holds a revoked token).
- packages/server/test: an `__Host-impersonation` cookie carrying a session WITHOUT actingAs never authenticates.
- BDD: new scenario in 27-admin-impersonation.feature 'After stopping impersonation in a browser, the admin is still signed in as themselves'.

Acceptance:
- After impersonate, the response sets `__Host-impersonation` and does not touch `__Host-session`.
- After stopImpersonating, the impersonation cookie is expired and the next request authenticates as the admin with no re-login.
- An ordinary session token planted in `__Host-impersonation` is rejected by the impersonation handler and the chain falls through to `__Host-session`.

Spec refs: BEH-EA-213, BEH-EA-216, BEH-EA-065, BEH-EA-072 · Effort: **M** · Depends on: WPS-004

**Needs decision:** yes — see *Decisions needed*.

**Recommended status:** `ready-for-human`

#### CSS-003 — stopImpersonating never restores the admin's own session cookie — the browser is stranded with a revoked impersonation cookie

`medium` · `correctness` · `admin` · [.issues/medium/CSS-003-cookie-security-specialist.md](../../.issues/medium/CSS-003-cookie-security-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **APS-006** — confidence high

**Assessment:** same root cause viewed from the stop leg: no cookie bridge back to the admin session; fixed by APS-006's plan.

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:164` — impersonate handler overwrites the single __Host-session cookie with the target's impersonation token

```ts
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
```

- `packages/admin/src/Admin.ts:316` — stopImpersonating: no Set-Cookie on the way out; episode close gates the revoke

```ts
          yield* records
            .endEpisode(caller.sessionId, "self")
            .pipe(
              Effect.catchTag("ImpersonationRecordNotFound", () =>
                Effect.fail(new AdminApi.AdminImpersonationNotFound()),
              ),
            );
          yield* sessions.revoke(Sessions.SessionId(caller.sessionId)).pipe(Effect.orDie);
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### IDS-005 — Impersonate overwrites the admin's httpOnly session cookie; browser admins cannot 'already hold' their original token

`medium` · `dx` · `admin` · [.issues/medium/IDS-005-impersonation-delegation-specialist.md](../../.issues/medium/IDS-005-impersonation-delegation-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **APS-006** — confidence high

**Assessment:** same root cause: impersonate overwrites the single __Host-session cookie; fixed by APS-006's plan.

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:164` — impersonate handler overwrites the single __Host-session cookie with the target's impersonation token

```ts
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
```

- `features/features/09-admin-and-impersonation/27-admin-impersonation.feature:76` — passes only because AdminSteps.ts keeps the raw admin cookie string aside (setOutcome("adminCookie", ...), AdminSteps.ts:36/81) — a real browser jar would have overwritten it

```text
    Scenario: A successful impersonate call answers with a session cookie for the target, leaving the caller's own session untouched
      Given a signed-in admin with an active session of their own
      When the admin calls "admin.impersonate" for a target user with a valid reason
      Then the response carries a new session cookie, distinct from the admin's own
      And the admin's own original session cookie still authenticates afterward
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### JR-006 — impersonate overwrites the browser's session cookie with the impersonation token, so the no-handback stop flow logs the admin out of the browser

`medium` · `correctness` · `admin` · [.issues/medium/JR-006-justin-richer.md](../../.issues/medium/JR-006-justin-richer.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **APS-006** — confidence high

**Assessment:** same root cause: cookie-mode impersonate destroys the admin's own credential; fixed by APS-006's plan.

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:164` — impersonate handler overwrites the single __Host-session cookie with the target's impersonation token

```ts
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
```

- `features/features/09-admin-and-impersonation/27-admin-impersonation.feature:76` — passes only because AdminSteps.ts keeps the raw admin cookie string aside (setOutcome("adminCookie", ...), AdminSteps.ts:36/81) — a real browser jar would have overwritten it

```text
    Scenario: A successful impersonate call answers with a session cookie for the target, leaving the caller's own session untouched
      Given a signed-in admin with an active session of their own
      When the admin calls "admin.impersonate" for a target user with a valid reason
      Then the response carries a new session cookie, distinct from the admin's own
      And the admin's own original session cookie still authenticates afterward
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### BAM-012 — Impersonation semantics differ from better-auth's cookie-swap model

`info` · `api` · `admin` · [.issues/info/BAM-012-better-auth-migration-specialist.md](../../.issues/info/BAM-012-better-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence medium

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:75` — the documented model differs from better-auth's swap-and-restore; no migration doc exists (no docs/ migration guide in repo; packages/admin/README.md:3 still says 'planned package')

```ts
   * BEH-EA-213/214/218: validates self/nested-impersonation first (neither
   * ever reaches the gate or publishes `impersonationDenied`), then the
   * configured gate, then issues a dual-identity session for `targetUserId`
   * and records a durable audit row — `caller`'s own session is never
   * touched.
```

- `packages/admin/src/Admin.ts:164` — impersonate handler overwrites the single __Host-session cookie with the target's impersonation token

```ts
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
```

**Fix plan** — Document the impersonation client contract (and its delta from better-auth) once APS-006's cookie contract is decided.

Steps:
1. packages/admin/README.md: replace the stale 'planned package' banner (DTWS-002) with a real usage section: dual-identity session, gate config, cookie-mode contract from APS-006 (impersonation cookie shadows the admin cookie; stop clears it), bearer-mode contract (client swaps tokens).
2. Add a 'Migrating from better-auth admin impersonation' subsection: better-auth swaps and restores the session cookie server-side; awthaq never touches the admin session, audits every episode, adds forceStop/list; list the endpoint mapping (impersonateUser → POST /admin/impersonate/:userId, stopImpersonating → POST /admin/stop-impersonating).

Files: `packages/admin/README.md`

Tests (write first):
- Docs-only; verify links with `pnpm run spec:verify:strict` if README is covered, otherwise manual review.

Acceptance:
- packages/admin/README.md describes the shipped impersonation client contract and the better-auth delta.

Spec refs: BEH-EA-213, BEH-EA-216 · Effort: **S** · Depends on: APS-006, DTWS-002

**Recommended status:** `ready-for-agent`

### Workstream `passkey-enumeration-safety`

#### TC-001 — Anonymous authenticate/options response leaks account existence via allowCredentials

`medium` · `security` · `passkey` · [.issues/medium/TC-001-tim-cappalli.md](../../.issues/medium/TC-001-tim-cappalli.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Canonical for:** CB-006, WPS-007

**Assessment:** Confirmed. The passkey design decision (.scratch/passkey/spec.md user story 20) keeps username-first a first-class, always-available path — so the fix must mask existence, not remove the email-scoped path.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:723` — known email ⇒ real credential ids; unknown ⇒ []

```ts
          if (email !== undefined) {
            const userOpt = yield* users.findByEmail(email);
            if (Option.isSome(userOpt)) {
              const owned = yield* credentials.listByUser(userOpt.value.id);
              allowCredentials = owned.map((row) => ({ id: row.id, transports: row.transports }));
            }
          }
```

- `packages/passkey/src/PasskeyApi.ts:288` — no Authentication and no rate-limit rule (no plugin registers RateLimits.rule anywhere)

```ts
  // Public and anonymous by design (see this file's header), but still two
  // unsafe-method (POST) endpoints a browser client reaches — CSRF-worth
  // protecting the same as `PasswordApi.ts`'s public `signIn`/`signUp`,
  // even though WebAuthn's own origin binding is a second, independent
  // defense here.
  .middleware(Api.CsrfProtection);
```

- `spec/behaviors/17-passkey.md:158`

```text
REQUIREMENT: Every distinct passkey ceremony failure MUST be its own typed
             `Schema.TaggedError`; the failure MUST NOT be collapsed into a
             single generic error whose message varies with the internal
             cause, and an unknown-credential failure MUST NOT reveal whether
             any credential was registered for the supplied user identifier.
```

**Fix plan** — Keep username-first but make its response indistinguishable for unknown emails via deterministic decoy descriptors, and rate-limit the endpoint.

Steps:
1. PasskeyConfigShape: `enumerationSecret: Redacted<string>` (Context.Reference default: a random per-process secret generated at layer build, with a startup Effect.logWarning recommending an explicit value for multi-instance deployments).
2. authenticateOptions: for an unknown email (or a known user with zero credentials), return `k` decoy descriptors where ids = base64url(HMAC-SHA256(secret, lowercase(email) || i)) truncated to a realistic credential-id length and k = 1 + (first HMAC byte mod 2); transports derived deterministically from the same HMAC (e.g. ["internal","hybrid"]). Known users keep their real descriptors.
3. Do the lookup work unconditionally (findByEmail + listByUser against a sentinel id) so timing is comparable.
4. Register a per-IP and per-email RateLimits rule on passkey.authenticate/authenticateOptions (shared with WPS-005).
5. Amend BEH-EA-136 to state the options half is inside the enumeration-safe envelope; comment next to PasskeyApi header.

Files: `packages/passkey/src/Passkey.ts`, `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/test/Passkey.test.ts`, `packages/passkey/test/AuthHttp.test.ts`, `spec/behaviors/17-passkey.md`, `features/features/05-authentication-methods/17-passkey.feature`

Tests (write first):
- packages/passkey/test/Passkey.test.ts: 'TC-001: authenticateOptions for an unknown email returns non-empty, deterministic allowCredentials shaped like a known user's' — call twice for the same unknown email, assert identical non-empty ids; compare shape with a known user's (fails today: []).

Acceptance:
- An observer cannot distinguish registered from unregistered emails by allowCredentials presence, count stability, or shape.
- Decoys are stable across calls for the same email.

Spec refs: BEH-EA-136, BEH-EA-131 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### TSS-004 — Passkey authenticateVerify early-returns for unknown credential IDs before any signature work

`medium` · `security` · `passkey` · [.issues/medium/TSS-004-timing-side-channel-specialist.md](../../.issues/medium/TSS-004-timing-side-channel-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence medium

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:761` — unknown ids return before any signature work

```ts
          const storedOpt = yield* credentials.findById(input.credential.id);
          if (Option.isNone(storedOpt)) {
            return yield* Effect.fail(new Api.InvalidCredentials());
          }
          const stored = storedOpt.value;

          const verified = yield* webAuthn
            .verifyAuthentication({
```

- `spec/behaviors/17-passkey.md:158`

```text
REQUIREMENT: Every distinct passkey ceremony failure MUST be its own typed
             `Schema.TaggedError`; the failure MUST NOT be collapsed into a
             single generic error whose message varies with the internal
             cause, and an unknown-credential failure MUST NOT reveal whether
             any credential was registered for the supplied user identifier.
```

**Fix plan** — Equalize cost on the unknown-credential path with a decoy verification, mirroring Password's dummyHash.

Steps:
1. packages/passkey/src/Passkey.ts: at layer build, create a decoy stored credential — a fixed COSE-encoded P-256 public key constant (generate once offline; store as a base64url string constant with a comment) with counter 0.
2. On `Option.isNone(storedOpt)`: run `webAuthn.verifyAuthentication({ ..., credential: decoy })` and ignore its result (Effect.exit), then fail InvalidCredentials. Comment citing Password.ts dummyHash.
3. Also move the users.findById/liveness work so both branches do the same number of DB round trips where feasible.

Files: `packages/passkey/src/Passkey.ts`, `packages/passkey/test/Passkey.test.ts`

Tests (write first):
- packages/passkey/test/Passkey.test.ts: 'TSS-004: an unknown credential id still invokes WebAuthn.verifyAuthentication' — use a spy port counting calls (fails today: 0 calls).

Acceptance:
- Unknown-credential and bad-signature paths both perform one signature verification before failing InvalidCredentials.

Spec refs: BEH-EA-136 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### CB-006 — authenticateOptions leaks account existence via allowCredentials population

`low` · `security` · `passkey` · [.issues/low/CB-006-christiaan-brand.md](../../.issues/low/CB-006-christiaan-brand.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **TC-001** — confidence high

**Assessment:** Same allowCredentials existence oracle.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:723` — known email ⇒ real credential ids; unknown ⇒ []

```ts
          if (email !== undefined) {
            const userOpt = yield* users.findByEmail(email);
            if (Option.isSome(userOpt)) {
              const owned = yield* credentials.listByUser(userOpt.value.id);
              allowCredentials = owned.map((row) => ({ id: row.id, transports: row.transports }));
            }
          }
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

#### WPS-007 — Public authenticateOptions leaks account existence via allowCredentials

`low` · `security` · `passkey` · [.issues/low/WPS-007-webauthn-passkeys-specialist.md](../../.issues/low/WPS-007-webauthn-passkeys-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE of **TC-001** — confidence high

**Assessment:** Same allowCredentials existence oracle.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:723` — known email ⇒ real credential ids; unknown ⇒ []

```ts
          if (email !== undefined) {
            const userOpt = yield* users.findByEmail(email);
            if (Option.isSome(userOpt)) {
              const owned = yield* credentials.listByUser(userOpt.value.id);
              allowCredentials = owned.map((row) => ({ id: row.id, transports: row.transports }));
            }
          }
```

**Fix plan:** none — closed as duplicate; see canonical issue.

**Recommended status:** `resolved`

### Workstream `passkey-ceremony-policy`

#### BPAS-005 — Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX

`medium` · `dx` · `passkey` · [.issues/medium/BPAS-005-biometric-platform-authenticator-specialist.md](../../.issues/medium/BPAS-005-biometric-platform-authenticator-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (commit `1f2df3a`) — confidence high

**Assessment:** Fixed by CB-001 (1f2df3a): the ordinary path now rejects UV=0 only when config.authenticatorSelection.userVerification === "required"; Passkey.test.ts has 'CB-001: register/verify via the ordinary scope accepts UV=0 under the default "preferred" policy'.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:662` — CB-001 fix (1f2df3a): UV enforced on the ordinary path only when config says "required"

```ts
          let enforceUserVerification =
            consumedOrdinary && config.authenticatorSelection.userVerification === "required";
          if (!consumedOrdinary) {
            const consumedConditional = yield* challengeStore.consume(
              conditionalScope(sessionId),
              clientData.challenge,
            );
```

**Fix plan:** none — already fixed.

**Recommended status:** `resolved`

#### CB-003 — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies

`medium` · `security` · `passkey` · [.issues/medium/CB-003-christiaan-brand.md](../../.issues/medium/CB-003-christiaan-brand.md) · current status `needs-triage`

**Verdict:** PARTIAL — confidence high

**Assessment:** PARTIAL: the audit's 'SimpleWebAuthn contains no crossOrigin check' is wrong for authentication (v14.0.1 rejects cross-origin assertions that carry topOrigin, i.e. Chromium). Still real: registration and reauthentication have no cross-origin check anywhere, and cross-origin authentication without topOrigin (Safari) is accepted.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:113` — crossOrigin/topOrigin never read by the plugin

```ts
const ClientDataSchema = Schema.Struct({
  type: Schema.String,
  challenge: Schema.String,
  origin: Schema.String,
});
```

- `node_modules/.pnpm/@simplewebauthn+server@14.0.1/node_modules/@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.js:75` — authentication DOES reject crossOrigin when topOrigin is present (expectedTopOrigin is never passed) — only topOrigin-less (Safari) cross-origin assertions pass; verifyRegistrationResponse.js has no crossOrigin check at all

```js
    if (crossOrigin) {
        /**
         * TODO: Since Safari doesn't support `topOrigin` as of May 2026, only check this when
         * `topOrigin` is available for now.
         */
        if (topOrigin) {
            if (!expectedTopOrigin) {
```

**Fix plan** — Reject cross-origin ceremonies in the plugin pre-check for all three ceremonies unless an explicit embedded-origin policy is configured.

Steps:
1. packages/passkey/src/Passkey.ts: extend ClientDataSchema with `crossOrigin: Schema.optional(Schema.Boolean)` and `topOrigin: Schema.optional(Schema.String)`.
2. Add `PasskeyConfigShape.allowedTopOrigins: ReadonlyArray<string>` (default []); a shared `checkCrossOrigin(clientData)` fails `PasskeyOriginMismatch` (register/reauth) when crossOrigin is true and topOrigin is absent or not in allowedTopOrigins.
3. authenticateVerify: run the same check and collapse to Api.InvalidCredentials (BEH-EA-136 posture); also pass `expectedTopOrigin` through the port when allowedTopOrigins is non-empty (add to VerifyAuthenticationInput/VerifyRegistrationInput).
4. Amend BEH-EA-133 to cover crossOrigin.

Files: `packages/passkey/src/Passkey.ts`, `packages/ports/src/WebAuthn.ts`, `packages/passkey/test/Passkey.test.ts`, `spec/behaviors/17-passkey.md`

Tests (write first):
- packages/passkey/test/Passkey.test.ts: 'CB-003: register/verify rejects clientData with crossOrigin:true' (fails today) and 'authenticate/verify rejects crossOrigin:true without topOrigin as InvalidCredentials'.

Acceptance:
- Every ceremony rejects crossOrigin=true unless its topOrigin is explicitly allowed.

Spec refs: BEH-EA-133, BEH-EA-136 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### MNA-007 — Passkey origin validation rejects Android-native assertions

`medium` · `correctness` · `passkey` · [.issues/medium/MNA-007-mobile-native-auth-specialist.md](../../.issues/medium/MNA-007-mobile-native-auth-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL — confidence high

**Assessment:** PARTIAL: the headline 'every native Android passkey sign-in fails as InvalidCredentials' is wrong — authenticateVerify never calls originMatchesRpId (git log -S shows it was never there), so an android:apk-key-hash origin listed in `origins` passes sign-in. Registration and step-up reauthentication do reject Android-native origins (PasskeyRpIdMismatch), which is still a real gap.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:146` — `new URL("android:apk-key-hash:…").hostname` is "" (verified with node) ⇒ false

```ts
const originMatchesRpId = (origin: string, rpId: string): boolean => {
  try {
    const host = new URL(origin).hostname;
    return host === rpId || host.endsWith(`.${rpId}`);
  } catch {
    return false;
  }
};
```

- `packages/passkey/src/Passkey.ts:648` — used by registerVerify (645-650) and reauthenticateVerify (914-919) only — authenticateVerify (742-783) has no plugin origin pre-check and relies on SimpleWebAuthn's exact expectedOrigin match

```ts
          if (!originMatchesRpId(clientData.origin, config.rpId)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyRpIdMismatch());
          }
```

**Fix plan** — Treat configured platform (android:apk-key-hash:) origins as exact-match origins exempt from the web rpId-suffix check, consistently across all ceremonies.

Steps:
1. packages/passkey/src/Passkey.ts: replace originMatchesRpId with `originAcceptable(origin, config)`: web origins (http/https) → existing registrable-suffix check; `android:apk-key-hash:` origins → accepted only if exactly present in config.origins (rpId binding is still enforced by the library via rpIdHash).
2. PasskeyConfigShape.origins doc: document android:apk-key-hash:<base64url sha256 of signing cert> entries and Digital Asset Links / Associated Domains setup in README.
3. Apply the same pre-check in authenticateVerify (collapsing to InvalidCredentials) so all three ceremonies share one origin policy (BEH-EA-133).

Files: `packages/passkey/src/Passkey.ts`, `packages/passkey/test/Passkey.test.ts`, `packages/passkey/README.md`, `spec/behaviors/17-passkey.md`

Tests (write first):
- packages/passkey/test/Passkey.test.ts: 'MNA-007: register/verify accepts a configured android:apk-key-hash origin' (fails today: PasskeyRpIdMismatch) and 'rejects an unconfigured android origin'.

Acceptance:
- A configured Android APK-hash origin completes registration, sign-in and reauthentication; an unconfigured one is rejected.

Spec refs: BEH-EA-133 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### TC-003 — No ceremony timeout knob; browser ceremony lifetime and server challenge TTL are unaligned

`medium` · `api` · `passkey` · [.issues/medium/TC-003-tim-cappalli.md](../../.issues/medium/TC-003-tim-cappalli.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Assessment:** Confirmed. Note BEH-EA-132 deliberately fixes the TTL at five minutes, so the fix aligns the client timeout to the TTL (configurable ≤ TTL) rather than making the TTL configurable.

**Evidence at HEAD**

- `packages/passkey/src/ChallengeStore.ts:55` — server-side window (spec-fixed at 5 min by BEH-EA-132)

```ts
/** BEH-EA-132: five minutes, non-configurable — the one value the behavior itself fixes. */
const TTL = Duration.minutes(5);
```

- `packages/ports/src/WebAuthn.ts:88` — no timeout/hints/extensions on RegistrationOptionsInput (88-100) nor AuthenticationOptionsInput (121-128)

```ts
export interface RegistrationOptionsInput {
  readonly rpId: string;
  readonly rpName: string;
  /** Base64url-encoded raw challenge bytes — see this module's own header comment. */
  readonly challenge: string;
```

- `node_modules/.pnpm/@simplewebauthn+server@14.0.1/node_modules/@simplewebauthn/server/esm/registration/generateRegistrationOptions.js:51` — browser ceremony silently runs on the library's 60s default while the challenge stays valid 5 min

```js
    const { rpName, rpID, userName, userID, challenge = await generateChallenge(), userDisplayName = '', timeout = 60000, attestationType = 'none', excludeCredentials = [], authenticatorSelection = defaultAuthenticatorSelection, extensions, supportedAlgorithmIDs = defaultSupportedAlgorithmIDs, preferredAuthenticatorType, } = options;
```

**Fix plan** — Expose ceremony timeout (≤ challenge TTL), hints and extension passthrough on the port and PasskeyConfig; set them explicitly in every options generator.

Steps:
1. packages/ports/src/WebAuthn.ts: add `timeout?: Duration.Duration`, `hints?: ReadonlyArray<"security-key" | "client-device" | "hybrid">`, `extensions?: { credProps?: boolean; ... }` to RegistrationOptionsInput and `timeout`/`hints`/`extensions` to AuthenticationOptionsInput; map to generate*Options (`timeout: Duration.toMillis`, `preferredAuthenticatorType`/hints, `extensions`).
2. packages/passkey/src/ChallengeStore.ts: export `CHALLENGE_TTL`.
3. packages/passkey/src/Passkey.ts PasskeyConfigShape: `ceremonyTimeout: Duration.Duration` (default = CHALLENGE_TTL minus a small skew, e.g. 4m30s), `hints?`, `extensions?` (default `{ credProps: true }` on registration); `config()` dies (Effect.die at layer build via a validation step in `make`) if ceremonyTimeout > CHALLENGE_TTL.
4. Pass these in registerOptions, registerOptionsConditional, authenticateOptions, reauthenticateOptions.
5. Document the pairing in README (TC-007) and in BEH-EA-132's rationale.

Files: `packages/ports/src/WebAuthn.ts`, `packages/ports/test/WebAuthn.test.ts`, `packages/passkey/src/ChallengeStore.ts`, `packages/passkey/src/Passkey.ts`, `packages/passkey/test/Passkey.test.ts`, `spec/behaviors/17-passkey.md`

Tests (write first):
- packages/ports/test/WebAuthn.test.ts: 'TC-003: registrationOptions/authenticationOptions echo the requested timeout and hints'.
- packages/passkey/test/Passkey.test.ts: 'TC-003: every options response carries timeout <= the challenge TTL' (fails today: 60000 from the library default is not what the plugin chose; assert equals config).

Acceptance:
- All four options endpoints emit an explicit timeout equal to config.ceremonyTimeout, never above the 5-minute TTL.
- Hints/extensions configured on PasskeyConfig reach the emitted options.

Spec refs: BEH-EA-132, BEH-EA-130, BEH-EA-131 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### CB-009 — Conditional-create UV exemption is keyed by challenge scope, not by ceremony eligibility

`low` · `security` · `passkey` · [.issues/low/CB-009-christiaan-brand.md](../../.issues/low/CB-009-christiaan-brand.md) · current status `needs-triage`

**Verdict:** PARTIAL — confidence high

**Assessment:** PARTIAL: CB-001's fix (1f2df3a) removed the 'two endpoints enforce opposite UV policies from one config value' half for "preferred"/"discouraged" (both now accept UV=0). What remains: under userVerification "required", any authenticated caller can still enrol a UV-less credential by choosing the conditional endpoint.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:662` — CB-001 fix (1f2df3a): UV enforced on the ordinary path only when config says "required"

```ts
          let enforceUserVerification =
            consumedOrdinary && config.authenticatorSelection.userVerification === "required";
          if (!consumedOrdinary) {
            const consumedConditional = yield* challengeStore.consume(
              conditionalScope(sessionId),
              clientData.challenge,
            );
```

- `packages/passkey/src/Passkey.ts:672` — the conditional scope still exempts UV unconditionally, even when config says "required"

```ts
            enforceUserVerification = false;
```

**Fix plan** — Make the conditional exemption policy-driven: conditional create is unavailable when the RP requires UV.

Steps:
1. packages/passkey/src/Passkey.ts registerOptionsConditional: fail PasskeyConditionalCreateDisabled when `config.authenticatorSelection.userVerification === "required"` (Chrome's conditional create cannot produce UV=1).
2. registerVerify (with WPS-003's explicit ceremony): enforce UV for conditional too when config is "required" (defense in depth), so the exemption can never outlive the policy.
3. Document in PasskeyConfig (conditionalCreate is implicitly disabled under required UV).

Files: `packages/passkey/src/Passkey.ts`, `packages/passkey/test/Passkey.test.ts`, `spec/behaviors/17-passkey.md`

Tests (write first):
- packages/passkey/test/Passkey.test.ts: 'CB-009: with userVerification required, registerOptionsConditional answers PasskeyConditionalCreateDisabled' (fails today: options issued).

Acceptance:
- Under a "required" UV policy no code path persists a credential with userVerified=false.

Spec refs: BEH-EA-130 · Effort: **S** · Depends on: WPS-003

**Recommended status:** `ready-for-agent`

#### HSK-007 — Conditional Create hardcodes residentKey:"required", silently excluding CTAP1-only and older-CTAP2 hardware keys

`low` · `dx` · `passkey` · [.issues/low/HSK-007-hardware-security-key-specialist.md](../../.issues/low/HSK-007-hardware-security-key-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Assessment:** Intentional behavior (Chrome autofill needs discoverable credentials); the gap is the missing documentation.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:628` — hard override; the conditionalCreate doc (Passkey.ts:56-57) says nothing about CTAP2/discoverable-credential requirements

```ts
            authenticatorSelection: {
              ...config.authenticatorSelection,
              residentKey: "required",
              userVerification: "discouraged",
            },
```

**Fix plan** — Document the discoverable-credential (CTAP2.1+ / platform) requirement of the conditional ceremony.

Steps:
1. packages/passkey/src/Passkey.ts: expand the `conditionalCreate` doc comment and PasskeyApi.PasskeyConditionalCreateDisabled doc: conditional create always requests residentKey "required"; U2F-only/early-CTAP2 security keys cannot complete it; fleets of such keys should set conditionalCreate:false.
2. README (TC-007) states the same.

Files: `packages/passkey/src/Passkey.ts`, `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/README.md`

Tests (write first):
- Docs-only.

Acceptance:
- conditionalCreate's doc names the discoverable-credential requirement and the opt-out.

Spec refs: — · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### TC-005 — userVerification:'discouraged' config is silently unenforceable for ordinary registration

`low` · `correctness` · `passkey` · [.issues/low/TC-005-tim-cappalli.md](../../.issues/low/TC-005-tim-cappalli.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (commit `1f2df3a`) — confidence high

**Assessment:** Same CB-001 fix: 'discouraged' no longer triggers UV enforcement on the ordinary path.

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:662` — CB-001 fix (1f2df3a): UV enforced on the ordinary path only when config says "required"

```ts
          let enforceUserVerification =
            consumedOrdinary && config.authenticatorSelection.userVerification === "required";
          if (!consumedOrdinary) {
            const consumedConditional = yield* challengeStore.consume(
              conditionalScope(sessionId),
              clientData.challenge,
            );
```

**Fix plan:** none — already fixed.

**Recommended status:** `resolved`

### Workstream `passkey-wire-contract`

#### AVS-003 — Untyped `Schema.Unknown` success contracts on passkey register-options endpoints

`medium` · `api` · `passkey` · [.issues/medium/AVS-003-api-design-versioning-specialist.md](../../.issues/medium/AVS-003-api-design-versioning-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Assessment:** Confirmed. The Unknown is a documented choice in PasskeyApi.ts's header (20-25), but no wayfinder decision fixes it; product value (typed generated clients) wins.

**Evidence at HEAD**

- `packages/passkey/src/PasskeyApi.ts:232` — also registerOptionsConditional (240), reauthenticateOptions (337) and AuthenticateOptionsResult.options (189)

```ts
    HttpApiEndpoint.post("registerOptions", "/passkey/register/options", {
      success: Schema.Unknown,
      // Ticket 15: gated behind the same freshness check as `registerVerify`.
      error: PasskeyReauthRequired,
    }),
```

- `packages/client/src/passkey/PasskeyClient.ts:120` — the client already has to hand-guard the untyped contract

```ts
const isCreationOptionsJSON = (value: unknown): value is PublicKeyCredentialCreationOptionsJSON =>
  Predicate.isReadonlyObject(value) &&
  Predicate.hasProperty(value, "challenge") &&
  Predicate.hasProperty(value, "rp") &&
```

**Fix plan** — Model the WebAuthn options dictionaries as Schemas in the contract and use them as success types.

Steps:
1. packages/passkey/src/PasskeyApi.ts: `PublicKeyCredentialCreationOptionsSchema` and `PublicKeyCredentialRequestOptionsSchema` mirroring the WebAuthn L3 JSON dictionaries (rp, user{id,name,displayName}, challenge, pubKeyCredParams, timeout?, excludeCredentials?, authenticatorSelection?, attestation?, hints?, extensions as Schema.Record(Schema.String, Schema.Unknown)) — use StructWithRest/records so unknown future members are preserved, not stripped.
2. Use them as `success` for registerOptions/registerOptionsConditional/reauthenticateOptions and inside AuthenticateOptionsResult; PasskeyShape return types follow (the port already returns @simplewebauthn's typed JSON — decode/encode, no casts).
3. packages/client: delete isCreationOptionsJSON/isRequestOptionsJSON guards; pass typed options straight to startRegistration/startAuthentication (verify structural compatibility at the type level).

Files: `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/src/Passkey.ts`, `packages/client/src/passkey/PasskeyClient.ts`, `packages/passkey/test/AuthHttp.test.ts`

Tests (write first):
- packages/passkey/test/AuthHttp.test.ts: 'AVS-003: the OpenAPI document declares a structured schema for /passkey/register/options' (fails today: {} any).

Acceptance:
- No passkey endpoint declares Schema.Unknown as success.
- The client compiles without runtime shape guards.

Spec refs: BEH-EA-130, BEH-EA-131 · Effort: **M** · Depends on: —

**Recommended status:** `ready-for-agent`

#### HSK-003 — Browser-reported transports are dropped at the API boundary, so the transports column is usually empty

`medium` · `dx` · `passkey` · [.issues/medium/HSK-003-hardware-security-key-specialist.md](../../.issues/medium/HSK-003-hardware-security-key-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/passkey/src/PasskeyApi.ts:141` — no transports

```ts
export const AttestationResponseSchema = Schema.Struct({
  clientDataJSON: Schema.String,
  attestationObject: Schema.String,
});
```

- `packages/passkey/src/Passkey.ts:158` — not forwarded to verifyRegistrationResponse; the client strips it too (PasskeyClient.ts:147-150); port falls back to `?? []` (WebAuthn.ts:227)

```ts
  id: input.id,
  rawId: input.rawId,
  response: {
    clientDataJSON: input.response.clientDataJSON,
    attestationObject: input.response.attestationObject,
  },
```

**Fix plan** — Carry browser-reported transports end-to-end and surface transports/aaguid in the credential DTO.

Steps:
1. PasskeyApi.ts AttestationResponseSchema: `transports: Schema.optional(Schema.Array(Schema.Literals(["ble","cable","hybrid","internal","nfc","smart-card","usb"])))`.
2. Passkey.ts toRegistrationResponseJSON: forward `transports` when present.
3. packages/client/src/passkey/PasskeyClient.ts toRegistrationCredentialInput: include `credential.response.transports`.
4. PasskeyCredentialDto: add `transports` and `aaguid` (and toCredentialDto).

Files: `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/src/Passkey.ts`, `packages/client/src/passkey/PasskeyClient.ts`, `packages/passkey/test/Passkey.test.ts`, `packages/passkey/test/AuthHttp.test.ts`, `packages/client/test/PasskeyClient.test.ts`

Tests (write first):
- packages/passkey/test (real port): 'HSK-003: a registration posting transports ["usb","nfc"] persists them and echoes them in excludeCredentials' (fails today: []).

Acceptance:
- Stored transports equal what the browser reported; list DTO shows transports and aaguid.

Spec refs: BEH-EA-130 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### AVS-006 — Two spellings of the DELETE verb and four id conventions for destructive endpoints

`low` · `api` · `passkey` · [.issues/low/AVS-006-api-design-versioning-specialist.md](../../.issues/low/AVS-006-api-design-versioning-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Assessment:** Passkey half is in this slice; organization/account id naming is cross-slice.

**Evidence at HEAD**

- `packages/passkey/src/PasskeyApi.ts:310` — only use of make("DELETE"); everywhere else uses HttpApiEndpoint.delete (api/Account.ts:34, OrganizationApi.ts:466/486/644/699/736)

```ts
    HttpApiEndpoint.make("DELETE")("remove", "/passkey/credentials/:id", {
```

**Fix plan** — Use HttpApiEndpoint.delete and a resource-action id for the passkey credential delete.

Steps:
1. packages/passkey/src/PasskeyApi.ts: `HttpApiEndpoint.delete("removeCredential", "/passkey/credentials/:id", …)`; rename sibling ids to `listCredentials`/`renameCredential` for one scheme.
2. Update Passkey.ts handlers (handleAll keys) and packages/client PasskeyClient.ts calls.
3. Coordinate the cross-package id convention with the organization/account slices (AVS-006 orchestrator note).

Files: `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/src/Passkey.ts`, `packages/client/src/passkey/PasskeyClient.ts`, `packages/passkey/test/AuthHttp.test.ts`

Tests (write first):
- Typecheck is the test: renaming the endpoint id breaks every stale handler/client reference; AuthHttp DELETE test stays green.

Acceptance:
- No `make("DELETE")` remains; the passkey group uses one id scheme.

Spec refs: — · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### HSK-008 — No test coverage for direct/enterprise attestation, transports, or cross-platform attachment

`low` · `testing` · `passkey` · [.issues/low/HSK-008-hardware-security-key-specialist.md](../../.issues/low/HSK-008-hardware-security-key-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence medium

**Assessment:** Confirmed; storage-level tests do use transports ["internal"] (PasskeyCredentials.test.ts:50) but nothing exercises propagation, AAGUID labelling, packed attestation or authenticatorAttachment.

**Evidence at HEAD**

- `packages/passkey/test/passkeyTestFixtures.ts:60` — plugin tests mock the port with zero AAGUID and empty transports

```ts
    verifyRegistration: () =>
      Effect.succeed({
        credentialId: "cred-mock-1",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        aaguid: "00000000-0000-0000-0000-000000000000",
        transports: [],
```

- `packages/ports/test/webauthnFixtures.ts:120` — real-crypto port fixtures build only 'none' attestation

```ts
  map.set("fmt", "none");
```

**Fix plan** — Add real-shaped fixtures (packed self-attestation, non-zero AAGUID, transports) and end-to-end plugin tests over the real port.

Steps:
1. packages/ports/test/webauthnFixtures.ts: `buildPackedSelfAttestation` (sign authData||clientDataHash with the credential key, fmt "packed", alg -7) and parameters for aaguid/transports.
2. packages/ports/test/WebAuthn.test.ts: verifyRegistration returns the fixture AAGUID and (with HSK-003) transports; options echo excludeCredentials transports.
3. packages/passkey/test: one test composing Passkey.layer with WebAuthn.layerSimpleWebAuthn (not the mock) — register with AAGUID ea9b8d66-… ⇒ credential named "Google Password Manager", transports persisted; authenticate with a non-zero counter updates recordUsage.

Files: `packages/ports/test/webauthnFixtures.ts`, `packages/ports/test/WebAuthn.test.ts`, `packages/passkey/test/PasskeyRealPort.test.ts`

Tests (write first):
- The new tests themselves; mutation-check by blanking aaguid mapping in the port.

Acceptance:
- At least one plugin test runs the real port with packed attestation, a named AAGUID, transports and a non-zero counter.

Spec refs: BEH-EA-130, BEH-EA-135 · Effort: **M** · Depends on: HSK-003

**Recommended status:** `ready-for-agent`

#### WPS-010 — Credential create has no duplicate-id guard and the two layers diverge on collision

`low` · `correctness` · `passkey` · [.issues/low/WPS-010-webauthn-passkeys-specialist.md](../../.issues/low/WPS-010-webauthn-passkeys-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/passkey/src/PasskeyCredentials.ts:104` — memory silently overwrites (re-owns) an existing id

```ts
    const create: PasskeyCredentialsShape["create"] = Effect.fnUntraced(function* (input) {
      const now = yield* DateTime.now;
      const record: PasskeyCredentialRecord = { ...input, createdAt: now, lastUsedAt: now };
      yield* Ref.update(state, (s) => HashMap.set(s, record.id, record));
      return record;
    });
```

- `packages/passkey/src/PasskeyCredentials.ts:251` — SQL plain INSERT ⇒ PK violation ⇒ `.pipe(Effect.orDie)` at :324 ⇒ 500 defect

```ts
      execute: (r) => sql`
        INSERT INTO passkey_credential
          (id, userId, webauthnUserId, publicKey, counter, deviceType, backedUp, transports, aaguid, name, createdAt, lastUsedAt)
```

**Fix plan** — Make create collision-aware and identical across layers with a typed error.

Steps:
1. PasskeyCredentials.ts: `PasskeyCredentialAlreadyExists` (Data.TaggedError); create's error channel gains it.
2. layerMemory: fail if HashMap.has(s, id) inside Ref.modify.
3. layerSql: `INSERT ... ON CONFLICT(id) DO NOTHING RETURNING *` via SqlSchema.findOneOption; None ⇒ fail typed error.
4. Passkey.ts registerVerify: map to a new `PasskeyAlreadyRegistered` API error (409) in the registerVerify error union (registerVerify is authenticated; no enumeration concern), and don't link Accounts in that case.

Files: `packages/passkey/src/PasskeyCredentials.ts`, `packages/passkey/src/PasskeyApi.ts`, `packages/passkey/src/Passkey.ts`, `packages/passkey/test/PasskeyCredentials.test.ts`, `packages/passkey/test/Passkey.test.ts`

Tests (write first):
- packages/passkey/test/PasskeyCredentials.test.ts (both layers): 'WPS-010: creating an existing credential id fails PasskeyCredentialAlreadyExists and leaves the original owner intact' (fails today: memory overwrites, sql dies).

Acceptance:
- Both layers refuse a duplicate id identically; registerVerify answers 409.

Spec refs: BEH-EA-130 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `admin-surface-expansion`

#### BAM-005 — Admin plugin is impersonation-only versus better-auth's 14-capability admin surface

`high` · `api` · `admin` · [.issues/high/BAM-005-better-auth-migration-specialist.md](../../.issues/high/BAM-005-better-auth-migration-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED — confidence high

**Assessment:** Decision already made: wayfinder ticket 19 (resolved) — grow packages/admin with user CRUD, session administration and a core-level `banned` gate; setRole explicitly scoped out per ADR-EA-009. Nothing of it is implemented at HEAD.

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:368` — AdminShape (73-108) still exposes exactly four impersonation operations

```ts
      return Admin.of({ impersonate, stopImpersonating, forceStop, list });
```

- `packages/core/src/Users.ts:51` — no banned/bannedReason/bannedUntil (fields end at updatedAt, line 67); grep for banned/listUsers/canManageUsers in core/admin src is empty

```ts
export interface UserRecord {
  readonly id: UserId;
  /** BEH-EA-041: always the lower-cased form of whatever email was given. */
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
```

**Fix plan** — Implement ticket 19 §1: fail-closed per-capability predicates, user/session admin endpoints, and a core-level ban gate at every sign-in call site.

Steps:
1. packages/admin/src/Admin.ts AdminConfigShape: add `canManageUsers`, `canBanUsers` (and `canAdministerTenants`, used by EP-003) — each `(subject: AuthSubject) => Effect.Effect<boolean>`, default `() => Effect.succeed(false)`.
2. packages/core/src/Users.ts + packages/sql (UserModel, CoreMigrations): add `banned: boolean` (default false), `bannedReason: Option<string>`, `bannedUntil: Option<DateTime.Utc>`; new forward migration; `Users.setBan(id, { reason, until })`/`clearBan(id)`; `Users.list(cursor, limit)` keyset page (BEH-EA-036).
3. packages/core: new typed error `UserBanned` (httpApiStatus 403) in @awthaq/api; check it in exactly the sign-in call sites that precede sessions.issue: password signIn, passkey authenticateVerify (right after the users.findById at Passkey.ts:818), oauth callback, magic-link when it lands — NOT inside Users.findById (admin must still resolve banned users). Also revokeAll on ban.
4. packages/admin/src/AdminApi.ts: new endpoints behind the same Authentication+Csrf middleware — listUsers (GET /admin/users?cursor&limit), getUser (GET /admin/users/:userId), updateUser (PATCH), banUser/unbanUser (POST /admin/users/:userId/ban|unban), listUserSessions (GET /admin/users/:userId/sessions), revokeUserSession (DELETE /admin/users/:userId/sessions/:sessionId), revokeUserSessions (DELETE .../sessions), deleteUser (DELETE /admin/users/:userId — calls Users.delete so BeforeUserDelete erasure taps run), setUserPassword/setUserEmail (via core/password services).
5. Each handler gates on its predicate and publishes a new admin event (`auth.admin.userBanned`, `auth.admin.userUpdated`, `auth.admin.sessionRevoked`, ...) added to AuthEvents (durably audited by AuditLog).
6. packages/admin/README.md: document that setRole is a qadi-application concern (ticket 19 §2).
7. spec: new behavior file section(s) under spec/behaviors/27-admin-impersonation.md (or a new 28-admin-users.md) with new BEH-EA ids (next free after BEH-EA-220 — coordinate with orchestrator), plus traceability rows; features: new feature scenarios for ban-blocks-sign-in and admin session revocation.

Files: `packages/admin/src/Admin.ts`, `packages/admin/src/AdminApi.ts`, `packages/core/src/Users.ts`, `packages/core/src/AuthEvents.ts`, `packages/core/src/AuditLog.ts`, `packages/sql/src/Models.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/sql/src/Repositories.ts`, `packages/api/src/Api.ts`, `packages/password/src/Password.ts`, `packages/passkey/src/Passkey.ts`, `packages/oauth/src/OAuth.ts`, `packages/admin/README.md`, `spec/behaviors/27-admin-impersonation.md`, `spec/traceability.md`

Tests (write first):
- packages/admin/test/Admin.test.ts: 'BAM-005: banUser is fail-closed by default' then 'a banned user cannot sign in with password/passkey/oauth (UserBanned) and all their sessions are revoked' — write first, fails (no API).
- packages/core/test/Users.test.ts (both layers): ban fields round-trip; list pages with a keyset cursor.
- BDD: 'an administrator bans an abusive account' scenario.

Acceptance:
- Every new admin capability denies by default and is gated by its own predicate.
- A banned user is refused at every sign-in path with UserBanned, while getUser/unbanUser still resolve them.
- No setRole endpoint exists; README states why.

Spec refs: BEH-EA-212, BEH-EA-036, BEH-EA-101 · Effort: **XL** · Depends on: —

**Recommended status:** `ready-for-agent`

#### EP-003 — Admin surface is impersonation-only; no user lifecycle or tenant administration

`high` · `api` · `admin` · [.issues/high/EP-003-eugenio-pace.md](../../.issues/high/EP-003-eugenio-pace.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED — confidence high

**Assessment:** Same ticket-19 decision as BAM-005, plus its tenant-administration slice (superadmin-only listOrganizations/getOrganization/suspendOrganization) built on ticket 18's organization-as-tenant model, shipped as an optional Admin.layerWithTenants variant.

**Evidence at HEAD**

- `packages/admin/src/AdminApi.ts:82` — the group still has only impersonate/stopImpersonating/forceStop/list (82-116)

```ts
export const AdminGroup = HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.post("impersonate", "/admin/impersonate/:userId", {
```

- `packages/admin/src/Admin.ts:48` — fail-closed default confirmed

```ts
  canImpersonate: () => Effect.succeed(false),
```

**Fix plan** — Implement ticket 19 §3: an optional superadmin tenant-administration sub-surface on top of BAM-005's user/session admin.

Steps:
1. packages/organization: add `suspended: boolean` (+ `suspendedAt`) to organization_org via a forward migration; enforce it wherever membership gates access (OrganizationQadi/membership checks) with a typed `OrganizationSuspended` error.
2. packages/admin/src/AdminApi.ts: separate `AdminTenantsGroup` (listOrganizations, getOrganization, suspendOrganization, unsuspendOrganization) behind Authentication+Csrf, gated by `canAdministerTenants`.
3. packages/admin/src/Admin.ts: `Admin.layerWithTenants` = the base layer plus the tenants group, with `dependsOn: [Organization]` (only this variant) — `Admin.layer` stays Organization-free (mirrors Password.layer/layerNoReset variant pattern).
4. Publish `auth.admin.organizationSuspended`/`Unsuspended` events.
5. spec: new BEH ids for the tenant-admin slice; features scenario 'a superadmin suspends an organization and its members lose org-scoped access'.

Files: `packages/admin/src/Admin.ts`, `packages/admin/src/AdminApi.ts`, `packages/organization/src/Organization.ts`, `packages/organization/src/OrganizationRecords.ts`, `packages/core/src/AuthEvents.ts`, `spec/behaviors/27-admin-impersonation.md`

Tests (write first):
- packages/admin/test/AdminTenants.test.ts: 'EP-003: suspendOrganization is denied by default' and 'a suspended organization refuses member access'.

Acceptance:
- Admin.layer composes without Organization; Admin.layerWithTenants requires it and exposes the four tenant endpoints.
- Suspension is enforced by the organization plugin's access checks.

Spec refs: BEH-EA-212 · Effort: **L** · Depends on: BAM-005, DRS-001

**Recommended status:** `ready-for-agent`

### Workstream `admin-api-tier`

#### AR-003 — Admin API shares the public surface — no separate tier, scheme, or network boundary

`medium` · `architecture` · `admin` · [.issues/medium/AR-003-aeneas-rekkas.md](../../.issues/medium/AR-003-aeneas-rekkas.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence medium

**Evidence at HEAD**

- `packages/admin/src/AdminApi.ts:115` — same `auth` HttpApi id, same cookie Authentication as self-service groups

```ts
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

export const AdminApi = HttpApi.make("auth").add(AdminGroup);
```

- `packages/core/src/Auth.ts:417` — Auth.make merges every plugin group into one public HttpApi — no tier to serve separately

```ts
  return HttpApi.make("auth").add(firstGroup, ...restGroups);
```

**Fix plan** — Give admin groups a separable tier (own HttpApi + optional dedicated auth middleware), defaulting to today's co-hosted behavior.

Steps:
1. packages/core/src/AuthPlugin.ts: allow a plugin to declare `adminContract?: HttpApi` (or tag groups) in addition to `contract`.
2. packages/core/src/Auth.ts: build `adminApi` from all adminContract groups; keep `api` for public groups.
3. packages/server/src/AuthHttp.ts: `AuthHttp.layer({ admin: { mount: "same" | { prefix } | "separate" } })` — separate yields `AuthHttp.adminLayer` for the host to serve on another port.
4. packages/api/src/Api.ts: `AdminAuthentication` middleware tag (same provides CurrentPrincipal) with a default implementation that delegates to Authentication; admin groups use it so hosts can override (mTLS/service principal).
5. packages/admin/src/AdminApi.ts: move AdminGroup to adminContract and to AdminAuthentication.
6. spec: amend BEH-EA-071 note and add a BEH for the admin tier.

Files: `packages/core/src/AuthPlugin.ts`, `packages/core/src/Auth.ts`, `packages/server/src/AuthHttp.ts`, `packages/api/src/Api.ts`, `packages/admin/src/AdminApi.ts`, `packages/admin/test/AuthHttp.test.ts`, `spec/behaviors/09-authentication-middleware.md`

Tests (write first):
- packages/admin/test/AuthHttp.test.ts: 'AR-003: with admin mount "separate", /admin/* is 404 on the public layer and served by adminLayer'.

Acceptance:
- Default composition serves admin endpoints exactly as today.
- A host can serve admin endpoints on a separate layer/port and swap the admin authentication middleware without forking the contract.

Spec refs: BEH-EA-071, BEH-EA-072 · Effort: **L** · Depends on: —

**Needs decision:** yes — see *Decisions needed*.

**Recommended status:** `ready-for-human`

### Workstream `admin-audit-integrity`

#### ALF-005 — Zero tamper-evidence on the one durable audit table — history is rewritable by anyone with SQL access

`medium` · `security` · `admin` · [.issues/medium/ALF-005-audit-logging-forensics-specialist.md](../../.issues/medium/ALF-005-audit-logging-forensics-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence medium

**Evidence at HEAD**

- `packages/admin/src/ImpersonationRecords.ts:242` — application-level discipline only

```ts
      execute: (r) => sql`
          UPDATE admin_impersonation SET endedAt = ${r.endedAt}, endedBy = ${r.endedBy}
          WHERE sessionId = ${r.sessionId} AND endedAt IS NULL
          RETURNING *
        `,
```

- `packages/admin/src/Admin.ts:210` — no hash/prev-hash column, no trigger, no REVOKE — plain mutable table (AuditLog.ts has no chaining either)

```ts
          CREATE TABLE admin_impersonation (
            id TEXT PRIMARY KEY,
            adminUserId TEXT NOT NULL,
            targetUserId TEXT NOT NULL,
            sessionId TEXT NOT NULL,
            reason TEXT NOT NULL,
            startedAt TIMESTAMPTZ NOT NULL,
```

**Fix plan** — Ship DB-level immutability triggers plus a shared HMAC hash-chain for durable audit tables (admin_impersonation, audit_log).

Steps:
1. packages/core: new `AuditChain` helper (canonical row encoding + HMAC via Crypto, key from a required `AuditChainConfig` Context.Reference with a fail-loud default in production mode).
2. Migrations: add `prevHash TEXT`, `rowHash TEXT` to admin_impersonation (packages/admin/src/Admin.ts adminMigrations) and audit_log (packages/sql CoreMigrations); add triggers: reject DELETE; reject UPDATE of any column except endedAt/endedBy while endedAt IS NULL (admin) / any UPDATE (audit_log).
3. ImpersonationRecords.layerSql.create/endEpisode compute and store the chain within one transaction that reads the latest rowHash (`SELECT ... ORDER BY rowid DESC LIMIT 1 FOR UPDATE` on pg; sqlite is single-writer).
4. Expose `ImpersonationRecords.verifyChain` / `AuditLog.verifyChain` returning the first broken link.
5. spec: amend BEH-EA-215 and BEH-EA-100 with the tamper-evidence requirement.

Files: `packages/core/src/AuditLog.ts`, `packages/admin/src/ImpersonationRecords.ts`, `packages/admin/src/Admin.ts`, `packages/sql/src/CoreMigrations.ts`, `spec/behaviors/27-admin-impersonation.md`, `spec/behaviors/13-events.md`

Tests (write first):
- packages/admin/test/ImpersonationRecords.test.ts (sql layer): 'ALF-005: a raw UPDATE of reason is rejected by the trigger' and 'verifyChain detects a row rewritten with triggers disabled'.

Acceptance:
- Raw DELETE/illegal UPDATE on admin_impersonation fails at the database.
- verifyChain reports the exact first tampered row.

Spec refs: BEH-EA-215, BEH-EA-100 · Effort: **L** · Depends on: —

**Needs decision:** yes — see *Decisions needed*.

**Recommended status:** `ready-for-human`

### Workstream `jwt-act-claim`

#### JR-005 — Impersonation is full-authority identity assumption: no scoped-delegation primitive exists, and the act claim deviates from RFC 8693

`medium` · `architecture` · `admin` · [.issues/medium/JR-005-justin-richer.md](../../.issues/medium/JR-005-justin-richer.md) · current status `needs-triage`

**Verdict:** PARTIAL — confidence medium

**Assessment:** PARTIAL: the RFC 8693 `act` claim deviation is a concrete, fixable defect. The 'no scoped-delegation primitive' half is an architecture observation that contradicts no spec: BEH-EA-142 deliberately models impersonation as a static subject attribute for qadi policies to restrict — building a delegation grant would be speculative new infra with no consumer (not planned here; left for roadmap).

**Evidence at HEAD**

- `packages/admin/src/Admin.ts:290` — full-authority identity assumption — restriction is left to policies reading actingAs (BEH-EA-142, by design)

```ts
            actingAs: { type: caller.ref.type, id: caller.ref.id },
```

- `packages/jwt/src/Jwt.ts:136` — RFC 8693 §4.1 `act` must identify the actor with `sub`; `{type,id}` is unreadable to compliant verifiers

```ts
        sub: principal.ref.id,
        sid: principal.sessionId,
        ...(principal.actingAs !== undefined
          ? { act: { type: principal.actingAs.type, id: principal.actingAs.id } }
          : {}),
```

**Fix plan** — Emit an RFC 8693-compliant `act` claim (`act.sub`) while keeping type/id as private extensions.

Steps:
1. packages/jwt/src/Jwt.ts principalClaims: emit `act: { sub: principal.actingAs.id, awthaq_actor_type: principal.actingAs.type }` (keep a `typ`-style private member rather than `type`/`id` to avoid colliding with registered names).
2. packages/jwt/src/verify.ts (and any decoder of `act`): accept the new shape; decode with Schema.Struct({ sub: Schema.String, awthaq_actor_type: Schema.optional(Schema.String) }) — no type assertions.
3. Update the Jwt.ts doc comment (drop '-style') and spec/models/08-jwt-bearer.md / JWT BEH text if it shows the claim shape.
4. Document in packages/admin README that impersonation grants the target's full authority and that restriction is a qadi policy over `subject.attributes.actingAs` (BEH-EA-142).

Files: `packages/jwt/src/Jwt.ts`, `packages/jwt/src/verify.ts`, `packages/jwt/test/Jwt.test.ts`, `packages/admin/README.md`

Tests (write first):
- packages/jwt/test: 'JR-005: an impersonation session's minted JWT carries act.sub = admin id' (fails today: act has type/id only).

Acceptance:
- Minted JWTs for actingAs sessions carry `act.sub` equal to the admin's id; non-impersonation JWTs carry no `act`.

Spec refs: BEH-EA-142 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `session-assurance`

#### HSK-005 — Passkey sign-in emits no assurance signal, so a qadi-level 'hardware key required' policy is unimplementable

`medium` · `api` · `passkey` · [.issues/medium/HSK-005-hardware-security-key-specialist.md](../../.issues/medium/HSK-005-hardware-security-key-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:832` — UV flag, deviceType, aaguid, provider are all dropped at issuance

```ts
          const issued = yield* sessions.issue({ userId: stored.userId }).pipe(Effect.orDie);
```

- `packages/core/src/Sessions.ts:169` — no amr/assurance field; grep for amr/assurance/AAL across packages/*/src, spec and wayfinder tickets is empty

```ts
  readonly issue: (input: {
    readonly userId: UserId;
    readonly request?: { readonly ip?: string; readonly userAgent?: string };
    readonly supersedes?: SessionId;
    /** BEH-EA-209/210: sets a hard expiry (`idleExpiresAt = absoluteExpiresAt`) and disables idle-refresh for this session's whole lifetime. */
    readonly actingAs?: ActingAs;
```

**Fix plan** — Record per-session authentication assurance (amr + UV + credential facts) at issuance and expose it to qadi policies.

Steps:
1. packages/core/src/Sessions.ts: `AuthenticationRecord` type; `issue` input `authentication?: AuthenticationRecord`; persisted columns (`amr` JSON text, `userVerified`) via a CoreMigrations forward migration; exposed on SessionView/SessionListItem.
2. packages/api Principal: UserPrincipal gains `authentication` (optional); PrincipalResolver maps it.
3. Plugins set it: passkey authenticateVerify → methods ["hwk" when deviceType singleDevice else "swk", "user" when UV]; password → ["pwd"]; oauth → ["fed"]; Sessions.reauthenticate appends.
4. packages/roles / @awthaq/qadi SubjectResolver: copy into `subject.attributes.authentication` (documented key).
5. spec: new BEH for session assurance; update BEH-EA-131.

Files: `packages/core/src/Sessions.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/sql/src/Models.ts`, `packages/api/src/Api.ts`, `packages/server/src/Authentication.ts`, `packages/passkey/src/Passkey.ts`, `packages/password/src/Password.ts`, `packages/oauth/src/OAuth.ts`, `packages/qadi/src/SubjectResolver.ts`, `spec/behaviors/17-passkey.md`

Tests (write first):
- packages/passkey/test/Passkey.test.ts: 'HSK-005: a passkey sign-in session records amr and UV' (fails today).
- packages/qadi/test: a policy `attributes.authentication.methods includes "hwk"` allows a hardware-key session and denies a synced-passkey session.

Acceptance:
- Every session carries the methods that created it; a qadi policy can require a hardware-bound passkey.

Spec refs: BEH-EA-131 · Effort: **L** · Depends on: —

**Needs decision:** yes — see *Decisions needed*.

**Recommended status:** `ready-for-human`

### Workstream `plugin-contract-docs`

#### JH-007 — dependsOn de-facto governs only migration order while requirements go through RIn

`low` · `api` · `admin` · [.issues/low/JH-007-jared-hanson.md](../../.issues/low/JH-007-jared-hanson.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence medium

**Assessment:** The spec (BEH-EA-008 example) and the shipped convention disagree about what dependsOn is for; no check ties 'touches another plugin's tables' to 'declares dependsOn'.

**Evidence at HEAD**

- `spec/behaviors/01-plugin-contract.md:148` — BEH-EA-008's own example lists core services in dependsOn

```text
static readonly layer = AuthPlugin.layer(Password, {
  dependsOn: [Sessions, Users],
  make: Effect.gen(function*() { /* … */ }),
```

- `packages/admin/src/Admin.ts:4` — shipped convention: dependsOn is for other plugins only (also Passkey.ts:4-15, BEH-EA-212)

```ts
// `Auth.make([Admin])` composes: `dependsOn` is left unset on
// `AuthPlugin.layer` — `Sessions`/`Users`/`AuthEvents` are core domain
// services this plugin's own `make` Effect simply `yield*`s directly, the
```

- `packages/core/src/Auth.ts:355` — migration order follows dependsOn topology only; RIn is resolved independently

```ts
const renumberMigrations = (order: ReadonlyArray<AuthPlugin.Any>): Migrations => {
```

**Fix plan** — Align BEH-EA-008 with the shipped convention and make the plugin-to-plugin data dependency explicit where it matters.

Steps:
1. spec/behaviors/01-plugin-contract.md BEH-EA-008: replace the `dependsOn: [Sessions, Users]` example with a plugin-to-plugin example (e.g. ticket 19's `Admin.layerWithTenants` depending on `Organization`), and state explicitly: core services are reached by `yield*`; `dependsOn` is reserved for other plugins and is the sole source of migration order.
2. packages/core/src/AuthPlugin.ts / Auth.ts: add an optional `readsTables?: ReadonlyArray<string>` on the plugin class options; in Auth.make, fail composition (typed error, same family as the dependsOn-cycle error) when a plugin declares a table owned (via `tables`) by another installed plugin that it does not list in dependsOn.
3. Declare `readsTables` where it is real today (none in admin/passkey; Organization-dependent admin tenant slice will need it).

Files: `spec/behaviors/01-plugin-contract.md`, `packages/core/src/AuthPlugin.ts`, `packages/core/src/Auth.ts`, `packages/core/test/Auth.test.ts`

Tests (write first):
- packages/core/test/Auth.test.ts: 'JH-007: a plugin reading another plugin's table without dependsOn is refused at composition'.

Acceptance:
- BEH-EA-008 no longer shows core services in dependsOn.
- Auth.make refuses a plugin whose readsTables names an undeclared plugin's table.

Spec refs: BEH-EA-008 · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `package-and-test-hygiene`

#### MTS-010 — Test-only workspace imports declared as runtime dependencies

`low` · `correctness` · `admin` · [.issues/low/MTS-010-monorepo-tooling-specialist.md](../../.issues/low/MTS-010-monorepo-tooling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/admin/package.json:30` — inside "dependencies" (block starts line 27)

```json
    "@awthaq/server": "workspace:*",
```

- `packages/admin/test/Admin.test.ts:10` — only test files import it (also AuthHttp.test.ts:11); the sole src mention is a comment at Admin.ts:13

```ts
import { Authentication, Csrf } from "@awthaq/server";
```

- `packages/test/package.json:28` — packages/test/src never imports @awthaq/api — only packages/test/test/TestAuth.test.ts does

```json
    "@awthaq/api": "workspace:*",
```

**Fix plan** — Reclassify test-only workspace deps and add a src-imports-vs-dependencies smoke check so the drift cannot recur.

Steps:
1. Move "@awthaq/server" from dependencies to devDependencies in packages/admin/package.json.
2. Move "@awthaq/api" from dependencies to devDependencies in packages/test/package.json (verify `grep -rn '@awthaq/api' packages/test/src` stays empty first).
3. Extend scripts/package-smoke.mjs: for every packages/*/package.json, collect bare-specifier imports from src/**/*.ts (static `from "..."`), and fail when a `dependencies` entry is never imported from src (allow-list type-only peer cases explicitly), and when a src import is missing from dependencies/peerDependencies.
4. Run `pnpm install` to refresh the lockfile; run `pnpm knip` and `pnpm check`.

Files: `packages/admin/package.json`, `packages/test/package.json`, `scripts/package-smoke.mjs`, `pnpm-lock.yaml`

Tests (write first):
- Add the new classification assertion to scripts/package-smoke.mjs and run it BEFORE moving the deps — it must fail naming admin's @awthaq/server and test's @awthaq/api, then pass after the move.

Acceptance:
- `node scripts/package-smoke.mjs` fails on a dependency never imported from src and passes on the corrected manifests.
- `pnpm --filter @awthaq/admin test` and `pnpm --filter @awthaq/test test` still pass (devDependencies still installed in the workspace).

Spec refs: — · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

#### TTE-009 — HTTP tests assert against untyped JSON casts instead of contract schemas

`low` · `testing` · `admin` · [.issues/low/TTE-009-typescript-type-level-engineer.md](../../.issues/low/TTE-009-typescript-type-level-engineer.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Evidence at HEAD**

- `packages/admin/test/AuthHttp.test.ts:293` — line drifted from 252; same at :300 and :312 (openapi)

```ts
        const allRows = (yield* Effect.promise(() => all.json())) as ReadonlyArray<unknown>;
```

- `packages/passkey/test/AuthHttp.test.ts:392` — same pattern in passkey tests (also :214, :291, :328); organization/server tests are other slices

```ts
        const listed = (yield* Effect.promise(() => listResponse.json())) as ReadonlyArray<{
```

**Fix plan** — Decode HTTP test responses through the contract schemas instead of casting.

Steps:
1. Add a tiny shared helper in packages/test (e.g. `decodeJson(schema)(response)` = Effect.promise(json) + Schema.decodeUnknownEffect(schema)).
2. packages/admin/test/AuthHttp.test.ts: replace the `as ReadonlyArray<unknown>` casts with `decodeJson(Schema.Array(AdminApi.ImpersonationRecordDto))`; decode the openapi body with a minimal Schema.Struct.
3. packages/passkey/test/AuthHttp.test.ts: same with PasskeyApi.PasskeyCredentialDto / AuthenticateOptionsResult / SessionContract.SessionDto.
4. Optionally add an oxlint rule/grep in CI forbidding `.json()) as` in test files.

Files: `packages/test/src/index.ts`, `packages/admin/test/AuthHttp.test.ts`, `packages/passkey/test/AuthHttp.test.ts`

Tests (write first):
- Temporarily rename a DTO field in the test's expected schema and confirm the test now fails at decode (mutation check), then revert.

Acceptance:
- No `.json()) as` casts remain in packages/admin/test and packages/passkey/test.
- Shape drift fails at decode with a SchemaError.

Spec refs: — · Effort: **S** · Depends on: —

**Recommended status:** `ready-for-agent`

### Workstream `passkey-docs`

#### WPS-012 — layerSql queries two tables whose CREATE TABLE exists only in test fixtures

`medium` · `architecture` · `passkey` · [.issues/medium/WPS-012-webauthn-passkeys-specialist.md](../../.issues/medium/WPS-012-webauthn-passkeys-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (commit `58ef46a`) — confidence high

**Assessment:** Fixed by BAM-002's resolution (commit 58ef46a).

**Evidence at HEAD**

- `packages/passkey/src/Passkey.ts:535` — dual-dialect passkeyMigrations (459-533: passkey_credential + userId index, passkey_challenge) shipped by 58ef46a (BAM-002); ChallengeStore/PasskeyCredentials SQL tests now run through the real migrations

```ts
export class Passkey extends AuthPlugin.Service<Passkey, PasskeyShape>()("passkey", {
  apiVersion: 1,
  contract: PasskeyApi.PasskeyApi,
  tables: ["passkey_credential", "passkey_challenge"],
  migrations: passkeyMigrations,
}) {
```

**Fix plan:** none — already fixed.

**Recommended status:** `resolved`

#### TC-007 — Passkey docs claim the package is unimplemented while it is fully shipped

`low` · `docs` · `passkey` · [.issues/low/TC-007-tim-cappalli.md](../../.issues/low/TC-007-tim-cappalli.md) · current status `needs-triage`

**Verdict:** CONFIRMED — confidence high

**Assessment:** All three stale statements hold at HEAD. The README-banner part is covered by cross-slice DTWS-002 (20-README sweep); this ticket owns the passkey-specific remainder (behavior banner, model 'What is missing', a real README with a Recovery section).

**Evidence at HEAD**

- `packages/passkey/README.md:3` — README banner is one instance of DTWS-002's 20-README sweep

```text
> **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
```

- `spec/behaviors/17-passkey.md:15`

```text
> This file describes planned behavior. No code implementing it exists yet; awthaq is pre-implementation.
```

- `spec/models/03-passkey-webauthn.md:69`

```text
## What is missing
Everything beyond the one-line mention in the plugin tuple: no `Passkey` class, no `WebAuthn` port implementation, no `passkey_credential` table or migration, no challenge/replay handling, and none of the origin-validation or CVE-class pitfalls `research/06-webauthn-passkeys.md` names (CVE-2026-30964, YSA-2026-02, both "application-level identity/origin confusion around an otherwise-correct library") have been designed against yet, let alone implemented or tested.
```

**Fix plan** — Rewrite the passkey README and passkey spec status text from the shipped code, including a Recovery section.

Steps:
1. packages/passkey/README.md: replace banner (coordinate with DTWS-002's shared wording) and document: config (rpId/origins/attestation/authenticatorSelection/conditionalCreate/reauthMaxAgeSeconds), ChallengeStore backends and their guarantees (see WPS-009), layers to compose (Passkey.layer, PasskeyCredentials.layerSql, ChallengeStore.layer*, WebAuthn.layerSimpleWebAuthn, Passkey.beforeUserDeleteErasure), the client (`PasskeyClient` in @awthaq/client).
2. Add a 'Recovery' section: BEH-EA-134 last-credential guard (LastAccountRefusal), recommend pairing passkeys with a second credential type (password/email verification/magic link) because there is no self-service zero-factor recovery (ticket 05 flag).
3. spec/behaviors/17-passkey.md:15: replace the banner with the shipped-status banner DTWS-001 standardizes.
4. spec/models/03-passkey-webauthn.md: rewrite 'What is missing'/'Verification' to the real gaps (link the open workstreams: user handle, counter policy, enumeration safety) and the real test files.

Files: `packages/passkey/README.md`, `spec/behaviors/17-passkey.md`, `spec/models/03-passkey-webauthn.md`

Tests (write first):
- `pnpm run spec:verify:strict` (links/ids) after the edit.

Acceptance:
- No passkey doc claims the package is unimplemented.
- README has a Recovery section stating the last-credential guard and the pairing recommendation.

Spec refs: BEH-EA-134 · Effort: **S** · Depends on: DTWS-002, DTWS-001

**Recommended status:** `ready-for-agent`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| IDS-005 | medium | DUPLICATE | duplicate of APS-006; same root cause: impersonate overwrites the single __Host-session cookie; fixed by APS-006's plan. | `packages/admin/src/Admin.ts:164` |
| JR-006 | medium | DUPLICATE | duplicate of APS-006; same root cause: cookie-mode impersonate destroys the admin's own credential; fixed by APS-006's plan. | `packages/admin/src/Admin.ts:164` |
| CSS-003 | medium | DUPLICATE | duplicate of APS-006; same root cause viewed from the stop leg: no cookie bridge back to the admin session; fixed by APS-006's plan. | `packages/admin/src/Admin.ts:164` |
| MTI-006 | high | DUPLICATE | duplicate of IDS-001; Identical root cause (the gate predicate never sees the target). Its tenant half (list/forceStop global across tenants) is carried by IDS-002, and IDS-001's canManageEpisode covers the per-episode scoping. | `packages/admin/src/Admin.ts:43` |
| APS-009 | low | DUPLICATE | duplicate of IDS-003; Its substantive half (phantom-target sessions/audit rows) is IDS-003; the param-constraint half is folded into IDS-003's fix steps. Its own note that forceStop's arbitrary sessionId is contained by endEpisode's uniform 404 still holds at Admin.ts:341-347. | `packages/admin/src/AdminApi.ts:58` |
| JR-011 | info | DUPLICATE | duplicate of IDS-004; Same missing hard-expiry observer as IDS-004. | `packages/admin/src/ImpersonationRecords.ts:32` |
| ESA-008 | low | DUPLICATE | duplicate of IDS-004; Same missing hard-expiry observer as IDS-004; IDS-004's fix also publishes the stopped event with endedBy "expired" as ESA-008 asks. | `packages/admin/src/ImpersonationRecords.ts:41` |
| CB-007 | low | DUPLICATE | duplicate of BPAS-008; Same === vs constantTimeEqual inconsistency. | `packages/passkey/src/ChallengeStore.ts:104` |
| WPS-008 | low | DUPLICATE | duplicate of BPAS-008; Same === vs constantTimeEqual inconsistency. | `packages/passkey/src/ChallengeStore.ts:104` |
| HSK-010 | info | DUPLICATE | duplicate of BPAS-008; Same === vs constantTimeEqual inconsistency. | `packages/passkey/src/ChallengeStore.ts:104` |
| WPS-012 | medium | ALREADY-FIXED | fixed by 58ef46a; Fixed by BAM-002's resolution (commit 58ef46a). | `packages/passkey/src/Passkey.ts:535` |
| BPAS-005 | medium | ALREADY-FIXED | fixed by 1f2df3a; Fixed by CB-001 (1f2df3a): the ordinary path now rejects UV=0 only when config.authenticatorSelection.userVerification === "required"; Passkey.test.ts has 'CB-001: register/verify via the ordinary scope accepts UV=0 under the default "preferred" policy'. | `packages/passkey/src/Passkey.ts:662` |
| TC-005 | low | ALREADY-FIXED | fixed by 1f2df3a; Same CB-001 fix: 'discouraged' no longer triggers UV enforcement on the ordinary path. | `packages/passkey/src/Passkey.ts:662` |
| HSK-001 | medium | DUPLICATE | duplicate of BPAS-003; Same root cause: per-ceremony random user handle; persisted value never the bound one; assertion userHandle unchecked. | `packages/passkey/src/Passkey.ts:591` |
| TC-002 | medium | DUPLICATE | duplicate of BPAS-003; Same root cause: per-ceremony random user handle; persisted value never the bound one; assertion userHandle unchecked. | `packages/passkey/src/Passkey.ts:591` |
| WPS-002 | medium | DUPLICATE | duplicate of BPAS-003; Same root cause: per-ceremony random user handle; persisted value never the bound one; assertion userHandle unchecked. | `packages/passkey/src/Passkey.ts:692` |
| CB-005 | low | DUPLICATE | duplicate of BPAS-003; Same root cause: per-ceremony random user handle; persisted value never the bound one; assertion userHandle unchecked. | `packages/passkey/src/Passkey.ts:692` |
| CB-006 | low | DUPLICATE | duplicate of TC-001; Same allowCredentials existence oracle. | `packages/passkey/src/Passkey.ts:723` |
| WPS-007 | low | DUPLICATE | duplicate of TC-001; Same allowCredentials existence oracle. | `packages/passkey/src/Passkey.ts:723` |
| HSK-004 | medium | DUPLICATE | duplicate of WPS-006; Same root cause as WPS-006 (log-only, no credential flag/enforcement); its 'volatile in-memory bus' half is already fixed by 6bd3f1d (durable AuditLog). | `packages/passkey/src/Passkey.ts:796` |
| BPAS-009 | info | DUPLICATE | duplicate of WPS-006; 'PasskeyCounterAnomaly declared but never raised' is part of WPS-006; resolved when CB-004/WPS-006 make the 'reject' policy raise it. | `packages/passkey/src/PasskeyApi.ts:133` |
