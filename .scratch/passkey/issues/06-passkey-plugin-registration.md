# 06 — Passkey plugin scaffold and registration ceremony

**What to build:** `@effect-auth/passkey` becomes a real, installable
plugin: `Auth.make([Passkey])` composes, depending on `Sessions`/`Users`
per `AuthPlugin.Service`'s `dependsOn`. A browser can complete a full
registration ceremony — `register/options` then `register/verify` — and
have its credential persisted only after the server's own verification
succeeds against the challenge issued for that ceremony, never on a
client-asserted success alone (BEH-EA-130).

**Blocked by:** 02 — WebAuthn port and its layerSimpleWebAuthn
implementation, 03 — ChallengeStore interface and layerMemory

**Status:** done

- [ ] `Passkey` is declared via `AuthPlugin.Service`, `dependsOn: [Sessions,
      Users]`, contributing an `HttpApi` group with `register/options` and
      `register/verify`
- [ ] `PasskeyConfig` is a `Context.Reference` with a default (`rpId`,
      `rpName`, `origins: ReadonlyArray<string>`, `attestation` default
      `"none"`, `authenticatorSelection` defaults per BEH-EA-135), plus a
      `config(partial)` override function — the same pattern
      `@effect-auth/password`'s `PasswordConfig`/`config()` already
      establishes
- [ ] A `passkey_credential` table (plugin-id-prefixed) persists `id`,
      `webauthnUserId` (a random per-user handle, distinct from the
      internal user id), `publicKey`, `counter`, `deviceType`, `backedUp`,
      `transports`, `aaguid`, `name`, `lastUsedAt`, `createdAt`
- [ ] `register/verify` persists the credential only after
      `WebAuthn.verifyRegistration` succeeds against the challenge issued
      by `ChallengeStore` for that specific ceremony — a client claiming
      success with no valid server-side verification persists nothing
- [ ] Registration also creates an `Accounts` link (`providerId: "passkey"`,
      `subject`: the credential id) in the same operation, so the existing
      cross-plugin last-credential invariant will apply to this credential
      type automatically (verified properly in ticket 09, not here)
- [ ] Origin/rpId mismatch (BEH-EA-133) is rejected with the correct typed
      error (`PasskeyOriginMismatch`/`PasskeyRpIdMismatch`), comparing
      `(scheme, host, port)` as an exact tuple, `rpId` as a
      registrable-domain suffix — never a bare host match
- [ ] A replayed or expired challenge is rejected with
      `PasskeyChallengeInvalid`
- [ ] A failed verification is rejected with `PasskeyVerificationFailed`
- [ ] `Auth.make([Passkey])` composes (a real `AuthComposition.test.ts`,
      mirroring `Password`'s/`OAuth`'s own)
- [ ] Tests stub `WebAuthn` via `Layer.mock` (BEH-EA-195's established
      partial-double pattern) — no real CBOR/attestation parsing needed at
      this level

## Result

Done. `Passkey` plugin (`packages/passkey/src/Passkey.ts`), `PasskeyConfig`/`config()` mirroring `PasswordConfig`. `passkey_credential` table (`PasskeyCredentials.ts`, own `Model`/`SqlSchema`-based repository, both `layerMemory`/`layerSql`). `register/verify` persists only after `WebAuthn.verifyRegistration` succeeds against a `ChallengeStore`-issued, session-scoped challenge; origin/rpId checked as BEH-EA-133 requires (exact tuple / registrable-domain suffix) before ever calling the port. Registration also links an ordinary `Accounts` row (`providerId: "passkey"`), so BEH-EA-134's last-credential guard applies automatically. `AuthComposition.test.ts` proves `Auth.make([Passkey])` composes; `WebAuthn` stubbed via `Layer.mock`.

**Correction**: this ticket's own `dependsOn: [Sessions, Users]` doesn't match how `AuthPlugin.layer`'s `dependsOn` actually works — it's reserved for depending on *another plugin* (an `AuthPlugin.Any` class), not core services. `Password`/`OAuth` don't set it either; they `yield*` `Users`/`Sessions`/`Accounts` directly inside `make`, which is what `Passkey.layer` does too. `dependsOn` is left unset — see `Passkey.ts`'s own header comment.
