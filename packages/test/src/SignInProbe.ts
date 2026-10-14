// @awthaq/test — SignInProbe (ADR-EA-038)
//
// Sign-in and sign-up policy (suspension, veto, divert, announcement) is tested once, at the
// `SignIn` and `SignUp` interfaces in core. A credential plugin then only needs to prove its
// *wiring*: which strategy and `amr` it hands the module, and which refusal it maps a vanished
// user to. This layer records what every sign-in/sign-up hook point is consulted with, never
// vetoing and never diverting, so a plugin test asserts exactly that and nothing more.
//
// Provide it on top of the composition's hook points, before the plugin runs:
// `SignInProbe.layer.pipe(Layer.provideMerge(TestAuth.memoryFoundation))`.

import { Hooks } from "@awthaq/core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export interface Recorded {
  readonly beforeSignUp: ReadonlyArray<Parameters<Parameters<typeof Hooks.BeforeSignUp.tap>[0]>[0]>;
  readonly afterSignUp: ReadonlyArray<Parameters<Parameters<typeof Hooks.AfterSignUp.tap>[0]>[0]>;
  readonly beforeSignIn: ReadonlyArray<Parameters<Parameters<typeof Hooks.BeforeSignIn.tap>[0]>[0]>;
  readonly beforeSessionIssue: ReadonlyArray<
    Parameters<Parameters<typeof Hooks.BeforeSessionIssue.tap>[0]>[0]
  >;
  readonly afterSignIn: ReadonlyArray<Parameters<Parameters<typeof Hooks.AfterSignIn.tap>[0]>[0]>;
}

const empty: Recorded = {
  beforeSignUp: [],
  afterSignUp: [],
  beforeSignIn: [],
  beforeSessionIssue: [],
  afterSignIn: [],
};

export interface SignInProbeShape {
  /** Everything the five hook points were consulted with so far, in order. */
  readonly recorded: Effect.Effect<Recorded>;
}

export class SignInProbe extends Context.Service<SignInProbe, SignInProbeShape>()(
  "awthaq/test/SignInProbe",
) {}

const record = <Key extends keyof Recorded>(ref: Ref.Ref<Recorded>, key: Key) => {
  return (input: Recorded[Key][number]) =>
    Ref.update(ref, (current) => ({ ...current, [key]: [...current[key], input] }));
};

/** Recording taps on `BeforeSignUp`, `AfterSignUp`, `BeforeSignIn`, `BeforeSessionIssue` (never diverting) and `AfterSignIn`. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const ref = yield* Ref.make(empty);
    return Layer.mergeAll(
      Layer.succeed(SignInProbe, SignInProbe.of({ recorded: Ref.get(ref) })),
      Hooks.BeforeSignUp.tap((input) => record(ref, "beforeSignUp")(input).pipe(Effect.as(input))),
      Hooks.AfterSignUp.tap(record(ref, "afterSignUp")),
      Hooks.BeforeSignIn.tap((input) => record(ref, "beforeSignIn")(input).pipe(Effect.as(input))),
      Hooks.BeforeSessionIssue.tap((input) =>
        record(ref, "beforeSessionIssue")(input).pipe(Effect.as(Option.none())),
      ),
      Hooks.AfterSignIn.tap(record(ref, "afterSignIn")),
    );
  }),
);
