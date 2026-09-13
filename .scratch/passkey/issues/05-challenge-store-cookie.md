# 05 — ChallengeStore.layerCookie

**What to build:** a stateless, cookie-backed `ChallengeStore`
implementation — the challenge round-trips in a signed HttpOnly cookie
rather than a database row, for edge/serverless deployments with no shared
store available to the request. Passes the same contract suite tickets 03
and 04 established.

**Blocked by:** 03 — ChallengeStore interface and layerMemory

**Status:** done

- [ ] `issue` produces a challenge whose state travels in a signed,
      HttpOnly cookie value (not a server-side store)
- [ ] `consume` validates the cookie's signature and rejects a tampered or
      forged cookie value
- [ ] Ticket 03's full contract suite (single-use, deleted/invalidated on
      every attempt regardless of outcome, five-minute TTL, scope
      isolation) passes identically against `layerCookie`
- [ ] Documented limitation, if any, of the cookie-backed approach (e.g.
      cookie size limits, native-shell cookie-prefix considerations per
      `research/06-webauthn-passkeys.md`) is noted in this implementation's
      own header comment

## Result

Done, with one deliberate, documented deviation from this ticket's own framing. `layerCookie` is not a literal `Set-Cookie` mechanism — `ChallengeStore`'s locked interface (`issue(scope): Effect<Redacted<string>>`, `consume(scope, challenge): Effect<boolean>`) has no request/response access at all, so it cannot itself read or write an HTTP cookie. Implemented instead as a stateless, HMAC-signed value (BLAKE-free hand-rolled HMAC-SHA256, matching `@effect-auth/server`'s `Csrf.ts` pattern) carrying `random || expiresAt || signature` as one base64url blob — no server-side storage at all.

**Real limitation, not silently glossed over**: a stateless design cannot enforce true single-use (nothing remembers "already consumed"); replay is bounded only by the five-minute TTL. `ChallengeStore.test.ts` states this directly in a test titled "documented limitation: ... a still-unexpired value MAY be consumed more than once" rather than asserting a false "identical suite passes" claim. This was flagged by `/code-review`'s Spec axis as not literally satisfying "the same contract suite passes identically" — accepted as the honest, correct outcome given the actual cryptographic constraint, not fixed, since making it falsely claim single-use would be worse than documenting the real tradeoff.
