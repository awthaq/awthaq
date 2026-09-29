// spec/behaviors/17-passkey.md, BEH-EA-130/131/134 — BPAS-003 (+HSK-001,
// TC-002, WPS-002, CB-005) and the server half of BPAS-006/TC-004.
//
// One random WebAuthn user handle per user, minted once, sent as `user.id` in
// every registration ceremony, stored on every credential, and checked
// against the `userHandle` a discoverable credential's assertion carries.
import { Migrations, Sessions, Users } from "@awthaq/core";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Passkey from "../src/Passkey.ts";
import * as PasskeyUserHandles from "../src/PasskeyUserHandles.ts";
import { assertionCredential, mockWebAuthn, registrationPayload } from "./passkeyTestFixtures.ts";
import { buildLayer } from "./passkeyTestLayers.ts";
import * as TestSql from "../../sql/test/support/TestSql.ts";

const newUserSession = (email: string) =>
  Effect.gen(function* () {
    const users = yield* Users.Users;
    const sessions = yield* Sessions.Sessions;
    const user = yield* users.create({
      identity: { _tag: "Email", email },
      name: `Name of ${email}`,
    });
    const issued = yield* sessions.issue({ userId: user.id });
    return { userId: user.id, sessionId: issued.session.id };
  });

describe("BPAS-003: one stable handle per user", () => {
  it.effect(
    "the stored webauthnUserId equals options.user.id, and every credential of one user shares it",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const { userId, sessionId } = yield* newUserSession("handle@example.com");

        const first = yield* passkey.registerOptions(userId, sessionId);
        const firstRecord = yield* passkey.registerVerify(
          userId,
          sessionId,
          registrationPayload({ options: first, id: "cred-1" }),
        );
        const second = yield* passkey.registerOptions(userId, sessionId);
        const secondRecord = yield* passkey.registerVerify(
          userId,
          sessionId,
          registrationPayload({ options: second, id: "cred-2" }),
        );
        const conditional = yield* passkey.registerOptionsConditional(userId, sessionId);

        // Before the fix each ceremony step minted its own random handle.
        assert.strictEqual(first.user.id, second.user.id);
        assert.strictEqual(first.user.id, conditional.user.id);
        assert.strictEqual(firstRecord.webauthnUserId, first.user.id);
        assert.strictEqual(secondRecord.webauthnUserId, first.user.id);
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("two users get different handles, and the handle is not the internal user id", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const a = yield* newUserSession("a-handle@example.com");
      const b = yield* newUserSession("b-handle@example.com");
      const optionsA = yield* passkey.registerOptions(a.userId, a.sessionId);
      const optionsB = yield* passkey.registerOptions(b.userId, b.sessionId);
      assert.notStrictEqual(optionsA.user.id, optionsB.user.id);
      assert.notStrictEqual(optionsA.user.id, a.userId);
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  const signedUp = (email: string) =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const user = yield* newUserSession(email);
      const options = yield* passkey.registerOptions(user.userId, user.sessionId);
      const record = yield* passkey.registerVerify(
        user.userId,
        user.sessionId,
        registrationPayload({ options }),
      );
      return { ...user, handle: record.webauthnUserId };
    });

  it.effect("an assertion whose userHandle matches the stored handle signs in", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, handle } = yield* signedUp("match@example.com");
      const { ceremonyId, options } = yield* passkey.authenticateOptions({});
      const issued = yield* passkey.authenticateVerify({
        ceremonyId,
        credential: assertionCredential({ options, userHandle: handle }),
      });
      assert.strictEqual(issued.session.userId, userId);
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("an assertion without a userHandle (a non-discoverable flow) still signs in", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId } = yield* signedUp("nohandle@example.com");
      const { ceremonyId, options } = yield* passkey.authenticateOptions({});
      const issued = yield* passkey.authenticateVerify({
        ceremonyId,
        credential: assertionCredential({ options }),
      });
      assert.strictEqual(issued.session.userId, userId);
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect(
    "an assertion whose userHandle differs from the stored handle is InvalidCredentials",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        yield* signedUp("mismatch@example.com");
        const { ceremonyId, options } = yield* passkey.authenticateOptions({});
        const failure = yield* passkey
          .authenticateVerify({
            ceremonyId,
            credential: assertionCredential({ options, userHandle: "someone-elses-handle" }),
          })
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "InvalidCredentials");
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("step-up reauthentication cross-checks the userHandle too", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId, sessionId, handle } = yield* signedUp("reauth-handle@example.com");

      const good = yield* passkey.reauthenticateOptions(userId, sessionId);
      yield* passkey.reauthenticateVerify(userId, sessionId, {
        credential: assertionCredential({ options: good, userHandle: handle }),
      });

      const bad = yield* passkey.reauthenticateOptions(userId, sessionId);
      const failure = yield* passkey
        .reauthenticateVerify(userId, sessionId, {
          credential: assertionCredential({ options: bad, userHandle: "someone-elses-handle" }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "PasskeyVerificationFailed");
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );
});

describe("BPAS-006/TC-004: the signals surface", () => {
  it.effect(
    "answers the rpId, the stable handle and only the caller's own accepted credential ids",
    () =>
      Effect.gen(function* () {
        const passkey = yield* Passkey.Passkey;
        const mine = yield* newUserSession("signals-me@example.com");
        const theirs = yield* newUserSession("signals-them@example.com");
        for (const [user, id] of [
          [mine, "mine-1"],
          [mine, "mine-2"],
          [theirs, "theirs-1"],
        ] as const) {
          const options = yield* passkey.registerOptions(user.userId, user.sessionId);
          yield* passkey.registerVerify(
            user.userId,
            user.sessionId,
            registrationPayload({ options, id }),
          );
        }
        const signals = yield* passkey.signals(mine.userId);
        const options = yield* passkey.registerOptions(mine.userId, mine.sessionId);
        assert.strictEqual(signals.rpId, "example.com");
        assert.strictEqual(signals.userId, options.user.id);
        assert.strictEqual(signals.name, "signals-me@example.com");
        assert.strictEqual(signals.displayName, "Name of signals-me@example.com");
        assert.deepStrictEqual([...signals.allAcceptedCredentialIds].sort(), ["mine-1", "mine-2"]);
      }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );

  it.effect("a user with no credentials still gets a handle and an empty accepted set", () =>
    Effect.gen(function* () {
      const passkey = yield* Passkey.Passkey;
      const { userId } = yield* newUserSession("signals-empty@example.com");
      const signals = yield* passkey.signals(userId);
      assert.isAbove(signals.userId.length, 0);
      assert.deepStrictEqual(signals.allAcceptedCredentialIds, []);
    }).pipe(Effect.provide(buildLayer(mockWebAuthn()))),
  );
});

const MemoryLayer = PasskeyUserHandles.layerMemory.pipe(Layer.provide(NodeCrypto.layer));

const SqlLive = TestSql.layer("passkey_PasskeyUserHandle");
const Migrated = Layer.effectDiscard(Migrations.run(Passkey.Passkey.migrations)).pipe(
  Layer.provide(SqlLive),
);
const SqlLayer = PasskeyUserHandles.layerSql.pipe(
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(SqlLive),
  Layer.provideMerge(Migrated),
);

const suite = (
  name: string,
  layer: Layer.Layer<PasskeyUserHandles.PasskeyUserHandles, unknown, never>,
): void => {
  describe(name, () => {
    const alice = Users.UserId("alice");
    const bob = Users.UserId("bob");

    it.effect("getOrCreate mints once and answers the same handle ever after", () =>
      Effect.gen(function* () {
        const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
        const first = yield* handles.getOrCreate(alice);
        assert.match(first, /^[A-Za-z0-9_-]{43}$/);
        assert.strictEqual(yield* handles.getOrCreate(alice), first);
        assert.notStrictEqual(yield* handles.getOrCreate(bob), first);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("concurrent first calls for one user all agree on a single handle", () =>
      Effect.gen(function* () {
        const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
        const user = Users.UserId("racer");
        const results = yield* Effect.all(
          Array.from({ length: 8 }, () => handles.getOrCreate(user)),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(new Set(results).size, 1);
        assert.strictEqual(yield* handles.getOrCreate(user), results[0]);
      }).pipe(Effect.provide(layer)),
    );

    it.effect("deleteByUser forgets the handle (a later one is fresh) and is idempotent", () =>
      Effect.gen(function* () {
        const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
        const user = Users.UserId("erased");
        const before = yield* handles.getOrCreate(user);
        yield* handles.deleteByUser(user);
        yield* handles.deleteByUser(user);
        assert.notStrictEqual(yield* handles.getOrCreate(user), before);
      }).pipe(Effect.provide(layer)),
    );
  });
};

suite("PasskeyUserHandles (layerMemory)", MemoryLayer);
suite("PasskeyUserHandles (layerSql)", SqlLayer);
