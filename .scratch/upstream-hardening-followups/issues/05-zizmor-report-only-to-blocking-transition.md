# 05 — Decide zizmor's report-only → blocking transition

**What to build:** a GitHub branch-protection ruleset that gates merges
on the zizmor finding classes actually worth blocking on, decided from a
real, triaged finding set rather than guessed upfront.

`.github/workflows/zizmor.yml` (added by
`.scratch/upstream-hardening/issues/06-zizmor-workflow-scanning.md`) scans
this repository's own GitHub Actions workflows and uploads SARIF findings
to GitHub's code-scanning UI, deliberately report-only — that ticket's
own answer named tightening to blocking as real follow-on work, "once
that first finding set has actually been seen and triaged," not part of
its own scope.

**Blocked by:** `zizmor.yml` actually running in CI and producing a real
finding set to triage — which itself needs a real GitHub remote for this
repository to exist and Actions to actually run on it (the same
prerequisite [ticket 04](04-wire-pkg-pr-new-previews.md) is blocked on,
tracked there — not a dependency on that ticket's own scope, just the
same external blocker). Not blocked by any other ticket in this list.

- [ ] A real GitHub remote exists and `zizmor.yml` has run at least once,
      producing an actual finding set in the code-scanning UI
- [ ] Every finding in that set is triaged (real issue vs. accepted risk
      vs. false positive for this repo's own workflows)
- [ ] A decision is recorded for which finding severities/classes should
      block a merge going forward, and why
- [ ] A GitHub branch-protection ruleset enforces that decision on
      `main`
