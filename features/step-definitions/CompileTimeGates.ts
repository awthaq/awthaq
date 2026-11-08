// Final-round burn-down of the `@skip`ped compile-time scenarios: the claims below are verified by
// the TypeScript compiler, not by vitest — the same convention as `PluginTypeGates.ts` (read its
// header). This file is part of the typecheck program, so it stops compiling the moment a claim
// stops holding (a `// @ts-expect-error` with no error under it is itself an error); the steps that
// name these scenarios read this file's source (`assertTypeGate`) so a gate cannot be deleted or
// gutted without its scenario failing. A gate is a `// type-gate: <name>` line followed by its
// block (up to the next blank line).
// @effect-diagnostics missingEffectContext:off
import { Api, SessionLifecycle } from "@awthaq/api";
import {
  Auth,
  EmailChange,
  HookPoint,
  RateLimits,
  type Users,
  Verification,
  VerificationLink,
} from "@awthaq/core";
import { TwoFactor } from "@awthaq/two-factor";
import { OAuthProvider } from "@awthaq/oauth";
import { Password } from "@awthaq/password";
import { ClientAddress, Mailer, PasswordHasher, RateLimiter } from "@awthaq/ports";
import { AuthHost, Csrf, RequestContext, SessionDelivery } from "@awthaq/server";
import { TestAuth } from "@awthaq/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { AuthorizedSubject } from "@awthaq/qadi";
import type { Authorized, Permission } from "@qadi/core";
import { PublicEndpoint } from "@qadi/http";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

// ---- 12-hooks.feature: BEH-EA-089 (REQ-EA-242/243) and BEH-EA-094 (REQ-EA-253/254) ----

class Complete extends HookPoint.veto<Complete>()("auth.gate.complete", Schema.String) {}

// type-gate: hook-kind-is-the-factory
// @ts-expect-error - `HookPoint.Service` does not exist: the kind is chosen by `veto`/`observe`/`divert`, so it cannot be omitted
export const noGenericFactory = HookPoint.Service;

// type-gate: hook-input-is-required
// Never called: the definition would not run without its schema.
export const definesWithoutInput = () => {
  // @ts-expect-error - `input` is a required argument of every factory
  class NoInput extends HookPoint.veto<NoInput>()("auth.gate.no-input") {}
  void NoInput;
};

// type-gate: tap-needs-its-point
const tapOnCompleted = Complete.tap((value) => Effect.succeed(value));
export const unsatisfiedTap = () =>
  // @ts-expect-error - `Complete` is required by the tap's Layer but nothing provides it (INV-EA-005)
  Effect.runPromise(Layer.launch(tapOnCompleted));

// type-gate: tap-satisfied-by-its-point
export const satisfiedTap = () =>
  Effect.runPromise(Layer.launch(tapOnCompleted.pipe(Layer.provide(Complete.layer))));

// ---- 15-password.feature: BEH-EA-115 (REQ-EA-312) and BEH-EA-120 (REQ-EA-326) ----

// type-gate: password-requires-a-hasher
export const passwordNeedsAHasher: PasswordHasher.PasswordHasher extends Layer.Services<
  typeof Password.Password.layer
>
  ? true
  : false = true;

// type-gate: password-config-is-policy-only
export const tightenedPolicy = Password.config({ minLength: 16 });
// @ts-expect-error - a policy override carries no contract, table or migration field to override
export const overriddenContract = Password.config({ contract: {}, tables: [], migrations: [] });

// ---- 33-email-otp.feature: BEH-EA-271 (REQ-EA-1102) ----

// type-gate: numeric-value-is-never-caller-chosen
export const callerChosenValue = (verification: Verification.VerificationShape) =>
  verification.issue({
    identifier: "email-otp:gate@example.com",
    ttl: Duration.minutes(5),
    format: { _tag: "Numeric", digits: 6 },
    maxAttempts: 3,
    // @ts-expect-error - `IssueInput` has no field through which a caller could choose the value
    value: "123456",
  });

// ---- 08-verification-tokens.feature: BEH-EA-058 (REQ-EA-1282) ----

// type-gate: verification-miss-protocol-is-internal
export const deferredMiss = (verification: Verification.VerificationShape) =>
  // @ts-expect-error - `consume` takes no options: a caller that needs a transaction uses `redeem`
  verification.consume("verify-email:gate", Redacted.make("v"), { deferMiss: true });
export const recordedMiss = (verification: Verification.VerificationShape) =>
  // @ts-expect-error - there is no `recordMiss`: `redeem` records a miss itself
  verification.recordMiss("verify-email:gate");
export const unknownSettlement = (verification: Verification.VerificationShape) =>
  verification.redeem({
    identifier: "verify-email:gate",
    value: Redacted.make("v"),
    use: () => Effect.void,
    // @ts-expect-error - a settlement is "rollback" or "commit"
    onFailure: () => "burn",
  });

// ---- 08-verification-tokens.feature: BEH-EA-057 (REQ-EA-1317) ----

type LinkDeps = Parameters<typeof VerificationLink.issue>[0];
const GateReset = VerificationLink.forUser({ name: "reset-password" });
const GateVerify = VerificationLink.forUser({ name: "verify-email" });

