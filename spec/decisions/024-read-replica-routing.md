# ADR-EA-024: Read-Replica Routing Is Opt-In, Classified Per Read, and Guarded by a Causal Token

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-024 |
> | Revision | 1.0 |
> | Effective Date | 2026-09-29 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-09-29): Initial release (RRC-001, RRC-008; wayfinder ticket 28) |

---

## Context

Repositories are built over one ambient `SqlClient` (BEH-EA-035), and `SqlModel.makeRepository` pulls that client with a bare `yield* SqlClient`, so a repository cannot be handed "the right client for this query" per call without forking Effect's primitive. A deployment with a Postgres streaming replica nevertheless wants its display/history listings off the primary. The constraint that makes this dangerous is ADR-EA-014: `Sessions.verify` revocation MUST be authoritative on the very next read, against any backend — a session revoked a millisecond ago must not verify because a lagging replica has not heard yet.

## Decision

1. **Routing is a second, optional ambient service; nothing changes unless it is provided.** `ReadRouting.ReplicaSqlClient` is a `Context.Reference<Option<SqlClient>>` defaulting to `None`; `ReadRouting.replica(layer)` provides it and consumes the replica's own `SqlClient` layer so it never replaces the ambient primary. Repositories resolve both clients once at layer construction (`ReadRouting.makeRouter`), because a call-time `provideService(SqlClient, replica)` would not reroute a query built at construction. With no replica configured, every read uses the primary, byte-for-byte as before.
2. **Every read is classified, and the default is the primary.** `Consistency` is `"authoritative"` (default) or `"eventual"`. Primary-pinned — always, with no override that can weaken them — are all writes, every `Users` read, every `Accounts` read (`unlink`'s last-account check depends on `listByUser`), every `Sessions` point read and CAS (`findById`, `touch`, `tombstone`, `markReused`, `reauthenticate`), all `Verification` and `VerificationReservations` methods (their writes carry results back with `RETURNING`; nothing re-reads). Replica-eligible are **display/history listings only**: `Sessions.listByUser` (authoritative unless a display-only caller passes `{ consistency: "eventual" }`; liveness decisions must not) and `AuditLog.list` (eventual by default). ADR-EA-014 is therefore satisfied by classification alone, not by the token.
3. **A causal token is the read-your-writes guardrail for eventual reads.** `CurrentCausalToken` is a fiber-scoped `Context.Reference<Option<CausalToken>>`. A domain service that owns a transaction wraps the write in `ReadRouting.captureToken`, which, once the write succeeded and only when a replica is configured, reads the primary's write position (`ReplicationPosition.current`) and sets the token for the rest of the fiber; an eventual read then uses the replica only if `ReplicationPosition.hasReplayed(replica, token)` — Postgres: `pg_last_wal_replay_lsn() >= token::pg_lsn`, where NULL (a server not in recovery) is "no" — and otherwise falls back to the primary. Any doubt (an error, an unparsable token, an unreadable position) means the primary. `ReplicationPosition` is a `Context.Reference` so a non-Postgres source, or a test double, can replace the default.
4. **Cross-request causal continuity is deferred, on purpose.** A redirect that lands on a different process cannot see the writing fiber's token. The login → redirect → verify case does not need it (verify is primary-pinned, decision 2); the case it would serve is membership write → authorization read across a request boundary. Carrying the token (a response header seeded back by middleware through `ReadRouting.withCausalToken`) touches the server package's response-hook pipeline and is left as a named follow-up. Callers that need it before then pass `"authoritative"`.
5. **Read-your-writes on a single primary is an assumption, stated.** Everything above the repositories assumes a read issued after a committed write on the primary sees it. With replicas enabled, that assumption holds only for reads classified authoritative, or eventual reads carrying a token the replica has passed. Code that adds a new replica-eligible read must say why staleness is acceptable there. Repositories carry write results back with `RETURNING` rather than re-reading (`verifyEmail`, `tryConsume`, `claim`, `touch`), which keeps single statements correct under any topology.

## Alternatives considered

**A `replica: SqlClient` argument on every repository method** — rejected: `SqlModel.makeRepository` hard-codes its client, so this means reimplementing part of `@effect/sql` to add a flag. **Overriding the pg client's routing globally** — rejected for the reason ADR-EA-004 rejects global codec overrides: the ambient client is shared with the host application's own tables. **Routing by method name only, no token** — rejected: the membership-write → authorization-read case (and a device list right after a revoke) needs read-your-writes for a read that is legitimately replica-eligible.

## Consequences

**Positive**: additive and default-off (no existing deployment changes); an operator cannot under-classify a sensitive read by turning replicas on, because the sensitive reads have no eventual mode; the token check is one cheap query, and only on eventual reads by a fiber that has written.

**Negative**: per-request write-then-list flows need their service to call `captureToken`; until then such a flow is stale-tolerant by classification, which is why `Sessions.listByUser` defaults to the primary. The token does not cross requests (decision 4). The default position source speaks Postgres only; SQLite has no replicas, so `captureToken` and the position checks are no-ops there.
