// @awthaq/core — SignIn (ADR-EA-038, BEH-EA-322)
//
// Eight flows turn a proven credential into a session. Each used to write the same sequence by
// hand (look up the user, the suspension gate, the `BeforeSignIn` veto, the `BeforeSessionIssue`
// divert, mint, `auth.user.signedIn`, `AfterSignIn`), and the copies drifted: SAML's divert lost its
// `amr`, a SAML sign-in finished by a second factor lost its Single Logout record, role mapping and
// tenant, only password announced a suspended refusal, a missing user had five answers. This module
// is the one implementation.
//
// - `clear(attempt)` returns a branded `Clearance`: the lookup, the gate (and the
//   `signInFailed{suspended}` event), the veto and the divert. The `amr` the divert sees is the
//   `amr` the clearance records, so they cannot disagree.
// - `issue(clearance)` is the only way to mint a session for a proven credential: it accepts
//   nothing but a `Clearance`, whose constructor is package-private. It mints under the clearance's
//   tenant, runs the first factor's continuation, publishes `auth.user.signedIn` and runs `AfterSignIn`.
// - `complete` is `clear` then `issue`, for every flow with nothing to do between the two.
// - `resume` is for the one plugin that resolved a divert (two-factor): it re-runs the gate only,
//   because the veto and the divert already ran for this sign-in, and restores the tenant and the
//   continuation from the handoff the divert carried.
//
// A plugin resolves this once inside its `make` (`SignIn.make`), like `MailDispatch.make`: its
// requirements are already in every sign-in plugin's `RIn`, so no host wires a new layer.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as HookPoint from "./HookPoint.ts";
import type * as Hooks from "./Hooks.ts";
import * as Steps from "./internal/signInSteps.ts";
import type { StoreUnavailable } from "./Errors.ts";
import { SignInContinuationRegistry } from "./SignInContinuationRegistry.ts";
import type { ContinuationContext } from "./SignInContinuationRegistry.ts";
import type * as Users from "./Users.ts";

export type { Attempt, Clearance, IssuedSession, SessionRequest } from "./internal/signInSteps.ts";
export { UserGone } from "./internal/signInSteps.ts";
// The registry class and the three hook points `make` requires ride this namespace so a plugin whose
// inferred layer type mentions them can name them through the `SignIn` import it already has (TS2883).
export * from "./SignInContinuationRegistry.ts";
export { AfterSignIn, BeforeSessionIssue, BeforeSignIn } from "./Hooks.ts";

export type ClearError =
  | Steps.UserGone
  | Users.UserSuspended
  | HookPoint.HookAborted
  | Hooks.TwoFactorRequired
  | StoreUnavailable;
export type ResumeError = Steps.UserGone | Users.UserSuspended | StoreUnavailable;

export interface SignInShape {
  /** Lookup, gate (+ `signInFailed{suspended}`), `BeforeSignIn`, `BeforeSessionIssue` (with this `amr` and the handoff). */
  readonly clear: (attempt: Steps.Attempt) => Effect.Effect<Steps.Clearance, ClearError>;
  /**
   * For the plugin that resolved a divert (two-factor) with the handoff the divert carried:
   * re-runs the gate only, because `BeforeSignIn` and `BeforeSessionIssue` already ran for this
   * sign-in. Call sites are allow-listed by `SignInSeams.test.ts`.
   */
  readonly resume: (
    attempt: Steps.Attempt & { readonly handoff?: Hooks.Handoff | undefined },
  ) => Effect.Effect<Steps.Clearance, ResumeError>;
  /** Mints under the clearance's tenant, runs its continuation, publishes `auth.user.signedIn`, runs `AfterSignIn`. */
  readonly issue: (
    clearance: Steps.Clearance,
    request?: Steps.SessionRequest,
  ) => Effect.Effect<Steps.IssuedSession, StoreUnavailable>;
  /** `clear` then `issue`: every flow with nothing to do between the two. */
  readonly complete: (
    attempt: Steps.Attempt,
    request?: Steps.SessionRequest,
  ) => Effect.Effect<Steps.IssuedSession, ClearError>;
}

/** Resolves the core services once, at plugin build; the returned closures carry no further requirements. */
export const make = Effect.map(Steps.makeSteps, (steps) => {
  const issue: SignInShape["issue"] = (cleared, request) =>
    Effect.flatMap(steps.mint(cleared, request), (issued) => steps.announce(cleared, issued));
  const complete: SignInShape["complete"] = (attempt, request) =>
    Effect.flatMap(steps.clear(attempt), (cleared) => issue(cleared, request));
  return { clear: steps.clear, resume: steps.resume, issue, complete } satisfies SignInShape;
});

/**
 * The typed front door for a sign-in continuation: work a first factor owes once its session
 * exists, whichever request finally mints it. `of(payload)` is what the first factor passes as
 * `Attempt.continuation` (the payload is encoded to JSON so it can cross a divert); `layer` (or
 * `register`, for a handler that closes over the plugin's own `make` scope) registers the handler,
 * which decodes it again.
 */
export const continuation = <P, I extends Schema.Json, E, R>(options: {
  /** The contributing plugin's id. */
  readonly id: string;
  readonly kind: string;
  readonly payload: Schema.Codec<P, I>;
  readonly make: Effect.Effect<
    (payload: P, context: ContinuationContext) => Effect.Effect<void, StoreUnavailable>,
    E,
    R
  >;
}) => {
  const decode = Schema.decodeUnknownEffect(options.payload);
  const encode = Schema.encodeEffect(options.payload);
  /** Registers the handler; a plugin whose handler closes over its own `make` scope yields this there. */
  const register = Effect.gen(function* () {
    const registry = yield* SignInContinuationRegistry;
    const run = yield* options.make;
    yield* registry.register({
      id: options.id,
      kind: options.kind,
      run: (payload, context) =>
        decode(payload).pipe(
          Effect.catchTag("SchemaError", Effect.die),
          Effect.flatMap((decoded) => run(decoded, context)),
        ),
    });
  });
  return {
    kind: options.kind,
    of: (payload: P) =>
      encode(payload).pipe(
        Effect.map((encoded): Hooks.Continuation => ({ kind: options.kind, payload: encoded })),
        // ADR-EA-028 D3: a codec bug is a defect, not a request outcome.
        Effect.catchTag("SchemaError", Effect.die),
      ),
    register,
    /** `AuthPlugin.layer(Self, { contributes })`: registers the handler when the layer is built. */
    layer: Layer.effectDiscard(register),
  };
};
