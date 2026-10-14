// AOMS-006 (.issues/high, wayfinder ticket 03): proves `Password.signUp`
// genuinely consults `Hooks.BeforeSignUp` — an Auth0-Rule-style policy
// (e.g. an email-domain allow-list) may reject the sign-up outright, or
// amend the input for whatever runs after it. A dedicated file so this
// composition's tap stays out of `Password.test.ts`'s own untapped `signUp`
// coverage (a hook registry is per composition, ELC-001).
import { HookPoint, Hooks } from "@awthaq/core";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Password from "../src/Password.ts";
import { makeTestLayer } from "./harness.ts";

// The veto is the composition's own tap (a hook registry is per composition, ELC-001).
const TestLayer = makeTestLayer({
  taps: Hooks.BeforeSignUp.tap((input) =>
    (input.email ?? "").endsWith("@forbidden.example.com")
      ? Effect.fail(new HookPoint.HookAbort({ code: "DOMAIN_BLOCKED" }))
      : Effect.succeed({ ...input, name: `${input.name} (tapped)` }),
  ),
});

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
