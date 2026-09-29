---
ID: "KRS-009"
Title: "Rotation mutation (markRotated + mint) is not atomic and has no single-current-key guard"
Level: low
Category: "correctness"
Status: resolved
Package: "jwt"
Source: "packages/jwt/src/KeyRing.ts:229"
Auditor: "key-rotation-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# KRS-009 — Rotation mutation (markRotated + mint) is not atomic and has no single-current-key guard

`LOW` · `correctness` · `jwt` · reported by **Key Rotation Specialist** (`key-rotation-specialist`)

Status: **resolved**

## Summary

Both layerFromStore's scheduled rotation and rotateNow perform two independent store writes: mark the old row rotated, then insert the replacement. A crash or mint failure between them leaves zero rows with rotatedAt IS NULL — self-healing on the next rebuild (findCurrent returns None and mint runs again), but a failing mint after rotateNow's markRotated leaves every sign call erroring until then. Additionally markRotated's UPDATE has no WHERE rotatedAt IS NULL guard and findCurrent silently picks newest among current rows, so two concurrent rotators (multi-instance deployment) can mint two simultaneously-current keys; verification stays correct since both remain in the verifiable set, but 'current' stops being unique.

## Evidence

Source: `packages/jwt/src/KeyRing.ts:229`

```
yield* markRotated(existing.value, now, config.keyGracePeriod);
}
yield* mint(config.algorithm);
```

## Recommended fix

Wrap markRotated + mint in the SqlTransaction port (or a store-level conditional insert guarded on 'no current row'), and add a partial unique index on rotatedAt IS NULL where the dialect supports it.

## Context

- Auditor verdict on this domain: **needs-work** (score 62/100), domain: Key lifecycle & rotation
- Full dossier: [`key-rotation-specialist`](../../.reports/key-rotation-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`KRS-006` — KeyRing only notices rotations visible to its own process; external rotateNow is invisible to busy servers](medium/KRS-006-key-rotation-specialist.md) `_(key-rotation-specialist, medium)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** DUPLICATE (confidence high); workstream `jwt-key-rotation-integrity`. Duplicate of `JJS-004` — closed by that issue's fix. Evidence at HEAD ec065a7: `packages/jwt/src/KeyRing.ts:227`. Full dossier: `.plan/slices/04-oauth-provider-jwt.md`. Status → resolved.

**Resolved (2026-09-29):** Duplicate of `JJS-004-jwt-jwk-specialist` — closed by its fix (see that issue's Resolved comment).
