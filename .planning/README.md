# Architecture deepening plans

Two batches. **Plans 01–10** come from the review of 2026-10-13 and are all implemented (see each plan's
"Decisions taken"). **Plans 11–24** come from the review of 2026-10-17 against `main` at `fc990c88`; they are
indexed in [Batch 2](#batch-2-plans-1124-review-of-2026-10-17) at the end of this file. The shared conventions
below apply to both batches.

## Batch 1: plans 01–10 (review of 2026-10-13)

Source: the architecture review of 2026-10-13 (`/improve-codebase-architecture`), against `main` at `38bcd1b`.
Each plan turns one deepening candidate (or, for plan 10, a set of loose findings) into an executable, phased
change. Vocabulary follows the codebase-design glossary: **module, interface, implementation, depth, seam,
adapter, leverage, locality**. Domain terms come from `spec/glossary.md` and `spec/overview.md`; decisions are
`spec/decisions/ADR-EA-NNN`.

Every plan has the same ten sections: summary and goals, verified current state, target design (TypeScript
sketches), phased migration, test plan, spec/ADR/traceability updates, risks, interactions, acceptance checklist,
and open questions for the user.

## Plans

| # | Plan | Strength | Dependency category | Live bugs it fixes | Lines | Open Qs |
|---|---|---|---|---|---|---|
| 01 | [Sign-in completion and sign-up in core](01-sign-in-sign-up/PLAN.md) | Strong | in-process | SAML + 2FA loses `fed`, its Single Logout record, role mapping and tenant · SCIM skips `BeforeSignUp`/`auth.user.created` · SCIM rollback swallows a veto | 1,132 | 3 |
| 02 | [One domain implementation over a store seam](02-domain-store-seam/PLAN.md) | Strong | local-substitutable + ports & adapters | ~40 memory/SQL drift items, e.g. a concurrent `Accounts.unlink` can leave zero accounts on Postgres, SQL `revoke`/`reauthenticate` not atomic, `supersedes` can tombstone another user's session | 1,289 | 9 |
| 03 | [Erasure is the only way to delete a User](03-erasure-single-cascade/PLAN.md) | Strong | in-process | SCIM erase skips the ADR-EA-031 cascade (memberships, linked accounts, tokens, audit); double veto; self/admin erasure leave SCIM mappings; vetoed self-delete → 500 | 1,116 | 10 |
| 04 | [Organization system modules beneath the authorized interface](04-organization-system-modules/PLAN.md) | Strong | in-process | SCIM team create/delete skip veto, tx, `maximumTeams`, events, `teams.enabled` · member removal never invalidates qadi decision caches · org deletion orphans connections · creation/acceptance not atomic | 1,534 | 11 |
| 05 | [Plugin table substrate in `@awthaq/sql`](05-plugin-table-substrate/PLAN.md) | Strong | local-substitutable · ports & adapters | ADR-EA-019 re-seal ignored by 5 of 6 sealed columns · no RLS on plugin tables · `withoutTenant` doesn't reset the Postgres tenant setting · plugin `orDie` | 1,488 | 7 |
| 06 | [Rate-limit budget in core](06-rate-limit-budget/PLAN.md) | Strong | local-substitutable | passkey doesn't strip `+tag` (budget evasion) · 7 enforced rules never declared · 4 registry keys don't match enforcement · escalation can't be enabled | ~2,050 | 10 |
| 07 | [`Verification.redeem` owns the transaction protocol](07-verification-redeem/PLAN.md) | Worth exploring | ports & adapters | memory burns a refused reset token, SQL restores it · tokens burned on failed completion · Postgres poisoned-tx on `Channel`'s duplicate-email retry | 765 | 7 |
| 08 | [Plugin record bundles and a deeper `TestAuth.layer`](08-test-composition/PLAN.md) | Worth exploring | local-substitutable | `TestAuth.layer` types `services` as present but only provides them (compiles, dies) · 13 of 20 plugins lack contract tests | 1,164 | 9 |
| 09 | [Event metadata travels with the event schema](09-event-definitions/PLAN.md) | Speculative | in-process | ban note survives erasure and reaches webhooks · memory audit erasure blanks every user's rows · relay passes free text to custom transports | 715 | 6 |
| 10 | [Standalone fixes and loose findings](10-standalone-fixes/PLAN.md) | mixed | mixed | **API keys outlive a banned/erased owner (P0 security)** · SAML `amr` · ADR-028 `orDie` on sign-in · `reauthenticate` on dead sessions · events from rolled-back tx (every tenanted Postgres request) | ~1,180 | 8 |

## Execution order

```
Wave 0 — hotfixes (each its own small PR, no refactor)
  10·item 0  API keys refused for suspended/erased owners          (security, first)
  10·items 1-2  SAML amr in the divert · drop sign-in orDie        (before 01)
  03·phase 1   SCIM erase goes through AccountErasure               (before 01, 02)
  04·P0-P2     SCIM team create/delete through the Teams module     (needs Q10 of plan 04)

Wave A — small, independent
  03 erasure (rest) · 09 events · 06 rate limits · 10·items 3, 4, 8, 9

Wave B — sign-in hot path
  10·item 5 (after-commit events, ADR-EA-037) ─┐
  01 sign-in / sign-up (ADR-EA-038) ───────────┴──► 07 redeem (ADR-EA-039)

Wave C — plugin persistence
  05 substrate ──► 04 organization (rest, ADR-EA-040) ──► 10·items 6, 7

Wave D — core persistence
  02 store seam (ADR-EA-041) ──► 08 test composition
```

Why this order:
- **10·item 0 first**: it is the only finding that grants access it shouldn't.
- **03 before 01 and 02**: 01's `SignUp` and 02's `UserStore` both assume `Users.delete` is gone from the interface.
- **06 before 01**: 01 removes the sign-in preamble; doing 06 first avoids rewriting the rate-limit wrappers twice.
- **10·item 5 before 07 and before 02's phase 8**: both change transaction boundaries and need after-commit events.
- **01 before 07**: magic-link/email-OTP completion becomes `redeem(…, use = SignIn…)`.
- **05 before 04 and 02**: 05 defines the shared `StoreFailure` helpers that both reuse.
- **01 before 02**: 01 collapses seven `sessions.issue` call sites into one, so 02 changes one caller.
- **02 and 05 before 08**: 08's bundles are the matched `Persistence.*` and `<Plugin>.records.*` those plans create.

## New ADR numbers (reserved)

Plans were written in parallel and initially all claimed ADR-EA-037. Numbers are now reserved in execution order;
if the order changes, renumber here and in the plan.

| ADR | Title (draft) | Plan |
|---|---|---|
| ADR-EA-037 | A unit of work releases state-change events on commit and attempt events either way | 10 (item 5) |
| ADR-EA-038 | Sign-in and sign-up are core modules | 01 |
| ADR-EA-039 | `Verification.redeem` owns the consume-in-transaction protocol | 07 |
| ADR-EA-040 | A plugin may expose namespaced domain services; dependents declare `dependsOn` | 04 |
| ADR-EA-041 | Core domain services are written once over atomic store ports | 02 |

Plans 03, 05, 06, 08 and 09 only amend existing ADRs (031; 018/019/028; none; none; 029/030).

## Cross-plan reconciliations

The plans were written in parallel. Where two plans define the same thing, this table is authoritative:

| Topic | Plans | Resolution |
|---|---|---|
| Store-failure mapping (`SqlError` → `StoreUnavailable`) | 05 defines `StoreFailure` in `@awthaq/sql`; 02 proposes `SqlStore.read/write` | 05 lands first. 02's `SqlStore.read/write` is a thin wrapper over 05's `StoreFailure`, not a second classification. |
| Tenant-stamp rule | 05 `TenantScoped.stamp` in `@awthaq/sql`; 02 `Tenant.stamp` in `@awthaq/ports` | The rule lives in **ports** (`Tenant.stamp`), because 02's memory adapters live in ports and ports can't depend on sql. 05's `TenantScoped` calls it. 05 adjusts §3 when it executes. |
| Abandon-a-half-made-user creation | 03 adds `Users.createWith` (SCIM rollback); 01 adds `SignUp.createWith` | 03's `Users.createWith` lands first as the primitive; 01's `SignUp.createWith` is built on it, and SCIM moves to `SignUp` in 01. 02 turns it into a `UserStore` primitive. |
| Who did it (`Actor` / initiator) | 04 `Actor` in organization; 03 `Self`/`Admin`/`Directory` initiator; 01 `scim:<org>:<conn>` strategy; 09 event actors | Open: plan 04 Q7. Recommended: one core `Actor` union used by all four. Decide before 03's phase 2. |
| Who owns the SAML + 2FA gap | 10 item 1 (`amr`) vs 01 (continuation) | 10 fixes `amr` only; 01 fixes the Single Logout record, role mapping and tenant with a typed continuation. |
| API keys and erasure | 03 Q9 vs 10 item 0 | 10 item 0 owns it (gate and erasure/export contributions); 03 Q9 is answered. |
| Request context (`ip`/`userAgent`) | 01 assumes per-request `AuthRequestContext` | It is opt-in today (only `examples/memory-server` installs it). Plan 01 Q1 decides whether it becomes required; 06 keys IPs the same way. |

## Shared conventions (apply to every plan)

- **No type assertions** (`as`, `as unknown as`, `as any`) anywhere in library source. Narrow with `Schema`, guards or overloads.
- **No return type annotations** on new Effect/Layer consts; let inference infer them.
- **Type-system first**: prefer an invariant the compiler enforces (branded clearance types, removed interface members, required declarations) over a runtime check or a doc comment.
- **Richness over simplicity** when a fork is a capability dial with a real caller; no speculative infra without one.
- **Effect version**: the repo pins `effect@4.0.0-rc.116` (`pnpm-workspace.yaml` catalog). The sibling checkout `../effect` is at **4.0.1**, where SQL moved to `effect/sql`. Check APIs against `node_modules/effect` (the pinned copy); use `../effect` only for intent and source reading. qadi is at `../qadi`.
- **Replace, don't layer** tests: tests move to the deepened module's interface; old per-caller tests that re-test the moved behaviour are deleted, not kept alongside.
- Every behaviour change updates its `spec/behaviors/*.md` entry (Document Control table: revision + change history), `spec/traceability.md`, and the BDD scenarios under `features/` where they exist.
- Every package-visible change carries a changeset with a migration note (ADR-EA-034).
- Gate for each phase: `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`; gate for each plan: `pnpm check` (and `pnpm test:pg` when SQL adapters change).
- Track execution as `.scratch/<plan-slug>/issues/NN-*.md` tickets (see `docs/agents/issue-tracker.md`) when work starts; these plans are the spec.
- Line numbers were verified on 2026-10-13 at `38bcd1b`; re-verify before editing, since earlier waves shift them.

## Decisions needed before each wave

Each plan's last section lists its open questions (80 in total). These block a wave from starting:

- **Wave 0:** plan 10 Q0a (a suspended owner's key → 401 or 403; recommended 401) · plan 04 Q10 (land the SCIM team fix early) · plan 04 Q1–Q3 (SCIM behaviour with `teams.enabled: false`, last team, `maximumTeams`).
- **Wave A:** plan 04 Q7 (one core `Actor`) · plan 03 Q1–Q3 (initiator on the veto input and on `auth.user.deleted`) · plan 06 Q1 (bucket-key rename resets counters) · plan 09 Q2 (is a ban reason personal data).
- **Wave B:** plan 01 Q1 (make `RequestContext.layer` required) and Q2 (host `BeforeSignUp` taps apply to SCIM) · plan 07 Q1 (do vetoes spend a magic link) · plan 10 Q7–Q8 (which hooks and events wait for commit).
- **Wave C:** plan 05 Q1 (one AAD convention with lazy re-seal, or keep per-column formats) and Q3 (RLS on organization tables by default) · plan 10 Q5 (cross-protocol domain claims).
- **Wave D:** plan 02 Q1 (external users of `layerSql`/`layerMemory`), Q3 (transactional memory) and Q4 (tenant filtering on SQLite) · plan 08 Q1 (absorb plugin-owned services into plugin layers; changes production).

---

## Batch 2: plans 11–24 (review of 2026-10-17)

Source: the architecture review of 2026-10-17 against `main` at `fc990c88`, after plans 01–10 had all landed.
Same ten-section shape, same conventions (above) and the same implementing rules (`IMPLEMENTING.md`). Every
plan re-verified its candidate at `fc990c88`; where the review was wrong the plan's §2 says so. Line numbers
shift as earlier plans land: re-locate by symbol before editing.

### Plans

| # | Plan | Strength | Dependency category | Live bugs it fixes (reproduced unless marked) | Phases | Open Qs |
|---|---|---|---|---|---|---|
| 11 | [One credential-resolution module](11-credential-resolution/PLAN.md) | Strong | in-process | web/next ignore `SessionCookieConfig`: under `SecureDomain` `getSession` is always `undefined`, `hasSessionCookie` always `false`, a rotation is written as `__Host-session` · qadi Path B: stale cookie (or failing `x-api-key`) + valid bearer → anonymous, Path A → the user | 7 | 6 |
| 12 | [One passkey ceremony module](12-passkey-ceremony/PLAN.md) | Strong | ports & adapters · local-substitutable | **BEH-EA-132**: register/reauthenticate refuse a bad origin/rpId *before* spending the challenge, which then verifies · all three ceremonies leave the challenge live on unreadable `clientDataJSON` | 4 | 4 |
| 13 | [One admin gate](13-admin-gate/PLAN.md) | Strong | in-process | **`AdminAccounts` ignores a tenant's `AdminConfig`** (`canDeleteUsers`, `canManageCredentials`, `passwordPolicy`, `links.changeEmail` read at build): a user is **erased** in a tenant whose config forbids it (ADR-EA-018 D8) | 6 | 6 |
| 14 | [Federated identity resolution in core](14-federated-identity/PLAN.md) | Strong | in-process | SAML: two concurrent ACS for one new NameID → 500 (two paths) · OAuth/SAML refuse an identity that only lost a race · OAuth explicit link to another user's identity "succeeds", links nothing and **overwrites that user's provider tokens** · OAuth refresh race → 500 · SAML `trustsEmail` not bounded to the connection's domains | 6 | 7 |
| 15 | [A host-composition module (`AuthHost`)](15-host-composition/PLAN.md) | Strong | local-substitutable | `examples/sql-server` + any table-owning plugin compiles (`RIn = never`) and answers 503 "no such table": plugin migrations never run; README quickstart has the same flaw · `userFieldsLayer` never provided (latent) | 5 | 9 |
| 16 | [Fold `Repositories` into the SQL store adapters](16-sql-store-adapters/PLAN.md) | Strong | local-substitutable | none at runtime · removes 8 test-only repository methods, a dead degraded token-read path, dead wiring in 9 test compositions, a BDD scenario only a dead method satisfies, the false libSQL claim · housekeeping: `Repositories.ts-E`, stale `packages/sql/README.md` | 8 | 7 |
| 17 | [Core sealed columns onto `SealedColumn`](17-core-sealed-columns/PLAN.md) | Strong | local-substitutable | **the documented runbook corrupts data** (`docs/plugin-authoring.md:156`: a hand-declared core sweep re-seals under an AAD the repository never reads → `null`) · account-token AAD doesn't bind the account · key retirement can't finish for core rows · a failed re-seal aborts an enclosing Postgres tx (plugin columns too) | 5 (+2b) | 8 |
| 18 | [`VerificationLink` owns redeeming a mailed token](18-verification-link-redeem/PLAN.md) | Worth exploring | local-substitutable | **`OAuth.callback` consumes any identifier**: a state of `email-otp:<victim>.000000` burns the victim's OTP attempts and bypasses EmailOtp's per-address budget · `confirmReset` has no per-IP rule, so every forged token reaches the breach-check network call | 7 | 7 |
| 19 | [A pure verdict for a presented session credential](19-session-verdict/PLAN.md) | Worth exploring | in-process | a rotation loser that finds the row expired publishes no `auth.session.expired` (ESA-006; narrow) | 4 | 6 |
| 20 | [One in-process user agent](20-in-process-user-agent/PLAN.md) | Worth exploring | in-process | `TestAuth.signIn` hands back a hard-coded `__Host-session` cookie (`TestAuth.ts:519`) the server ignores under `SecureDomain` (401) · 63 `Set-Cookie` reads in 31 test files, 7 parsers, 4 hand-made jars | 6 | 7 |
| 21 | [The session lifecycle is declared on the `HttpApi` contract](21-session-minting-annotation/PLAN.md) | Worth exploring (plan finds it stronger) | in-process | **a bearer client that changes its password is logged out everywhere**: the new token is not sent as `set-auth-token`, the superseded one is presented again, reuse detection revokes the whole family | 8 | 8 |
| 22 | [Each plugin table's DDL lives with its records](22-table-ddl-locality/PLAN.md) | Worth exploring | local-substitutable | all 47 plugin indexes lack `IF NOT EXISTS` (the documented online-index procedure fails) · `passkey_credential.counter` is int4 on Postgres (uint32 counter ≥ 2³¹ breaks sign-in) · tenancy declarations never checked against the schema | 9 | 7 |
| 23 | [`RelayCursorStore` is a store port](23-relay-cursor-store/PLAN.md) | Worth exploring | ports & adapters | cursor outage is a defect, not `StoreUnavailable`; a busy cursor write redelivers the whole batch · the composition in `README.md:390` and `packages/webhooks/README.md:19` does not compile · two same-named relays can move the cursor backwards | 4 | 4 |
| 24 | [Plugin record stores: one behaviour for memory and SQL](24-memory-records-over-sqlite/PLAN.md) | Speculative | local-substitutable | `members?sortDirection=desc` returns ascending over SQL · team/connection-domain order drifts · duplicate JWT `kid` overwrites in memory, dies over SQL · SQLite PK clash missed by `orConflict` · **10 SQL record adapters not atomic on Postgres** (team-move cycle, negative member count, lost updates; confirmed by reading, not run) | 6 (+Track A) | 8 |

Plan 24's default is **Track B** (keep the `Ref` adapters, enforce parity with a differential harness, fix the
drifts and the Postgres races). Track A (memory bundles become SQL over SQLite `:memory:`) runs only if the
Phase 0 spike passes gates G1–G5. The review's premise did not survive §2: SQLite serialises writers, so it
cannot reproduce the Postgres races that matter most, and TRBS-005 means "single-process", not "driver-free".

### Execution order

```
Wave 0 — hotfixes, each its own small PR, no refactor (security first)
  13·P0   AdminAccounts reads the tenant's AdminConfig per operation         (erases accounts today)
  18·P0   pin, then pull the OAuth-callback identifier-prefix check forward  (cross-flow token burn)
  14·P0   SAML answers a lost race by re-reading the anchor                  (500 on concurrent ACS)
  12·P0   passkey ceremonies spend the challenge first                       (BEH-EA-132)
  11·P0   web/next read the configured cookie; Path B falls through to bearer
  21·P0   pin the bearer change-password family revocation (fix lands in 21·P5; pull forward if wanted)
  15·P0   pin the sql-server example; fix the README quickstart's missing plugin migrations

Wave A — contained deepenings, independent of each other
  13 (P1–P3, P5) · 12 (rest) · 14 (rest) · 19 · 23

Wave B — the request path
  11·P1 (shared current-user + IssuedSession helpers) ──► 13·P4
  11·P2–P6 ──► 18 (uses 11's ClientAddress)
  21 ──────────────────────────────────────────────► 20 (Wave D)

Wave C — persistence
  23 ──► 17 ──► 16          (see "16 vs 17" below)
  22 ──► 24·P0 spike ──► 24 (Track B by default)

Wave D — composition and test edge
  15 ──► 20
```

Why this order:
- **13·P0 first**: it is the only finding that destroys data an operator's configuration forbids touching.
- **18·P0 early**: the cross-flow consume is an unauthenticated way to exhaust another person's OTP budget. The
  plan fixes it in Phase 5 (the shared burn-first codec); the prefix check alone, the same `startsWith` the
  native exchange already does at `OAuth.ts:1339`, can ship ahead of that.
- **11·P1 before 13·P4**: 11 exports the one current-user helper (in core, because organization, webhooks and
  SAML don't depend on server); 13 only deletes the admin copies. 12 also takes 11's `IssuedSession`.
- **21 before 20**: 21 makes every bearer mint send `set-auth-token`, so 20's agent captures bearer tokens by
  "follow the headers" instead of duck-typing the body.
- **15 before 20 and 24**: 15 moves the example smoke tests onto `TestAuth.app` (which 20 then gives a cookie
  jar), and 15 is the one place a memory composition is assembled (which 24's Track A would change).
- **23 before 16**: 16 deletes `Repositories`, and `core/src/EventRelay.ts` is its only importer outside
  `@awthaq/sql` besides `Persistence.ts`. 23 also builds the first SQL adapter with no repository behind it,
  the shape 16 then applies to the other five stores.
- **22 before 24**: both edit the same records modules; 24 builds on 22's colocated DDL.

### New ADR numbers (reserved) and ADR revisions

| ADR | Title (draft) | Plan |
|---|---|---|
| ADR-EA-042 | One credential-resolution module beneath every entry point | 11 |
| ADR-EA-043 | Federated identity resolution is a core module | 14 |
| ADR-EA-044 | One host-composition module derives the servable layer | 15 |
| ADR-EA-045 | The session lifecycle is declared on the `HttpApi` contract | 21 |
| ADR-EA-046 | Plugin record stores: one behaviour for memory and SQL | 24 |

Several plans amend the same ADR and each wrote the next revision number it saw. **Revision numbers are
assigned when a plan lands, in landing order**, not as written in the plan:

| ADR | Amended by (claimed revision) | Assign in landing order |
|---|---|---|
| ADR-EA-004 (rev 1.2 today) | 16 (1.3), 22 (1.3), 24 (1.3) | 22 → 16 → 24 per the waves above: 1.3, 1.4, 1.5 |
| ADR-EA-014 (rev 1.3) | 19 (1.4), 23 (1.4), 24 (1.4) | 19 → 23 → 24 |
| ADR-EA-028 (rev 1.5) | 11 (1.6), 23 (1.6) | whichever lands first takes 1.6 |
| ADR-EA-041 (rev 1.1) | 23 (1.2), 16 (1.3), 24 (if Track A) | as written: 23 then 16 |
| ADR-EA-019 (rev 1.2) | 17 (1.3) | — |
| ADR-EA-018 (rev 1.4) | 13 (1.5) | — |
| ADR-EA-003 · 015 · 020 · 030 · 039 | 21 · 11 · 18 · 23 · 18 | one amender each |

### Cross-plan reconciliations

Where two plans in this batch touch the same thing, this table is authoritative:

| Topic | Plans | Resolution |
|---|---|---|
| **16 vs 17 order** | 16 §8/Q7 says 23 → 16 → 17; 17 §8/Q8 says 17 first | **Recommended: 23 → 17 → 16.** 17 fixes live bugs (the runbook that corrupts data, the token AAD that doesn't bind the account); 16 fixes none at runtime. 16 is written to support either order and lists exactly what changes with 17 first (no `internal/CoreSealing.ts`, Q1 moot, it moves 17's `SealedColumn.codec` declarations). **User decision.** |
| Shared current-user helper and `IssuedSession` | 11 P1, 12, 13 P4 | 11 owns them (11 copies of `currentUserPrincipal`, not 8; the helper goes in core). 12 and 13 consume them and only delete their own copies. |
| Configured cookie names | 11, 20 | 11 makes every reader take the name from `SessionCookieConfig`; 20's agent (and `TestAuth.signIn`, `TestAuth.ts:519`) must read the configured names too, never a hard-coded name. |
| "A cookie the handler wrote wins" | 11, 21 | 21 owns the rule (it declares which endpoints mint, rotate, end or swap); 11's delivery sink defers to it. |
| Bearer token capture | 20, 21 | 21 makes the headers authoritative; 20 follows the headers. |
| Session-lifecycle declaration mechanism | 21 | Effect rc.116 endpoint annotations are untyped (`HttpApiEndpoint.ts:189`) and there is no `annotateContext`, so 21 declares mint/rotate/end/swap with **middleware markers** (type-level gate checked by `tsc` probe), not annotations. Four handlers write the session cookie outside `SessionDelivery` today (OAuth callback and exchange, SAML ACS, admin impersonation); 21 brings them under the gate, so 12, 13 and 14 rebase onto the markers in those handlers. |
| `Passkey.ts` regions | 12, 22 | 22 owns the migrations region (`Passkey.ts:803-958`) and the counter column; 12 leaves it alone. Disjoint, either order. |
| Where new column DDL goes | 14 P5, 17, 22 | Wherever 22 has moved that table's DDL (its records module). 17's sealed-column declarations move with the table. |
| Store insert primitives | 14, 16 | 16 must keep `insertIfAbsent`/`insertOrHolder` as single `ON CONFLICT DO NOTHING` statements; 14's race handling relies on them. |
| Session verdict and sealed values | 17, 19 | 19's pure verdict never decrypts `ipAddress`/`userAgent`; 17 makes `toView` effectful, which changes two lines of 19's interpreter. |
| `Sessions.verify` interface | 11, 19 | 19 keeps it unchanged, so 11 only rebases. |
| `OAuth.callbackFlow` | 14, 18 | Both edit it; whichever lands second rebases (18 §8 has the merge note). |
| Production hook points | 15 Q9 vs plan 08 Q5 | 15 proposes reversing plan 08's decision (provide declared `hookPoints` in production). **User decision** (15 Q9). |
| `regclass` re-run note | 15, 16 | It didn't reproduce on Postgres 16 (15 §2); 16 re-tests it and drops the note from `packages/sql/README.md` if it still doesn't. |
| Records bundle shape | 15, 23, 24 | Only Track A of 24 changes it. If Track A goes, 15's memory mode and 23's `Ref` cursor adapter are revisited in 24's Phase 0 decision record. |
| Follow-ups handed off (not planned here) | 13 Q4, 14 Q7, 21 Q6 | SAML `canManageSaml` per tenant · SAML anchor stability when `entityId` is edited · JWT session-mirror cookie on sign-out. Open as tickets when the owning plan lands. |

### Decisions needed before each wave

Each plan's §10 has a recommended default for every question (94 in total). These block a wave from starting:

- **Wave 0:** 13 Q6 (ship P0 alone; recommended yes) · 14 Q5 (a second lost race → typed `Contended`, recommended, or 503) · 12 Q2 (when both challenge and origin are wrong, `PasskeyChallengeInvalid` wins, a visible error change) · whether to pull 18's prefix check and 21's bearer fix forward into Wave 0.
- **Wave A:** 13 Q1 (make `AdminConfig` private) and Q2 (`actionDenied` carries the target; a core event change) · 14 Q1–Q3 (SAML-created users verified within claimed domains; email trust bounded to claimed domains; new `auth.account.linked` event) · 12 Q1 (do admission refusals spend the challenge) · 23 Q1 (monotonic `advance`) and Q2 (a lease per relay name).
- **Wave B:** 11 Q2 (Path B's tier) and Q3 (a non-`User` principal from a session is a 401 on user-tier groups) · 21 Q1 (keep `token` in the body), Q2 (refuse bearer impersonation), Q4 (an unsettled declared endpoint dies with 500 in production) and Q5 (core's cookie writers move to server) · 18 Q1 (a foreign row is spent) and Q2 (`confirmResetByIp` numbers).
- **Wave C:** **16 vs 17 order** (above) · 17 Q1 (does any environment hold rows under today's core AADs; decides whether Phase 2b ships a re-key) and Q2 (core ports carry `Sealed` values) · 22 Q3 (rewrite shipped migrations' source, or freeze them) and Q4 (widen the passkey counter to `BIGINT` with a migration, or clamp) · 24 Q1 (accept G1–G5 as the go/no-go) and Q4 (fix the 10 Postgres atomicity bugs inside 24).
- **Wave D:** 15 Q1 (`AuthHost` in server or a new package), Q2 (`migrations` required in SQL mode), Q6 (move the ledger drift check from the CLI into core) and **Q9 (reverse plan 08 Q5)**.

---

# Batch 3: deepening plans 25–30 (review of 2026-11-08)

Source: the architecture review of 2026-11-08 (`/improve-codebase-architecture`, report at
https://claude.ai/artifact/PF2z5egsLacVozRDi7PaSe). That review read `chore/effect-4.1-peer-deps`
(`ede063d8`), which predates batch 2. Every plan was then re-verified on `architecture/deepening-plans-2` @
`5a0e8df4` with the merge of `main` (`935d15ee`) in progress. Each plan's header says which tree its line numbers
come from. Two candidates turned out to be already done by batch 2 (plans 16 and 17), so plan 28 and plan 30
Part B are residual plans only.

The format is unchanged: ten sections, numbered tickets that map onto `.scratch/<NN-slug>/issues/NN-*.md`, an
acceptance checklist, open questions with recommended defaults, and an empty "Decisions taken" record.

## Plans

| # | Plan | Strength | Dependency category | Live bugs (confirmed unless marked) | Lines | Tickets | Open Qs |
|---|---|---|---|---|---|---|---|
| 25 | [Plugin record stores: atomic primitives, data-driven contract](25-record-store-contract/PLAN.md) | Strong | local-substitutable · ports & adapters | **two owners removing each other leave 0 owners** (memory, SQLite, Postgres; Postgres 3/3 runs without a forced interleaving) · concurrent removals leave 0 teams · `membershipLimit` 2 ends with 3 members · crossing `moveTeam` makes a team cycle on Postgres (6–8 of 8 runs) · ~10 more check-then-write shapes by reading | 1,391 | 27 | 10 |
| 26 | [Request facts are read from `AuthRequestContext` only](26-request-context/PLAN.md) | Strong | in-process | impersonation sessions record no address or user agent (`Admin.ts:1116`) · audit and webhook user agent uncapped (session caps at 512) · the `a232d8e6` build-time warning is wrong about sessions · `Saml.logout` takes an unused `ip`. *Refuted:* no shipped caller forgets `ip` (the risk is latent) | 1,471 | 28 | 9 |
| 27 | [One password credential module](27-password-credential/PLAN.md) | Worth exploring (plan argues Strong) | in-process | **administrator-set and seeded passwords skip breach screening and `Password.config`** (three policies, not two) · 6 ADR-EA-028 `orDie`s turn a store outage into 500 · `changePassword` is four commits, not one unit · `seed admin` silently keeps an existing password | 1,143 | 18 | 9 |
| 28 | [SQL store adapters: residual gaps after plan 16](28-sql-store-adapters/PLAN.md) | Residual | local-substitutable | `ConnectionRecords.ts:566` answers 503 instead of `ConnectionDomainTaken` on libSQL (by reading) · `SamlRecords.ts:762` maps every `ConstraintError` to "domain taken" · the store contract never runs on the sealed bundle | 284 | 3 | 3 |
| 29 | [Plugins own their event definitions](29-plugin-owned-events/PLAN.md) | Strong friction | in-process | the CLI's `linkErrorCodes` misses 5 `Auth.make` link errors. Two design gaps in plan 09 §3.7 caught before shipping (erasure of a removed plugin's personal data; an open `ForeignEvent` kills narrowing) | 1,822 | 25 | 8 |
| 30 | [Speculative follow-ups](30-speculative-followups/PLAN.md): (A) organization authorization as one primitive · (B) core sealed columns | A: GO · B: superseded by 17 | in-process · local-substitutable | A, by reading, failing tests first in ticket 01: **an outsider can probe organization existence via the role endpoints (403 vs 404, BEH-EA-284)** · suspended organizations can still cancel invitations · read, accept and reject invitations, and the active context, ignore suspension (BEH-EA-237) | 1,099 | 15 | 10 |

## Execution order

```
Wave 0 (hotfixes, each its own small PR, any branch)
  25 · tickets 02-03   last-owner race: failing Postgres test + per-organization advisory lock
  30 · tickets 01-04   organization existence probe (roles) + suspension gaps
  27 · ticket 04       ADR-EA-028: store outage → 503 on the credential path
  28 · tickets 01-02   sealed-bundle contract run; unique-violation classification

After the merge of main into architecture/deepening-plans-2 is committed
  30 · ticket 21       re-run plan 17's sealed-column proofs (the merge rewrites ports/src/Encryption.ts)

Wave E: the deepenings
  26 request context (phases 0-3 can start now; rebase against batch-2 21, Api.RequestContext outermost)
    └─► 26 ticket 13 (password) ──► 27 password credential
  22 (batch 2) ──► 25 record-store contract, per package (replaces 24 Track B) ── 28 ticket 03 lands with it
  25 + 26 + 27 ──► 29 plugin-owned events, plugin by plugin (password after 27, organization last)
  30 A1-A3 any time after Wave 0; rebase around 25 and 29
```

### Status (2026-11-08)

| Item | State |
|---|---|
| Batch 2 plans 15, 20, 21 | Landed in PR #46 (with the merge of main). Plan 24: Phases 1–5 superseded by 25 (Q0 accepted); Track A spike not started |
| Wave 0 · 25 tickets 02–03 | Landed, PR #49 |
| Wave 0 · 30 tickets 01–04 | Landed, PR #51 |
| Wave 0 · 27 ticket 04 | Landed, PR #50 |
| 27 · tickets 01–03, 05–18 | Done on `feat/password-credential` (draft PR #59): Wave E (05–11) and Wave F (12–18); BEH-EA-345, ADR-EA-048, REQ-EA-1502 (see plan 27 "Decisions taken") |
| Wave 0 · 28 tickets 01–02 | Landed, PR #48 |
| 30 Wave A · tickets 05–12 | Done on `feat/organization-access` (not pushed): `OrganizationAccess`, compiler-owned ceiling, generated matrix, static guard, ADR-EA-040 1.1; REQ-EA-1503–1504 |
| 30 ticket 21 | Done: plan 17 verified on the merged base, no regression; R1 NO-GO (no pre-1.3 environment), so 22–23 are closed |
| 25 | Done: Wave 0 (02–03, PR #49), Wave E (04, 06–14, PR #55, with 28 ticket 03), Wave F (15–25, PRs #57/#58), Wave G (26–27, `docs/record-store-contract-close`); ticket 01 skipped. Left as follow-ups: sealed-column suites over `recordsBase`, the PG-only cases proven only by CI's `pnpm test:pg` (see plan 25 "Decisions taken") |
| 29 | Done on `feat/plugin-owned-events` (draft PR #62): tickets 01–25; core keeps 24 events, 73 moved into eleven plugins; ADR-EA-049 Accepted, BEH-EA-346, REQ-EA-1510–1513 (see plan 29 "Decisions taken") |
| Wave E (rest) | Not started |

Each plan's "Decisions taken" section records what its Wave 0 PR decided and where the plan was stale. Numbers
taken since this batch was written: BEH-EA-340–342 (plan 15), 343 (21), 344 (20); ADR-EA-044 (15), 045 (21);
REQ-EA-1321–1334 (15, 21, 20), 1335–1336 (30 Wave 0), 1502–1503 (30 Wave A). Plan 27's behaviour is therefore BEH-EA-345.

Why this order:
- **25's owner fix first**: it is the only confirmed invariant break (an organization with no owner) and it ships without the refactor.
- **26 before 27**: 26 rewrites `PasswordShape` inputs mechanically, 27 rewrites the bodies. The reverse order rebases every handler twice.
- **25 before 29**: 29 moves events out of the organization modules that 25 fixes; fixing first keeps the race fixes reviewable.
- **22 before 25**: 25 edits the same records modules as batch-2 22 and builds on its colocated DDL.

## Numbers assigned

| Item | Plan | Note |
|---|---|---|
| ADR-EA-047 | 26 | Request facts are read from `AuthRequestContext`; reverses plan 01 decision 7 (26 Q1) |
| ADR-EA-048 | 27 | The password credential is one module of `@awthaq/password`, under one policy |
| ADR-EA-049 | 29 | Plugins own their event definitions; BEH-EA-101 reworded |
| BEH-EA-346, REQ-EA-1510–1513 | 29 | `Auth.make` composes event definitions and refuses a duplicate tag; the four §6.5 scenarios (1505–1509 left free) |
| BEH-EA-345 | 27 | Every path that verifies, sets or rehashes a password goes through one module (338–344 are taken: 340–342 plan 15, 343 plan 21, 344 plan 20) |
| ADR-EA-041 decision 9 | 25 | Plugin record stores meet a data-driven contract; 28 ticket 03 rewrites decision 5 in the same revision |
| ADR-EA-040 rev 1.1 | 27, 30 A | Both add a revision note; assign the revision in landing order |

## Reconciliations with batch 2

| Topic | Plans | Resolution |
|---|---|---|
| Plugin memory/SQL parity | 24, 25 | **25 subsumes 24 Track B** (R1–R6, `orConflict`, C1–C10 become contract cases). 24 keeps the Track A spike and ADR-EA-046. **25 Q0 accepted (2026-11-08):** 24 Phases 1–5 are marked superseded. |
| Fold `Repositories` | 16, 28 | 16 did it; 28 is three residual tickets. |
| Core sealed columns | 17, 30 B | 17 did it; 30 B keeps ticket 21 (re-run proofs) and gates tickets 22–23 (re-key) on a named environment. |
| Request facts | 11, 20, 21, 26 | 26 deletes 11's `ClientAddress.facts`/`address` helpers; names its brand `Api.UserAgentHeader` to avoid 20's `UserAgent`; shares 21's contract files (second to land rebases). |
| Admin password policy | 13, 18, 27 | 27 §8.1: 13's per-tenant `cleared.config.passwordPolicy` is replaced by `Password`'s policy; 18's `beforeClaim` calls 27's `accept`. |
| Organization authorization | 04, 30 A | 30 A builds plan 04's never-made `internal/authorize.ts`; keeps 04's Q7/Q9 decisions. |
| `eventsLayer` placement | 15, 29 | Either order; the second to land adds one line to `AuthHost`. |

## Stale convention

The shared conventions above say the repo pins `effect@4.0.0-rc.116`. The catalog is now `effect ^4.1.2` (dev) /
`^4.1.0` (peer), and batch-3 plans checked APIs against the installed 4.1.2. `scripts/test-pg.sh` can't start
Postgres where the docker socket refuses the user; podman works (25 Q6 proposes a fallback).
