// spec/models/07-api-keys.md, BEH-EA-141, ADR-EA-022 (MAPS-003, OCM-001, OCM-005):
// `client_credentials` clients minting short-lived service JWTs through `@awthaq/jwt`.
import { SecretHash, Users } from "@awthaq/core";
import { Jwt } from "@awthaq/jwt";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as ApiKey from "../src/ApiKey.ts";
import * as ApiKeyClientRecords from "../src/ApiKeyClientRecords.ts";
import { buildLayer, type HarnessOptions } from "./harness.ts";

const owner = Users.UserId("owner-1");
const someoneElse = Users.UserId("owner-2");

const suite = (store: HarnessOptions["store"]) => {
  const provide = (config: Partial<ApiKey.ApiKeyConfigShape> = {}) =>
    Effect.provide(buildLayer({ store, suite: "api_key_clients", config }));

  const secretOf = (created: ApiKey.CreatedClient) => Redacted.value(created.clientSecret);

  describe(`client_credentials (${store} records)`, () => {
    it.effect("registerClient shows the secret once and persists only its SHA-256 digest", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const records = yield* ApiKeyClientRecords.ApiKeyClientRecords;
        const crypto = yield* Crypto.Crypto;
        const created = yield* apiKey.registerClient(owner, { name: "billing", scopes: ["a:b"] });
        const secret = secretOf(created);
        assert.match(created.view.clientId, /^svc_/);
        const stored = Option.getOrThrow(yield* records.findById(created.view.clientId));
        assert.strictEqual(stored.secretHash, yield* SecretHash.digest(crypto, secret));
        assert.notInclude(JSON.stringify(stored), secret);
        assert.notInclude(JSON.stringify(yield* apiKey.listClients(owner)), secret);
      }).pipe(provide()),
    );

    it.effect("a valid secret mints a scoped JWT that verifies as a service token", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const jwt = yield* Jwt.Jwt;
        const created = yield* apiKey.registerClient(owner, {
          name: "billing",
          scopes: ["invoices:read", "invoices:write"],
        });
        const issued = yield* apiKey.issueServiceToken({
          clientId: created.view.clientId,
          clientSecret: created.clientSecret,
        });
        assert.strictEqual(issued.expiresIn, 900);
        assert.deepStrictEqual(issued.scope, ["invoices:read", "invoices:write"]);
        const claims = yield* jwt.verifyJWT(Redacted.value(issued.accessToken), {
          typ: ApiKey.SERVICE_TOKEN_TYP,
        });
        assert.strictEqual(claims["sub"], `service:${created.view.clientId}`);
        assert.strictEqual(claims["scope"], "invoices:read invoices:write");
        // It is not a principal token: `verify` (typ at+jwt) refuses it.
        const asPrincipal = yield* Effect.flip(jwt.verify(Redacted.value(issued.accessToken)));
        assert.strictEqual(asPrincipal._tag, "JwtInvalidError");
      }).pipe(provide()),
    );

    it.effect("requested scopes are intersected with the registered ones, never widened", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const created = yield* apiKey.registerClient(owner, {
          name: "c",
          scopes: ["a:read", "a:write"],
        });
        const grant = (requestedScope?: ReadonlyArray<string>) =>
          apiKey.issueServiceToken({
            clientId: created.view.clientId,
            clientSecret: created.clientSecret,
            requestedScope,
          });
        assert.deepStrictEqual((yield* grant(["a:read"])).scope, ["a:read"]);
        // Beyond the registered set is dropped, not granted.
        assert.deepStrictEqual((yield* grant(["a:read", "admin:all"])).scope, ["a:read"]);
        assert.deepStrictEqual((yield* grant(undefined)).scope, ["a:read", "a:write"]);
        // Nothing in common: invalid_scope.
        const none = yield* Effect.flip(grant(["admin:all"]));
        assert.strictEqual(none._tag, "InvalidScope");
        assert.strictEqual(none.error, "invalid_scope");
      }).pipe(provide()),
    );

    it.effect("wrong secret, unknown client and revoked client are all invalid_client", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const created = yield* apiKey.registerClient(owner, { name: "c", scopes: ["a:b"] });
        const attempt = (clientId: string, secret: string) =>
          Effect.flip(apiKey.issueServiceToken({ clientId, clientSecret: Redacted.make(secret) }));
        const wrong = yield* attempt(created.view.clientId, "cs_wrong");
        assert.strictEqual(wrong._tag, "InvalidClient");
        assert.strictEqual(wrong.error, "invalid_client");
        const unknown = yield* attempt("svc_unknown", secretOf(created));
        assert.strictEqual(unknown._tag, "InvalidClient");
        const empty = yield* attempt(created.view.clientId, "");
        assert.strictEqual(empty._tag, "InvalidClient");
        yield* apiKey.revokeClient(owner, created.view.clientId);
        const revoked = yield* attempt(created.view.clientId, secretOf(created));
        assert.strictEqual(revoked._tag, "InvalidClient");
      }).pipe(provide()),
    );

    it.effect(
      "revokeClient blocks new tokens but an already-minted token verifies until its expiry (TestClock)",
      () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const jwt = yield* Jwt.Jwt;
          const created = yield* apiKey.registerClient(owner, { name: "c", scopes: ["a:b"] });
          const issued = yield* apiKey.issueServiceToken({
            clientId: created.view.clientId,
            clientSecret: created.clientSecret,
          });
          yield* apiKey.revokeClient(owner, created.view.clientId);
          const blocked = yield* Effect.flip(
            apiKey.issueServiceToken({
              clientId: created.view.clientId,
              clientSecret: created.clientSecret,
            }),
          );
          assert.strictEqual(blocked._tag, "InvalidClient");

          const verify = jwt.verifyJWT(Redacted.value(issued.accessToken), {
            typ: ApiKey.SERVICE_TOKEN_TYP,
          });
          yield* TestClock.adjust(Duration.minutes(14));
          assert.strictEqual((yield* verify)["sub"], `service:${created.view.clientId}`);
          yield* TestClock.adjust(Duration.minutes(2));
          const expired = yield* Effect.flip(verify);
          assert.strictEqual(expired._tag, "JwtInvalidError");
        }).pipe(provide()),
    );

    it.effect("serviceTokenTtl and serviceTokenAudience shape the token", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const jwt = yield* Jwt.Jwt;
        const created = yield* apiKey.registerClient(owner, { name: "c", scopes: ["a:b"] });
        const issued = yield* apiKey.issueServiceToken({
          clientId: created.view.clientId,
          clientSecret: created.clientSecret,
        });
        assert.strictEqual(issued.expiresIn, 60);
        const claims = yield* jwt.verifyJWT(Redacted.value(issued.accessToken), {
          typ: ApiKey.SERVICE_TOKEN_TYP,
          audience: "inventory-service",
        });
        assert.strictEqual(claims["aud"], "inventory-service");
        // The origin's own audience no longer matches.
        const wrongAudience = yield* Effect.flip(
          jwt.verifyJWT(Redacted.value(issued.accessToken), { typ: ApiKey.SERVICE_TOKEN_TYP }),
        );
        assert.strictEqual(wrongAudience._tag, "JwtInvalidError");
      }).pipe(
        provide({
          serviceTokenTtl: Duration.minutes(1),
          serviceTokenAudience: "inventory-service",
        }),
      ),
    );

    it.effect("clients are scoped to their owner: someone else's client is an unknown client", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const created = yield* apiKey.registerClient(owner, { name: "c", scopes: [] });
        const revoke = yield* Effect.flip(apiKey.revokeClient(someoneElse, created.view.clientId));
        assert.strictEqual(revoke._tag, "ApiKeyClientNotFound");
        const rotate = yield* Effect.flip(
          apiKey.rotateClientSecret(someoneElse, created.view.clientId),
        );
        assert.strictEqual(rotate._tag, "ApiKeyClientNotFound");
        assert.deepStrictEqual(yield* apiKey.listClients(someoneElse), []);
        assert.strictEqual((yield* apiKey.listClients(owner)).length, 1);
      }).pipe(provide()),
    );

    it.effect("grantableScopes also bound what a client may be registered with", () =>
      Effect.gen(function* () {
        const apiKey = yield* ApiKey.ApiKey;
        const refused = yield* Effect.flip(
          apiKey.registerClient(owner, { name: "c", scopes: ["admin:all"] }),
        );
        assert.strictEqual(refused._tag, "ApiKeyScopeNotGrantable");
      }).pipe(provide({ grantableScopes: ["a:b"] })),
    );

    describe("secret rotation (ADR-EA-022)", () => {
      it.effect(
        "after rotateClientSecret both secrets mint tokens until the grace ends, then only the new one",
        () =>
          Effect.gen(function* () {
            const apiKey = yield* ApiKey.ApiKey;
            const created = yield* apiKey.registerClient(owner, { name: "c", scopes: ["a:b"] });
            const rotated = yield* apiKey.rotateClientSecret(owner, created.view.clientId, {
              gracePeriod: Duration.hours(2),
            });
            const oldSecret = created.clientSecret;
            const newSecret = rotated.clientSecret;
            assert.notStrictEqual(Redacted.value(oldSecret), Redacted.value(newSecret));
            const mint = (clientSecret: Redacted.Redacted<string>) =>
              Effect.exit(
                apiKey.issueServiceToken({ clientId: created.view.clientId, clientSecret }),
              );

            yield* TestClock.adjust(Duration.hours(1));
            assert.isTrue((yield* mint(oldSecret))._tag === "Success");
            assert.isTrue((yield* mint(newSecret))._tag === "Success");

            yield* TestClock.adjust(Duration.hours(2));
            assert.isTrue((yield* mint(oldSecret))._tag === "Failure");
            assert.isTrue((yield* mint(newSecret))._tag === "Success");
          }).pipe(provide()),
      );

      it.effect("at most two secrets are ever valid: a second rotation retires the first", () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const created = yield* apiKey.registerClient(owner, { name: "c", scopes: ["a:b"] });
          const second = yield* apiKey.rotateClientSecret(owner, created.view.clientId);
          const third = yield* apiKey.rotateClientSecret(owner, created.view.clientId);
          const mint = (clientSecret: Redacted.Redacted<string>) =>
            Effect.exit(
              apiKey.issueServiceToken({ clientId: created.view.clientId, clientSecret }),
            );
          assert.isTrue((yield* mint(created.clientSecret))._tag === "Failure");
          assert.isTrue((yield* mint(second.clientSecret))._tag === "Success");
          assert.isTrue((yield* mint(third.clientSecret))._tag === "Success");
        }).pipe(provide()),
      );

      it.effect("a grace beyond maxRotationGrace is refused; a revoked client cannot rotate", () =>
        Effect.gen(function* () {
          const apiKey = yield* ApiKey.ApiKey;
          const created = yield* apiKey.registerClient(owner, { name: "c", scopes: [] });
          const tooLong = yield* Effect.flip(
            apiKey.rotateClientSecret(owner, created.view.clientId, {
              gracePeriod: Duration.days(8),
            }),
          );
          assert.strictEqual(tooLong._tag, "ApiKeyLifetimeInvalid");
          yield* apiKey.revokeClient(owner, created.view.clientId);
          const dead = yield* Effect.flip(apiKey.rotateClientSecret(owner, created.view.clientId));
          assert.strictEqual(dead._tag, "ApiKeyClientNotFound");
        }).pipe(provide({ maxRotationGrace: Duration.days(7) })),
      );
    });
  });
};

suite("memory");
suite("sql");
