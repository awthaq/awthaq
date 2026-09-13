# 14 — Change-password rate limit

**What to build:** The change-password endpoint (ticket 11) is throttled
by identity.

**Blocked by:** 11, 12

**Status:** ready-for-agent

- [ ] Change-password keys on identity/email, matching the pattern
      established in ticket 12
- [ ] Exceeding the threshold yields a throttled response, asserted in
      ticket 11's own wire-level test file
