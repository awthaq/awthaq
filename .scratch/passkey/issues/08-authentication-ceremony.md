# 08 — Authentication ceremony

**What to build:** `authenticate/options` and `authenticate/verify`, both
supporting a username-first path (an identifier scopes `allowCredentials`
to that user's own credentials) and a fully usernameless, discoverable-
credential path (`allowCredentials: []`, the assertion's `userHandle`
resolving the user after the fact) — neither gated behind a separate
opt-in flag, both first-class from day one (BEH-EA-131). A successful
authentication issues a real session through the core `Sessions` capability,
never setting a cookie itself.

**Blocked by:** 06 — Passkey plugin scaffold and registration ceremony

**Status:** done

- [ ] `authenticate/options` called with an identifier scopes
      `allowCredentials` to that user's registered credentials
- [ ] `authenticate/options` called with no identifier returns options for
      a fully discoverable-credential (usernameless) ceremony
      (`allowCredentials: []`)
- [ ] `authenticate/verify` maps a verified assertion's `userHandle` to the
      correct user for the usernameless path
- [ ] A successful verification issues a session via `Sessions` — the same
      capability every other credential plugin already uses, not a
      passkey-specific session-issuing path
- [ ] The credential's `counter` and `backedUp` fields are updated on every
      successful authentication
- [ ] A counter regression is flagged as `PasskeyCounterAnomaly` without
      hard-locking the account (log + step-up, not an instant kill)
- [ ] Missing required user verification is rejected as
      `PasskeyUserVerificationRequired`
- [ ] An unknown-credential authentication failure reveals nothing about
      whether any credential was ever registered for the supplied
      identifier — the same enumeration-safety discipline
      `InvalidCredentials` already applies to password sign-in
- [ ] A replayed or expired challenge is rejected as `PasskeyChallengeInvalid`

## Result

Done. `authenticate/options`/`authenticate/verify` support both username-first (`email` scopes `allowCredentials`) and usernameless (`allowCredentials: []`) paths, neither behind a separate flag. A successful verification issues a session via core `Sessions`. Counter/backup-state recorded on every success; a counter regression publishes `AuthEvents.PasskeyCounterAnomalyEvent` (a new event added to `AuthEvents.ts`'s closed union) without failing the ceremony ("log + step-up, not an instant kill"). Missing UV answers `PasskeyUserVerificationRequired`. An unknown-credential failure, and any origin/rpId/verification failure, all collapse into the same `Api.InvalidCredentials` password sign-in already uses (BEH-EA-136) — `PasskeyChallengeInvalid` and `PasskeyUserVerificationRequired` stay distinct since neither leaks account existence. See `PasskeyApi.ts`'s own header comment for the full enumeration-safety reasoning.

**Gap fixed during `/code-review`**: `PasskeyCounterAnomaly` (one of BEH-EA-136's 8 named errors) had no actual `Schema.TaggedError` class, only the internal `AuthEvents` event — added `PasskeyApi.PasskeyCounterAnomaly` for taxonomy completeness, documented as deliberately never appearing in any endpoint's error union.
