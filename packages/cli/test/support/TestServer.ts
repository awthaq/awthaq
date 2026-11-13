// BEH-EA-353: a REAL auth server for the CLI on a real socket: `TestAuth.listen` over the composition `Auth.make`
// derives, so `login` and `whoami` speak through the generated `HttpApiClient` to what a deployed host serves.
import { Auth, Sessions, Users } from "@awthaq/core";
import { DeviceAuthorization } from "@awthaq/device-authorization";
import { Password } from "@awthaq/password";
import { TestAuth } from "@awthaq/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

type Run = <X>(effect: Effect.Effect<X, never, Users.Users | Sessions.Sessions>) => Promise<X>;

/** A fresh user with one live session; `token` is what `AWTHAQ_TOKEN` / `login --token` carries. */
const scenario = (run: Run) => ({
  issue: (email: string) =>
    Effect.promise(() =>
      run(
        Effect.gen(function* () {
          const user = yield* Users.Users.use((users) =>
            users.create({ identity: { _tag: "Email", email }, name: "Test" }),
          );
          const issued = yield* Sessions.Sessions.use((s) => s.issue({ userId: user.id }));
          return {
            userId: user.id,
            sessionId: issued.session.id,
            token: Redacted.value(issued.token),
          };
        }).pipe(Effect.orDie, TestAuth.withoutRequest),
      ),
    ),
  /** Revokes every session of the user server-side, as an admin or another device would. */
  revokeAll: (userId: Users.UserId) =>
    Effect.promise(() =>
      run(Sessions.Sessions.use((s) => s.revokeAll(userId, "userRevoked")).pipe(Effect.orDie)),
    ),
});

export const serveAuth = (options?: { readonly device?: boolean }) =>
  Effect.gen(function* () {
    // The socket runs on the step's TestClock; `app.run` on the wall clock. Align them, as `lazyApp` does.
    yield* TestClock.setTime(Date.now());
    if (options?.device === false) {
      const app = yield* TestAuth.listen(
        TestAuth.layer(Auth.make([Password.Password]), {
          services: Layer.mergeAll(Password.config({}), TestAuth.httpClient.noBreach),
        }),
      );
      const decide = (_code: string, _email: string, _decision?: "approve" | "deny") =>
        Effect.die("serveAuth({ device: false }) has no device authorization plugin");
      return { baseUrl: app.url, ...scenario(app.run), decide };
    }
    const app = yield* TestAuth.listen(
      TestAuth.layer(Auth.make([DeviceAuthorization.DeviceAuthorization]), {
        services: DeviceAuthorization.config({
          verificationUri: "https://app.test/device",
        }),
      }),
    );
    const { issue, revokeAll } = scenario(app.run);
    /** The person on the second device: opens the verification page for `userCode` (claiming it) and decides. */
    const decide = (userCode: string, email: string, decision: "approve" | "deny" = "approve") =>
      Effect.flatMap(issue(email), ({ userId, sessionId }) =>
        Effect.promise(() =>
          app.run(
            DeviceAuthorization.DeviceAuthorization.use((plugin) => {
              const caller = {
                userId,
                sessionId,
                impersonated: false,
                amr: ["pwd" as const],
              };
              const source = { userCode };
              return plugin
                .verify(source, Option.some(caller))
                .pipe(
                  Effect.andThen(
                    decision === "approve"
                      ? plugin.approve(source, caller)
                      : plugin.deny(source, caller),
                  ),
                );
            }).pipe(Effect.orDie, TestAuth.withRequest({ ip: "198.51.100.20" })),
          ),
        ),
      );
    return { baseUrl: app.url, issue, revokeAll, decide };
  });
