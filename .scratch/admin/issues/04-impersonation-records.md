# 04 — `admin_impersonation` audit-trail persistence (`ImpersonationRecords`)

**What to build:** A new capability, owned by `@effect-auth/admin`, over a
durable `admin_impersonation` table (plugin-prefixed, per this project's
table-naming convention): `id`, `adminUserId`, `targetUserId`, `sessionId`,
`reason`, `startedAt`, `endedAt` (nullable), `endedBy` (`"self" |
"forcedByAdmin" | "expired"`, nullable). Independent of any impersonation
domain logic — this ticket is purely the persistence layer, the same role
`PasskeyCredentials.ts` played for `@effect-auth/passkey` before that
plugin's own registration logic existed. Ships both `layerMemory` and
`layerSql`.

**Blocked by:** Ticket 01.

**Status:** done

- [x] A record type and shape (`create`, `findById` or equivalent lookup,
      `endEpisode` — setting `endedAt`/`endedBy` exactly once, `listByFilter`
      or equivalent supporting a full-history and an active-only query) is
      defined, with both `layerMemory` and `layerSql` implementations
      (BEH-EA-215)
- [x] `layerSql`'s table is named with this plugin's own id prefix, so
      `runPluginContractTests` will pass for `Admin` once it composes
      (ticket 05)
- [x] Attempting to end an already-ended episode a second time is either
      rejected with a typed error or is a documented no-op — the ticket
      implementer picks one and states which in the `## Result` note; no
      double `endedAt` overwrite either way
- [x] `packages/admin/test/ImpersonationRecords.test.ts`: the same
      contract-suite-over-multiple-layers pattern
      `PasskeyCredentials.test.ts` established — create/find round-tripping
      every field against both `layerMemory` and `layerSql`; an
      active-only query excludes rows with `endedAt` set; a full-history
      query returns everything, newest-first

## Result

Done. `ImpersonationRecords` (`packages/admin/src/ImpersonationRecords.ts`):
`create`, `findBySessionId` (the practical lookup key — a session issued by
`impersonate` is 1:1 with its own audit row), `endEpisode`, `list({active?})`.
Table `admin_impersonation`, correctly prefixed for `runPluginContractTests`.

**Decision on double-ending**: rejected with a typed error
(`ImpersonationRecordNotFound`) — an unknown `sessionId` and an
already-ended one answer identically, the same enumeration-safety reasoning
`PasskeyCredentials.ts`'s own `rename`/`delete` document. This also gives
ticket 06's `forceStop` its 404 for free with no separate error type.
`ImpersonationRecords.test.ts` covers both layers, including the
already-ended-episode rejection and newest-first/active-only listing.
