---
"@awthaq/react": minor
---

A mutation against an endpoint the composed contract declares with a `SessionLifecycle` marker refetches the session (and the subject) on its own (ADR-EA-045, BEH-EA-178): `makeReactClient` always installs `ReactClient.sessionInvalidation`, the client half of the five markers, beside the default transport or a caller-supplied `httpClient`. A failed (non-2xx) mutation invalidates nothing.

Migration: drop `reactivityKeys: [SESSION_KEY]` from mutations against declared endpoints (keeping it is harmless); a mutation of your own outside the contract that changes the session still passes it.
