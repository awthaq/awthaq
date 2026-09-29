// FAMS-010 (BEH-EA-207): a Firebase `auth:export` user maps onto the domain-service import shape,
// its password verifies through the firebase-scrypt legacy verifier (and is flagged for rehash to
// argon2id at first sign-in), and every record that cannot be imported is *reported*, never dropped.
//
// The fixtures follow Firebase's documented export shape; user 1's password hash is the published
// firebase/scrypt test vector (project hash_config, per-user salt, password "user1password"), so the
// credential is verified against an independent, real Firebase-produced value.
import { PasswordHasher } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { fileURLToPath } from "node:url";
import * as FirebaseScryptVerifier from "../src/FirebaseScryptVerifier.ts";
import * as ImportFirebaseUser from "../src/ImportFirebaseUser.ts";

const usersFile = fileURLToPath(new URL("./fixtures/users.json", import.meta.url));
const hashConfigFile = fileURLToPath(new URL("./fixtures/hash_config.json", import.meta.url));

const Files = NodeFileSystem.layer;

const load = Effect.gen(function* () {
  const config = yield* ImportFirebaseUser.readHashConfig(hashConfigFile);
  const users = yield* Stream.runCollect(ImportFirebaseUser.readUsers(usersFile));
  return { config, users };
}).pipe(Effect.provide(Files));

const mapAll = (issuers?: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const { config, users } = yield* load;
    return yield* Effect.forEach(users, (raw) =>
      ImportFirebaseUser.mapUser(raw, { config, issuers }).pipe(Effect.result),
    );
  });

describe("reading the export", () => {
  it.effect("reads the project's hash config and every user record", () =>
    Effect.gen(function* () {
      const { config, users } = yield* load;
      assert.strictEqual(config.rounds, 8);
      assert.strictEqual(config.memCost, 14);
      assert.strictEqual(config.saltSeparator, "Bw==");
      assert.strictEqual(users.length, 4);
    }),
  );

  it.effect("a users file that is not the export shape is a SourceReadError", () =>
    Effect.gen(function* () {
      const error = yield* Stream.runCollect(ImportFirebaseUser.readUsers(hashConfigFile)).pipe(
        Effect.provide(Files),
        Effect.flip,
      );
      assert.strictEqual(error._tag, "SourceReadError");
    }),
  );
});

describe("ImportFirebaseUser.mapUser", () => {
  it.effect("maps an email-verified password user to a firebase-scrypt credential; extra fields are reported", () =>
    Effect.gen(function* () {
      const [first] = yield* mapAll();
      assert.strictEqual(first?._tag, "Success");
      if (first?._tag !== "Success") return;
      assert.strictEqual(first.success.sourceRowId, "fb-user-1");
      assert.deepStrictEqual(first.success.user.identity, { _tag: "Email", email: "user1@example.com" });
      assert.strictEqual(first.success.user.name, "User One");
      assert.isTrue(first.success.user.verified);
      assert.strictEqual((first.success.user.credentials ?? []).length, 1);
      const [account] = first.success.user.credentials ?? [];
      assert.strictEqual(account?.providerId, "password");
      assert.match(
        account?.credentialHash === undefined ? "" : Redacted.value(account.credentialHash),
        /^\$firebase-scrypt\$/,
      );
      assert.strictEqual(first.success.user.image, "https://example.com/u1.png");
      assert.deepStrictEqual(first.success.unmapped, ["createdAt", "lastSignedInAt"]);
    }),
  );

  it.effect("the imported password signs in through the legacy verifier and is flagged for rehash to argon2id", () =>
    Effect.gen(function* () {
      const [first] = yield* mapAll();
      if (first?._tag !== "Success") return assert.fail("user 1 did not map");
      const hash = first.success.user.credentials?.[0]?.credentialHash;
      if (hash === undefined) return assert.fail("no credential hash");
      const hasher = yield* PasswordHasher.PasswordHasher;
      const phc = Redacted.value(hash);
      assert.isTrue(yield* hasher.verify(Redacted.make("user1password"), phc));
      assert.isFalse(yield* hasher.verify(Redacted.make("user1passwore"), phc));
      assert.isTrue(hasher.needsRehash(phc));
    }).pipe(
      Effect.provide(
        PasswordHasher.layerArgon2id.pipe(
          Layer.provideMerge(FirebaseScryptVerifier.layer),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("a google providerUserInfo becomes a linked account with the right subject and the issuer the caller names", () =>
    Effect.gen(function* () {
      const results = yield* mapAll({ google: "https://accounts.google.com" });
      const second = results[1];
      if (second?._tag !== "Success") return assert.fail("user 2 did not map");
      const [account] = second.success.user.credentials ?? [];
      assert.strictEqual(account?.providerId, "google");
      assert.strictEqual(account?.subject, "112233445566778899");
      assert.strictEqual(account?.issuer, "https://accounts.google.com");
      assert.isUndefined(account?.credentialHash);
      // Two things with no destination are reported, the phone identity and the phone number.
      assert.deepStrictEqual(second.success.unmapped, [
        "createdAt",
        "phoneNumber",
        "providerUserInfo.phone",
      ]);
    }),
  );

  it.effect("an email-less record is reported as unmappable, not imported", () =>
    Effect.gen(function* () {
      const third = (yield* mapAll())[2];
      assert.strictEqual(third?._tag, "Failure");
      if (third?._tag !== "Failure") return;
      assert.strictEqual(third.failure._tag, "UnmappableRow");
      assert.strictEqual(third.failure.sourceRowId, "fb-user-3");
      assert.include(third.failure.reason, "no email");
    }),
  );

  it.effect("a disabled Firebase user is refused rather than silently re-enabled", () =>
    Effect.gen(function* () {
      const fourth = (yield* mapAll())[3];
      assert.strictEqual(fourth?._tag, "Failure");
      if (fourth?._tag !== "Failure") return;
      assert.include(fourth.failure.reason, "disabled");
    }),
  );

  it.effect("a password hash with no hash config cannot be verified, so the record is unmappable", () =>
    Effect.gen(function* () {
      const { users } = yield* load;
      const error = yield* ImportFirebaseUser.mapUser(users[0], { config: undefined }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "UnmappableRow");
      assert.include(error.reason, "hash config");
    }),
  );

  it("providerIdFor strips the .com suffix and leaves other ids alone", () => {
    assert.strictEqual(ImportFirebaseUser.providerIdFor("google.com"), "google");
    assert.strictEqual(ImportFirebaseUser.providerIdFor("github.com"), "github");
    assert.strictEqual(ImportFirebaseUser.providerIdFor("oidc.acme"), "oidc.acme");
  });
});
