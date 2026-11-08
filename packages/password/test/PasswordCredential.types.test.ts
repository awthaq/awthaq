// Plan 27 (ticket 02): what the type system carries for the password credential module. These are
// compile-time checks (`tsc -p tsconfig.test.json` is the assertion), with runtime tests so the
// file is a suite.
import { Accounts, Auth, AuthPlugin, Users } from "@awthaq/core";
import { PasswordHasher } from "@awthaq/ports";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import * as PasswordCredential from "../src/PasswordCredential.ts";
import { makeTestLayer } from "./harness.ts";

type Includes<Haystack, Needle> = [Needle] extends [Haystack] ? true : false;

// `Password.layer` exposes the module (ADR-EA-040), declared without `as const`: it is in the
// layer's output and not among its requirements.
export const passwordExposesTheModule: Includes<
  Layer.Success<typeof Password.Password.layer>,
  PasswordCredential.PasswordCredential
> = true;
export const passwordDoesNotRequireTheModule: Includes<
  Layer.Services<typeof Password.Password.layer>,
  PasswordCredential.PasswordCredential
> = false;

// A trusted dependent requires the module and lists `Password` in `dependsOn`.
class Steward extends AuthPlugin.Service<Steward, {}>()("steward", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  static readonly layer = AuthPlugin.layer(Steward, {
    dependsOn: [Password.Password],
    make: Effect.gen(function* () {
      yield* PasswordCredential.PasswordCredential;
      return {};
    }),
  });
}

// ...and one that requires it without listing `Password`.
class Stowaway extends AuthPlugin.Service<Stowaway, {}>()("stowaway", {
  apiVersion: 1,
  contract: HttpApi.make("auth"),
}) {
  static readonly layer = AuthPlugin.layer(Stowaway, {
    make: Effect.gen(function* () {
      yield* PasswordCredential.PasswordCredential;
      return {};
    }),
  });
}

export const composesWithPassword = () => Auth.make([Password.Password, Steward]);
// @ts-expect-error - plugin "steward" depends on plugin "password", which is not in the list
export const refusedWithoutPassword = () => Auth.make([Steward]);
// @ts-expect-error - plugin "stowaway" requires a service exposed by "password": add it to dependsOn
export const refusedWithoutDependsOn = () => Auth.make([Password.Password, Stowaway]);

// A proof cannot be forged: only `verify` mints one.
export const cannotForgeAProof = (credential: PasswordCredential.PasswordCredentialShape) =>
  credential.rehashIfStale(
    // @ts-expect-error - a plain object is not a `Proof`
    {
      accountId: Accounts.AccountId("a-1"),
      hash: Redacted.make(PasswordHasher.PhcHash("h")),
      candidate: Redacted.make("x"),
    },
  );

// No write without the policy: an `Accepted` cannot be built from a literal, and `linkFor` refuses a
// raw candidate.
export const cannotForgeAnAcceptance = (credential: PasswordCredential.PasswordCredentialShape) =>
  // @ts-expect-error - a plain `{ candidate }` is not an `Accepted`; only `accept` mints one
  credential.linkFor({ candidate: Redacted.make("x") });
export const cannotLinkARawCandidate = (credential: PasswordCredential.PasswordCredentialShape) =>
  // @ts-expect-error - a raw `Redacted` is not an `Accepted`
  credential.linkFor(Redacted.make("x"));

// `verify` takes any claimant effect whose value carries the user id: a `Users.findByEmail`
// lookup (`U = UserRecord`, `E = StoreUnavailable`) and a known id alike, with no annotation.
export const verifiesALookup = (
  credential: PasswordCredential.PasswordCredentialShape,
  users: Users.UsersShape,
) =>
  credential
    .verify(users.findByEmail("ada@example.com"), Redacted.make("x"))
    .pipe(
      Effect.map((verdict): Option.Option<Users.UserRecord> =>
        verdict._tag === "Verified" ? Option.some(verdict.claimant) : Option.none(),
      ),
    );
export const verifiesAKnownId = (credential: PasswordCredential.PasswordCredentialShape) =>
  credential.verify(Effect.succeedSome({ id: Users.UserId("u-1") }), Redacted.make("x"));

describe("PasswordCredential types (plan 27)", () => {
  it("lists the exposed key on Password, readable without building a layer", () => {
    assert.deepStrictEqual(Password.Password.exposes, ["awthaq/plugin/password/Credential"]);
    assert.deepStrictEqual(Steward.dependsOn, [Password.Password]);
  });

  it.effect("a composition of Password provides the module to a test", () =>
    Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      assert.isFunction(credential.verify);
    }).pipe(Effect.provide(makeTestLayer())),
  );
});
