# 29 — README rewrite + Postgres-backed quickstart

**What to build:** The README accurately describes this project and
gives a prospective adopter a real, runnable quickstart against the new
Postgres backend.

**Blocked by:** 08, 09, 10, 11, 15

**Status:** ready-for-agent

- [ ] The stale "pre-implementation, no source exists" banner is removed,
      replaced with an accurate one-line status linking to
      `spec/roadmap.md` and this effort's wayfinder map for progress
      tracking
- [ ] A single flat quickstart (mirroring upstream's own ~500-line
      document shape) demonstrates a real `Auth.make(...)` composition
      against the Postgres backend from ticket 15, including sign-up/
      sign-in and at least one account-lifecycle endpoint from tickets
      08–11
- [ ] The quickstart code is actually runnable/copy-pasteable — verified
      by literally running it (or an equivalent smoke test), not just
      read for plausibility
- [ ] No separate `examples/` app is added — the quickstart lives
      entirely in the README
