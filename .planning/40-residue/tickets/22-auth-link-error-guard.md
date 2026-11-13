---
plan: 40-residue
ticket: 22
title: "Auth.LinkError and Auth.isLinkError; the CLI keeps no list; exhaustiveness test"
type: tdd
wave: 0
depends_on: [21]
files_modified:
  - packages/core/src/Auth.ts
  - packages/core/test/LinkErrors.test.ts
  - packages/cli/src/Config.ts
  - packages/api/src/SessionLifecycle.ts
autonomous: true
requirements: [REQ-EA-1616, REQ-EA-1617]
estimate: {tasks: 3, size: M}
must_haves:
  truths:
    - "Auth.LinkError is the union of every tagged error the composition path raises (14, 15 with Q8)"
    - "The tag set is an object literal `satisfies Record<LinkError['_tag'], true>`, so a missing or extra tag fails typecheck"
    - "A trigger table typed against LinkError['_tag'] proves each tag is raised and recognised; a source scan proves no TaggedError on the composition path is left out"
    - "packages/cli/src/Config.ts classifies with Auth.isLinkError; linkErrorCodes is gone; ticket 21's three cases are green"
  artifacts:
    - path: packages/core/src/Auth.ts
      provides: "LinkError, linkErrorTags, isLinkError"
      contains: "export const isLinkError"
    - path: packages/core/test/LinkErrors.test.ts
      provides: "exhaustiveness: trigger table + source scan"
  key_links:
    - from: packages/cli/src/Config.ts
      to: packages/core/src/Auth.ts
      via: "asLoadFailure → Auth.isLinkError"
      pattern: "Auth\\.isLinkError"
---
Status: done (uncommitted)
Blocked by: 21

<objective>
Core owns the set of link errors; the CLI asks core.
Purpose: C-F1/C-F2 (PLAN §2.C.4) and the drift class behind plan 29 F4.
Output: `Auth.LinkError`, `Auth.linkErrorTags`, `Auth.isLinkError`; `SessionLifecycle.Conflict` (Q8); `LinkErrors.test.ts`; `Config.ts` without its mirror.
</objective>

<context>
@packages/core/src/Auth.ts (:30-175 error classes, :1086 composeApi → SessionLifecycle.inventory, :1247-1277 make)
@packages/core/src/AuthPlugin.ts (:433 ConflictingDependsOn)
@packages/core/src/UserFields.ts (:75 InvalidDeclaration, :81 UserFieldConflict)
@packages/sql/src/SealedColumn.ts (:35 InvalidDeclaration)
@packages/api/src/SessionLifecycle.ts (:108-130 inventory)
@packages/cli/src/Config.ts (:27 import, :106-139 linkErrorCodes and asLoadFailure)
@packages/core/test/RouteConflict.test.ts, packages/core/test/AuthPlugin.test.ts (how each error is provoked today)
@.planning/40-residue/PLAN.md §2.C.1 (the table of 14 + 1), §3.C
</context>

