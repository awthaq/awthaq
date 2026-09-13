# 07 — README & quickstart scope

**Type:** grilling
**Status:** resolved
**Blocked by:** 01

## Question

`README.md` L5 states: "This project is currently pre-implementation: no
package has been published and no line of source exists yet." That's
false against 12k+ LOC of real, tested implementation across 20+
packages. Upstream's own README (502 lines, a runnable quickstart plus
OAuth and Drizzle wiring) is cited by the origin report as a DX
benchmark, but this repo is architecturally different (20-package
hexagonal plugin platform vs. upstream's single package) so the same
document shape may not transfer directly.

Decide, once ticket 01 has fixed what the actual current wire surface is:
(a) what does the quickstart itself demonstrate — the minimal
`TestAuth`/in-memory composition (fastest to show, matches how this
repo's own test suite already composes plugins), or a "real" composition
against the persistent backend from ticket 03 (richer, but couples this
ticket's timing to ticket 03's)? (b) does the README gain a runnable code
block only, or does this map's destination include a real `examples/`
app (upstream has one, this repo has none) — if the latter, that's
tracked in "Not yet specified" until this ticket sharpens it, not
pre-decided here. (c) structure — mirror upstream's single flat
502-line document, or lean into this repo's own existing spec-corpus
strength and keep the README shorter with links out to `spec/overview.md`
and per-package READMEs (if those don't exist per-package yet, does
creating them belong to this ticket)? (d) what happens to the stale
"pre-implementation" framing — replaced with an accurate one-line status
plus a link to real progress tracking (this map itself, `spec/roadmap.md`,
whatever's authoritative), not just deleted.

## Answer

**(a) Quickstart demonstrates a real composition against ticket 03's new
Postgres backend**, not the minimal `TestAuth`/in-memory path. This is a
soft implementation-order dependency on ticket 03 (in addition to this
ticket's own hard `Blocked by: 01`) — the README shouldn't be finalized
until the Postgres composition it documents actually exists.

**(b) No separate `examples/` app — README code blocks only.** Clears
the "runnable examples app" item out of this map's "Not yet specified"
fog; it's decided as out of this map's destination, not deferred fog.

**(c) Structure — single flat document mirroring upstream's ~500-line
shape**, not split out to `spec/overview.md` links. The full
account-lifecycle/OAuth/RBAC/Postgres story lives in one document,
matching the DX benchmark the origin report cited directly.

**(d) Stale banner** replaced with an accurate one-line status (real,
working library, N packages, M plugins shipped) linking to this map and
`spec/roadmap.md` for progress tracking — not simply deleted.
