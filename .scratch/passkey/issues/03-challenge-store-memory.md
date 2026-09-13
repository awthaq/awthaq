# 03 — ChallengeStore interface and layerMemory

**What to build:** `@effect-auth/passkey` gains a `ChallengeStore`
capability (BEH-EA-132) — `issue(scope)`/`consume(scope, challenge)` — with
a `Ref`-backed `layerMemory` implementation. A challenge is deleted from
the store on every `consume` attempt regardless of outcome, and expires
within a bounded TTL (five minutes) if never used. `ChallengeStore` is
owned by this plugin, not `@effect-auth/ports` — only this plugin needs it.

**Blocked by:** 01 — Wire package dependencies

**Status:** done

- [ ] `issue(scope)` returns a fresh `Redacted<string>` challenge each call
- [ ] `consume(scope, challenge)` returns `true` for the exact challenge
      just issued for that scope, `false` for any other value
- [ ] A challenge is deleted after `consume` is called on it — a second
      `consume` with the same value returns `false` (single-use)
- [ ] Consuming a challenge with the *wrong* value still deletes it (BEH-EA-132's
      "deleted on every verification attempt... regardless of whether that
      attempt succeeds")
- [ ] An unconsumed challenge expires after five minutes (`TestClock`-driven,
      not a real wait) — `consume` after expiry returns `false`
- [ ] Two different scopes' challenges don't interfere with each other

## Result

Done. `ChallengeStore` (`packages/passkey/src/ChallengeStore.ts`) with `issue`/`consume` and `layerMemory`, matching BEH-EA-132 exactly: single-use (deleted on *every* consume attempt, matching or not), five-minute TTL via `TestClock`, scope isolation. Full contract suite in `packages/passkey/test/ChallengeStore.test.ts`, shared with tickets 04/05.
