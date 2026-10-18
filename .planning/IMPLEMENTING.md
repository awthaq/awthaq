# How an agent implements a plan (rules shared by every assignment)

Repo: `/Users/mohammadalmechkor/Projects/Perso/effect-auth`, branch `architecture/deepening-plans` (already checked out; never switch branches, never push). One agent works in the tree at a time.

## Read first
`.planning/README.md` (conventions, wave order, reserved ADR numbers, cross-plan reconciliations), your plan's `PLAN.md` in full (including any "Decisions taken" section earlier plans appended), `AGENTS.md`, `docs/plugin-authoring.md`. Earlier plans are already merged on the branch: `git log --oneline` shows them; read their commit messages and "Decisions taken" sections when your plan's Interactions section depends on them. The repo pins `effect@4.0.0-rc.116`: check APIs in `node_modules/effect`, not `../effect`.

## Conventions
- No `as`, `as unknown as`, `as any` in library source. No return-type annotations on new Effect/Layer consts. Type-system first. Replace-don't-layer tests: delete tests that re-test moved behaviour.
- Open questions: take the plan's recommended default; if none, the richest option with a real caller (no speculative infrastructure). Record every default in a "Decisions taken" section appended at the END of the plan file, and in your final report.
- Line numbers in plans were verified at commit 38bcd1b; re-verify before editing.
- Spec updates: behaviors (+ Document Control revision/change history), `spec/traceability.md`, ADRs (new ADR numbers are reserved in the README), `docs/plugin-authoring.md`, READMEs, BDD scenarios under `features/`. Add changeset(s) in `.changeset/` (format: `.changeset/api-key-owner-standing.md`; breaking changes carry a `Migration:` line).

## Method
- TDD: failing test first, then implementation; phase by phase as the plan lays out. Run single test files often (`npx vitest run <path>`), typecheck often (`npx tsc -b tsconfig.json && npx tsc -p tsconfig.test.json --noEmit`).
- Gates before committing a phase: typecheck, lint, tests of every touched package, format (`npx oxfmt <paths>`). Before finishing the assignment also: `pnpm test` (full), `pnpm test:bdd`, `pnpm circular`, `pnpm format:check`, `pnpm spec:verify:strict`, `pnpm check:error-tags`, `pnpm check:readmes`, `pnpm package:smoke` when package exports/dependencies changed, and `pnpm test:pg` when a SQL adapter changed (needs a throwaway Postgres; see `scripts/test-pg.sh`; say so if you cannot run it).
- `pnpm knip` fails ONLY because of ~101 untracked files under `.reports/` (pre-existing; never commit them). Treat knip as passing if every reported unused file is under `.reports/`; fix anything else it reports (unused exports, deps).
- If a phase cannot be completed green, stop at the last green phase, commit that, and report exactly what remains. Never leave the tree red, never weaken or skip a test to get green, never claim anything you did not run.

## Commits
One commit per independently green phase (or one for the whole assignment if phases are not separable). Subject: `<type>(<scope>): <summary> (plan NN[ phase N])`. Stage by explicit path (never `git add -A`; never stage `.reports/`, `.claude/`, `.scratch/`). Every commit message MUST explain with boxed ASCII diagrams (box-drawing characters ┌─┐│└┘├┤▼►) the PROBLEM, the SOLUTION and a BEFORE/AFTER comparison. See `git show 2f56ab5` and `git show 01b82ea` for the expected style. End with exactly:
`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
Use `git commit -F -` with a heredoc.

## Final report (≤250 words)
Per phase what was implemented, test counts, every default decision taken, anything in the plan that was wrong or that you did NOT do (explicit), commit hashes.
