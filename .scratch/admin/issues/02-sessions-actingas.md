# 02 — `actingAs` on `Sessions.issue`/the `Session` row, with hard expiry

**What to build:** `Sessions.issue` accepts a new, optional `actingAs: {
type: string; id: string }` parameter and persists it immutably on the
issued session's own row (no `update`/`jsonUpdate` variant — the same
insert-only shape `secretHash`/`absoluteExpiresAt` already have) in both
`layerMemory` and `layerSql`. When `actingAs` is present at issuance,
`idleExpiresAt` is set equal to `absoluteExpiresAt`, and `Sessions.verify`'s
idle-refresh touch (BEH-EA-052) is skipped for that row for its whole
lifetime — the complete mechanism behind INV-EA-014's "hard expiry, no
sliding refresh." This is a generic, `Admin`-agnostic extension to
`@effect-auth/core` — no new plugin code is added by this ticket, and no
existing caller's behavior changes (every current call site simply omits
`actingAs`).

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `SessionsShape.issue`'s input type gains an optional `actingAs: {
      readonly type: string; readonly id: string }` field
- [x] Both `layerMemory` and `layerSql` persist `actingAs` on the row at
      issuance and never allow it to be modified afterward
- [x] A session issued with `actingAs` gets `idleExpiresAt =
      absoluteExpiresAt` at issuance (not merely "a long idle window")
- [x] `Sessions.verify`'s touch/idle-refresh logic is skipped whenever the
      fetched row's `actingAs` is present, proven via `TestClock` the same
      way BEH-EA-052's existing idle-refresh tests already do (advancing
      time and asserting `idleExpiresAt` is unchanged)
- [x] A session issued with no `actingAs` behaves exactly as it does today
      — existing `Sessions.test.ts` cases keep passing unmodified
- [x] New `Sessions.test.ts` cases cover: `actingAs` round-trips through
      both layers; idle-refresh is skipped for an `actingAs` session; an
      ordinary session's idle-refresh is unaffected (BEH-EA-209/210)

## Result

Done. `Sessions.issue` gained both `actingAs?: { type, id }` and
`absoluteDuration?: Duration.Duration` (see **Correction** below);
`SessionView`/`SessionRow` gained `actingAs: Option.Option<ActingAs>`.
`@effect-auth/sql`'s `Session` model gained two new nullable, insert-only
columns (`actingAsType`/`actingAsId`), excluded from `update`/`jsonUpdate`
the same way `secretHash`/`absoluteExpiresAt` already are. Both
`layerMemory` and `layerSql` set `idleExpiresAt = absoluteExpiresAt` at
issuance whenever `actingAs` is present, and `verify` skips its
touch/idle-refresh entirely for such a row in both layers. New
`Sessions.test.ts` cases cover the round-trip, the hard-expiry-at-issuance
assertion, and the idle-refresh skip (via `TestClock`), plus confirm an
ordinary session's own idle-refresh is unaffected. Every existing
`Sessions.test.ts`/`packages/sql/test/Repositories.test.ts` case (the
latter's own hand-built `Session.insert` fixtures needed the two new
required-but-nullable columns added) keeps passing unmodified.

**Correction (found while building ticket 05)**: this ticket's own text
never mentions a per-call absolute-duration override, but ticket 05's
`AdminConfig.maxDuration` requirement ("hard expiry from
`AdminConfig.maxDuration`") has no way to reach `Sessions.issue` without
one — the ambient `SessionConfig.absolute` is a single, global duration.
Added `issue`'s optional `absoluteDuration` override (defaults to
`SessionConfig.absolute` when omitted) as a small, generic, `Admin`-agnostic
extension in the same spirit as `actingAs` itself.
