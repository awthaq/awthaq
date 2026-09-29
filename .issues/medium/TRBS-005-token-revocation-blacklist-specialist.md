---
ID: "TRBS-005"
Title: "Memory layer revocation never propagates: per-process Ref, zero cross-instance story"
Level: medium
Category: "security"
Status: ready-for-agent
Package: "core"
Source: "packages/core/src/Sessions.ts:222"
Auditor: "token-revocation-blacklist-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# TRBS-005 — Memory layer revocation never propagates: per-process Ref, zero cross-instance story

`MEDIUM` · `security` · `core` · reported by **Token Revocation & Blacklist Specialist** (`token-revocation-blacklist-specialist`)

Status: **ready-for-agent**

## Summary

layerMemory's entire positive-list store is one in-process Ref. With more than one instance behind a load balancer, each instance holds a disjoint store: a session issued on instance A does not exist on instance B (verify fails SessionNotFound), and — the revocation half — a revoke on A leaves the row alive on B for any instance that independently issued or cached issuance context. ADR-EA-014 requires revocation to be 'authoritative on the very next read... against any backend', which a per-process Ref cannot satisfy across replicas; the propagation latency across instances is not seconds, it is never. The same in-process boundary applies to AuthEvents (a PubSub per process), so even the replay/audit signal of a revocation is invisible to sibling instances. Nothing in the layer's name or docs states the single-instance (or sticky-session) constraint it silently imposes.

## Evidence

Source: `packages/core/src/Sessions.ts:222`

```
const state = yield* Ref.make(HashMap.empty<SessionId, SessionRow>());
```

## Recommended fix

Document layerMemory as single-instance-only in its API docs, and for multi-instance deployments provide the SQL layer or a KV-backed Sessions per ADR-EA-014's own KV alternative; long-term, a Redis-pubsub-backed AuthEvents variant closes the event-propagation half.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Token Revocation
- Full dossier: [`token-revocation-blacklist-specialist`](../../.reports/token-revocation-blacklist-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AH-007` — Redundant assertion after sound narrowing in session supersedes path](low/AH-007-anders-hejlsberg.md) `_(anders-hejlsberg, low)_`
- [`AGA-004` — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate](medium/AGA-004-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, medium)_`
- [`APS-010` — All principal identifiers are UUIDv7: time-ordered, partially predictable](info/APS-010-auth-pentest-specialist.md) `_(auth-pentest-specialist, info)_`
- [`BO-005` — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login](medium/BO-005-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BAM-003` — Session cutover invalidates every live better-auth session with no bridge](high/BAM-003-better-auth-migration-specialist.md) `_(better-auth-migration-specialist, high)_`
- [`DRS-004` — Session token carries no shard/region hint; verify is a bare findById that needs a global directory under any partitioning](medium/DRS-004-data-residency-sharding-specialist.md) `_(data-residency-sharding-specialist, medium)_`
- [`ECF-007` — issue(supersedes) is a two-step delete-then-insert with no transaction or interruption guard](low/ECF-007-effect-concurrency-fiber-specialist.md) `_(effect-concurrency-fiber-specialist, low)_`
- [`EEM-008` — Internal Data.TaggedError classes carry stringly message fields and reuse wire tag names verbatim](low/EEM-008-effect-error-management-specialist.md) `_(effect-error-management-specialist, low)_`
- … 29 more findings touch `packages/core/src/Sessions.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-docs-accuracy`. Evidence at HEAD ec065a7: `packages/core/src/Sessions.ts:317`. Fix: Document every core layerMemory as single-process/test-grade and point multi-instance deployments at layerSql (or a future KV layer per ADR-EA-014). (effort S). Full dossier: `.plan/slices/01-core-sessions-users.md`. Status → ready-for-agent.