<tasks>
  <task type="tdd">
    <name>Task 1: exhaustiveness test (red)</name>
    <files>packages/core/test/LinkErrors.test.ts</files>
    <read_first>packages/core/test/RouteConflict.test.ts; packages/core/test/AuthPlugin.test.ts; packages/core/test/EventComposition.test.ts (EventTagConflict trigger)</read_first>
    <behavior>
      - triggers: an object literal `satisfies Record<Auth.LinkError["_tag"], () => unknown>` with one synchronous thunk per tag, each provoking exactly that error (reuse the minimal plugins those test files build; EmptyPluginTuple via the untyped implementation is not callable from typed code — trigger it through the overload-free path the existing tests use, or, if none exists, through `composeLayer`'s public effect, and say which in a comment).
      - for each entry: calling the thunk throws; `Auth.isLinkError(thrown)` is true; `thrown._tag` equals the key.
      - source scan: read packages/core/src/Auth.ts, AuthPlugin.ts, UserFields.ts, packages/sql/src/SealedColumn.ts (and packages/api/src/SessionLifecycle.ts if Q8) with `node:fs`, collect every tag in `Data.TaggedError(` followed by a string literal on the same or next line; assert the collected set deepStrictEquals `new Set(Object.keys(Auth.linkErrorTags))`; also assert the collected set has at least 14 members (guards a broken regex).
      - negative: isLinkError is false for `new HookPoint.HookPointFrozen(...)` (or any non-link TaggedError core exports), `new Error("x")`, `null`, `"RouteConflict"`.
    </behavior>
    <action>Write the file per the behaviour; it fails to compile until task 2 (red).</action>
    <verify><automated>npx vitest run packages/core/test/LinkErrors.test.ts 2>&1 | tail -3   # RED</automated></verify>
    <done>Red.</done>
  </task>
  <task type="auto">
    <name>Task 2: LinkError, tag set, guard; CLI uses it</name>
    <files>packages/core/src/Auth.ts, packages/cli/src/Config.ts</files>
    <read_first>packages/core/src/Auth.ts:1-40, :160-175; packages/cli/src/Config.ts:20-40, :100-140</read_first>
    <action>In Auth.ts, after the error classes: export `type LinkError` = the union in PLAN §3.C (import `UserFields` already imported; `AuthPlugin` already imported; add `type SealedColumn` is already imported from "@awthaq/sql": use `SealedColumn.InvalidDeclaration` in the type). Export `const linkErrorTags = { … } satisfies Record<LinkError["_tag"], true>` with one key per tag (string keys with a slash need quotes). Export `isLinkError = (u: unknown): u is LinkError => Predicate.hasProperty(u, "_tag") && typeof u._tag === "string" && Object.hasOwn(linkErrorTags, u._tag)` (import `effect/Predicate`; no `as`). Doc comment: BEH-EA-201; "every refusal raised while a configuration module is evaluated: by `Auth.make` or where a plugin, a user field or a sealed column is declared". In Config.ts: change `import type { Auth, AuthPlugin, Migrations }` to import `Auth` as a value (keep the others type-only), delete `linkErrorCodes` and its two comment lines, and make `asLoadFailure` return `new LinkProblem({ code: error._tag, message: describeError(error) })` when `Auth.isLinkError(error)`; everything else unchanged.</action>
    <verify><automated>npx vitest run packages/core/test/LinkErrors.test.ts packages/cli/test/ConfigLoader.test.ts packages/cli/test/Doctor.test.ts && pnpm typecheck</automated></verify>
    <acceptance_criteria>`rg -c 'linkErrorCodes' packages/cli/src/Config.ts` prints nothing (baseline 2); `rg -n 'Auth\.isLinkError' packages/cli/src/Config.ts` prints 1 line (baseline 0); ticket 21's 3 cases green.</acceptance_criteria>
    <done>Loader classifies all 14 tags.</done>
  </task>
  <task type="auto">
    <name>Task 3 (Q8, default yes): tag the session-lifecycle refusal</name>
    <files>packages/api/src/SessionLifecycle.ts, packages/core/src/Auth.ts, packages/core/test/LinkErrors.test.ts</files>
    <read_first>packages/api/src/SessionLifecycle.ts:1-30, :100-135; `pnpm check:error-tags` script (scripts/check-error-tags.mjs) for tag naming rules</read_first>
    <action>In SessionLifecycle.ts add `export class Conflict extends Data.TaggedError("SessionLifecycle/Conflict")<{ readonly endpoint: string; readonly kinds: ReadonlyArray<string>; readonly message: string }> {}` and throw it at :124 with the same message text. Add `SessionLifecycle.Conflict` to `Auth.LinkError` and its tag to `linkErrorTags`; add its trigger (an `HttpApi` endpoint carrying two lifecycle middlewares, passed through `Auth.make` with one plugin) and its file to the source scan. Run `pnpm check:error-tags`. If Q8 is answered no, skip this task and write that in Comments.</action>
    <verify><automated>npx vitest run packages/core/test/LinkErrors.test.ts packages/api/test && pnpm check:error-tags</automated></verify>
    <done>15 tags classified.</done>
  </task>
</tasks>

<threat_model>
## Trust edges
| Edge | Description |
|---|---|
| configuration module → CLI output | a link error's message is printed by `doctor`, `--json` and every command (BEH-EA-201: never a secret value) |

## STRIDE register
| Threat ID | Category | Site | Severity | Disposition | Mitigation |
|---|---|---|---|---|---|
| T-40-18 | Information disclosure | `LinkProblem.message` for the newly classified tags | low | accept | their messages name plugin ids, field keys, tables and columns only (UserFields.ts:148-165, AuthPlugin.ts:877-883, SealedColumn.ts:60-64), never configuration values; the same text was already printed inside `ConfigUnavailable` |
</threat_model>

<verification>pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular && pnpm check:error-tags</verification>

<success_criteria>11 → 14 (15) tags classified; the mirror deleted; a new link error without a tag-set entry fails typecheck or `LinkErrors.test.ts`.</success_criteria>

## Comments
Done. Q8 = yes: `SessionLifecycle.Conflict` (tag "SessionLifecycle/Conflict") added; 15 tags. `Auth.LinkError`, `linkErrorTags` (satisfies), `isLinkError` (Predicate.hasProperty + Object.hasOwn); `linkErrorCodes` deleted from Config.ts. LinkErrors.test.ts: 18 cases green (15 triggers, table-vs-tags, negatives, source scan). LinkerInvariantViolation cannot be provoked from a well-formed input, so its trigger throws a constructed instance (commented). EmptyPluginTuple is provoked via `Auth.make([])` under @ts-expect-error. ConfigLoader 12/12 green. tsc/circular/check:error-tags clean for touched files.
