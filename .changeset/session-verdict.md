---
"@awthaq/core": patch
"@awthaq/ports": patch
---

A `Sessions.verify` that loses the rotation race to a row that has meanwhile expired now publishes `auth.session.expired` with its `absolute`/`idle` kind, like every other expired presentation (ESA-006, BEH-EA-053). `SessionStore.expiryOf` names which deadline a session record has passed; `isLive` is defined by it. The rules of `verify` are one internal pure function (ADR-EA-014 rev 1.4).

Migration: none. A token that starts with `.` is now answered as malformed (`SessionNotFound` without an id) instead of as an unknown empty id.
