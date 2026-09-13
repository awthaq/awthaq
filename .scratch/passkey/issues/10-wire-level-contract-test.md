# 10 — Full wire-level contract test

**What to build:** the entire `passkey` HTTP group — registration,
conditional-create, authentication (both paths), and credential management
— exercised end to end over a real `HttpRouter`/`HttpRouter.toWebHandler`,
mirroring `Password`'s/`OAuth`'s own `AuthHttp.test.ts`. This is the closing
proof that the actual wire-level request/response shapes (status codes,
`Set-Cookie` on successful authentication, error response shapes) work
together as one coherent contract, not just that each ceremony's domain
logic is individually correct.

**Blocked by:** 07 — Conditional-create registration endpoint, 08 —
Authentication ceremony, 09 — Credential management

**Status:** done

- [ ] A full registration ceremony (`register/options` → `register/verify`)
      over real HTTP persists a credential and returns the expected
      response shape
- [ ] The conditional-create endpoint is reachable only with a session
      cookie already present
- [ ] A full authentication ceremony over real HTTP (both username-first
      and usernameless) sets a real session cookie on success
- [ ] `credentials` list/rename/delete work over real HTTP, including the
      last-credential-refusal case returning the correct status/error body
- [ ] Every typed error from `spec/behaviors/17-passkey.md`'s BEH-EA-136
      list lands on its own distinct, correctly-mapped HTTP status —
      verified at least once each somewhere in this suite (individual
      ceremony tickets may have already covered the domain-level case;
      this ticket confirms the HTTP-layer mapping)
- [ ] `WebAuthn` remains mocked (`Layer.mock`) here too — this ticket
      proves the wire contract, not the cryptography, which ticket 02
      already covers separately

## Result

Done. `packages/passkey/test/AuthHttp.test.ts`: a full registration ceremony over real HTTP persists a credential (200); `register/options`/`register/options/conditional` both require a session (401 without, 200 with); a full authentication ceremony sets a real `__Host-session` cookie; an unknown credential answers 401 `InvalidCredentials`; credential list/rename/delete work over HTTP, including 409 (last-credential) and 404 (unknown id); OpenAPI/Scalar docs serve. `WebAuthn` stays mocked.

**One BEH-EA-136 error not wire-tested**: `PasskeyCounterAnomaly` never reaches any endpoint's response by design (it's an internal `AuthEvents` publish, ceremony still succeeds — see ticket 08's own result note) — its domain-level behavior is covered in `Passkey.test.ts` instead. Its `httpApiStatus: 409` annotation (added purely for BEH-EA-136 taxonomy completeness) is never independently wire-verified, though the same declarative mechanism is proven correct elsewhere in this same file for `PasskeyCredentialNotFound`/`PasskeyLastCredential`.
