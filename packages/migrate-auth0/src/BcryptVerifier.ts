// @awthaq/migrate-auth0 — BcryptVerifier
//
// AOMS-001 (.scratch/resolve-ready-for-human-findings, ticket 21): the
// `LegacyPasswordVerifierShape` an Auth0 database-connection export needs.
// Auth0 hands bcrypt (`$2a$`/`$2b$`/`$2y$`) hashes back through its bulk
// export — fully self-describing (cost factor + salt embedded in the
// string) — so an imported `credentialHash` (see `ImportAuth0User.ts`) is
// exactly this format until the user's next successful sign-in triggers
// `rehashOnLogin` (`packages/password/src/Password.ts:552-556`, unchanged
// by this package).
//
// `bcryptjs`, not `@node-rs/bcrypt` — `PasswordHasher.ts`'s own header
// states the project's standing zero-native-dependency/pure-JS-or-WASM
// preference specifically so the port stays usable on edge runtimes; this
// verifier only ever runs off the hot path, once per not-yet-rehashed
// account, so `bcryptjs`'s slower pure-JS cost is a one-time-per-user tax,
// not a standing one.

import { PasswordHasher } from "@awthaq/ports";
import bcrypt from "bcryptjs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

// `$2a$`/`$2b$` are the two tags Auth0's own export actually uses; `$2y$`
// (PHP's tag for the identical algorithm) is recognized too since some
// Auth0 custom-database migrations originate from a PHP-hashed source.
const BCRYPT_TAG = /^\$2[aby]\$\d{2}\$/;

export const bcryptVerifier: PasswordHasher.LegacyPasswordVerifierShape = {
  id: "bcrypt",
  recognizes: (phc) => BCRYPT_TAG.test(phc),
  verify: (plain, phc) =>
    Effect.tryPromise(() => bcrypt.compare(Redacted.value(plain), phc)).pipe(
      Effect.orElseSucceed(() => false),
    ),
};

/**
 * Compose alongside the deployment's primary hasher layer
 * (`PasswordHasher.layerArgon2id`/`layerScrypt`) — a deployment that never
 * installs this layer sees zero behavior change, since
 * `PasswordHasher.LegacyPasswordVerifiers` defaults to `[]`.
 */
export const layer: Layer.Layer<never> = Layer.succeed(PasswordHasher.LegacyPasswordVerifiers, [
  bcryptVerifier,
]);
