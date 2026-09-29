---
ID: "KRS-006"
Title: "KeyRing only notices rotations visible to its own process; external rotateNow is invisible to busy servers"
Level: medium
Category: "architecture"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/KeyRing.ts:192"
Auditor: "key-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# KRS-006 — KeyRing only notices rotations visible to its own process; external rotateNow is invisible to busy servers

`MEDIUM` · `architecture` · `jwt` · reported by **Key Rotation Specialist** (`key-rotation-specialist`)

Status: **resolved**

## Summary

The cached snapshot is refreshed only when the locally cached current key passes keyRotationInterval, or via idleTimeToLive ('1 hour') when the ref goes idle. A rotation performed out of band — the documented emergency path rotateNow, intended to be reachable from the planned CLI, or another instance's rotation — is not picked up by a busy server: it keeps signing with a key already marked rotated in the store, omits the replacement from its JWKS and verification set (so peers' new-key tokens fail verification here), and only converges when the old key's own age crosses the interval. The rotation model implicitly assumes a single writer.

## Evidence

Source: `packages/jwt/src/KeyRing.ts:192`

```
if (isStale(cache.current.createdAt, now, config.keyRotationInterval)) {
  yield* ref.refresh;
}
```

## Recommended fix

Add a store-driven invalidation (compare the store's current kid on rotateIfDue, or a max-age bound on the snapshot in addition to idleTimeToLive) so signers converge on externally-triggered rotations within a bounded, TTL-sized window.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: Key lifecycle & rotation
- Full dossier: [`key-rotation-specialist`](../../.reports/key-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`KRS-009` — Rotation mutation (markRotated + mint) is not atomic and has no single-current-key guard](low/KRS-009-key-rotation-specialist.md) `_(key-rotation-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `jwt-key-rotation-integrity`. Evidence at HEAD ec065a7: `packages/jwt/src/KeyRing.ts:186`. Fix: Bound snapshot staleness with a max-age refresh and refresh once (rate-limited) on an unknown kid so peer/external rotations converge. (effort M). Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** KeyRing snapshot records loadedAt and JwtConfig.keyCacheMaxAge (default 5 min) makes current/verifiable refresh a stale snapshot; Jwt.verifyWith forces one rate-limited (JwtConfig.keyMinRefreshInterval, default 30 s; ports RefreshingCache.refreshOnMiss) KeyRing.refresh on an unknown kid and retries once. Test: packages/jwt/test/KeyRing.test.ts 'an out-of-band rotateNow on the shared store is picked up by a busy KeyRing within keyCacheMaxAge' (memory and SQL suites, two KeyRings over one store + TestClock).
