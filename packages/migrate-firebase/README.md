# @awthaq/migrate-firebase

Lets users exported from **Firebase Authentication** keep their passwords.
Firebase hashes passwords with a modified scrypt that neither
`PasswordHasher.layerArgon2id` nor `layerScrypt` can parse, so an imported
Firebase hash would otherwise fail every sign-in
([`FAMS-001`](../../.issues/high/FAMS-001-firebase-auth-migration-specialist.md)).
This package ships a `LegacyPasswordVerifier` for it: the imported hash verifies
on the user's first sign-in, and `rehashOnLogin` replaces it with argon2id in
the same request. `hash()` still only ever produces argon2id/scrypt output.

## The recipe

**1. Export** your users and the project's hash parameters:

```sh
firebase auth:export users.json --format=json
```

Each user has `email`, `emailVerified`, `displayName`, `passwordHash` and
`salt` (both base64). The project's `hashConfig` (from the Firebase console's
"Password hash parameters", or `firebase auth:export`) gives `base64_signer_key`,
`base64_salt_separator`, `rounds` and `mem_cost` — the same four values for
every user.

**2. Encode** each user's credential, then import it as the credential hash
(here through `@awthaq/migrate-auth0`'s generic `importUser`, or by linking a
password `Account` yourself):

```ts
import { FirebaseScryptVerifier } from "@awthaq/migrate-firebase";

const config = {
  signerKey: hashConfig.base64_signer_key,
  saltSeparator: hashConfig.base64_salt_separator,
  rounds: hashConfig.rounds,
  memCost: hashConfig.mem_cost,
};

const credentialHash = FirebaseScryptVerifier.encodeHash({
  passwordHash: exported.passwordHash,
  salt: exported.salt,
  config,
});
// "$firebase-scrypt$k=...,ss=...,r=8,mc=14$<salt>$<hash>" — self-describing.
```

A stored hash is the branded `PasswordHasher.PhcHash`; `encodeHash` returns one
(it is the import's trust boundary), so link it directly:
`Accounts.link({ ..., credentialHash: Redacted.make(credentialHash) })`.

Carry `emailVerified` across (`Users.verifyEmail` for the users Firebase had
verified). `@awthaq/password` refuses to sign in an unverified account by
default; if part of your population was never verified in Firebase, set
`Password.config({ requireVerifiedEmail: false })` and restrict unverified users
downstream instead.

**3. Install the verifier** next to your primary hasher:

```ts
import { PasswordHasher } from "@awthaq/ports";
import { FirebaseScryptVerifier } from "@awthaq/migrate-firebase";

const HasherLive = PasswordHasher.layerArgon2id.pipe(
  Layer.provideMerge(FirebaseScryptVerifier.layer),
);
```

`PasswordHasher.LegacyPasswordVerifiers` holds a single list, so to accept
several legacy formats at once (Firebase and bcrypt from `@awthaq/migrate-auth0`,
say) provide
`Layer.succeed(PasswordHasher.LegacyPasswordVerifiers, [firebaseScryptVerifier, bcryptVerifier])`
instead of merging their `layer`s (the last one merged would win).

## How it verifies

Firebase stores an AES-256-CTR encryption of the project's signer key under a
key derived from the password, not a plain digest:

```
derived = scrypt(password, salt || saltSeparator, N = 2^memCost, r = rounds, p = 1, dkLen = 32)
hash    = AES-256-CTR(key = derived, counter = 16 zero bytes).encrypt(signerKey)
```

(the algorithm of [firebase/scrypt](https://github.com/firebase/scrypt)). The
verifier is checked against that project's published test vector. Stored cost
parameters are untrusted input, so `mem_cost` above 17 and `rounds` above 16 are
refused without running scrypt; Firebase's own defaults are 14 and 8. The
derivation runs through hash-wasm on the calling thread, bounded by the hasher's
`AUTH_PASSWORD_HASH_CONCURRENCY`, once per not-yet-rehashed account.
