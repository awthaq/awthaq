// @awthaq/cli — DeviceLogin
//
// BEH-EA-307 (DAG-002, CTA-001, decision 06; spec/models/13-device-authorization.md): the interactive
// half of `awthaq login` — the OAuth 2.0 Device Authorization Grant (RFC 8628) as a client of a running
// server's `@awthaq/device-authorization` plugin. It never starts a listener and never accepts an inbound
// request (BEH-EA-208, class 3): the person completes the sign-in in a browser on this or another device,
// and this command only asks and polls.
//
//   1. `POST /device/code` with the CLI's own client id (`awthaq-cli`, the plugin's default client);
//   2. prints the user code and the verification URL — on stderr, so `--json` keeps stdout for the
//      result — and, unless `--no-browser`, tries to open the URL (`Browser`);
//   3. polls `POST /device/token` on a schedule that starts at the server's `interval`, **adds 5 seconds
//      to it on every `slow_down`** (RFC 8628 §3.5) and never polls faster than the server last advised,
//      waits out a `429`, gives up after three consecutive transport failures, and stops on
//      `expired_token`, `access_denied` or `invalid_grant`.
//
// The device speaks plain RFC 8628 through the plugin's own contract (`DeviceGroup`, the generated
// `HttpApiClient`): form-encoded, no cookie, no CSRF token — the back channel needs none. The pacing
// (`Pacing.sleep`) is a `Context.Reference` so a test paces a whole login in microseconds; nothing else
// is injected. Nothing here prints the device code or the token.

import { DeviceAuthorizationApi } from "@awthaq/device-authorization";
import { AuthClient } from "@awthaq/client";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { Browser } from "./Browser.ts";
import {
  AuthenticationRequired,
  DeviceAuthorizationUnavailable,
  ServerUnavailable,
  UsageError,
} from "./CliErrors.ts";
import * as Output from "./Output.ts";

/** The CLI's own client id: the `@awthaq/device-authorization` plugin registers it by default. */
export const DEFAULT_CLIENT_ID = "awthaq-cli";

/** RFC 8628 §3.5: a `slow_down` adds this many seconds to the interval. */
export const SLOW_DOWN_STEP_SECONDS = 5;

/** Consecutive transport failures tolerated while polling before the login gives up. */
const MAX_TRANSPORT_FAILURES = 3;

/** The longest interval a backoff may reach, so a flapping network never turns into a minute-long wait per poll. */
const MAX_BACKOFF_SECONDS = 60;

const deviceApi = HttpApi.make("auth").add(DeviceAuthorizationApi.DeviceGroup);

export interface PacingShape {
  /** Waits `duration` between two polls. */
  readonly sleep: (duration: Duration.Duration) => Effect.Effect<void>;
}

/** The poll's clock: real sleeping by default; a test provides one that returns at once. */
export const Pacing = Context.Reference<PacingShape>("awthaq/cli/Pacing", {
  defaultValue: () => ({ sleep: Effect.sleep }),
});

export interface DeviceLoginInput {
  readonly baseUrl: string;
  readonly clientId: string;
  /** `--no-browser`: only print the URL and the code. */
  readonly noBrowser: boolean;
}

/** A stock server without the plugin answers a route it does not have with a 404. */
const isMissingRoute = (error: { readonly _tag: string }) =>
  HttpClientError.isHttpClientError(error) && error.response?.status === 404;

