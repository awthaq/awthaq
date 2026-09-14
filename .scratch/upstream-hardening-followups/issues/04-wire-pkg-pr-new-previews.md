# 04 — Wire `pkg-pr-new` preview installs

**What to build:** every pull request gets an installable preview build
of the packages it touches, via `pkg-pr-new`'s own npm-compatible URLs —
the DX win the pasted upstream-comparison report originally cited,
decided but deliberately deferred in
`.scratch/upstream-hardening/issues/08-npm-publish-smoke-path.md`'s own
answer.

Confirmed via `pkg-pr-new`'s own README during that ticket's research:
it does **not** care about `"private": true` at all (it never publishes
to the real npm registry). The actual blocker is that it requires
installing the `pkg-pr-new` GitHub App on the repository, which needs a
real GitHub remote to attach to — this repository has none yet
(`docs/agents/issue-tracker.md`'s own header: "no GitHub/GitLab to point
at yet").

**Blocked by:** a real GitHub remote for this repository, and the
`pkg-pr-new` GitHub App installed on it — manual, agent-inaccessible
setup, the same category
`.scratch/shipping-gaps/issues/06-release-governance-readiness.md`'s own
residual OIDC trusted-publishing note already tracks. Not blocked by any
other ticket in this list.

- [ ] A GitHub remote exists for this repository and the `pkg-pr-new`
      GitHub App is installed on it (external prerequisite — confirm
      before starting the rest)
- [ ] A CI step (new, or added to an existing workflow) runs `pkg-pr-new`
      on every pull request, publishing a preview for every package that
      changed
- [ ] The preview install command is surfaced somewhere a PR author/
      reviewer will actually see it (a PR comment, or wired through
      whatever mechanism `pkg-pr-new`'s own GitHub App already provides)
