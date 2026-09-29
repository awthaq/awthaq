// AOMS-006 (.issues/high, wayfinder ticket 03): proves `Password.signUp`
// genuinely consults `Hooks.BeforeSignUp` — an Auth0-Rule-style policy
// (e.g. an email-domain allow-list) may reject the sign-up outright, or
// amend the input for whatever runs after it. A dedicated file, not
// folded into `Password.test.ts` — `HookPoint`'s tap registry freezes at
// its own first `run()` (BEH-EA-024), a shared, module-level singleton
// class, and `Password.test.ts`'s own untapped `signUp` coverage would
// otherwise freeze it with zero taps before this file's own tap could
// ever install (see `packages/organization/test/OrganizationHooks.test.ts`'s
// own identical reasoning).
import {
  AuditLog,
  Hooks,
  HookPoint,
  AuthEvents,
  RateLimits,
  Sessions,
  Users,
  Verification,
  Accounts,
} from "@awthaq/core";
import { ClientAddress, Mailer, PasswordHasher, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { Authentication, Csrf } from "@awthaq/server";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Password from "../src/Password.ts";

const NoBreachHttpClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const CoreLive = Layer.mergeAll(
  Users.layerMemory,
  Accounts.layerMemory,
  Sessions.layerMemory,
  Verification.layerMemory,
).pipe(
  Layer.provideMerge(AuthEvents.layer),
  Layer.provideMerge(AuditLog.layerMemory),
  Layer.provideMerge(Hooks.HooksLive),
  Layer.provideMerge(
    Hooks.BeforeSignUp.tap((input) =>
      input.email.endsWith("@forbidden.example.com")
        ? Effect.fail(new HookPoint.HookAbort({ code: "DOMAIN_BLOCKED" }))
        : Effect.succeed({ ...input, name: `${input.name} (tapped)` }),
    ),
  ),
  Layer.provideMerge(NodeCrypto.layer),
);

const PortsLive = Layer.mergeAll(
  PasswordHasher.layerArgon2id,
  Mailer.layerMemory,
  RateLimiter.layerPermissive,
).pipe(Layer.provideMerge(NodeCrypto.layer));

const AuthenticationLive = Authentication.AuthenticationLive.pipe(
  Layer.provide(Authentication.PrincipalResolverLive),
);

const CsrfProtectionLive = Csrf.CsrfProtectionLive.pipe(
  Layer.provide(
    Layer.succeed(Csrf.CsrfConfig, {
      secret: Redacted.make("password-hooks-test-csrf-secret-padded-to-thirty-two-bytes"),
      allowedOrigins: [] as ReadonlyArray<string>,
    }),
  ),
  Layer.provide(NodeCrypto.layer),
);

const TestLayer = Password.Password.layer.pipe(
  Layer.provideMerge(AuthenticationLive),
  Layer.provide(CsrfProtectionLive),
  Layer.provideMerge(CoreLive),
  Layer.provideMerge(PortsLive),
  Layer.provideMerge(RateLimits.layer),
  Layer.provide(NoBreachHttpClient),
  Layer.provide(SqlTransaction.layerNoop),
  Layer.provide(ClientAddress.layerDirect),
);

const strongPassword = Redacted.make("correct horse battery staple");

describe("Password signUp hook (BEH-EA-090)", () => {
  it.effect(
    "a BeforeSignUp veto tap can reject a sign-up outright, or amend it for the operation to use",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;

        // JH-001/PERS-001: BEH-EA-090's own MUST — the veto abort reaches
        // the caller as the typed `HookAborted`, naming this point's own
        // id and the tap's own code.
        const aborted = yield* password
          .signUp({ email: "eve@forbidden.example.com", password: strongPassword })
          .pipe(
            Effect.flip,
            Effect.flatMap((error) =>
              error._tag === "HookAborted" ? Effect.succeed(error) : Effect.die(error),
            ),
          );
        assert.strictEqual(aborted.point, "auth.user.signUp");
        assert.strictEqual(aborted.code, "DOMAIN_BLOCKED");

        // A non-blocked email passes through, with the tap's own
        // amendment (the appended "(tapped)" suffix) actually used by the
        // real `users.create` call this flow makes.
        const issued = yield* password.signUp({
          email: "ada@example.com",
          password: strongPassword,
        });
        assert.isString(issued.session.userId);
      }).pipe(Effect.provide(TestLayer)),
  );
});
