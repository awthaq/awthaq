// The shared composition for this package's tests: `Auth.make([TwoFactor, DeviceAuthorization])` through
// `TestAuth.layer` (plan 08): the real `DeviceAuthorization` plugin over in-memory `Users`/`Sessions`, its grant and
// client records either in memory or on a real migrated database (`records: "sql"`: `:memory:` SQLite by default, a
// real per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`), the real `@awthaq/two-factor` gates (so the MFA divert
// is a real divert), and the contract served behind the derived CSRF and authentication middleware, so a test can go
// through the wire (`makeApp`) or call the service directly (`buildLayer`), over the very same rows.
import { Api } from "@awthaq/api";
import { Auth, Sessions, Users } from "@awthaq/core";
import type { Hooks } from "@awthaq/core";
import { SecondFactor, TwoFactor } from "@awthaq/two-factor";
import { TestAuth } from "@awthaq/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as DeviceAuthorization from "../../src/DeviceAuthorization.ts";
import * as DeviceAuthorizationApi from "../../src/DeviceAuthorizationApi.ts";

const ORIGIN = "http://localhost:3000";

const built = Auth.make([TwoFactor.TwoFactor, DeviceAuthorization.DeviceAuthorization]);

export interface HarnessOptions {
  readonly store: "memory" | "sql";
  /** Names the schema on Postgres; one distinct value per test file. */
  readonly suite?: string;
  readonly config?: Partial<DeviceAuthorization.DeviceAuthorizationConfigShape>;
  /** The enforcing limiter over the in-memory store, instead of the permissive one. */
  readonly rateLimiter?: "permissive" | "enforcing";
}

/** Hook taps a test installs: they need the points the composition provides. */
type Taps = Layer.Layer<
  never,
  never,
  | Hooks.BeforeSignIn
  | Hooks.BeforeSessionIssue
  | DeviceAuthorization.BeforeDeviceApproval
  | DeviceAuthorization.AfterDeviceApproval
>;

export const buildLayer = (options: HarnessOptions, taps: Taps = Layer.empty) => {
  const common = {
    rateLimiter: options.rateLimiter ?? "permissive",
    taps,
    services: Layer.merge(
      DeviceAuthorization.config(options.config ?? {}),
      // `@awthaq/two-factor`'s gates are always installed: they divert only a user with a confirmed second factor.
      Layer.mergeAll(TwoFactor.sessionGate, TwoFactor.credentialResetGate).pipe(
        Layer.provideMerge(SecondFactor.layer),
      ),
    ),
  };
  return options.store === "sql"
    ? TestAuth.layer(built, {
        ...common,
        records: "sql",
        suite: options.suite ?? "device_authorization",
      })
    : TestAuth.layer(built, common);
};

export type HarnessServices = Layer.Success<ReturnType<typeof buildLayer>>;

/** A running app: the real web handler, and a way to reach the very services it runs against. */
export const makeApp = (options: HarnessOptions, taps?: Taps) => {
  const layer = buildLayer(options, taps);
  const app = TestAuth.app(layer, { baseUrl: ORIGIN });
  const withContext = <A, E>(effect: Effect.Effect<A, E, HarnessServices>): Promise<A> =>
    app.run(effect);

  /** A real session for a fresh user with `amr`, as `{ userId, cookie, bearer }`, against the same running `Sessions`. */
  const signedInUser = (email: string, amr: ReadonlyArray<Sessions.AuthMethod> = ["pwd"]) =>
    withContext(
      Effect.gen(function* () {
        const users = yield* Users.Users;
        const sessions = yield* Sessions.Sessions;
        const user = yield* users.create({ identity: { _tag: "Email", email }, name: email });
        const issued = yield* sessions.issue({ userId: user.id, amr });
        const token = Redacted.value(issued.token);
        return {
          userId: user.id,
          sessionId: issued.session.id,
          cookie: `${Api.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
          bearer: token,
        };
      }).pipe(Effect.orDie),
    );

  return { handler: app.handler, withContext, signedInUser, request: app.request, layer };
};

export const CLI_CLIENT_ID = DeviceAuthorization.CLI_CLIENT.clientId;
export const DEVICE_GRANT = DeviceAuthorizationApi.DEVICE_CODE_GRANT_TYPE;
