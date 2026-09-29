// spec/models/07-api-keys.md, BEH-EA-140, ADR-EA-022 (OCM-002, OCM-005). The same domain
// suite runs against the in-memory records and against real migrated SQL records.
import { AuditLog, SecretHash, Users } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as ApiKey from "../src/ApiKey.ts";
import * as ApiKeyRecords from "../src/ApiKeyRecords.ts";
import { buildLayer, type HarnessOptions } from "./harness.ts";

const owner = Users.UserId("owner-1");
const someoneElse = Users.UserId("owner-2");

const suite = (store: HarnessOptions["store"]) => {
  const provide = (config: Partial<ApiKey.ApiKeyConfigShape> = {}) =>
    Effect.provide(buildLayer({ store, suite: "api_key_domain", config }));

  describe(`ApiKey domain (${store} records)`, () => {
    it.effect(
      "create returns a show-once key whose only persisted form is its SHA-256 digest",
      () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const records = yield* ApiKeyRecords.ApiKeyRecords;
          const crypto = yield* Crypto.Crypto;
          const created = yield* apiKey.create(owner, { name: "ci", scopes: ["reports:read"] });
          const key = Redacted.value(created.key);
          assert.isTrue(key.startsWith("ak_"));

          const parsed = ApiKey.parseKey(key, "ak_");
          assert.isTrue(Option.isSome(parsed));
          const { id, secret } = Option.getOrThrow(parsed);
          assert.strictEqual(id, created.view.id);
          assert.match(secret, /^[0-9a-f]{64}$/);

          const stored = Option.getOrThrow(yield* records.findById(id));
          assert.strictEqual(stored.secretHash, yield* SecretHash.digest(crypto, secret));
          // Nothing persisted, and nothing listed, equals the secret or the whole key.
          for (const value of Object.values({ ...stored, secretHash: "" })) {
            assert.notInclude(String(value), secret);
          }
          const listed = JSON.stringify(yield* apiKey.list(owner));
          assert.notInclude(listed, secret);
          assert.notInclude(listed, stored.secretHash);
          // `start` is the head of the credential (prefix + public id): no secret in it.
          assert.isTrue(key.startsWith(stored.start));
          assert.notInclude(stored.start, secret.slice(0, 6));
        }).pipe(provide()),
    );

    it.effect("a created key resolves to an ApiKeyPrincipal carrying exactly its scopes", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const created = yield* apiKey.create(owner, {
          name: "scim",
          scopes: ["scim:users:write", "scim:users:write", "reports:read"],
        });
        const principal = yield* apiKey.resolve(created.key);
        assert.isTrue(Option.isSome(principal));
        const resolved = Option.getOrThrow(principal);
        assert.strictEqual(resolved._tag, "ApiKey");
        assert.strictEqual(resolved.ref.type, "apikey");
        assert.strictEqual(resolved.ref.id, created.view.id);
        // Duplicates collapse, order is kept.
        assert.deepStrictEqual(resolved.scopes, ["scim:users:write", "reports:read"]);
      }).pipe(provide()),
    );

    it.effect("right keyId with the wrong secret, an unknown id and garbage all resolve None", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const created = yield* apiKey.create(owner, { name: "k", scopes: [] });
        const key = Redacted.value(created.key);
        const id = created.view.id;
        const attempts = [
          `ak_${id}.${"0".repeat(64)}`,
          `ak_${id}.`,
          `ak_${id}`,
          `ak_no-such-id.${"a".repeat(64)}`,
          `other_${id}.${key.slice(key.indexOf(".") + 1)}`,
          "",
          "ak_",
          "not a key at all",
        ];
        for (const attempt of attempts) {
          assert.isTrue(Option.isNone(yield* apiKey.resolve(Redacted.make(attempt))), attempt);
        }
        assert.isTrue(Option.isSome(yield* apiKey.resolve(created.key)));
      }).pipe(provide()),
    );

    it.effect("resolve fails immediately after revoke", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const created = yield* apiKey.create(owner, { name: "k", scopes: [] });
        assert.isTrue(Option.isSome(yield* apiKey.resolve(created.key)));
        yield* apiKey.revoke(owner, created.view.id);
        assert.isTrue(Option.isNone(yield* apiKey.resolve(created.key)));
        const listed = yield* apiKey.list(owner);
        assert.isTrue(Option.isSome(listed[0]?.revokedAt ?? Option.none()));
      }).pipe(provide()),
    );

    it.effect("resolve fails once expiresIn has elapsed (TestClock)", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const created = yield* apiKey.create(owner, {
          name: "short",
          scopes: [],
          expiresIn: Duration.hours(1),
        });
        yield* TestClock.adjust(Duration.minutes(59));
        assert.isTrue(Option.isSome(yield* apiKey.resolve(created.key)));
        yield* TestClock.adjust(Duration.minutes(2));
        assert.isTrue(Option.isNone(yield* apiKey.resolve(created.key)));
      }).pipe(provide()),
    );

    it.effect("keys are scoped to their owner: someone else's key is an unknown key", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const created = yield* apiKey.create(owner, { name: "mine", scopes: [] });
        const revoke = yield* Effect.flip(apiKey.revoke(someoneElse, created.view.id));
        assert.strictEqual(revoke._tag, "ApiKeyNotFound");
        const rotate = yield* Effect.flip(apiKey.rotate(someoneElse, created.view.id));
        assert.strictEqual(rotate._tag, "ApiKeyNotFound");
        const missing = yield* Effect.flip(apiKey.revoke(owner, "no-such-key"));
        assert.strictEqual(missing._tag, "ApiKeyNotFound");
        assert.deepStrictEqual(yield* apiKey.list(someoneElse), []);
        assert.isTrue(Option.isSome(yield* apiKey.resolve(created.key)));
      }).pipe(provide()),
    );

    it.effect("list is newest first and never carries the secret", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const first = yield* apiKey.create(owner, { name: "first", scopes: [] });
        yield* TestClock.adjust(Duration.seconds(5));
        const second = yield* apiKey.create(owner, { name: "second", scopes: [] });
        const listed = yield* apiKey.list(owner);
        assert.deepStrictEqual(
          listed.map((view) => view.id),
          [second.view.id, first.view.id],
        );
      }).pipe(provide()),
    );

    describe("rotation (ADR-EA-022)", () => {
      it.effect(
        "after rotate both keys resolve until the grace window elapses, then only the successor",
        () =>
          Effect.gen(function* () {
            const apiKey = yield* ApiKey.ApiKey;
            const original = yield* apiKey.create(owner, { name: "svc", scopes: ["a:b"] });
            const successor = yield* apiKey.rotate(owner, original.view.id, {
              gracePeriod: Duration.hours(2),
            });
            assert.notStrictEqual(successor.view.id, original.view.id);
            assert.strictEqual(successor.view.name, "svc");
            assert.deepStrictEqual(successor.view.scopes, ["a:b"]);

            yield* TestClock.adjust(Duration.hours(1));
            assert.isTrue(Option.isSome(yield* apiKey.resolve(original.key)));
            assert.isTrue(Option.isSome(yield* apiKey.resolve(successor.key)));

            yield* TestClock.adjust(Duration.hours(2));
            assert.isTrue(Option.isNone(yield* apiKey.resolve(original.key)));
            assert.isTrue(Option.isSome(yield* apiKey.resolve(successor.key)));
          }).pipe(provide()),
      );

      it.effect("the default grace is 24 hours and a zero grace cuts the old key at once", () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const a = yield* apiKey.create(owner, { name: "a", scopes: [] });
          yield* apiKey.rotate(owner, a.view.id);
          yield* TestClock.adjust(Duration.hours(23));
          assert.isTrue(Option.isSome(yield* apiKey.resolve(a.key)));
          yield* TestClock.adjust(Duration.hours(2));
          assert.isTrue(Option.isNone(yield* apiKey.resolve(a.key)));

          const b = yield* apiKey.create(owner, { name: "b", scopes: [] });
          yield* apiKey.rotate(owner, b.view.id, { gracePeriod: Duration.zero });
          assert.isTrue(Option.isNone(yield* apiKey.resolve(b.key)));
        }).pipe(provide()),
      );

      it.effect("a grace beyond maxRotationGrace is refused; a revoked key cannot be rotated", () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const created = yield* apiKey.create(owner, { name: "k", scopes: [] });
          const tooLong = yield* Effect.flip(
            apiKey.rotate(owner, created.view.id, { gracePeriod: Duration.days(8) }),
          );
          assert.strictEqual(tooLong._tag, "ApiKeyLifetimeInvalid");
          yield* apiKey.revoke(owner, created.view.id);
          const dead = yield* Effect.flip(apiKey.rotate(owner, created.view.id));
          assert.strictEqual(dead._tag, "ApiKeyNotFound");
        }).pipe(provide({ maxRotationGrace: Duration.days(7) })),
      );

      it.effect("rotating never lengthens a key that was already about to expire", () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const created = yield* apiKey.create(owner, {
            name: "k",
            scopes: [],
            expiresIn: Duration.hours(1),
          });
          yield* apiKey.rotate(owner, created.view.id, { gracePeriod: Duration.hours(12) });
          yield* TestClock.adjust(Duration.hours(2));
          assert.isTrue(Option.isNone(yield* apiKey.resolve(created.key)));
        }).pipe(provide()),
      );
    });

    describe("policy", () => {
      it.effect("scopes outside grantableScopes are refused, naming them", () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const ok = yield* apiKey.create(owner, { name: "ok", scopes: ["reports:read"] });
          assert.deepStrictEqual(ok.view.scopes, ["reports:read"]);
          const refused = yield* Effect.flip(
            apiKey.create(owner, { name: "bad", scopes: ["reports:read", "admin:all"] }),
          );
          assert.strictEqual(refused._tag, "ApiKeyScopeNotGrantable");
          if (refused._tag === "ApiKeyScopeNotGrantable") {
            assert.deepStrictEqual(refused.scopes, ["admin:all"]);
          }
        }).pipe(provide({ grantableScopes: ["reports:read", "reports:write"] })),
      );

      it.effect("maxExpiresIn caps a requested lifetime and applies when none is requested", () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const tooLong = yield* Effect.flip(
            apiKey.create(owner, { name: "k", scopes: [], expiresIn: Duration.days(90) }),
          );
          assert.strictEqual(tooLong._tag, "ApiKeyLifetimeInvalid");
          const defaulted = yield* apiKey.create(owner, { name: "k2", scopes: [] });
          assert.isTrue(Option.isSome(defaulted.view.expiresAt));
          yield* TestClock.adjust(Duration.days(31));
          assert.isTrue(Option.isNone(yield* apiKey.resolve(defaulted.key)));
        }).pipe(provide({ maxExpiresIn: Duration.days(30) })),
      );

      it.effect(
        "defaultExpiresIn applies when the caller names none; unset means never expires",
        () =>
          Effect.gen(function* () {
            const apiKey = yield* ApiKey.ApiKey;
            const defaulted = yield* apiKey.create(owner, { name: "k", scopes: [] });
            assert.isTrue(Option.isSome(defaulted.view.expiresAt));
          }).pipe(provide({ defaultExpiresIn: Duration.days(7) })),
      );

      it.effect("without any lifetime setting a key never expires", () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const forever = yield* apiKey.create(owner, { name: "k", scopes: [] });
          assert.isTrue(Option.isNone(forever.view.expiresAt));
          yield* TestClock.adjust(Duration.days(3650));
          assert.isTrue(Option.isSome(yield* apiKey.resolve(forever.key)));
        }).pipe(provide()),
      );

      it.effect("a custom prefix marks keys and only that prefix resolves", () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const created = yield* apiKey.create(owner, { name: "k", scopes: [] });
          const key = Redacted.value(created.key);
          assert.isTrue(key.startsWith("acme_"));
          assert.isTrue(Option.isSome(yield* apiKey.resolve(created.key)));
          const wrongPrefix = `ak_${key.slice("acme_".length)}`;
          assert.isTrue(Option.isNone(yield* apiKey.resolve(Redacted.make(wrongPrefix))));
        }).pipe(provide({ prefix: "acme_" })),
      );

      it.effect("lastUsedAt is written at most once per lastUsedGranularity", () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const created = yield* apiKey.create(owner, { name: "k", scopes: [] });
          const usedAt = Effect.map(
            apiKey.list(owner),
            (all) => all[0]?.lastUsedAt ?? Option.none(),
          );
          assert.isTrue(Option.isNone(yield* usedAt));
          yield* apiKey.resolve(created.key);
          const first = Option.getOrThrow(yield* usedAt);
          yield* TestClock.adjust(Duration.seconds(10));
          yield* apiKey.resolve(created.key);
          assert.strictEqual(
            DateTime.toEpochMillis(Option.getOrThrow(yield* usedAt)),
            DateTime.toEpochMillis(first),
          );
          yield* TestClock.adjust(Duration.minutes(2));
          yield* apiKey.resolve(created.key);
          assert.isAbove(
            DateTime.toEpochMillis(Option.getOrThrow(yield* usedAt)),
            DateTime.toEpochMillis(first),
          );
        }).pipe(provide()),
      );
    });

    it.effect("lifecycle events reach the audit log with the owner as actor, never a secret", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const audit = yield* AuditLog.AuditLog;
        const created = yield* apiKey.create(owner, { name: "k", scopes: [] });
        const rotated = yield* apiKey.rotate(owner, created.view.id);
        yield* apiKey.revoke(owner, rotated.view.id);
        const rows = yield* audit.list();
        const tags = rows.map((row) => row.eventTag);
        assert.includeMembers(tags, [
          "auth.apiKey.created",
          "auth.apiKey.rotated",
          "auth.apiKey.revoked",
        ]);
        assert.isTrue(rows.every((row) => Option.contains(row.actorUserId, owner)));
        const serialized = JSON.stringify(rows);
        assert.notInclude(serialized, Redacted.value(created.key));
        assert.notInclude(serialized, Redacted.value(rotated.key));
      }).pipe(provide()),
    );
  });
};

suite("memory");
suite("sql");
