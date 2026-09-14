# Session token rotation on refresh

Type: grilling
Status: open

## Question

`Sessions.verify` (`packages/core/src/Sessions.ts:227-286`) already
idle-slides `lastActiveAt`/`idleExpiresAt` on touch, but the session
secret and its stored hash never change for the session's lifetime — no
session-fixation defense.

Decide: what triggers rotation (every touch? only past some idle
threshold? only on privilege-relevant events like password change?); how
the new secret reaches the client (a `set-auth-token`-style response
header/cookie write from within `verify`, analogous to upstream); what
happens to the old secret/hash after rotation (immediate invalidation vs.
a short grace window for in-flight concurrent requests); and how this
interacts with the existing idle-slide touch hook — one write path or two.
