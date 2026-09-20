---
ID: "AVS-001"
Title: "Wildcard `./*` subpath export makes every source file public API in all 21 packages"
Level: high
Category: "api"
Status: resolved
Package: "api"
Source: "packages/api/package.json:21"
Auditor: "api-design-versioning-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# AVS-001 — Wildcard `./*` subpath export makes every source file public API in all 21 packages

`HIGH` · `api` · `api` · reported by **API Design & Versioning Specialist** (`api-design-versioning-specialist`)

Status: **resolved**

## Summary

Every package's export map maps `./*` to every compiled file, so `@awthaq/api/Session.ts`, `@awthaq/core/Slots.ts`, etc. are all de-facto public surface the moment the first package is published. There is no internal/private module distinction anywhere in the monorepo (measured: 21/21 identical maps), which means every filename, and every symbol in every file, is frozen API from day one. For a plugin architecture whose stated goal (ADR-EA-003) is a stable contract surface distinct from internals, this defeats the distinction: refactoring or renaming any module is a breaking change for unknown consumers. Mitigating today: all packages are `private: true` and unpublished, so the cost is still zero — but it crystallizes at first publish.

## Evidence

Source: `packages/api/package.json:21`

```
"./*": {
  "types": "./lib/*.d.ts",
  "bun": "./src/*.ts"
```

## Recommended fix

Before first publish, replace `./*` with an explicit export map enumerating only the public entry points (index plus the `<Name>Api` contract modules), or at minimum add a deny-list for internal modules (`./internal/*`, `*Records`, `*Handlers`). Decide now what the stable surface is; after publication it can only be taken away deprecatively.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 63/100), domain: API surface & versioning
- Full dossier: [`api-design-versioning-specialist`](../../.reports/api-design-versioning-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [Public API surface hardening](../../.scratch/resolve-ready-for-human-findings/issues/25-public-api-surface-hardening.md) — delete the `"./*"` subpath export from all 21 `package.json` files, keeping only `"."`; every package's existing `src/index.ts` barrel is already the curated public surface, so this is deletion, not a new allowlist to maintain. One deep cross-package import (`packages/organization/src/OrganizationQadi.ts:40`) needs a one-line fix to go through the barrel first. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/api/package.json:21` matches (`"./*": { "types": "./lib/*.d.ts", "bun": "./src/*.ts" ...}`), and all 21 `packages/*/package.json` files contain the identical wildcard export (verified by grep). Choosing the actual stable public surface before first publish is a product/API-design decision, not a mechanical change. Status → ready-for-human.

**Resolved (2026-09-20):** Implemented exactly [Public API surface hardening](../../.scratch/resolve-ready-for-human-findings/issues/25-public-api-surface-hardening.md)'s AVS-001 half — the wildcard was deleted, not narrowed to an allowlist, since every package's `src/index.ts` barrel already is the curated public surface. Deleted the `"./*"` subpath export from all 21 original packages plus the new `@awthaq/migrate-auth0` (added this session, after the decision ticket was written, so it carried the same stale template) — 22 `package.json` files total, each keeping only `"."`.

Re-checking the monorepo for deep cross-package imports (the decision ticket's own grep only covered `src`/`test`) turned up 5 real sites beyond the one it named, all in `features/step-definitions` and `examples/`: `AdminWorld.ts`/`PasswordWorld.ts` (`@awthaq/core/AuthEvents`), `PasswordWorld.ts`/`SessionWorld.ts` (`@awthaq/ports/Mailer`), and `examples/memory-server/index.ts` (`@awthaq/test/TestAuth`) — each fixed by importing the already-present barrel namespace and qualifying the type reference (`AuthEvents.AuthEvent`, `Mailer.MailMessage`) instead of a second, bare top-level import. `packages/organization/src/OrganizationQadi.ts:40`'s `@awthaq/core/Users` (the one site the decision ticket did name) fixed the same way. `features/lib/**/*.d.ts`'s own deep-import references are compiled output (gitignored, regenerate automatically) and needed no direct edit.

Full monorepo `pnpm run typecheck` clean (confirms no other file anywhere in the workspace relied on a deep subpath import that the wildcard's removal would have silently broken); `pnpm run test` green (720 passed, unchanged); `pnpm run test:bdd` unaffected (same 2 pre-existing, unrelated `15-password.steps.test.ts` failures). No new test needed — this is a pure API-surface removal with an existing full-suite typecheck as its own regression guard, the same reasoning `MA-003`'s own barrel-only enforcement (tracked separately) will lean on.

**Out of scope**: this same decision ticket's `MA-003` half (the `effect/unstable/httpapi/*` re-export barrel plus CI import-path enforcement) is `MA-003`'s own finding, not part of this ticket's ask — left for its own pass.
