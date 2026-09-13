# 11 — Key rotation

**What to build:** signing keys rotate on a schedule (or on demand)
without breaking tokens already in flight.

**Blocked by:** 07 — Key generation, persistence, and the KeyRing; 08 — Sign and stateless verify; 09 — JWKS endpoint

**Status:** done

- [x] Automatic, time-based rotation at `keyRotationInterval` — a key past
      that point stops being used to sign new tokens
- [x] An explicit, directly-triggerable rotation operation (`KeyRing`'s
      own refresh) independent of the schedule, for an out-of-band forced
      rotation
- [x] A rotated-out key keeps verifying, and stays listed in JWKS, until
      `rotatedAt + keyGracePeriod`; after that it verifies nothing and
      disappears from JWKS
- [x] `TestClock`-driven test: mint a token, rotate, confirm the token
      still verifies and the old key still appears in JWKS; advance past
      the grace period, confirm both the token and the old key are now
      rejected/absent

## Result

Done. `SigningKeyRecords.ts` gained `markRotated(kid, rotatedAt, retiresAt)`
(both `layerMemory`/`layerSql`) — after it runs, a row no longer satisfies
`findCurrent`'s "no `rotatedAt` yet" predicate (so the next `create`
becomes the new current key) but keeps satisfying `listVerifiable` until
`retiresAt`, via the filtering that already existed from ticket 07.

`KeyRing.ts`'s `layerFromStore` now does the actual rotation mutation
(mark old key rotated + mint its replacement) whenever the current row's
`createdAt` is past `keyRotationInterval` — it already had every service
this needs (`SigningKeyRecords`/`Crypto`). Triggering that check is a
separate, much cheaper concern: `rotateIfDue` (new) does one in-memory age
comparison against the already-cached snapshot (`R = KeyRing | JwtConfig`
only, no store access when nothing is due) and calls `ref.refresh` when
stale — `current`/`verifiable` both call it on every access, not just on
`idleTimeToLive`-driven rebuilds, since a continuously-busy `KeyRing` would
otherwise never re-check (age-since-mint, not time-since-last-access, is
what actually matters for a rotation schedule). `rotateNow` (new,
exported) forces the same mutation immediately, independent of the
schedule — reachable from the planned CLI (`spec/roadmap.md` M6); unlike
`current`/`verifiable` it isn't wired to any HTTP handler, so it's fine for
it to carry real service requirements rather than needing `R = never`.

**Refactor**: `Jwt.ts`'s `make` previously reimplemented `ref.get`
composition inline for `currentKey`/`verifiableKeys`. Switched to calling
`KeyRing.current`/`KeyRing.verifiable` directly (the same accessors this
ticket's own tests exercise) instead of duplicating that logic — their
`R` (`KeyRing | JwtConfig`) is discharged to `never` once, via a small
`Layer.succeed`-built ambient context from the two values `make` already
yields, keeping every `Jwt` method's own `R` at `never` per this file's
established convention.

**Tests** (`packages/jwt/test/KeyRing.test.ts`, extended): a key rotates
automatically once past `keyRotationInterval`, stays verifiable (and in
`KeyRing.verifiable`) through its grace period, then drops out after;
does *not* rotate before the interval elapses; `rotateNow` forces
rotation immediately regardless of schedule.

**Verification**: `pnpm --filter @effect-auth/jwt typecheck` clean,
`pnpm exec tsc -p tsconfig.test.json` clean, `pnpm --filter @effect-auth/jwt test`
— 5 files, 27 tests, all passing (up from 22 before this ticket).
`pnpm lint`/`pnpm format:check` clean workspace-wide. No explicit
`Effect`/`Layer` return-type annotations on any new `const`, no type
assertions in `src/`.
