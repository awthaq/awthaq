---
"@awthaq/core": minor
---

User creation is one core module, `SignUp` (BEH-EA-323, ADR-EA-038): `vet` runs `BeforeSignUp` and returns a branded `Vetted` application, and `create`, `createWith` and `createSignedIn` accept nothing else. They create, mark verified, link the credential and run the caller's own work as one unit that leaves nothing behind on failure (memory compositions included), answer every collision as one `SignUp/IdentityTaken`, and publish `auth.user.created` and run `AfterSignUp` only after the unit commits.

Migration: plugin authors create a user for a sign-up with `SignUp.make` (`vet` then `create`/`createWith`/`createSignedIn`), never `Users.create`; operator imports (`UserImport.importUser`, `awthaq seed admin`) are exempt.
