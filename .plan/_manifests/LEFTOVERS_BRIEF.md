# Final round: resolve everything that is left

Read `.plan/_manifests/EXEC_BRIEF.md` first (setup, protocol, constraints, integration step) — it still applies. The base is the fully integrated
`plan/resolve-audit-issues` (895 of 934 issues resolved; `pnpm run check` is green). What changed since the brief was written:
- oxlint ENFORCES no type assertions in `packages/*/src` (`typescript/consistent-type-assertions: never`), lint must stay 0 errors / 0 warnings;
  `noPropertyAccessFromIndexSignature` is on; base lib is ESNext (DOM only in client/react/next/features/tests).
- **Definition of done = `pnpm run check` exits 0 from a CLEAN build** (delete packages/*/lib, examples/*/lib, features/lib, every `*.tsbuildinfo`;
  tsgo `-b` does not invalidate on lib changes) + `pnpm run check:readmes` + `pnpm run check:error-tags` + `pnpm run test:pg` if Docker is available.
  `pnpm workspace:sync` after adding a package/example. Add a `.changeset/*.md` (with a `Migration:` section when behavior breaks) for user-visible changes.
- Argon2/scrypt tests are slow under load; `testTimeout` is 30s in password/ports. Re-run flakes in isolation before blaming yourself.
- BEH-EA ids are used up to 298, ADR-EA up to 035, INV-EA up to 018, REQ-EA up to ~1186 (allocator: `features/scripts/allocate-req-ea.py`); core
  migrations up to 28. Check the max at merge time; other agents run in parallel and integrate serially — keep diffs tight, expect to re-merge.
- Closing: `python3 .plan/_manifests/resolve.py <file-stem> "<what changed…>"`. For issues the user authorised to be **closed as wontfix**, set
  `Status: wontfix` (edit the `Status:` lines in the file, frontmatter + the `Status: **…**` line) and append a `**Wontfix (date):**` comment with the
  rationale AND, when the finding named a real gap you are deliberately not fixing, what a user would do instead.
- **The user said "resolve all what's left".** For each item in your worklist: either fix it properly (TDD, spec/BEH text updated, docs) or, where
  the finding is an observation/positive note/upstream-forced/speculative, close it as wontfix with a rationale. Prefer doing real gaps when a
  contained implementation exists — the user's standing preference is *flexibility over complexity: ship the richer, more configurable option*,
  but never speculative unused infrastructure; type-system-first (Layer types); no "API stability" arguments (pre-release library).
- Do not stop early. Do not weaken tests/gates. Final report ≤ 25 lines: HEAD SHA, closed IDs (fixed vs wontfix), anything genuinely left + why, gates.
