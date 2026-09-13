# 07 — `list` — the queryable audit trail

**What to build:** A gated listing endpoint over the `admin_impersonation`
audit trail (ticket 04): full history by default, newest-first, with an
`active` filter narrowing to episodes that haven't ended yet — both the
"what happened" and the "what's live right now" (a `sessionId` to hand
`forceStop`, ticket 06) use cases over the same one table.

**Blocked by:** Tickets 04, 05.

**Status:** done

- [x] `list` is gated by the same `canImpersonate` predicate as
      `impersonate`/`forceStop`
- [x] With no filter, returns every `admin_impersonation` row,
      newest-first
- [x] With `active: true`, returns only rows whose `endedAt` is still null
      (BEH-EA-219)
- [x] The endpoint and its response DTO exist on the `admin`
      `HttpApiGroup` in `AdminApi.ts`
- [x] `packages/admin/test/Admin.test.ts` (or a dedicated test file, the
      implementer's choice) covers both the unfiltered and `active`-filtered
      cases, including a mix of ended and still-active episodes in the
      same test

## Result

Done. `list` is gated by `canImpersonate` exactly like `impersonate`/
`forceStop` (publishing `impersonationDenied` on rejection too); it then
delegates to `ImpersonationRecords.list({active})`, which already returns
newest-first with an `active`-only filter (ticket 04). `AdminApi.ts`
declares `GET /admin` with a `query: { active }` param (query-string
booleans modeled as `"true" | "false"` literals, decoded in the handler)
and `ImpersonationRecordDto`. `Admin.test.ts` covers both cases in the
same test, mixing one ended and one still-active episode for the same
admin/target pair.
