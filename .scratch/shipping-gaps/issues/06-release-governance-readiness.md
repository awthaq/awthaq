# 06 — Release & governance readiness

**Type:** grilling
**Status:** resolved
**Blocked by:** None — can start immediately

## Question

No `LICENSE`, `CHANGELOG`, `CONTRIBUTING`, or `SECURITY.md` exists
anywhere in the repo. `@changesets/cli` is already a root devDependency
with a `.changeset/config.json` and `changeset`/`changeset-version`/
`changeset-publish` scripts — present but inert, no changeset entries
exist. `spec/process/definitions-of-done.md` L43/L68-73 already commits
to a specific plan for M8: follow Effect's own release template
(pnpm workspaces + changesets fixed version group), publish only via npm
OIDC trusted publishing (no long-lived tokens, for automatic Sigstore
provenance), citing the ecosystem-wide classic-token revocation of
Dec 2025. No dedicated ADR exists for this beyond that one DoD-doc
paragraph.

Decide: (a) is `spec/process/definitions-of-done.md`'s existing plan
sufficient as-is, or does it need to graduate to a real ADR before
governance files get written against it? (b) LICENSE choice — MIT is
what the origin report's own recommendation assumed by analogy to
upstream; confirm that's actually the right call for this project rather
than assuming it. (c) CONTRIBUTING/SECURITY.md content — adapted from
upstream's own five governance files as a structural template (fine to
reuse *structure*, this isn't the "don't touch upstream's repo"
constraint, it's about writing this repo's own files), or written from
scratch? (d) does this ticket's destination include actually publishing
`0.1.0`, or only landing the scaffolding — the trusted-publishing OIDC
workflow requires one-time manual npm/GitHub configuration outside any
agent's reach, which would make "publish" a **task**-type ticket blocked
on that manual setup, not a decision this ticket can resolve alone. (e)
does knip (dead-export gate) and a `.github/dependabot.yml` belong here
as a minor addendum (as flagged in this map's charting decision), or as
their own follow-on?

## Answer

**(a)** `spec/process/definitions-of-done.md`'s existing M8 plan is
sufficient as-is — no need to graduate it to a formal ADR before writing
governance files against it.

**(b) License: MIT.** Matches upstream's own license; no signal toward
anything more restrictive.

**(c) CONTRIBUTING/SECURITY.md — structurally templated from upstream,
content is this repo's own.** Reusing document *structure* from
upstream's five governance files is fine (this is not the "don't touch
upstream's repo" constraint — nothing here edits their repository); the
actual content is written fresh for this project.

**(d) Scope — scaffolding only, publishing is a future task-type
ticket.** This map ships LICENSE, CHANGELOG (changesets-driven),
CONTRIBUTING, SECURITY.md, and a provenance-publish workflow that's
wired but never run. Actually cutting and publishing `0.1.0` needs
one-time manual npm/GitHub OIDC trusted-publishing setup outside any
agent's reach — that becomes its own **task**-type ticket (HITL, blocked
on the user) at `/to-tickets` time, not resolved further in this map.

**(e) knip + dependabot — included here as a minor addendum**, per this
map's own charting decision. Both are pure config-file additions; no
separate ticket needed.
