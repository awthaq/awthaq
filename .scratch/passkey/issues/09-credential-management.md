# 09 — Credential management

**What to build:** an authenticated user can list, rename, and delete their
own registered passkeys. Deleting a user's only remaining authentication
credential is refused; deleting one of several succeeds (BEH-EA-134) —
reached through the same cross-plugin `Accounts`/`LastAccountRefusal`
mechanism (BEH-EA-045) every other credential-contributing plugin already
relies on, not a second, passkey-specific "last credential" check.

**Blocked by:** 06 — Passkey plugin scaffold and registration ceremony

**Status:** done

- [ ] `GET credentials` lists the current user's own credentials only —
      id, an AAGUID-derived friendly label (falling back to a generic
      label when the AAGUID is unrecognized or zeroed), `deviceType`,
      `backedUp`, `createdAt`/`lastUsedAt`
- [ ] `PATCH credentials/:id` renames a credential the caller owns; fails
      for a credential belonging to another user
- [ ] `DELETE credentials/:id` removes both the `passkey_credential` row
      and its corresponding `Accounts` link in one operation
- [ ] Deleting a user's only remaining credential (across every credential
      type — passkey, password, linked OAuth account) fails with
      `PasskeyLastCredential`, mapped from the core `LastAccountRefusal`
      this deletion path reaches through `Accounts` — not a
      passkey-specific reimplementation of the same rule
- [ ] Deleting one of several credentials succeeds normally
- [ ] `PasskeyCredentialNotFound` is returned for an id that doesn't exist
      or doesn't belong to the caller (indistinguishable between the two,
      per the same enumeration-safety discipline as ticket 08's
      unknown-credential handling)

## Result

Done. `GET credentials` lists the caller's own rows only, with an AAGUID-derived friendly label (a small, explicitly non-exhaustive lookup, falling back to "Passkey" — a full registry is FIDO MDS3, out of scope). `PATCH`/`DELETE credentials/:id` both fail identically (`PasskeyCredentialNotFound`) for an unknown id and for one owned by another user. Deleting reaches `LastAccountRefusal` through `Accounts.unlink` (mapped to `PasskeyLastCredential`) — not a passkey-specific reimplementation.

**Noted, not changed**: `removeCredential` calls `accounts.unlink` then `credentials.delete` as two sequential effects, not one SQL transaction — `unlink` must run first (it's the only place the last-credential guard is enforced), and no other plugin in this codebase spans a transaction across two independently-owned services either. A `delete` failure right after a successful `unlink` is treated as a defect (`Effect.orDie`), not a recoverable path — see the code's own comment.
