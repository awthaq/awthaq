# 08 — Wire-level contract test for the whole `admin` group

**What to build:** `packages/admin/test/AuthHttp.test.ts` — the `admin`
group's own contract end to end over a real `HttpRouter`/
`HttpRouter.toWebHandler`, mirroring `packages/passkey/test/
AuthHttp.test.ts`'s shape: real HTTP requests/responses, real status codes,
a real session cookie, rather than only the domain-level assertions
tickets 05–07 already cover.

**Blocked by:** Tickets 05, 06, 07.

**Status:** done

- [x] `impersonate` over real HTTP: `200` (or the chosen success status)
      with a session cookie for the target identity on success; `403` for
      a denied gate; `400` for a bad `reason` or self-impersonation; `409`
      for nested impersonation
- [x] `stopImpersonating` and `forceStop` both answer `204` on success;
      `forceStop` answers `404` for an unknown/already-ended session id
- [x] `list` answers the audit rows over real HTTP, both unfiltered and
      with `?active=true`
- [x] The generated OpenAPI/docs endpoints include the `admin` group (the
      same check `packages/passkey/test/AuthHttp.test.ts` already makes for
      `passkey`)
- [x] `runPluginContractTests` passes for `Admin` (manifest legality, group
      ids, the `admin_impersonation` table prefix, migration determinism)

## Result

Done. `packages/admin/test/AuthHttp.test.ts` exercises the whole `admin`
group over a real `HttpRouter.toWebHandler`, mirroring
`packages/passkey/test/AuthHttp.test.ts`'s shape: a real session cookie
issued directly against the shared `Sessions` instance (via a shared
`memoMap`), real `POST`/`GET` requests, real status codes for every case
in the checklist. `/openapi.json` is asserted to include
`/admin/impersonate/{userId}`; `/docs` answers `200`.
`TestAuth.runPluginContractTests` (from `@effect-auth/test`, added as a
devDependency) runs against the real `Admin` plugin class at the bottom of
the same file, using a small `TestFramework` adapter over real
`describe`/`it`/`assert` rather than the recording framework
`packages/test/test/runPluginContractTests.test.ts` itself uses — all
checks pass (table prefix, no host-id collision, no `dependsOn` since it's
empty, deterministic migrations, contract stability).
