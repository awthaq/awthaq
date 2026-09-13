# 19 — PKCE verifier/nonce encryption

**What to build:** PKCE verifier/nonce state is encrypted wherever it's
persisted — in the `__Host-oauth-state` cookie and in the `Verification`
`FlowPayload` — using the same encryption service as provider tokens.

**Blocked by:** 17, 18

**Status:** done

## Result

`@effect-auth/oauth`'s `OAuth.ts` now uses the ticket-18 `Encryption`
service directly: `authorize` encrypts the generated PKCE `codeVerifier`
and (for `"oidc"` providers) `nonce` before building `FlowPayload`,
using the flow's own freshly-generated `identifier` as AAD — binding
each ciphertext to the one flow it belongs to, the same row-binding
principle ticket 18 applied to `accessToken`/`refreshToken`. `callback`
decrypts both right after `consumed.payload` is validated as this flow's
own, before either value is used (`exchangeCode`'s `codeVerifier`,
`verifyIdToken`'s `nonce`). A decrypt failure — a tampered envelope, or a
`kid` this `KeyProvider` no longer knows about — maps to the same
`OAuthCallbackFailed` every other validation failure in this handler
already produces, not a defect: this payload travels through
attacker-reachable request state (`input.state`/`input.cookieState`) to
reach this point, even though the ciphertext itself is the server's own.

**A real discrepancy this ticket's own investigation surfaced, resolved
by scoping to what's actually true rather than forcing the spec's
literal wording:** ticket 19's own acceptance criteria (and spec.md's
problem statement) describe PKCE state as living in *both* "the
`__Host-oauth-state` cookie and... `FlowPayload`". Tracing `OAuth.ts`'s
actual `authorize`/`callback` code (`encodeState`/`decodeState`, both
private to that module) shows the cookie only ever carries
`${identifier}.${value}` — the `Verification` entry's own opaque
correlation id and bearer secret (`value`, itself never persisted in
plaintext; only its SHA-256 `valueHash` is, per `Models.ts`'s own
`VerificationToken` design, BEH-EA-060) — never the raw PKCE
`codeVerifier`/`nonce` themselves. Those only ever live in
`FlowPayload`, which is exactly what `VerificationToken.payload` persists
server-side. So there is no plaintext PKCE material in the cookie to
encrypt in the first place; the cookie's own secret is already correctly
protected by a completely different, already-existing mechanism (a
same-origin/`httpOnly`/`secure` cookie plus server-side hash comparison
— a bearer-token model, not an at-rest-encryption problem). This ticket
delivers the one real target found: `FlowPayload`'s persisted
`codeVerifier`/`nonce`, encrypted exactly the way the acceptance
criteria's actual security goal requires.

New tests, `packages/oauth/test/OAuth.test.ts`'s "Ticket 19" describe
block (2): the persisted `FlowPayload`'s `codeVerifier`/`nonce`, read
back directly via `Verification.consume` (bypassing `OAuth.ts`'s own
`callback`, the same "read the real persisted value, not the module's
own claim about it" principle ticket 18's raw-`SELECT` test used),
decode to this module's own `{v, kid, iv, ciphertext}` envelope shape —
structurally incompatible with a raw base64url PKCE value, proving it
isn't just base64 of the plaintext either; and a full `authorize` →
`callback` round trip still completes correctly end-to-end with real
encrypted PKCE state in the middle (this ticket's own explicit
acceptance criterion). All 22 pre-existing `OAuth.test.ts` tests pass
unmodified in external behavior, plus all of `AuthHttp.test.ts`'s and
`AuthComposition.test.ts`'s.

Ripple: `OAuth.layer`'s requirements grew `Encryption` —
`packages/oauth/test/OAuth.test.ts` and `AuthHttp.test.ts` (`AppLayer`
and `ThrottledAppLayer` both) needed the same test `EncryptionLive`
(env-backed `KeyProvider.layerEnv` under an isolated `ConfigProvider`,
plus `NodeCrypto.layer`) ticket 18's own ripple already established
elsewhere in this monorepo.

`pnpm test` — 586 passed, 2 skipped (was 584; +2 new); `pnpm
typecheck`/`pnpm lint`/`pnpm format:check` clean workspace-wide.

- [x] The encryption service from ticket 18 is called from both the SQL
      persistence path and the cookie/`FlowPayload` path, proving it's
      genuinely shared rather than duplicated — called from both the SQL
      persistence path (ticket 18) and `FlowPayload` (this ticket); see
      Result above for why the cookie itself carries no PKCE plaintext
      to encrypt
- [x] PKCE verifier/nonce values are ciphertext in the
      `__Host-oauth-state` cookie and in any persisted `FlowPayload` —
      ciphertext in `FlowPayload`; the cookie carries no PKCE material at
      all (see Result)
- [x] Round-trip test: an OAuth flow using an encrypted PKCE value still
      completes correctly end-to-end
- [x] A test asserts the cookie's raw PKCE-carrying value is not the
      plaintext verifier/nonce — reframed to what's actually true: a
      test asserts the *persisted `FlowPayload`'s* raw value is not the
      plaintext verifier/nonce (the cookie itself never carries PKCE
      material — see Result)
