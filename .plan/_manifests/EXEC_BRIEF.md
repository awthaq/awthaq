# Execution brief: implementing one program of the audit-resolution plan

You are one of several agents, each in its **own git worktree** (own branch), implementing a *program* from `.plan/`.
Your program file is `.plan/programs/<PNN>-*.md` (workstreams → issue tables). Each issue row links to its full dossier in
`.plan/slices/<slice>.md` (evidence at old HEAD `ec065a7`, fix steps, files, tests to write first, acceptance criteria,
BEH-EA refs). `.plan/README.md` §2/§4/§5/§8 explain the method; `.plan/DECISIONS.md` holds the open design calls.

Already done on the base branch (do not redo): programs P01, P02, P03, P04, P05 (mostly), P06, P07, P08, P09, P13 are merged (see `git log`
and the `.issues/` comments — an issue with `Status: resolved` is done). Read the **Resolved** comments of neighbouring issues before touching a
shared file; they describe APIs that changed (e.g. `Sessions.revoke*` require a `reason`; `Authentication.resolveSession` takes a `scheme`;
CSRF secrets must be >= 32 bytes; core migration ids up to 20 and ADR ids 017/019/024/025/026 are taken; BEH-EA-221..224 are taken).
Remaining open work is in `.plan/programs/*.md` rows whose `.issues/` file is not `resolved`.

## Setup (first thing)

1. `pwd` — confirm you are in a worktree, not `/Users/mohammadalmechkor/Projects/Perso/effect-auth`. Never edit the main checkout.
2. `pnpm install --offline` (fall back to `pnpm install`). Then `pnpm run typecheck` once to confirm a clean baseline.
3. Read your program file and `.plan/README.md`. Skim `AGENTS.md` and `spec/README.md`.

## Per-issue protocol (README §8)

1. Read the dossier. **Re-verify the evidence at current HEAD** — lines drift and other agents/commits have landed. If the defect no
   longer reproduces, close the issue as already-fixed with proof (no code).
2. **Red**: write the failing test named in the dossier first (vitest under `packages/<pkg>/test/`; BDD only if cheap). Run it and
   confirm it fails *for the stated reason*.
3. **Green**: implement the planned steps. Do canonical issues first; their fix closes the listed duplicates.
4. Update the `spec/behaviors` BEH-EA text (and `spec/traceability.md` if you add ids) when behavior changes. New ADR/BEH numbers assumed by
   dossiers must be re-checked against the repo.
5. **Gate** before each commit: `pnpm run typecheck`, the touched packages' tests, then the full `pnpm run test`, `pnpm run test:bdd`,
   `pnpm run spec:verify:strict`, and `pnpm exec oxlint <touched packages>`. (`pnpm lint` at the repo root has pre-existing errors in
   `packages/ports/src/ClientAddress.ts` and `packages/core/test/HttpApiTypes.test.ts` — not yours.) Long commands: use a big `timeout`.
6. **Close in `.issues/`**: `python3 .plan/_manifests/resolve.py <file-stem-or-unique-ID> "<what changed: files/symbols, tests + proof it was red, gates, anything deferred>"`
   — it sets `Status: resolved`, appends the comment, and also closes every plan duplicate of that issue (`--no-dups` to skip).
   IDs `AH-`, `ESS-`, `SMS-`, `TS-` are ambiguous: use the file stem (e.g. `TS-001-tim-smart`).
   Issues you decide **not** to do (out of scope / blocked) stay open; add a `**Plan note (date):**` comment saying why.
7. **Commit** per workstream (or per issue for big ones) on your worktree branch, imperative summary + `(<IDs>)`, ending with the
   trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. **Never push, never touch the main checkout, never rewrite history,
   never `git add` `.reports/`, `.scratch/` or `.claude/`.** Don't edit anything under `.plan/` except via `resolve.py` (it edits `.issues/`).

## Hard constraints (user's standing preferences)

- **No type assertions** anywhere in library source: no `as`, `as unknown as`, `as any` (a lint-disable does not count). Use Schema decoding,
  type guards, narrowing. (`as const` is also best avoided.) Tests: keep casts minimal; prefer helpers/`assert`.
- **No return-type annotations** on new Effect/Layer consts — let inference infer.
- **Type-system-first plugins**: composition via Layer types; never argue from "API stability" (the library is pre-release; product value wins).
- **Flexibility over complexity**: when a trade-off pits complexity vs richness/configurability, ship the richer option — but no speculative unused infra.
- Effect v4 sources live at `../effect` (check real APIs there); authorization is delegated to the user's qadi library at `../qadi`
  (qadi-side fixes belong there only if the dossier says so; you may edit `../qadi` files only if the plan names it — otherwise note it as deferred).
- Match surrounding code: comment density, naming, idioms. Comments explain *why* (cite the issue ID), not what.

## Decisions

If a dossier says `needs_decision` (⚖️ in the table): use the dossier's **recommendation** (it already encodes the user's preferences) and
record `Decision (date): adopted recommended option <X> per plan; user may revisit` in the issue comment. Do not stall on decisions. Only stop
work on an issue if the recommendation is missing or you find it unsafe — then leave it open with a Plan note.

## Scope discipline

- Work **only your program's issues**. If an issue depends on another program's unfinished work (its `Blocked by`), skip it, leave a Plan note,
  and continue. If a fix needs a tiny change in a shared file another program owns, make the smallest possible change and mention it in the
  commit message — other agents run in parallel, so **expect merge conflicts to be resolved by the orchestrator; keep diffs tight** and avoid
  drive-by reformatting/renames/moves.
- Wontfix candidates: leave them alone unless your dossier says to act.
- Large/XL issues: implement the dossier's steps in order; if you cannot finish an XL issue, land a coherent, gate-green partial slice, keep
  the issue open with a Plan note listing exactly what remains.
- Do not stop early: work through **every workstream in your program** in the order given, highest severity first. Budget your effort so the
  high-severity items are finished properly before the long tail of low/info items; for low/info doc items batch several per commit.

## Final integration step (mandatory, before the report)

Other agents keep landing on `plan/resolve-audit-issues` while you work. When your program is done: `git merge plan/resolve-audit-issues` INTO YOUR
worktree branch (real merge, no rebase/force), resolve every conflict keeping BOTH sides' intent (renumber your ADR/BEH/INV/migration ids if
they collide; regenerate `pnpm-lock.yaml` with `pnpm install --offline` after merging it), then re-run ALL gates from a CLEAN build (delete
`packages/*/lib`, `examples/*/lib`, `features/lib`, every `*.tsbuildinfo`): `pnpm run typecheck` (must be 0 errors) + `npx tsc -p tsconfig.test.json`,
full `pnpm run test` (timing flakes under load: `--testTimeout=120000`), `pnpm run test:bdd`, `pnpm run spec:verify:strict`, `pnpm run check:readmes`,
`pnpm run circular`, `pnpm run package:smoke`, oxlint on touched packages. Commit the merge. The orchestrator then fast-forwards your branch.

## Final report (≤ 25 lines)

Branch name, HEAD SHA, issues closed (IDs), issues left open with reason, new defects discovered, decisions adopted, gate results
(typecheck / test count / bdd / spec:verify / oxlint), and any files you touched outside your program's packages (conflict hints).
