# 13 — OAuth callback rate limit

**What to build:** The OAuth callback endpoint is throttled by IP.

**Blocked by:** 12

**Status:** ready-for-agent

- [ ] OAuth callback keys on IP alone — no identity exists yet at that
      point in the flow
- [ ] Exceeding the threshold yields a throttled response, asserted in
      the OAuth plugin's existing wire-level test file
- [ ] Uses the exact same `RateLimits` mechanism/pattern established in
      ticket 12 — no parallel implementation
