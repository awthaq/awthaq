# Architecture deepening plans

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
