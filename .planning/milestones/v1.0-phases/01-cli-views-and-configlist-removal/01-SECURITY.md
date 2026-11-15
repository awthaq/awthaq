---
phase: "01"
slug: "cli-views-and-configlist-removal"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-11-14"
---

# Phase 01 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| CLI stdout/stderr | `awthaq plugin list`, `config list`, `openapi` and `migration apply` print to a terminal or a pipe that scripts parse | Effective configuration (secrets are redacted before rendering), plugin rows, migration status |
| `--format` / `--json` flag resolution | Operator-supplied flags decide text vs one JSON document; a wrong resolution changes what a consumer parses | Output mode |
| Planning artifacts (`01-BASELINE.md`) | Gate output committed to the repository | Gate results, knip path lists (no secrets) |
| Released package surface (`@awthaq/cli` export) | Removing `ConfigList` is a breaking export change for consumers | Public API |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-01-01 | Information disclosure | `01-BASELINE.md` content | low | mitigate | Baseline holds gate tables, knip path lists and counts only; grep for secret patterns hits only a hook path and a package name; no `.claude/`, `.reports/` or `.scratch/` file is committed | closed |
| T-01-02 | Tampering | `knip.json` | low | mitigate | `git diff --quiet a5ab6311 -- knip.json` exits 0; empty `git diff --stat` recorded in the baseline | closed |
| T-01-03 | Tampering | flag resolution in `PluginViews.resolve` | medium | mitigate | `PluginViews.ts` resolves `--format` and `--json` once; DOT forces `{ json: false }`; `Output.report` uses `options?.json ?? out.json`; `PluginViews.test.ts` pins every view x fixture x mode cell and real-argv cases | closed |
| T-01-04 | Repudiation | failure rendering (BEH-EA-225) | medium | mitigate | `failure` and `failureDocument` untouched; `PluginViews.test.ts` pins `awthaq: <msg>` on stderr with exit 9 and the JSON failure document only under global `--json`; `ExitCodes.test.ts` unchanged | closed |
| T-01-05 | Information disclosure | plugin row builders | low | mitigate | Row builders untouched; test asserts stdout equals `JSON.stringify(rows, null, 2)` of the builder output, nothing added | closed |
| T-01-06 | Information disclosure | `config list` after inlining into `Cli.ts` | high | mitigate | Redaction happens in `ConfigDescriptor.flatten` / `scrubCredentials` before `renderConfigItems` sees a string; `packages/core` and `Doctor.ts` have no diff; `Output.report` override is optional and not passed by `config list`; ECS-005 canary drives `runCli(["config","list"], config)` with three secret shapes and asserts none leak | closed |
| T-01-07 | Tampering | `openapi` stdout after the `Output.report` move | low | mitigate | `Inspection.test.ts` pins `openapi` and `--json openapi` byte-identical, one stdout entry, exit 0; `--out` branch unchanged | closed |
| T-01-08 | Repudiation | `migration apply` result line | medium | mitigate | `finish(true)` stays after `Migrations.apply`; a failed apply short-circuits before it; `Migration.test.ts` pins the `applied N migration(s)` line for `--yes`, absence for `--dry-run`, and one JSON document | closed |
| T-01-09 | Repudiation | breaking export removal not announced | medium | mitigate | Changeset `@awthaq/cli: minor` with one `Migration:` line; spec 26-cli Revision 1.10 and Change History row; traceability Revision 1.89; `pnpm spec:verify:strict` PASS 32 FAIL 0; no `ConfigList` left outside the changeset prose | closed |
| T-01-10 | Tampering | knip gate masking a regression | medium | mitigate | Filtered knip rule (drop `.claude/` and `.reports/`, allow only the 3 `readme-quickstart.ts` rows); independent re-run exits 1 as baseline with 0 extra findings | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

No accepted risks.

---

## Informational (non-blocking)

- The ECS-005 canary asserts the text path of `config list` against the secret fixture. `--json config list` against the same fixture is not asserted; the `--json` byte pin runs on a non-secret fixture. The JSON path emits the same already-redacted items, so no threat is opened. Adding a `runCli(["--json","config","list"], config)` canary case would close the asymmetry.
- Postgres-gated `Migration.apply` pins ran against the SQLite layer only (no local Postgres).

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-14 | 10 | 10 | 0 | gsd-security-auditor (ASVS 1, block on high) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-14