// type-gate: verification-link-purpose
export const mintWithoutUser = (deps: LinkDeps) =>
  // @ts-expect-error - a `forUser` purpose requires the `userId` its row names
  VerificationLink.issue(deps, GateReset, { ttl: Duration.hours(1) });
export const mintWithAnotherPayload = (deps: LinkDeps, userId: Users.UserId) =>
  VerificationLink.issue(deps, EmailChange.Link, {
    ttl: Duration.hours(1),
    userId,
    // @ts-expect-error - the change-email payload is `{ newEmail }`, not another purpose's shape
    payload: { email: "x" },
  });
export const redeemAnotherPurposesToken = (
  verification: Verification.VerificationShape,
  minted: VerificationLink.IssuedLink<"reset-password">,
) =>
  VerificationLink.redeemer(GateVerify, {
    verification,
    budget: { source: "caller", token: "none" },
  })(
    // @ts-expect-error - a token minted for "reset-password" is not accepted by the "verify-email" redeemer
    { token: minted.token },
    Effect.succeed,
  );

// ---- 14-rate-limiting.feature: BEH-EA-108 (REQ-EA-292) ----

// type-gate: rate-limit-key-is-a-strategy-or-a-function
export const builtInIp = RateLimits.rule({
  group: "g",
  endpoint: "e",
  key: RateLimits.Key.ip,
  limit: 1,
  window: "1 minute",
});
export const customKey = RateLimits.rule({
  group: "g",
  endpoint: "e",
  key: RateLimits.Key.custom(
    "custom",
    Schema.Struct({ email: Schema.String }),
    (input) => input.email,
  ),
  limit: 1,
  window: "1 minute",
});
export const arbitraryKey = RateLimits.rule({
  group: "g",
  endpoint: "e",
  // @ts-expect-error - a bare string is not a key strategy: keying on caller-supplied data needs Key.custom
  key: "x-forwarded-for",
  limit: 1,
  window: "1 minute",
});

// ---- 14-rate-limiting.feature: BEH-EA-111 (plan 06) ----

const gatedRules = {
  signIn: RateLimits.rule({
    group: "gated",
    endpoint: "get",
    key: RateLimits.Key.ip,
    limit: 1,
    window: "1 minute",
  }),
};

// type-gate: spend-names-only-declared-rules
// (An `ip` rule takes no input: it reads the request context's address, ADR-EA-047.)
export const spendsDeclared = (limits: RateLimits.Budget<typeof gatedRules>) =>
  limits.spend("signIn");
export const spendsUndeclared = (limits: RateLimits.Budget<typeof gatedRules>) =>
  // @ts-expect-error - "signUp" is not in the table the plugin declared, so it cannot be enforced
  limits.spend("signUp");

// ---- 19-qadi-bridge-path-a.feature: BEH-EA-145 (REQ-EA-406) ----

const bridgedBase = HttpApiGroup.make("gated").add(
  HttpApiEndpoint.get("get", "/gated", { success: Schema.String }),
);

// type-gate: authorized-subject-needs-authentication-first
export const misordered = bridgedBase
  .middleware(Api.Authentication)
  .middleware(AuthorizedSubject.AuthorizedSubject);
export const misorderedLeavesPrincipal: Api.CurrentPrincipal extends HttpApiGroup.MiddlewareServices<
  typeof misordered
>
  ? true
  : false = true;

// type-gate: authorized-subject-in-the-right-order
export const ordered = bridgedBase
  .middleware(AuthorizedSubject.AuthorizedSubject)
  .middleware(Api.Authentication)
  // ADR-EA-047: the request context `Authentication` requires, outermost.
  .middleware(Api.RequestContext);
export const orderedLeavesNothing: [HttpApiGroup.MiddlewareServices<typeof ordered>] extends [never]
  ? true
  : false = true;

// type-gate: guard-witness-is-not-a-boolean
const removeWithWitness = (_witness: Authorized<Permission>, _id: string) => Effect.void;
// @ts-expect-error - `true` is not the branded witness only `guard` mints (BEH-EA-151, REQ-EA-423)
export const flagInPlaceOfWitness = removeWithWitness(true, "project-42");

// ---- 20-qadi-bridge-path-b.feature: BEH-EA-155 (REQ-EA-435) ----

// type-gate: public-endpoint-needs-a-reason
export const bareBoolean = HttpApiEndpoint.get("health", "/health", {
  success: Schema.String,
}).annotate(
  PublicEndpoint,
  // @ts-expect-error - the annotation value is qadi's `PublicDeclaration` ({ reason: string }); a bare boolean is not one
  true,
);

// ---- 31-two-factor.feature: BEH-EA-261 (REQ-EA-1039) ----

type Includes<Haystack, Needle> = [Needle] extends [Haystack] ? true : false;
type TwoFactorNeeds = Layer.Services<typeof TwoFactor.TwoFactor.layer>;

// type-gate: two-factor-requires-the-session-gate
export const requiresTheSessionGate: Includes<TwoFactorNeeds, TwoFactor.TwoFactorGateInstalled> =
  true;

