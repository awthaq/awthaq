# Slice validation & fix-planning brief (shared by all slice agents)

Repo: `/Users/mohammadalmechkor/Projects/Perso/effect-auth` (awthaq, TypeScript auth runtime on Effect v4).
Validate against **HEAD** (`git rev-parse --short HEAD`). Record the SHA in your output.

## Your job

You own one slice manifest `.plan/_manifests/<slice>.tsv` (one row per open issue from the 2026-09-19 audit).
For **every** row:

1. **Read the issue file** (`.issues/<level>/<ID>-*.md`) — Summary, Evidence, Recommended fix, Related findings, and
   any `## Comments` (some highs already carry a Validation + Decision; the decision links to a wayfinder ticket under
   `.scratch/resolve-ready-for-human-findings/issues/NN-*.md` — read it; **follow that decision, don't re-litigate it**).
2. **Validate against the current code, not the audit's quote.** Line numbers have drifted since the audit (100+
   commits landed). Open the cited file, find the construct, grep the repo for any fix. Also run
   `git log --oneline --grep=<ID>` and grep other `.issues/` files' Comments for the ID — a sibling finding's
   resolution often fixed this one too.
3. **Assign exactly one verdict:**
   - `CONFIRMED` — defect exists at HEAD as described.
   - `PARTIAL` — part of the claim holds; state precisely which part and which part is fixed/overstated.
   - `ALREADY-FIXED` — no longer reproduces; cite the commit (`git log -S` / `--grep`) and the code that fixes it.
   - `INVALID` — the claim misreads the code/spec; show the evidence that refutes it.
   - `DUPLICATE` — same root cause as another ID (name the canonical ID — prefer the highest-severity / earliest one,
     cross-slice IDs allowed). Still give evidence.
   - `WONTFIX-CANDIDATE` — real but should not be actioned (out of scope per spec/roadmap, targets `node_modules`,
     pure opinion, etc.); give the rationale. Findings against `node_modules/@qadi/*` belong to the user's own qadi
     repo at `../qadi` — plan them there instead if real.
4. **Evidence is mandatory for every verdict:** `path:line` at HEAD plus a short verbatim snippet (≤ 8 lines) of the
   current code/spec that proves the verdict. For ALREADY-FIXED also the commit SHA. For INVALID the refuting snippet.
   Never write a verdict from the issue text alone.
