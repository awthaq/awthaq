# Upstream hardening — follow-ups

Five independent tickets surfaced while implementing
[`.scratch/upstream-hardening/map.md`](../upstream-hardening/map.md)'s own
9 tickets (all already resolved and implemented, 3 commits on `main`) —
either found during that implementation's own code-review pass, or already
named as deferred/fog in the map itself. None of these were part of that
map's own scope; they're tracked here as their own frontier.

## Tickets

- [01 — Quote camelCase columns in the core SQL repositories](issues/01-quote-camelcase-columns-in-sql-repositories.md)
- [02 — Promote applicable `@effect/language-service` warnings to `error`](issues/02-promote-language-service-warnings-to-error.md)
- [03 — Request-scoped memoization so `Sessions.verify` runs at most once per request](issues/03-request-scoped-session-verify-memoization.md)
- [04 — Wire `pkg-pr-new` preview installs](issues/04-wire-pkg-pr-new-previews.md)
- [05 — Decide zizmor's report-only → blocking transition](issues/05-zizmor-report-only-to-blocking-transition.md)

All five are independent — no blocking edges among them. Tickets 04 and 05
each carry their own external blocker (a real GitHub remote + relevant App
installations existing), the same category of manual, agent-inaccessible
setup `.scratch/shipping-gaps/issues/06-release-governance-readiness.md`'s
own residual OIDC note already tracks — not a dependency on any other
ticket in this list.
