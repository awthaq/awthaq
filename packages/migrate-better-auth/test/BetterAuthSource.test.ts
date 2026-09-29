// BAM-001 (BEH-EA-207, decision 07 §6): the better-auth import adapter, validated against a REAL
// export — `fixtures/better-auth-export.sqlite` was produced by better-auth 1.7.6 itself (its own
// migrations, `signUpEmail`, and the internal adapter's `createOAuthUser`; regenerate with
// `fixtures/generate-better-auth-export.mjs`). Nothing here is a hand-written row.
import { PasswordHasher } from "@awthaq/ports";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { fileURLToPath } from "node:url";
import * as BetterAuthScryptVerifier from "../src/BetterAuthScryptVerifier.ts";
import * as BetterAuthSource from "../src/BetterAuthSource.ts";

const fixture = fileURLToPath(new URL("./fixtures/better-auth-export.sqlite", import.meta.url));

// The retained export is only ever read.
const Source = SqliteClient.layer({ filename: fixture, readonly: true, disableWAL: true });

const readAll = (batchSize?: number) =>
  BetterAuthSource.read({ batchSize }).pipe(Stream.runCollect, Effect.provide(Source));

const mapAll = (issuers?: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const rows = yield* readAll();
    return yield* Effect.forEach(rows, (row) => BetterAuthSource.mapUser(row, { issuers }));
  });

const byEmail = (mapped: ReadonlyArray<BetterAuthSource.MappedUser>, email: string) => {
  const found = mapped.find(
    (item) => item.user.identity._tag === "Email" && item.user.identity.email === email,
  );
  if (found === undefined) throw new TypeError(`the export has no user ${email}`);
  return found;
};

describe("BetterAuthSource.read", () => {
  it.effect("streams every user with its accounts, in a stable order", () =>
    Effect.gen(function* () {
      const rows = yield* readAll();
      assert.strictEqual(rows.length, 3);
      assert.deepStrictEqual(
        rows.map((row) => row.accounts.length),
        [1, 1, 1],
      );
      const ids = rows.map((row) => String(row.user["id"]));
      assert.deepStrictEqual(ids, [...ids].sort());
    }),
  );

  it.effect("paginates by keyset: a page size of 2 yields the same rows as one page", () =>
    Effect.gen(function* () {
      const whole = yield* readAll();
      const paged = yield* readAll(2);
      assert.deepStrictEqual(
        paged.map((row) => row.user["id"]),
        whole.map((row) => row.user["id"]),
      );
    }),
  );

  it.effect("counts the four tables for the plan", () =>
    Effect.gen(function* () {
      const counts = yield* BetterAuthSource.counts.pipe(Effect.provide(Source));
      assert.deepStrictEqual(counts, { user: 3, account: 3, session: 2, verification: 0 });
    }),
  );
});