/** Runs the flow and answers the bearer token the server issued; the caller validates and stores it. */
export const obtainToken = (input: DeviceLoginInput) =>
  Effect.gen(function* () {
    const out = yield* Output.Output;
    const browser = yield* Browser;
    const pacing = yield* Pacing;
    const client = yield* AuthClient.make(deviceApi, { baseUrl: input.baseUrl });

    const unreachable = () =>
      new ServerUnavailable({ message: `could not reach the auth server at ${input.baseUrl}` });

    const code = yield* client.device_authorization
      .code({ payload: { client_id: input.clientId } })
      .pipe(
        Effect.catchTags({
          InvalidClient: () =>
            Effect.fail(
              new UsageError({
                message: `the server does not know the client "${input.clientId}" (register it in DeviceAuthorizationConfig.clients, or the plugin's default awthaq-cli)`,
              }),
            ),
          InvalidScope: () =>
            Effect.fail(new UsageError({ message: "the server refused the requested scope" })),
          InvalidRequest: () =>
            Effect.fail(new UsageError({ message: "the server refused the device code request" })),
          RateLimited: (limited) =>
            Effect.fail(
              new ServerUnavailable({
                message: `the server is rate limiting login requests; retry in ${Math.ceil(limited.retryAfterMillis / 1000)} seconds`,
              }),
            ),
        }),
        Effect.mapError((error) =>
          error instanceof UsageError || error instanceof ServerUnavailable
            ? error
            : isMissingRoute(error)
              ? new DeviceAuthorizationUnavailable({
                  message: `the server at ${input.baseUrl} does not serve the device authorization endpoints: install the DeviceAuthorization plugin (@awthaq/device-authorization), or pass --token / set AWTHAQ_TOKEN`,
                })
              : unreachable(),
        ),
      );

    // ---- what the person is asked to do -----------------------------------------------------------
    yield* out.warn(
      `To sign in, open ${code.verification_uri_complete}\nand confirm the code ${code.user_code} (it expires in ${Math.round(code.expires_in / 60)} minutes).`,
    );
    if (!input.noBrowser) {
      const opened = yield* browser.open(code.verification_uri_complete);
      if (opened) yield* out.warn("A browser window was opened for you; waiting for approval...");
      else yield* out.warn("Waiting for approval...");
    } else {
      yield* out.warn("Waiting for approval...");
    }

    // ---- the poll ---------------------------------------------------------------------------------
    const expired = () =>
      new AuthenticationRequired({
        message: "the login code expired before it was approved; run `awthaq login` again",
      });
    let interval = code.interval;
    let waited = 0;
    let failures = 0;
    while (true) {
      yield* pacing.sleep(Duration.seconds(interval));
      waited += interval;
      // The server's `expired_token` is the authority; this only stops a client that cannot reach it.
      if (waited > code.expires_in + interval) return yield* expired();
      const outcome = yield* client.device_authorization
        .token({
          payload: {
            grant_type: DeviceAuthorizationApi.DEVICE_CODE_GRANT_TYPE,
            device_code: code.device_code,
            client_id: input.clientId,
          },
        })
        .pipe(Effect.result);
      if (outcome._tag === "Success") return Redacted.make(outcome.success.access_token);
      const error = outcome.failure;
      switch (error._tag) {
        case "AuthorizationPending":
          failures = 0;
          break;
        case "SlowDown":
          failures = 0;
          // RFC 8628 §3.5: add 5 seconds; and never poll faster than the interval the server now advises.
          interval = Math.max(interval + SLOW_DOWN_STEP_SECONDS, error.interval);
          break;
        case "RateLimited":
          failures = 0;
          interval = Math.max(interval, Math.ceil(error.retryAfterMillis / 1000));
          break;
        case "AccessDenied":
          return yield* new AuthenticationRequired({
            message: "the login request was denied on the other device",
          });
        case "ExpiredToken":
          return yield* expired();
        case "InvalidGrant":
          return yield* new AuthenticationRequired({
            message: "the server no longer recognises this login request; run `awthaq login` again",
          });
        case "UserSuspended":
        case "HookAborted":
          return yield* new AuthenticationRequired({
            message: "the server refused to sign this account in",
          });
        case "InvalidRequest":
        case "UnsupportedGrantType":
          return yield* new ServerUnavailable({
            message:
              "the server did not accept the device token request (is it a compatible awthaq server?)",
          });
        default:
          // A transport failure or an unusable answer: back off, and give up after a few in a row.
          failures += 1;
          if (failures >= MAX_TRANSPORT_FAILURES) return yield* unreachable();
          interval = Math.min(interval * 2, MAX_BACKOFF_SECONDS);
      }
    }
  });
