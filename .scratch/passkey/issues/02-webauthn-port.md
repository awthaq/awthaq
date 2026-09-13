# 02 — WebAuthn port and its layerSimpleWebAuthn implementation

**What to build:** `@effect-auth/ports` gains a `WebAuthn` port (BEH-EA-129)
with four methods — `registrationOptions`, `verifyRegistration`,
`authenticationOptions`, `verifyAuthentication` — and exactly one shipped
implementation, `layerSimpleWebAuthn`, wrapping `@simplewebauthn/server`.
This is a self-contained capability, independent of the passkey plugin
logic that will sit above it: it can be built and tested entirely on its
own, against known-good WebAuthn test vectors, before any plugin code
exists to consume it.

As part of this ticket, correct `@effect-auth/ports/src/index.ts`'s header
comment, which currently states WebAuthn's port is "deliberately not yet
implemented" and that "nothing in spec/ or archive/ names WebAuthn's own
port methods" — this is stale; `spec/behaviors/17-passkey.md`'s BEH-EA-129
already names them exactly.

**Blocked by:** 01 — Wire package dependencies

**Status:** done

- [ ] `WebAuthn` is declared as a `Context.Service` (or equivalent port
      pattern) with the four methods per BEH-EA-129's interface
- [ ] `layerSimpleWebAuthn` wraps `@simplewebauthn/server`'s
      `generateRegistrationOptions`/`verifyRegistrationResponse`/
      `generateAuthenticationOptions`/`verifyAuthenticationResponse`
- [ ] Registration verification rejects a tampered/forged response and
      succeeds for a real, correctly-signed one (against known-good test
      vectors)
- [ ] Authentication verification rejects a tampered assertion, a wrong
      origin, and a wrong rpId, and succeeds for a real, correctly-signed
      one
- [ ] `packages/ports/src/index.ts`'s stale header comment about WebAuthn
      being undesigned is corrected to reflect BEH-EA-129 already existing
- [ ] No `layerMemory`/`layerNoop` variant is added for this port — plugin-
      level tests will stub it via `Layer.mock` instead (a later ticket's
      concern, not this one's)

## Result

Done. `WebAuthn` port (`packages/ports/src/WebAuthn.ts`) with the four BEH-EA-129 methods, `layerSimpleWebAuthn` wrapping `@simplewebauthn/server`. `PasskeyVerificationFailed` is the port's one error, per BEH-EA-129's own type signature. `verifyRegistration`/`verifyAuthentication` always call the library with `requireUserPresence: false, requireUserVerification: false` — UP/UV *policy* enforcement is `@effect-auth/passkey`'s own job (see that plugin's header comments), never this port's.

Tests use a real software authenticator (`packages/ports/test/webauthnFixtures.ts` — an ECDSA P-256 keypair via `node:crypto`, CBOR/COSE via `@simplewebauthn/server/helpers`) to exercise genuine cryptographic verification, not only rejection paths: a real registration and authentication both verify; tampering, wrong origin, wrong rpId, and wrong challenge are each rejected as `PasskeyVerificationFailed`. Also fixed the stale header comment in `packages/ports/src/index.ts` claiming WebAuthn was "deliberately not yet implemented."

A real, non-obvious bug caught during implementation: passing the `ChallengeStore`-issued base64url challenge as a bare `string` to `@simplewebauthn/server`'s `challenge`/`userID` options double-encodes it (the library treats a string challenge as UTF-8 text to re-encode). Fixed by decoding to raw bytes first (`isoBase64URL.toBuffer`) — see `WebAuthn.ts`'s own header comment.
