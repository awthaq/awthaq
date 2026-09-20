// AOMS-001 (.scratch/resolve-ready-for-human-findings, ticket 21): the
// import half of the recipe, wired end-to-end into `PasswordHasher` so a
// freshly-imported account's bcrypt hash actually verifies and flags
// itself for rehash — the whole point of the finding.
import { Accounts, Hooks, Users } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import bcrypt from "bcryptjs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as BcryptVerifier from "../src/BcryptVerifier.ts";
import * as ImportAuth0User from "../src/ImportAuth0User.ts";

const DomainLive = Layer.mergeAll(Users.layerMemory, Accounts.layerMemory).pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provide(Hooks.HooksLive),
);

const HasherLive = PasswordHasher.layerArgon2id.pipe(
  Layer.provideMerge(BcryptVerifier.layer),
  Layer.provide(NodeCrypto.layer),
);

describe("ImportAuth0User", () => {
  it.effect("stores the exported bcrypt hash byte-for-byte, keyed by the new user's own id", () =>
    Effect.gen(function* () {
      const accounts = yield* Accounts.Accounts;
      const legacyHash = bcrypt.hashSync("s3cret-from-auth0", 4);

      const { user, account } = yield* ImportAuth0User.importUser({
        email: "migrated@example.com",
        name: "Migrated User",
        emailVerified: true,
        passwordHash: legacyHash,
      });

      assert.strictEqual(user.email, "migrated@example.com");
      assert.isTrue(user.emailVerified);
      assert.strictEqual(account.subject, user.id);
      assert.strictEqual(account.providerId, Accounts.PASSWORD_PROVIDER_ID);

      const stored = yield* accounts.findCredentialHash(account.id);
      assert.isTrue(Option.isSome(stored));
      assert.strictEqual(Redacted.value(Option.getOrThrow(stored)), legacyHash);
    }).pipe(Effect.provide(DomainLive)),
  );

  it.effect("emailVerified: false leaves the imported user unverified", () =>
    Effect.gen(function* () {
      const { user } = yield* ImportAuth0User.importUser({
        email: "unverified@example.com",
        name: "Unverified User",
        emailVerified: false,
        passwordHash: bcrypt.hashSync("whatever", 4),
      });
      assert.isFalse(user.emailVerified);
    }).pipe(Effect.provide(DomainLive)),
  );

  it.effect(
    "end-to-end: the imported user's Auth0 password verifies via PasswordHasher and is flagged for rehash",
    () =>
      Effect.gen(function* () {
        const accounts = yield* Accounts.Accounts;
        const hasher = yield* PasswordHasher.PasswordHasher;
        const legacyHash = bcrypt.hashSync("auth0-original-password", 4);

        const { account } = yield* ImportAuth0User.importUser({
          email: "e2e@example.com",
          name: "E2E User",
          emailVerified: true,
          passwordHash: legacyHash,
        });

        const stored = Redacted.value(
          Option.getOrThrow(yield* accounts.findCredentialHash(account.id)),
        );

        const verifiedCorrect = yield* hasher.verify(
          Redacted.make("auth0-original-password"),
          stored,
        );
        const verifiedWrong = yield* hasher.verify(Redacted.make("guessed-wrong"), stored);

        assert.isTrue(verifiedCorrect);
        assert.isFalse(verifiedWrong);
        assert.isTrue(hasher.needsRehash(stored));
      }).pipe(Effect.provide(Layer.mergeAll(DomainLive, HasherLive))),
  );
});