5. **For CONFIRMED / PARTIAL / DUPLICATE-canonical issues write a fix plan:**
   - Concrete steps naming exact files/symbols to change (and new files to add).
   - Tests: the failing test to write first (TDD — the repo's convention), file + scenario name; note if a
     `features/**/*.feature` BDD scenario or `spec/behaviors` BEH-EA-### text must change too.
   - Acceptance criteria (observable, checkable).
   - Effort `S` (<1h) / `M` (half-day) / `L` (1–2 days) / `XL` (multi-day, needs decomposition).
   - Dependencies on other IDs (blocked-by), and the **workstream** it belongs to (a short kebab slug shared by issues
     that must/should be fixed together — reuse slugs across your slice; the orchestrator merges across slices).
   - `needs_decision`: true only if a product/design call is genuinely open (no existing decision covers it) — then
     list the options and give **your recommendation** (see preferences below). Recommended target status:
     `ready-for-agent` if fully specified, `ready-for-human` if a decision is open, `resolved` for ALREADY-FIXED,
     `wontfix` for INVALID / WONTFIX-CANDIDATE, and `resolved` (as duplicate) for DUPLICATE.

## Hard constraints

- **Read-only on the repo.** Do NOT edit source, tests, specs, or `.issues/` files. The ONLY files you may write are
  your two outputs: `.plan/slices/<slice>.md` and `.plan/slices/<slice>.json`. Scratch work goes in `/private/tmp/…/scratchpad`
  if needed. You may run read-only commands (grep, git log/show/blame, `pnpm vitest run <file>` for an existing test).
- Don't skip rows. Every ID in the manifest must appear in both outputs. If you truly can't validate one, verdict
  `PARTIAL` with `confidence: low` and say what's missing.
- Fix plans must respect the user's standing preferences:
  - **No type assertions** (`as`, `as unknown as`, `as any`) anywhere in library source — plan schema decoding / type
    guards / narrowing instead.
  - **No return-type annotations** on new Effect/Layer consts — let inference infer.
  - **Type-system-first plugins**: plugin composition via Layer types; never argue from "API stability" — product value wins
    (the library is pre-release).
  - **Flexibility over complexity**: when a trade-off pits complexity vs richness/configurability, recommend the richer
    option — but don't plan speculative infra nobody uses.
  - Effect v4 source is at `../effect` (check real APIs there, e.g. `effect/unstable/httpapi`); authorization is delegated
    to the user's qadi library at `../qadi`.
- Spec lives in `spec/` (`overview.md`, `decisions/`, `behaviors/` with BEH-EA-### ids, `traceability.md`,
  `invariants.md`, `roadmap.md`). A fix that changes behavior must name the BEH-EA id(s) it touches.
- Verification commands for the plan: `pnpm run typecheck`, `pnpm run test`, `pnpm run test:bdd`,
  `pnpm run spec:verify:strict`, `pnpm lint`, `pnpm knip` (full gate: `pnpm check`).

## Output 1 — `.plan/slices/<slice>.json`

```json
{
  "slice": "<slice>", "validated_at_sha": "<sha>", "validated_on": "2026-09-29",
  "issues": [
    {
      "id": "OIT-001", "level": "high", "category": "security", "package": "oauth",
      "title": "…", "issue_file": ".issues/high/OIT-001-….md", "current_status": "ready-for-agent",
      "verdict": "CONFIRMED", "confidence": "high",
      "evidence": [{"path": "packages/oauth/src/OAuth.ts", "line": 640, "snippet": "…", "note": "…"}],
      "fixed_by_commit": null, "duplicate_of": null, "duplicates": ["…"],
      "workstream": "oauth-oidc-claims-integrity",
      "fix": {"summary": "…", "steps": ["…"], "files": ["…"], "tests": ["…"], "acceptance": ["…"],
              "spec_refs": ["BEH-EA-122"], "effort": "S"},
      "depends_on": [], "needs_decision": false, "decision_options": null, "recommendation": null,
      "recommended_status": "ready-for-agent"
    }
  ],
  "workstreams": [
    {"slug": "…", "title": "…", "ids": ["…"], "rationale": "…", "order_hint": 1, "effort": "M", "depends_on_workstreams": []}
  ]
}
```

Must be valid JSON (verify with `python3 -m json.tool`). `fix` is `null` for ALREADY-FIXED / INVALID / WONTFIX-CANDIDATE / non-canonical DUPLICATE.

## Output 2 — `.plan/slices/<slice>.md`

1. **Header** — slice name, SHA, date, counts table (verdict × level), one-paragraph summary of what's really wrong in this area.
2. **Workstreams** — for each: title, IDs closed, why grouped, ordered steps for the whole group, test plan, acceptance, effort, cross-workstream deps.
3. **Decisions needed** — only genuinely open ones, each with options + recommendation.
4. **Per-issue dossiers** (grouped by workstream, highest severity first) — for each ID:
   `### <ID> — <title>` · level/category/package · link to issue file · **Verdict** (+confidence) ·
   **Evidence at HEAD** (path:line + fenced snippet) · **Fix plan** (steps/files/tests/acceptance/effort/deps) or the
   rationale for no fix · **Recommended status**.
5. **Closed without work** — table of ALREADY-FIXED / INVALID / DUPLICATE / WONTFIX-CANDIDATE with one-line reason + evidence pointer.

Be exhaustive and specific; this document is what an implementing agent will execute from without re-reading the audit.
When done, reply with a ≤ 10-line summary: counts per verdict, workstreams list, any decisions needed, and any
cross-slice duplicates you spotted (IDs outside your manifest).
