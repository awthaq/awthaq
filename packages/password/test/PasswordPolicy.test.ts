// password-policy-posture: PHS-004 (breach-check body + timeout), PHS-006
// (screening on by default), FAMS-003 (verified-email gate knob).
import { createHash } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Password from "../src/Password.ts";
import {
  email,
  httpClientReturning,
  makeTestLayer,
  NoBreachHttpClient,
  strongPassword,
} from "./harness.ts";

describe("PHS-004: the breach check's own failure modes follow onUnavailable", () => {
  it.effect("a 200 HTML body fails closed under onUnavailable: reject", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const failure = yield* password.signUp({ email, password: strongPassword }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          httpClient: httpClientReturning(() => "<html><body>Bad gateway</body></html>"),
          config: { breachCheck: { onUnavailable: "reject" } },
        }),
      ),
    ),
  );

  it.effect("a 200 HTML body fails open by default", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const issued = yield* password.signUp({ email, password: strongPassword });
      assert.isDefined(issued.token);
    }).pipe(
      Effect.provide(makeTestLayer({ httpClient: httpClientReturning(() => "<html>oops</html>") })),
    ),
  );

  it.effect("an empty 200 body is unavailable, not 'not breached'", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const failure = yield* password.signUp({ email, password: strongPassword }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          httpClient: httpClientReturning(() => ""),
          config: { breachCheck: { onUnavailable: "reject" } },
        }),
      ),
    ),
  );

  const NeverResponds = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.never),
  );

  it.effect("a never-responding breach check fails open after breachCheckTimeout", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const fiber = yield* Effect.forkChild(password.signUp({ email, password: strongPassword }), {
        startImmediately: true,
      });
      yield* TestClock.adjust(Duration.seconds(2));
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust(Duration.seconds(2));
      const issued = yield* Fiber.join(fiber);
      assert.isDefined(issued.token);
    }).pipe(Effect.provide(makeTestLayer({ httpClient: NeverResponds }))),
  );

  it.effect("a never-responding breach check fails closed under reject", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const fiber = yield* Effect.forkChild(
        password.signUp({ email, password: strongPassword }).pipe(Effect.flip),
        { startImmediately: true },
      );
      yield* TestClock.adjust(Duration.seconds(4));
      const failure = yield* Fiber.join(fiber);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(
      Effect.provide(
        makeTestLayer({
          httpClient: NeverResponds,
          config: {
            breachCheck: { onUnavailable: "reject" },
            breachCheckTimeout: Duration.seconds(3),
          },
        }),
      ),
    ),
  );
});

describe("PHS-006: breach screening is on by default", () => {
  const breached = Redacted.make("pwned-password-123");
  const hex = createHash("sha1").update(Redacted.value(breached)).digest("hex").toUpperCase();
  const BreachedHttpClient = httpClientReturning((url) =>
    url.endsWith(hex.slice(0, 5)) ? `${hex.slice(5)}:5` : `${"F".repeat(35)}:1`,
  );

  it.effect("with the default config a breached password is rejected", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const failure = yield* password.signUp({ email, password: breached }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "WeakPassword");
    }).pipe(Effect.provide(makeTestLayer({ httpClient: BreachedHttpClient }))),
  );

  it.effect("breachCheck: false opts out", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      const issued = yield* password.signUp({ email, password: breached });
      assert.isDefined(issued.token);
    }).pipe(
      Effect.provide(
        makeTestLayer({ httpClient: BreachedHttpClient, config: { breachCheck: false } }),
      ),
    ),
  );
});

describe("FAMS-003: requireVerifiedEmail", () => {
  it.effect(
    "with requireVerifiedEmail: false an unverified user with correct credentials signs in",
    () =>
      Effect.gen(function* () {
        const password = yield* Password.Password;
        yield* password.signUp({ email, password: strongPassword });
        const issued = yield* password.signIn({ email, password: strongPassword });
        assert.isDefined(issued.token);
      }).pipe(
        Effect.provide(
          makeTestLayer({
            httpClient: NoBreachHttpClient,
            config: { requireVerifiedEmail: false },
          }),
        ),
      ),
  );

  it.effect("the credentials are still checked first when the gate is off", () =>
    Effect.gen(function* () {
      const password = yield* Password.Password;
      yield* password.signUp({ email, password: strongPassword });
      const failure = yield* password
        .signIn({ email, password: Redacted.make("totally wrong password") })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "InvalidCredentials");
    }).pipe(Effect.provide(makeTestLayer({ config: { requireVerifiedEmail: false } }))),
  );
});
