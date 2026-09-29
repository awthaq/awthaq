// spec/behaviors/18-roles-subject-resolver.md, BEH-EA-137, BEH-EA-142, BEH-EA-143.
import { Api } from "@awthaq/api";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { anonymous } from "@qadi/core";
import * as SubjectResolver from "../src/SubjectResolver.ts";

describe("SubjectResolver (default)", () => {
  it.effect("BEH-EA-137: a UserPrincipal resolves to id-only, no roles or permissions", () =>
    Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const principal = new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: "u-1" }),
        sessionId: "s-1",
      });
      const subject = yield* resolver.resolve(principal);
      assert.strictEqual(subject.id, "user:u-1");
      assert.strictEqual(subject.roles.size, 0);
      assert.strictEqual(subject.permissions.size, 0);
    }),
  );

  it.effect("BEH-EA-143: an AnonymousPrincipal resolves to qadi's own anonymous, verbatim", () =>
    Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const subject = yield* resolver.resolve(Api.anonymousPrincipal);
      assert.deepStrictEqual(subject, anonymous);
    }),
  );

  it.effect("BEH-EA-142: a UserPrincipal's actingAs lands on attributes.actingAs", () =>
    Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const principal = new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: "u-2" }),
        sessionId: "s-2",
        actingAs: new Api.PrincipalRef({ type: "user", id: "admin-1" }),
      });
      const subject = yield* resolver.resolve(principal);
      assert.deepStrictEqual(subject.attributes["actingAs"], { type: "user", id: "admin-1" });
    }),
  );

  it.effect("a UserPrincipal with no actingAs carries no actingAs attribute at all", () =>
    Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const principal = new Api.UserPrincipal({
        ref: new Api.PrincipalRef({ type: "user", id: "u-3" }),
        sessionId: "s-3",
      });
      const subject = yield* resolver.resolve(principal);
      assert.isFalse("actingAs" in subject.attributes);
    }),
  );

  // AAPS-006/SOS-005/HSK-005 (BEH-EA-255): how the session was authenticated reaches the policy layer.
  it.effect(
    "a session's amr, authenticatedAt and derived aal land on the subject's attributes",
    () =>
      Effect.gen(function* () {
        const resolver = yield* SubjectResolver.SubjectResolver;
        const principal = new Api.UserPrincipal({
          ref: new Api.PrincipalRef({ type: "user", id: "u-aal" }),
          sessionId: "s-aal",
          amr: ["pwd", "otp", "mfa"],
          authenticatedAt: 1_700_000_000,
        });
        const subject = yield* resolver.resolve(principal);
        assert.deepStrictEqual(subject.attributes["amr"], ["pwd", "otp", "mfa"]);
        assert.strictEqual(subject.attributes["authenticatedAt"], 1_700_000_000);
        assert.strictEqual(subject.attributes["aal"], "aal2");
        assert.strictEqual(subject.attributes["restrictedFactor"], false);
      }),
  );

  it.effect("a passkey session and a password+SMS session are distinguishable by aal", () =>
    Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const user = (id: string, amr: ReadonlyArray<string>) =>
        new Api.UserPrincipal({
          ref: new Api.PrincipalRef({ type: "user", id }),
          sessionId: `s-${id}`,
          amr,
        });
      const passkey = yield* resolver.resolve(user("pk", ["hwk", "user"]));
      const sms = yield* resolver.resolve(user("sms", ["pwd", "sms"]));
      assert.strictEqual(passkey.attributes["aal"], "aal3");
      assert.strictEqual(sms.attributes["restrictedFactor"], true);
      assert.include(passkey.attributes["amr"], "hwk");
    }),
  );

  it.effect("a principal with no recorded amr resolves to the aal1 floor, not a guess", () =>
    Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const subject = yield* resolver.resolve(
        new Api.UserPrincipal({
          ref: new Api.PrincipalRef({ type: "user", id: "u-none" }),
          sessionId: "s-none",
        }),
      );
      assert.deepStrictEqual(subject.attributes["amr"], []);
      assert.strictEqual(subject.attributes["aal"], "aal1");
    }),
  );

  it.effect("BEH-EA-140: an ApiKeyPrincipal's scopes become AuthSubject permissions", () =>
    Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const principal = new Api.ApiKeyPrincipal({
        ref: new Api.PrincipalRef({ type: "apikey", id: "key-1" }),
        scopes: ["reports:read", "scim:users:write"],
      });
      const subject = yield* resolver.resolve(principal);
      assert.strictEqual(subject.id, "apikey:key-1");
      assert.deepStrictEqual([...subject.permissions].sort(), ["reports:read", "scim:users:write"]);
    }),
  );

  it.effect("BEH-EA-141: a ServicePrincipal's scopes become AuthSubject permissions", () =>
    Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const principal = new Api.ServicePrincipal({
        ref: new Api.PrincipalRef({ type: "service", id: "svc-1" }),
        scopes: ["invoices:read"],
      });
      const subject = yield* resolver.resolve(principal);
      assert.strictEqual(subject.id, "service:svc-1");
      assert.deepStrictEqual([...subject.permissions], ["invoices:read"]);
    }),
  );

  it.effect("a scope that is not shaped resource:action names no permission (fail-closed)", () =>
    Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const principal = new Api.ApiKeyPrincipal({
        ref: new Api.PrincipalRef({ type: "apikey", id: "key-2" }),
        scopes: ["admin", ":read", "read:", "ok:read"],
      });
      const subject = yield* resolver.resolve(principal);
      assert.deepStrictEqual([...subject.permissions], ["ok:read"]);
      assert.strictEqual(subject.permissions.size, 1);
    }),
  );

  it.effect("no scopes, no permissions", () =>
    Effect.gen(function* () {
      const resolver = yield* SubjectResolver.SubjectResolver;
      const subject = yield* resolver.resolve(
        new Api.ApiKeyPrincipal({
          ref: new Api.PrincipalRef({ type: "apikey", id: "key-3" }),
          scopes: [],
        }),
      );
      assert.strictEqual(subject.permissions.size, 0);
    }),
  );
});
