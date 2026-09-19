---
ID: "EHA-001"
Title: "Duplicate group-id refusal (BEH-EA-032) unimplemented: colliding groups silently overwrite"
Level: high
Category: "correctness"
Status: resolved
Package: "core"
Source: "packages/core/src/Auth.ts:379"
Auditor: "effect-http-api-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# EHA-001 — Duplicate group-id refusal (BEH-EA-032) unimplemented: colliding groups silently overwrite

`HIGH` · `correctness` · `core` · reported by **Effect HTTP API Specialist** (`effect-http-api-specialist`)

Status: **resolved**

## Summary

composeApi flattens every plugin's contract groups (Auth.ts:374) into one HttpApi.make('auth').add(...). The installed effect's HttpApi.add stores groups by identifier with last-wins assignProperty semantics and no collision check (effect@4.0.0-rc.116 HttpApi.ts:157), so two plugins contributing a group with the same identifier resolve to whichever was added last — the loser's endpoints silently vanish from the served surface while its handlers layer still merges. spec/behaviors/04-contract-stratum.md:150-156 (BEH-EA-032) explicitly requires this merge to 'MUST fail ... never by one group silently replacing the other', naming the E_GROUP_CONFLICT design. Auth.make's Validate<P> catches duplicate plugin ids and missing dependencies at the type level but says nothing about group identifiers, so the documented invariant is enforced nowhere.

## Evidence

Source: `packages/core/src/Auth.ts:379`

```
return HttpApi.make("auth").add(firstGroup, ...restGroups);
```

## Recommended fix

In composeApi, reduce groups with a Map keyed by group.identifier and throw a typed E_GROUP_CONFLICT error naming both contributing plugins on collision (the spec's own prescribed failure); optionally encode the same constraint in Validate<P> so duplicates fail type-check before runtime.

## Context

- Auditor verdict on this domain: **needs-work** (score 67/100), domain: HttpApi contracts & wiring
- Full dossier: [`effect-http-api-specialist`](../../.reports/effect-http-api-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 30 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`JH-006` — Static layer type matches the runtime fold only when the tuple is pre-sorted](medium/JH-006-jared-hanson.md) `_(jared-hanson, medium)_`
- [`MW-002` — Served API surface is fragmented across three HttpApi values; core session/account routes are unreachable via Auth.make](high/MW-002-matias-woloski.md) `_(matias-woloski, high)_`
- [`MA-007` — Built<P>['layer']'s static type assumes caller-side dependency ordering the runtime does not require](medium/MA-007-michael-arnaldi.md) `_(michael-arnaldi, medium)_`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — evidence quote matches `packages/core/src/Auth.ts:379` exactly; the installed `HttpApi.add` (`node_modules/.../effect@4.0.0-rc.116/.../unstable/httpapi/HttpApi.js:26`) implements it as `InternalRecord.assignProperty(groups, group.identifier, group)`, literally `self[key] = value` — last-wins, no collision check. `spec/behaviors/04-contract-stratum.md:150-163` (BEH-EA-032) explicitly requires this merge to fail, and `Auth.ts`'s `Validate<P>` (line 140) only checks duplicate plugin ids, not group identifiers. Fix (Map-keyed reduce + typed conflict error in `composeApi`) is mechanical. Status → ready-for-agent.

**Resolved (2026-09-20):** `composeApi` (`packages/core/src/Auth.ts`) now walks each plugin's contributed groups tracking which plugin first claimed each identifier in a `Map`, throwing a new `GroupIdConflict` (naming the group id and both contributing plugin ids, matching `archive/design/usage-examples-v4.md` §2.2's `E_GROUP_CONFLICT` failure shape — `AuthPlugin`'s own `id`/`apiVersion` identity used in place of that example's fabricated `package@version` pair) the instant a second plugin claims an identifier already taken.

Note on what's actually reachable: `AuthPlugin.ts`'s own `GroupsFor<Id>` type constraint (BEH-EA-004) already confines each plugin's own groups to its own id or a dotted sub-id of it, so two *different* top-level plugin ids can never type-check their way into literally the same top-level group name — that shape is already refused at compile time, independent of this fix. The real, still-reachable collision BEH-EA-032 guards against is a dotted sub-group: plugin `alpha` legitimately owning a sub-group `alpha.beta`, colliding with a wholly separate, independently-valid plugin literally id'd `alpha.beta` contributing its own top-level group of that name — neither `GroupsFor<Id>` nor `Validate<P>`'s `DuplicateId` check (which only compares full plugin ids) catches this.

TDD: `packages/core/test/AuthPlugin.test.ts` gained two toy plugins (`Alpha`/`AlphaBeta`) reproducing exactly that dotted-sub-id collision, and a test asserting `Auth.make([Alpha, AlphaBeta])` throws a `GroupIdConflict` naming `groupId: "alpha.beta"`, `firstPluginId: "alpha"`, `secondPluginId: "alpha.beta"`. A second test repurposes the file's existing (pre-fix, silently-tolerated) `Ping`/`PingDuplicate` duplicate-plugin-id scaffold — both share a `contract`, so this is a second, independent proof the same check fires; fixing it required also converting that scaffold's bare module-level `@ts-expect-error` line (which used to execute silently at import time, since JS ignores the comment) into a real `assert.throws` test, since it would otherwise now crash module evaluation for the whole test file. Verified both new tests fail for the right reason with the collision check temporarily removed (no throw at all). Full monorepo `pnpm run typecheck` and `pnpm run test` both green (666 passed, 7 skipped).