// type-gate: two-factor-requires-the-rate-limiter-port
export const requiresTheRateLimiterPort: Includes<TwoFactorNeeds, RateLimiter.RateLimiter> = true;

// type-gate: two-factor-requires-a-reset-guard
export const requiresAResetGuard: Includes<TwoFactorNeeds, TwoFactor.TwoFactorResetGuard> = true;

// ---- 16-oauth.feature: BEH-EA-126 (REQ-EA-347) ----

// type-gate: oauth-secret-is-config-redacted
export const leakyProvider = OAuthProvider.oauth2({
  id: "leaky",
  clientId: "abc",
  // @ts-expect-error - a secret must be a `Config<Redacted<string>>`, never a bare string
  clientSecret: "hunter2",
  scopes: [],
  endpoints: {
    authorizationEndpoint: "https://x.example.com/a",
    tokenEndpoint: "https://x.example.com/t",
  },
  mapProfile: () => ({ subject: "x" }),
});

// ---- 02-plugin-composition-validate.feature: BEH-EA-340 (plan 15) ----

// type-gate: auth-host-missing-port
const hostedPassword = AuthHost.layer(Auth.make([Password.Password]), {
  persistence: { records: "memory" },
  csrf: Csrf.layerConfig,
});
const everyPortButMailer = Layer.mergeAll(
  PasswordHasher.layerArgon2id,
  RateLimiter.layerPermissive,
  ClientAddress.layerDirect,
  TestAuth.httpClient.noBreach,
).pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provideMerge(HttpRouter.layer),
);
export const hostWithoutMailer = () =>
  // @ts-expect-error - `Mailer` is still in the layer's requirements: the host omitted a port (BEH-EA-014)
  Effect.runPromise(Layer.launch(hostedPassword.pipe(Layer.provide(everyPortButMailer))));
export const hostWithEveryPort = () =>
  Effect.runPromise(
    Layer.launch(
      hostedPassword.pipe(Layer.provide(everyPortButMailer), Layer.provide(Mailer.layerMemory)),
    ),
  );

// ---- 04-contract-stratum.feature: BEH-EA-343 (plan 21, ADR-EA-045) ----

const lifecycleApi = HttpApi.make("auth").add(
  HttpApiGroup.make("gate")
    .add(
      HttpApiEndpoint.post("mint", "/gate/mint", { success: Schema.String }).middleware(
        SessionLifecycle.Mints,
      ),
    )
    .add(HttpApiEndpoint.post("plain", "/gate/plain", { success: Schema.String })),
);

// type-gate: session-delivery-needs-a-declared-endpoint
export const undeclaredDelivery = HttpApiBuilder.group(lifecycleApi, "gate", (handlers) =>
  handlers
    .handle("mint", () => Effect.as(SessionDelivery.decline(SessionLifecycle.MintGrant), "ok"))
    .handle("plain", () => Effect.as(SessionDelivery.decline(SessionLifecycle.MintGrant), "ok")),
);
export const undeclaredLeavesTheGrant: [
  Extract<
    Layer.Services<typeof undeclaredDelivery>,
    HttpRouter.Request<"Requires", SessionLifecycle.MintGrant>
  >,
] extends [never]
  ? false
  : true = true;

// type-gate: a-declared-endpoint-gets-its-grant
export const declaredDelivery = HttpApiBuilder.group(lifecycleApi, "gate", (handlers) =>
  handlers
    .handle("mint", () => Effect.as(SessionDelivery.decline(SessionLifecycle.MintGrant), "ok"))
    .handle("plain", () => Effect.succeed("ok")),
);
export const declaredLeavesNothing: [
  Extract<Layer.Services<typeof declaredDelivery>, HttpRouter.Request<"Requires", unknown>>,
] extends [never]
  ? true
  : false = true;

// ---- 09-authentication-middleware: ADR-EA-047 (plan 26) ----

const contextGroup = HttpApiGroup.make("context")
  .add(HttpApiEndpoint.get("who", "/context", { success: Schema.String }))
  .middleware(Api.RequestContext);
const contextApi = HttpApi.make("auth").add(contextGroup);
const contextHandlers = HttpApiBuilder.group(contextApi, "context", (handlers) =>
  handlers.handle("who", () =>
    Effect.map(Effect.service(Api.AuthRequestContext), (context) => context._tag),
  ),
);

// type-gate: serving-without-request-context-does-not-compile
// A group whose handler reads the request context, served without the populator, leaves `Api.RequestContext`
// an unmet requirement: the layer cannot be launched.
// @ts-expect-error - `Api.RequestContext` (the request context's populator) is still required
export const servedWithoutRequestContext: Layer.Layer<never, never, never> = contextHandlers;
export const servedWithRequestContext = contextHandlers.pipe(
  Layer.provide(RequestContext.RequestContextLive),
  Layer.provide(ClientAddress.layerDirect),
  Layer.provide(NodeCrypto.layer),
);
export const withTheRequestContextNothingIsLeft: [
  Layer.Services<typeof servedWithRequestContext>,
] extends [never]
  ? true
  : false = true;
