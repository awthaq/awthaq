# zizmor workflow-security scanning

Type: grilling
Status: resolved
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

## Answer

Researched against zizmor's own docs (`docs.zizmor.sh/integrations`) and
`zizmorcore/zizmor-action`'s real tags (`git ls-remote`, confirming
`v0.6.4` — `cc914d7f3750a2d13d75c7f184a1060aa0e9d482` — is current).

**Own new workflow file (`zizmor.yml`), not a step in `check.yml`.**
Decided by ticket 05's own permissions work, not independently: zizmor's
SARIF-based integration needs `security-events: write` (to upload
findings) and `actions: read` (for private repos' upload-sarif workflow
info) — both strictly wider than `check.yml`'s just-narrowed
`contents: read`-only posture (ticket 05). Adding zizmor as a step
inside `check.yml`'s one job would force that job back open again,
undoing ticket 05's own work. A separate workflow keeps each file's
permissions minimal for what it actually does.

**Report-only via SARIF, non-blocking — this is zizmor's own designed
default, not a deliberate loosening of this repo's otherwise-strict
"8-gate check."** Per zizmor's own docs: "When using `--format=sarif`,
`zizmor` does not use its exit codes to signal the presence of
findings" — the workflow always succeeds; findings surface as GitHub
code-scanning annotations instead. Blocking is available, but
deliberately lives one layer up — GitHub's own branch-protection
rulesets on code-scanning alerts — not inside the workflow itself. This
also sidesteps the exact risk the ticket's own question flagged: locking
CI red on day one against zizmor's full, untriaged default finding set.
Tightening to blocking (via a ruleset) is real follow-on work once that
first finding set has actually been seen and triaged, not part of this
ticket's decision.

**Implementation — the `zizmorcore/zizmor-action`, SHA-pinned per
ticket 05's discipline**, not a raw `uvx zizmor` CLI invocation (the
action wraps SARIF upload automatically; the manual path would mean
re-implementing that wiring by hand for no benefit here):

```yaml
permissions:
  contents: read
  security-events: write
  actions: read
steps:
  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
  - uses: zizmorcore/zizmor-action@cc914d7f3750a2d13d75c7f184a1060aa0e9d482 # v0.6.4
```

Triggers mirror `check.yml`'s own (`pull_request`, `push: branches:
[main]`) for consistency, not because zizmor itself requires it.