describe("BetterAuthSource.mapUser", () => {
  it.effect(
    "maps a password user: verbatim scrypt hash under the `password` provider, unmapped columns reported",
    () =>
      Effect.gen(function* () {
        const ada = byEmail(yield* mapAll(), "ada@example.com");
        assert.strictEqual(ada.user.name, "Ada Lovelace");
        assert.isTrue(ada.user.verified);
        assert.strictEqual((ada.user.credentials ?? []).length, 1);
        const [account] = ada.user.credentials ?? [];
        assert.strictEqual(account?.providerId, "password");
        // `undefined` subject = the new user's own id (`Password.signUp`'s convention).
        assert.isUndefined(account?.subject);
        assert.match(
          account?.credentialHash === undefined ? "" : Redacted.value(account.credentialHash),
          /^[0-9a-f]{32}:[0-9a-f]{128}$/,
        );
        // A plugin-style column with data, and the bookkeeping columns, have no destination: reported.
        assert.deepStrictEqual(ada.unmapped, [
          "account.createdAt",
          "account.updatedAt",
          "user.createdAt",
          "user.plan",
          "user.updatedAt",
        ]);
      }),
  );

  it.effect(
    "keeps an unverified address unverified and reports no plugin column that is empty",
    () =>
      Effect.gen(function* () {
        const alan = byEmail(yield* mapAll(), "alan@example.com");
        assert.isFalse(alan.user.verified);
        assert.notInclude(alan.unmapped, "user.plan");
      }),
  );

  it.effect("maps a social user: provider id, subject and tokens carried, image reported", () =>
    Effect.gen(function* () {
      const grace = byEmail(yield* mapAll({ github: "https://github.com" }), "grace@example.com");
      assert.isTrue(grace.user.verified);
      const [account] = grace.user.credentials ?? [];
      assert.strictEqual(account?.providerId, "github");
      assert.strictEqual(account?.subject, "1815");
      assert.strictEqual(account?.issuer, "https://github.com");
      assert.isUndefined(account?.credentialHash);
      assert.strictEqual(
        account?.tokens === undefined ? "" : Redacted.value(account.tokens.accessToken),
        "gho_fixtureAccessToken",
      );
      assert.strictEqual(
        Option.getOrElse(account?.tokens?.scope ?? Option.none(), () => ""),
        "read:user,user:email",
      );
      assert.isTrue(Option.isSome(account?.tokens?.accessTokenExpiresAt ?? Option.none()));
      // The avatar has a destination now (BAM-009): carried, not reported.
      assert.strictEqual(grace.user.image, "https://avatars.example.com/grace.png");
      assert.notInclude(grace.unmapped, "user.image");
    }),
  );

  it.effect(
    "carries no issuer unless the caller names one (a plain OAuth2 provider has none)",
    () =>
      Effect.gen(function* () {
        const grace = byEmail(yield* mapAll(), "grace@example.com");
        assert.isUndefined(grace.user.credentials?.[0]?.issuer);
      }),
  );

  it.effect("refuses a credential account whose password is not a better-auth scrypt hash", () =>
    Effect.gen(function* () {
      const error = yield* BetterAuthSource.mapUser({
        user: { id: "u1", name: "X", email: "x@example.com", emailVerified: 1 },
        accounts: [
          { providerId: "credential", accountId: "u1", password: "$2b$10$abcdefghijklmnopqrstuv" },
        ],
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "UnmappableRow");
      assert.strictEqual(error.sourceRowId, "u1");
    }),
  );

  it.effect("refuses a user row without an email", () =>
    Effect.gen(function* () {
      const error = yield* BetterAuthSource.mapUser({
        user: { id: "u2", name: "X", email: "", emailVerified: 0 },
        accounts: [],
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "UnmappableRow");
    }),
  );
});

// BAM-004 + BAM-001: the imported hash is not decoration — the legacy verifier accepts the real
// password better-auth hashed, and the hasher flags it for rehash, so the first sign-in retires it.
describe("an imported better-auth credential", () => {
  const HasherLive = PasswordHasher.layerArgon2id.pipe(
    Layer.provideMerge(BetterAuthScryptVerifier.layer),
    Layer.provide(NodeCrypto.layer),
  );

  it.effect("verifies with the real password and needs a rehash", () =>
    Effect.gen(function* () {
      const ada = byEmail(yield* mapAll(), "ada@example.com");
      const alan = byEmail(yield* mapAll(), "alan@example.com");
      const adaHash = ada.user.credentials?.[0]?.credentialHash;
      const alanHash = alan.user.credentials?.[0]?.credentialHash;
      assert.isDefined(adaHash);
      assert.isDefined(alanHash);
      if (adaHash === undefined || alanHash === undefined) return;
      const hasher = yield* PasswordHasher.PasswordHasher;
      const ada_ = Redacted.value(adaHash);
      const alan_ = Redacted.value(alanHash);
      assert.isTrue(yield* hasher.verify(Redacted.make("ExistingUser123!"), ada_));
      assert.isFalse(yield* hasher.verify(Redacted.make("not-her-password"), ada_));
      assert.isTrue(yield* hasher.verify(Redacted.make("Enigma-Breaker-1912"), alan_));
      assert.isTrue(hasher.needsRehash(ada_));
    }).pipe(Effect.provide(HasherLive)),
  );
});
