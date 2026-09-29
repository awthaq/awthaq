# ADR-EA-031: Erasure Is a Core Domain Service over an Aggregating Registry, and Retention Is a Separate, Opt-In Sweep

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-031 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (CSG-001, DRS-002, SEA-001, SSMS-002) |

---

## Context

The account-deletion cascade lived inline in the HTTP handler, and every plugin that stores personal data took part through an opt-in `BeforeUserDelete` tap the host had to remember to install. Forgetting one left a plugin's rows behind silently; a tap is also the wrong shape (an observe hook swallows failures, BEH-EA-092, and erasure must abort and roll back). The schema has no foreign keys by design, so no database cascade can do the job either (SEA-001).

## Decision

1. **`Erasure.AccountErasure.eraseAccount(userId, { deletedBy })` is the one cascade.** The `BeforeUserDelete` veto runs first, before anything is touched (a legal hold must not leave a composition without a real transaction half-erased); then, inside one `SqlTransaction`, every registered contribution, the core rows (accounts, sessions, verification tokens, the user) and, last, the audit pseudonymization (ADR-EA-029); then, after the commit, `auth.user.deleted`. An HTTP handler, an admin console or a CLI call the same service. A contribution that fails or dies rolls the whole erasure back (`AccountErasure.test.ts`, over SQLite).
2. **Plugins contribute to an aggregating registry (ADR-EA-012 style).** `Erasure.contribute({ id, order, make })` returns a `Layer` that requires `ErasureRegistry`, and `AuthPlugin.layer(Self, { contributes })` folds it into the plugin's own layer, so a composition that installs a plugin holding personal data without the registry does not compile, the same compile-time guarantee ADR-EA-028 gives taps. `Hooks.HooksLive` provides the registry, so existing compositions need no edit. Contributions run ordered by `order`, then id; the first read freezes the registry (`ErasureRegistryFrozen` is a defect). `organization`, `passkey`, `roles` and `claims` ship contributions.
3. **Retained by decision: `admin_impersonation` and its hash chain** (legal-obligation basis, GDPR Art. 17(3)(b)/(e), access-review evidence). They are protected by triggers and their chain payloads embed the ids a rewrite would touch. Follow-up: a ledger whose identifiers are per-user keyed digests, so an erasure can drop the key.
4. **Not covered, documented**: passkey challenge rows expire on their own (minutes); the JWT revocation store holds token ids, not personal data.
5. **Retention is separate from erasure.** Expiry-driven purging (sessions past their grace, verification tokens past a forensic window, audit rows past a per-class window) is `Retention.sweep`, opt-in and off by default for the audit log (retain forever unless a window is set), never a side effect of a request.

## Alternatives considered

**Making the veto a contribution.** Rejected: the veto must run before the transaction opens.

**A database cascade.** Rejected: the schema is FK-less on purpose (plugins own their tables; BEH-EA-040/095), and a cascade is invisible to the audit trail.

## Consequences

**Positive**: erasure is complete by construction and atomic; adding a plugin cannot silently forget it.

**Negative**: a plugin store outside the transaction (a remote service) cannot be rolled back by `SqlTransaction`; such a contribution must be idempotent and retry-safe.
