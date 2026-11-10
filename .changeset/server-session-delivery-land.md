---
"@awthaq/server": minor
"@awthaq/oauth": patch
---

`SessionDelivery.redirect` is replaced by `SessionDelivery.land`, which owns the PV-016 landing choice (architecture plan 33).

OAuth's callback answers exactly as before; it now calls `land` instead of building the interstitial itself.

Migration: replace `SessionDelivery.redirect(HttpServerResponse.redirect(url), issued)` with `SessionDelivery.land(url, issued)`; pass `{ bounce: false }` to keep the plain `302` under a `Strict` session cookie, and `undefined` for `issued` to decline `Mints`. ADR-EA-045 revision 1.1.
