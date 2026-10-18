---
"@awthaq/oauth": minor
---

Concurrent first callbacks for one provider identity now sign in as one user instead of answering `AccountExists`/`OAuthCallbackFailed`. An explicit link of an identity already linked to another account now answers `OAuthCallbackFailed` (`account-already-linked`) and no longer refreshes that account's tokens; a link for a user erased before the callback answers the same opaque failure. An account removed during a callback is resolved again instead of a 500. Auto-links and explicit links publish `auth.account.linked`. The decision moves to core's `FederatedIdentity` (ADR-EA-043, BEH-EA-338).

Migration: none for callers. A host that relied on an explicit link silently "succeeding" for an identity linked elsewhere now gets the refusal (BEH-EA-123, ADR-EA-043).
