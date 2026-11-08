// The shared composition for this package's tests: `Auth.make([TwoFactor, DeviceAuthorization])` through
// `TestAuth.layer` (plan 08): the real `DeviceAuthorization` plugin over in-memory `Users`/`Sessions`, its grant and
// client records either in memory or on a real migrated database (`records: "sql"`: `:memory:` SQLite by default, a
// real per-suite Postgres schema under `AWTHAQ_POSTGRES_URL`), the real `@awthaq/two-factor` gates (so the MFA divert
// is a real divert), and the contract served behind the derived CSRF and authentication middleware, so a test can go
// through the wire (`makeApp`) or call the service directly (`buildLayer`), over the very same rows.
import { Api } from "@awthaq/api";
import { Auth, type Sessions } from "@awthaq/core";
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
  /** ADR-EA-047: the address every request resolves to. */
  readonly clientAddress?: string;
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
    ...(options.clientAddress === undefined ? {} : { clientAddress: options.clientAddress }),
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

  /**
   * A real session for a fresh user with `amr`, against the same running `Sessions`: `browser` is an agent
   * holding it (its cookies and CSRF echo), `bearer` its raw token, `cookie` the `Cookie` pair a browser
   * sends (read from the agent's store), for a test that hand-builds a forged request.
   */
  const signedInUser = async (email: string, amr: ReadonlyArray<Sessions.AuthMethod> = ["pwd"]) => {
    const browser = await app.signIn(email, { amr });
    const held = browser.cookies.get(Api.SESSION_COOKIE_NAME);
    if (held === undefined)
      throw new Error("expected the signed-in agent to hold a session cookie");
    return {
      userId: browser.userId,
      browser,
      cookie: `${held.name}=${held.value}`,
      bearer: Redacted.value(browser.token),
    };
  };

  return { handler: app.handler, withContext, signedInUser, request: app.request, layer };
};

export const CLI_CLIENT_ID = DeviceAuthorization.CLI_CLIENT.clientId;
export const DEVICE_GRANT = DeviceAuthorizationApi.DEVICE_CODE_GRANT_TYPE;
