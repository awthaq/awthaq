# zizmor workflow-security scanning

Type: grilling
Status: open
Blocked by: 05

## Question

No workflow-security scanning exists at all — confirmed, only `check.yml`
and `release.yml` exist in `.github/workflows/`.

Decide: whether zizmor runs as its own new workflow file or as a step
inside `check.yml`; and whether findings gate the build (fail on any
finding) or are report-only (SARIF upload to GitHub's code-scanning UI,
non-blocking) — given this repo's "8-gate check" is otherwise strict,
lean toward understanding what zizmor's default finding set actually
flags before committing to blocking.

Sequenced after ticket 05 (SHA-pinning) deliberately: zizmor itself flags
unpinned actions, so running it first would just surface ticket 05's own
gap as day-one noise.
