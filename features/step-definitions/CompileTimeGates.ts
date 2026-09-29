// Final-round burn-down of the `@skip`ped compile-time scenarios: the claims below are verified by
// the TypeScript compiler, not by vitest — the same convention as `PluginTypeGates.ts` (read its
// header). This file is part of the typecheck program, so it stops compiling the moment a claim
// stops holding (a `// @ts-expect-error` with no error under it is itself an error); the steps that
// name these scenarios read this file's source (`assertTypeGate`) so a gate cannot be deleted or
// gutted without its scenario failing. A gate is a `// type-gate: <name>` line followed by its
// block (up to the next blank line).
// @effect-diagnostics missingEffectContext:off
import { Api } from "@awthaq/api";
import { HookPoint, RateLimits, Verification } from "@awthaq/core";
import { TwoFactor } from "@awthaq/two-factor";
import { OAuthProvider } from "@awthaq/oauth";
import { Password } from "@awthaq/password";
import { PasswordHasher, RateLimiter } from "@awthaq/ports";
import { AuthorizedSubject } from "@awthaq/qadi";
import { PublicEndpoint } from "@qadi/http";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

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

// ---- 14-rate-limiting.feature: BEH-EA-108 (REQ-EA-292) ----

// type-gate: rate-limit-key-is-a-strategy-or-a-function
export const principalKey: RateLimits.RateLimitKey = "principal";
export const ipKey: RateLimits.RateLimitKey = "ip";
export const customKey: RateLimits.RateLimitKey = (input) => `signin:${JSON.stringify(input)}`;
// @ts-expect-error - a bare string other than the two strategies is not a key: keying on caller-supplied data needs a function
export const arbitraryKey: RateLimits.RateLimitKey = "x-forwarded-for";

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
  .middleware(Api.Authentication);
export const orderedLeavesNothing: [HttpApiGroup.MiddlewareServices<typeof ordered>] extends [never]
  ? true
  : false = true;

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
