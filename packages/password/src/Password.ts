// @awthaq/password — Password
//
// spec/behaviors/15-password.md, BEH-EA-113 through BEH-EA-120.
// spec/models/01-password.md's plugin-class sketch, reproduced with the
// gaps that sketch leaves open (a duplicate email, the missing `name` a
// `User` record requires, the reset token's own encoding, the breach-check
// transport) filled in and documented at each site rather than left to
// silently die or guessed at without a comment explaining the choice.

import { Api, SessionContract } from "@awthaq/api";
import {
  Accounts,
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  Errors,
  HookPoint,
  Hooks,
  MailDispatch,
  RateLimits,
  Sessions,
  Users,
  Verification,
  VerificationLink,
} from "@awthaq/core";
import {
  ClientAddress,
  Defects,
  Hmac,
  Mailer,
  PasswordHasher,
  RateLimiter,
  SqlTransaction,
} from "@awthaq/ports";
import { SessionDelivery } from "@awthaq/server";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as PasswordApi from "./PasswordApi.ts";
import * as PasswordRateLimits from "./PasswordRateLimits.ts";

export interface PasswordConfigShape {
  readonly minLength: number;
  /**
   * BEH-EA-119/PHS-006: screening a new password against the HIBP corpus is on
   * by default (NIST SP 800-63B section 3.1.1.2 makes checking against
   * compromised-password lists a SHALL; the k-anonymity range API discloses
   * only a 5-character SHA-1 prefix). `true` fails open when the provider is
   * unavailable, `{ onUnavailable: "reject" }` fails closed, `false` disables
   * it (air-gapped deployments).
   */
  readonly breachCheck: boolean | { readonly onUnavailable: "allow" | "reject" };
  /**
   * PHS-004: how long the breach lookup (request plus body) may take before
   * it counts as "unavailable" and follows `breachCheck`'s `onUnavailable`,
   * so a black-holed egress never hangs sign-up.
   */
  readonly breachCheckTimeout: Duration.Duration;
  readonly resetTtl: Duration.Duration;
  readonly rehashOnLogin: boolean;
  /**
   * TSS-006: the minimum time `signIn`'s credential check (lookup plus
   * verify) takes, so an account whose stored hash is cheaper than the
   * configured cost (a legacy bcrypt row awaiting rehash) cannot be told
   * apart from an unknown email by latency. `"calibrated"` (the default)
   * times the boot-time dummy verify and pads to 1.25 times that; a
   * `Duration` fixes the floor; `"off"` disables it. A hash costlier than
   * the floor still takes longer, and stays distinguishable until rehashed.
   */
  readonly signInTimingFloor: "calibrated" | "off" | Duration.Duration;
  /**
   * TMS-006: maps an address to the per-email rate-limit bucket it is
   * counted in (sign-up, sign-in, reset, resend). The default lower-cases and
   * strips a `+tag`, so subaddressed aliases share one budget; delivery still
   * uses the literal address. Override for providers with other conventions.
   */
  readonly rateLimitEmailKey: (email: string) => string;
  /**
   * MLO-009: builds the link mailed for each token, from the token string. When
   * set, the mail's `data.url` carries it (alongside `token` and `expiresAt`,
   * which are always present). Point it at a page that consumes the token from
   * the URL fragment or a form POST — never a query string a GET handler
   * acts on, which mail scanners prefetch.
   */
  readonly links: {
    readonly verifyEmail?: (token: string) => string;
    readonly resetPassword?: (token: string) => string;
  };
  /**
   * FAMS-003: whether `signIn` refuses an account whose email is unverified
   * (after the credentials are confirmed, so it is never a password oracle).
   * Default `true`. A deployment that imported users from a source that
   * never verified them (or verified differently) may set `false` and
   * restrict unverified users downstream instead, or call
   * `Users.verifyEmail` for the imported users the source had verified.
   */
  readonly requireVerifiedEmail: boolean;
  /**
   * TMS-005: how `signUp` answers an address that already has an account.
   * `"reveal"` (default) fails with 409 `EmailAlreadyExists` and issues the
   * session at once. `"conceal"` answers 202 for a fresh and an existing
   * address alike, issues no session until the mailbox is proven (the
   * verification mail), and mails the existing owner an `account-exists`
   * notice. See ADR-EA-018.
   */
  readonly signUpEnumeration: "reveal" | "conceal";
}

const defaultPasswordConfig: PasswordConfigShape = {
  minLength: 12,
  breachCheck: true,
  breachCheckTimeout: Duration.seconds(3),
  resetTtl: Duration.hours(1),
  rehashOnLogin: true,
  signInTimingFloor: "calibrated",
  rateLimitEmailKey: PasswordRateLimits.defaultEmailRateKey,
  links: {},
  requireVerifiedEmail: true,
  signUpEnumeration: "reveal",
};

/** BEH-EA-017's `Context.Reference`-with-default pattern, applied to this plugin's own policy knobs. */
export const PasswordConfig: Context.Reference<PasswordConfigShape> = Context.Reference(
  "awthaq/password/Config",
  { defaultValue: () => defaultPasswordConfig },
);

/** BEH-EA-018/120: a partial override, type-checked against `PasswordConfigShape`, never runtime-validated. */
export const config = (partial: Partial<PasswordConfigShape>): Layer.Layer<never> =>
  Layer.succeed(PasswordConfig, { ...defaultPasswordConfig, ...partial });

export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

export interface PasswordShape {
  /** BEH-EA-113: creates the user, links a password credential, issues a session, and dispatches (never awaits) a verification mail. */
  readonly signUp: (input: {
    readonly email: string;
    readonly password: Redacted.Redacted<string>;
    /**
     * AGA-001/NHS-003: same per-source dimension `signIn`'s own `ip`
     * documents below — bounds mass account creation from one source
     * independently of the (attacker-chosen) email each attempt names.
     */
    readonly ip?: string;
    /** CSD-003: recorded on the issued session (device list, forensics); capped by `Sessions.issue`. */
    readonly userAgent?: string;
  }) => Effect.Effect<
    IssuedSession,
    | PasswordApi.WeakPassword
    | PasswordApi.EmailAlreadyExists
    | Api.RateLimited
    | HookPoint.HookAborted | Errors.StoreUnavailable
  >;
  /**
   * TMS-005: the `signUpEnumeration: "conceal"` flavour of `signUp` — the same
   * checks, then the same outcome for a fresh and an already-registered
   * address: nothing is returned and no session is issued (a fresh account
   * gets its verification mail, an existing owner an `account-exists` notice),
   * so the response cannot tell them apart. The HTTP handler routes here when
   * the config says `"conceal"`; `signUp` above is the reveal flavour.
   */
  readonly signUpConcealed: (input: {
    readonly email: string;
    readonly password: Redacted.Redacted<string>;
    readonly ip?: string;
  }) => Effect.Effect<
    void,
    PasswordApi.WeakPassword | Api.RateLimited | HookPoint.HookAborted | Errors.StoreUnavailable
  >;
  /**
   * BEH-EA-114/116: uniform `InvalidCredentials`, constant real hashing cost
   * regardless of which of the three reasons applied; rehashes
   * opportunistically on success. Upstream-hardening ticket 04:
   * `EmailNotVerified` is checked only once a genuinely correct password
   * has already been confirmed — it can never be used to probe a guessed
   * password's correctness.
   */
  readonly signIn: (input: {
    readonly email: string;
    readonly password: Redacted.Redacted<string>;
    /**
     * RBS-001/CSD-002/AGA-001/NHS-003: the per-email budget below is
     * keyed on a value the attacker fully controls, so it alone neither
     * stops distributed credential spraying across many accounts nor
     * attributes it to a source — `ip` (mirroring `OAuthShape["callback"]`'s
     * own optional `ip`, sourced from the application-provided
     * `ClientAddress` port rather than raw `remoteAddress`) backs a
     * second, independent per-source budget. `undefined` when the
     * handler's own request carries none, which the rate limiter treats
     * as a single shared "unknown origin" bucket, never as unthrottled.
     */
    readonly ip?: string;
    /** CSD-003: recorded on the issued session; see `signUp`'s own `userAgent`. */
    readonly userAgent?: string;
  }) => Effect.Effect<
    IssuedSession,
    | Api.InvalidCredentials
    | PasswordApi.EmailNotVerified
    | Users.UserSuspended
    | Api.RateLimited
    | Hooks.TwoFactorRequired | Errors.StoreUnavailable
  >;
  /** BEH-EA-064/117: identical response whether or not `email` resolves to an account — the caller (the HTTP handler) always answers 202. */
  readonly requestReset: (input: {
    readonly email: string;
    /** AGA-001/NHS-003: same per-source dimension as `signIn`'s own `ip`. */
    readonly ip?: string;
  }) => Effect.Effect<void, Api.RateLimited | Errors.StoreUnavailable>;
  /**
   * Upstream-hardening ticket 04: identical response whether `email`
   * doesn't exist, the account is already verified, or a mail genuinely
   * goes out — same enumeration-safe shape as `requestReset`.
   */
  readonly resendVerification: (input: {
    readonly email: string;
    /** MLO-003: same per-source dimension as `requestReset`'s own `ip`. */
    readonly ip?: string;
  }) => Effect.Effect<void, Api.RateLimited | Errors.StoreUnavailable>;
  /** BEH-EA-117: consumes the reset token and sets the new password in one call, then revokes every other session. */
  readonly confirmReset: (input: {
    readonly token: Redacted.Redacted<string>;
    readonly password: Redacted.Redacted<string>;
  }) => Effect.Effect<
    void,
    PasswordApi.TokenConsumed | PasswordApi.WeakPassword | Api.RateLimited | Errors.StoreUnavailable
  >;
  /**
   * Shipping-gap map (.scratch/shipping-gaps), ticket 08: consumes the
   * verify-email token `signUp` already dispatches and flips
   * `Users.emailVerified`. No prior local capability existed to consume
   * that token at all — this is the wiring gap the map's own ticket 01
   * audit identified.
   */
  readonly verifyEmail: (input: {
    readonly token: Redacted.Redacted<string>;
    /** APS-003: resolved via `ClientAddress`, mirroring `signIn`/`signUp`/`requestReset`. */
    readonly ip?: string;
  }) => Effect.Effect<void, PasswordApi.TokenConsumed | Api.RateLimited | Errors.StoreUnavailable>;
  /**
   * Shipping-gap map (.scratch/shipping-gaps), ticket 11: authenticated
   * change-password — distinct from the unauthenticated `requestReset`/
   * `confirmReset` pair, which no capability here provided at all before
   * this ticket.
   */
  /**
   * PIL-002/RRS-001/SMS-001: BEH-EA-053 — every privilege-changing
   * operation mints a fresh session and tombstones the row it supersedes
   * (atomically with the insert — ESR-002/RRS-004).
   * `currentSessionId` names the caller's own session so it can be
   * rotated (superseded, not merely kept) while every *other* session for
   * this user is revoked outright, closing the classic "attacker holds a
   * hijacked session through a password change" gap `confirmReset`'s own
   * `revokeAll` already closes for the reset path.
   */
  readonly changePassword: (input: {
    readonly userId: Users.UserId;
    readonly currentSessionId: Sessions.SessionId;
    readonly currentPassword: Redacted.Redacted<string>;
    readonly newPassword: Redacted.Redacted<string>;
    /** CSD-003: the superseding session records the caller's request context too. */
    readonly ip?: string;
    readonly userAgent?: string;
  }) => Effect.Effect<
    IssuedSession,
    PasswordApi.WrongPassword | PasswordApi.WeakPassword | Api.RateLimited | Errors.StoreUnavailable
  >;
  /**
   * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
   * (AAPS-001): re-verifies `currentPassword` and, on success, calls
   * `Sessions.reauthenticate(currentSessionId)` — refreshes the session's
   * own `authenticatedAt` without superseding it (distinct from
   * `changePassword`, which mints a fresh session because the credential
   * itself changed).
   */
  readonly reauthenticate: (input: {
    readonly userId: Users.UserId;
    readonly currentSessionId: Sessions.SessionId;
    readonly currentPassword: Redacted.Redacted<string>;
  }) => Effect.Effect<void, PasswordApi.WrongPassword | Api.RateLimited | Errors.StoreUnavailable>;
}

const { toHex } = Hmac;

// MLO-009: the mailed token's codec is `VerificationLink`'s, shared with every
// plugin that mails a `Verification` token; these are this plugin's purposes.
const RESET_PURPOSE = "reset-password";
const VERIFY_PURPOSE = "verify-email";
const VERIFY_TTL = Duration.hours(24);

/** PHS-004: internal only — routed to `onUnavailable` by `isBreached`, never surfaced. */
class MalformedBreachResponse extends Data.TaggedError("MalformedBreachResponse")<{}> {}

/** One HIBP range line: the 35-hex-character SHA-1 suffix and its breach count. */
const HIBP_LINE = /^[0-9A-F]{35}:\d+$/i;

/**
 * BEH-EA-119: the k-anonymity HIBP check — only a 5-character SHA-1 prefix
 * ever leaves the process, per the API's own design; a real network/parse
 * failure resolves to `onUnavailable === "reject"`, never re-raised as a
 * distinguishable error (fail-open is a `false` here, fail-closed is `true`
 * — "assume breached" is what actually blocks sign-up).
 */
const isBreached = (
  httpClient: HttpClient.HttpClient,
  crypto: Crypto.Crypto,
  password: Redacted.Redacted<string>,
  onUnavailable: "allow" | "reject",
  timeout: Duration.Duration,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const digest = yield* crypto.digest(
      "SHA-1",
      new TextEncoder().encode(Redacted.value(password)),
    );
    const hex = toHex(digest).toUpperCase();
    const prefix = hex.slice(0, 5);
    const suffix = hex.slice(5);
    // CSD-001: `HttpClient` resolves for any status — a 429/503 from HIBP
    // (its own aggressive throttling is the most common failure mode at
    // scale) would otherwise read as an ordinary body, fail the suffix
    // match, and silently report "not breached" even under
    // `onUnavailable: "reject"`. `filterStatusOk` turns any non-2xx into a
    // failure, routed to `onUnavailable` by the same catch-all below a
    // transport error already used.
    const response = yield* httpClient
      .get(`https://api.pwnedpasswords.com/range/${prefix}`)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const body = yield* response.text;
    // PHS-004: a 200 that is not a range listing (an HTML error page from a
    // proxy, a truncated body) is no evidence of anything — treat it as
    // unavailable rather than as "not breached". Every real prefix has
    // hundreds of entries, so an empty body is malformed too.
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 0 || !lines.every((line) => HIBP_LINE.test(line))) {
      return yield* new MalformedBreachResponse();
    }
    return lines.some((line) => line.split(":")[0]?.toUpperCase() === suffix);
  }).pipe(
    // PHS-004: a black-holed egress follows `onUnavailable` too, not a hang.
    Effect.timeout(timeout),
    Effect.catch(() => Effect.succeed(onUnavailable === "reject")),
  );

const checkPolicy = (
  httpClient: HttpClient.HttpClient,
  crypto: Crypto.Crypto,
  password: Redacted.Redacted<string>,
  config: PasswordConfigShape,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const hints: Array<string> = [];
    if (Redacted.value(password).length < config.minLength) {
      hints.push(`must be at least ${config.minLength} characters`);
    }
    if (config.breachCheck !== false) {
      const onUnavailable =
        config.breachCheck === true ? "allow" : config.breachCheck.onUnavailable;
      if (
        yield* isBreached(httpClient, crypto, password, onUnavailable, config.breachCheckTimeout)
      ) {
        hints.push("appears in known breaches");
      }
    }
    return hints;
  });

/** CSD-003: the `request` context `Sessions.issue` records — omitted keys, not `undefined` (`exactOptionalPropertyTypes`). */
const sessionRequest = (input: { readonly ip?: string; readonly userAgent?: string }) => ({
  ...(input.ip !== undefined ? { ip: input.ip } : {}),
  ...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
});

/** CSD-003: the caller's `User-Agent` header, when present. */
const requestUserAgent = (request: HttpServerRequest.HttpServerRequest) =>
  Option.match(Headers.get(request.headers, "user-agent"), {
    onNone: () => ({}),
    onSome: (userAgent) => ({ userAgent }),
  });

/**
 * Resolves `Password` once here, in the group-builder generator itself —
 * not inside each handler body — the same `HttpApiBuilder.group` pattern
 * `@awthaq/server`'s `Session.SessionHandlers` uses and documents: a
 * service a handler function's own body `yield*`s directly gets wrapped as
 * `HttpRouter.Request<"Requires", R>`, which no ordinary `Layer.provide` can
 * satisfy. Defined before the `Password` class below but only *reads* it
 * from inside a lazily-run generator body (not evaluated until this Layer
 * is actually built), so the forward reference is safe — the same reason
 * `Password`'s own `static readonly layer` can pass this very constant to
 * `AuthPlugin.layer` before the class statement finishes evaluating.
 */
export const PasswordHandlers = HttpApiBuilder.group(
  PasswordApi.PasswordApi,
  "password",
  Effect.fnUntraced(function* (handlers) {
    const password = yield* Password;
    const clientAddress = yield* ClientAddress.ClientAddress;
    const config = yield* PasswordConfig;

    return handlers.handleAll({
      signUp: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: PasswordApi.SignUpPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        // MNA-001: validated before anything is minted.
        const delivery = yield* SessionDelivery.mode(request);
        const resolvedAddress = yield* clientAddress.resolve(request);
        const signUpInput = {
          ...payload,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
          ...requestUserAgent(request),
        };
        // TMS-005: `conceal` answers 202 with no session for a fresh and an
        // existing address alike (ADR-EA-026).
        if (config.signUpEnumeration === "conceal") {
          return yield* password.signUpConcealed(signUpInput);
        }
        const issued = yield* password.signUp(signUpInput);
        // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
        const response: SessionContract.SessionDto = yield* SessionDelivery.deliver(delivery, issued);
        return response;
      }),

      signIn: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: PasswordApi.SignInPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const delivery = yield* SessionDelivery.mode(request);
        // AGA-001/NHS-003: resolved through the application-provided
        // `ClientAddress` port rather than `request.remoteAddress`
        // directly, so a trusted-proxy-aware composition gets a real
        // client IP here too, not just for `OAuth`'s own callback.
        const resolvedAddress = yield* clientAddress.resolve(request);
        const issued = yield* password.signIn({
          ...payload,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
          ...requestUserAgent(request),
        });
        // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
        const response: SessionContract.SessionDto = yield* SessionDelivery.deliver(delivery, issued);
        return response;
      }),

      requestReset: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: PasswordApi.RequestResetPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const resolvedAddress = yield* clientAddress.resolve(request);
        yield* password.requestReset({
          ...payload,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
        });
      }),

      resendVerification: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: PasswordApi.ResendVerificationPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const resolvedAddress = yield* clientAddress.resolve(request);
        yield* password.resendVerification({
          ...payload,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
        });
      }),

      confirmReset: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: PasswordApi.ConfirmResetPayload;
      }) {
        yield* password.confirmReset(payload);
      }),

      verifyEmail: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: PasswordApi.VerifyEmailPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const resolvedAddress = yield* clientAddress.resolve(request);
        yield* password.verifyEmail({
          ...payload,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
        });
      }),
    });
  }),
);

/**
 * EHA-007: the `password.account` group — the endpoints that need a live
 * session (`Api.Authentication` runs as group middleware, so
 * `Api.CurrentPrincipal` is always resolved here).
 */
export const PasswordAccountHandlers = HttpApiBuilder.group(
  PasswordApi.PasswordApi,
  "password.account",
  Effect.fnUntraced(function* (handlers) {
    const password = yield* Password;
    const clientAddress = yield* ClientAddress.ClientAddress;

    return handlers.handleAll({
      changePassword: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: PasswordApi.ChangePasswordPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const principal = yield* Api.CurrentPrincipal;
        // `changePassword`'s own `Authentication` middleware already
        // refused an unauthenticated request; a non-`User` principal
        // reaching it is a wiring defect, mirroring `Session.ts`'s own
        // `currentUserPrincipal` guard.
        if (principal._tag !== "User") {
          return yield* Defects.invariantViolation("NonUserPrincipal", `awthaq: change-password reached with a non-User principal: ${principal._tag}`);
        }
        const delivery = yield* SessionDelivery.mode(request);
        const resolvedAddress = yield* clientAddress.resolve(request);
        const issued = yield* password.changePassword({
          userId: Users.UserId(principal.ref.id),
          currentSessionId: Sessions.SessionId(principal.sessionId),
          currentPassword: payload.currentPassword,
          newPassword: payload.newPassword,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
          ...requestUserAgent(request),
        });
        // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
        const response: SessionContract.SessionDto = yield* SessionDelivery.deliver(delivery, issued);
        return response;
      }),

      reauthenticate: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: PasswordApi.ReauthenticatePayload;
      }) {
        const principal = yield* Api.CurrentPrincipal;
        if (principal._tag !== "User") {
          return yield* Defects.invariantViolation("NonUserPrincipal", `awthaq: reauthenticate reached with a non-User principal: ${principal._tag}`);
        }
        yield* password.reauthenticate({
          userId: Users.UserId(principal.ref.id),
          currentSessionId: Sessions.SessionId(principal.sessionId),
          currentPassword: payload.password,
        });
      }),
    });
  }),
);

export class Password extends AuthPlugin.Service<Password, PasswordShape>()("password", {
  apiVersion: 1,
  contract: PasswordApi.PasswordApi,
  // BEH-EA-044: a password credential is an ordinary `accounts` row — this
  // plugin owns no table of its own, so there is nothing to declare here.
  tables: [],
  // ECS-008/BEH-EA-229: the policy knobs `doctor` audits and `config list` prints.
  config: [
    ConfigDescriptor.make(PasswordConfig, {
      audit: (value, environment) => [
        ...(value.minLength < 8
          ? [
              ConfigDescriptor.finding(
                "warning",
                "password-min-length",
                `the minimum password length is ${value.minLength} (NIST SP 800-63B asks for at least 8)`,
              ),
            ]
          : []),
        ...(environment.production && value.breachCheck === false
          ? [
              ConfigDescriptor.finding(
                "warning",
                "password-breach-check-off",
                "screening new passwords against the breached-password corpus is disabled",
              ),
            ]
          : []),
        ...(environment.production && !value.requireVerifiedEmail
          ? [
              ConfigDescriptor.finding(
                "warning",
                "password-unverified-sign-in",
                "sign-in does not require a verified email address",
              ),
            ]
          : []),
      ],
    }),
  ],
}) {
  /**
   * BEH-EA-001/008 (`AuthPlugin.ts`'s own doc comment): a plugin's `layer`
   * static is added by the plugin author, not by `AuthPlugin.Service`
   * itself — `Auth.make` reads it directly off the class
   * (`AuthPlugin.Any["layer"]`), so it must live here rather than as a
   * sibling export.
   */
  static readonly layer = AuthPlugin.layer(Password, {
    handlers: Layer.mergeAll(PasswordHandlers, PasswordAccountHandlers),
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const accounts = yield* Accounts.Accounts;
      const sessions = yield* Sessions.Sessions;
      const verification = yield* Verification.Verification;
      const hasher = yield* PasswordHasher.PasswordHasher;
      const mailer = yield* Mailer.Mailer;
      const events = yield* AuthEvents.AuthEvents;
      const config = yield* PasswordConfig;
      const crypto = yield* Crypto.Crypto;
      const httpClient = yield* HttpClient.HttpClient;
      const limiter = yield* RateLimiter.RateLimiter;
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      const rateLimitsRegistry = yield* RateLimits.RateLimitsRegistry;
      // ERS-002: mail is dispatched in the background (BEH-EA-064/113) by a
      // dispatcher this layer owns — supervised, retried, bounded, observable
      // and drained on shutdown — in place of unowned `forkDetach` fibers.
      const mailDispatcher = yield* MailDispatch.make;
      // AOMS-006/BCR-004 (.issues/high, wayfinder ticket 03): the mechanism
      // an Auth0-Rule-style sign-up policy, and the MFA divert point a
      // future `TwoFactor` plugin taps, both attach through.
      const beforeSignUp = yield* Hooks.BeforeSignUp;
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;

      // RBS-006: one typed definition per rule feeds both this registry
      // (BEH-EA-107/110/111 introspection) and the enforcement calls below,
      // so `registered()` reports exactly the keys enforced. A
      // `RateLimitScopeViolation` is only reachable if a rule named a group
      // other than this plugin's own `"password"` — a coding defect in this
      // package, not a condition a caller composing `Password` could trigger,
      // hence `Effect.orDie` rather than widening the public error surface.
      const rules = PasswordRateLimits.makeRules(config.rateLimitEmailKey);
      yield* Effect.all(
        // The callback's return type is annotated to break the inference
        // cycle through `Password.layer` (its own initializer names `Password`).
        PasswordRateLimits.registryEntries(rules).map(
          (entry): Effect.Effect<void, RateLimits.RateLimitScopeViolation> =>
            rateLimitsRegistry.register(Password, entry),
        ),
      ).pipe(Effect.orDie);

      // BEH-EA-114: paid once at boot, not once per unsuccessful attempt —
      // a real PHC/scrypt-encoded string this plugin's own configured
      // hasher produced, so `hasher.verify` always does the same real
      // work whether or not a matching account/credential actually
      // exists.
      const dummyPassword = Redacted.make("awthaq/password/dummy");
      const dummyHash = Redacted.make(yield* hasher.hash(dummyPassword));

      // TSS-006: `hasher.hash` above has already warmed the KDF (WASM
      // instantiation), so this timing is the steady-state verify cost.
      const timingFloorMillis = yield* Effect.gen(function* () {
        if (config.signInTimingFloor === "off") return 0;
        if (Duration.isDuration(config.signInTimingFloor)) {
          return Duration.toMillis(config.signInTimingFloor);
        }
        const start = DateTime.toEpochMillis(yield* DateTime.now);
        yield* hasher.verify(dummyPassword, Redacted.value(dummyHash));
        return 1.25 * (DateTime.toEpochMillis(yield* DateTime.now) - start);
      });

      /**
       * TSS-006: runs `effect` (success or failure alike) and holds its
       * result back until at least `timingFloorMillis` has elapsed, so a
       * cheap-hash path is not faster than the dummy-hash path.
       */
      const withTimingFloor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        timingFloorMillis <= 0
          ? effect
          : Effect.gen(function* () {
              const start = DateTime.toEpochMillis(yield* DateTime.now);
              const exit = yield* Effect.exit(effect);
              const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - start;
              if (elapsed < timingFloorMillis) {
                yield* Effect.sleep(Duration.millis(timingFloorMillis - elapsed));
              }
              return yield* exit;
            });

      /**
       * Ticket 12: enforces one `rules.*` definition against its own
       * secret-free key input, mapping the port's domain `RateLimitExceeded`
       * (`@awthaq/ports`) onto the wire-level `Api.RateLimited` — the same
       * class `PasswordShape`'s own error unions declare and `PasswordApi`'s
       * endpoints carry, so no separate mapping is needed again at the HTTP
       * handler layer.
       */
      const rateLimit = <I>(
        rule: PasswordRateLimits.PasswordRule<I>,
        input: I,
      ): Effect.Effect<void, Api.RateLimited> =>
        // EOTS-007: `RateLimits.enforce` also publishes the breach event, logs and counts it.
        RateLimits.enforce({
          key: rule.keyOf(input),
          limit: rule.limit,
          window: rule.window,
          meta: PasswordRateLimits.metaOf(rule),
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );

      /**
       * JH-001/PERS-001 (`packages/organization/src/OrganizationHooks.ts`'s
       * own `veto` helper — the same translation): BEH-EA-090 requires a
       * veto abort to reach the caller as a typed `HookAborted`, not the
       * bare `HookAbort` a tap itself fails with.
       */
      const vetoBeforeSignUp = (
        effect: Effect.Effect<
          { readonly email: string; readonly name: string },
          HookPoint.HookAbort
        >,
      ): Effect.Effect<{ readonly email: string; readonly name: string }, HookPoint.HookAborted> =>
        effect.pipe(
          Effect.catchTag(
            "HookAbort",
            (abort) =>
              new HookPoint.HookAborted({
                point: "auth.user.signUp",
                code: abort.code,
                message: abort.message,
              }),
          ),
        );

      /** Issues a verify-email token and mails it; dispatched, never awaited. */
      const dispatchVerificationMail = (user: Users.UserRecord) =>
        mailDispatcher.dispatch(
          { template: "verify-email", userId: user.id },
          Effect.gen(function* () {
            const issued = yield* VerificationLink.issue(
              { verification, crypto },
              { purpose: VERIFY_PURPOSE, ttl: VERIFY_TTL, userId: user.id },
            );
            // FAMS-002: only an Email identity has an address to mail.
            const to = Users.emailOf(user);
            if (Option.isNone(to)) return;
            yield* mailer.send({
              to: to.value,
              template: "verify-email",
              data: VerificationLink.mailData({
                token: issued.token,
                expiresAt: issued.expiresAt,
                link: config.links.verifyEmail,
              }),
            });
          }),
        );

      /**
       * The checks `signUp` and `signUpConcealed` share, in the same order:
       * rate limits, password policy, the `BeforeSignUp` veto, then the hash.
       */
      const prepareSignUp = Effect.fnUntraced(function* (input: {
        readonly email: string;
        readonly password: Redacted.Redacted<string>;
        readonly ip?: string;
      }) {
        // AGA-001/NHS-003: per-IP first, cheaper to enforce, bounds mass
        // account creation from one source before the per-email check.
        yield* rateLimit(rules.signUpByIp, input);
        yield* rateLimit(rules.signUp, input);
        const hints = yield* checkPolicy(httpClient, crypto, input.password, config);
        if (hints.length > 0) {
          return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
        }
        // BEH-EA-113's own sketch has no `name` input at all — a `User`
        // record requires one (BEH-EA-041), so the email's local part is
        // used as a placeholder the user can change later via
        // `updateProfile`.
        const name = input.email.split("@")[0] ?? input.email;
        // AOMS-006: an Auth0-Rule-style policy (e.g. an email-domain
        // allow-list) may reject the sign-up outright, or amend the input
        // for whatever taps run after it — before the (comparatively
        // expensive) password hash is even computed.
        const vetoedSignUp = yield* vetoBeforeSignUp(
          beforeSignUp.run({ email: input.email, name }),
        );
        const hash = yield* hasher.hash(input.password);
        return { vetoedSignUp, hash };
      });

      const signUp: PasswordShape["signUp"] = Effect.fnUntraced(function* (input) {
        const { vetoedSignUp, hash } = yield* prepareSignUp(input);

        // RRC-002/BEH-EA-113: "MUST create the user and session in one
        // transaction" — create+link+issue previously committed
        // independently; a crash between them could leave a real,
        // unlinked `User` row with no credential (the same orphaned-row
        // hazard `OAuth.ts`'s own create+link fix, ticket 16, closes for
        // its own flow) or a linked account with no session to hand back
        // to the caller who just paid for account creation.
        const { user, issued } = yield* sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              const user = yield* users
                .create({
                  identity: { _tag: "Email", email: vetoedSignUp.email },
                  name: vetoedSignUp.name,
                })
                .pipe(
                  Effect.catchTag("Users/EmailAlreadyExists", () => new PasswordApi.EmailAlreadyExists()),
                  // FAMS-002: `create` is Email-identity here, so a phone conflict is unreachable.
                  Effect.catchTag("Users/PhoneAlreadyExists", Effect.die),
                );
              yield* accounts
                .link({
                  userId: user.id,
                  providerId: Accounts.PASSWORD_PROVIDER_ID,
                  subject: user.id,
                  credentialHash: Redacted.make(hash),
                })
                .pipe(Effect.orDie);
              const issued = yield* sessions
                .issue({ userId: user.id, request: sessionRequest(input), amr: ["pwd"] })
                .pipe(Effect.orDie);
              return { user, issued };
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
        yield* events.publish({ _tag: "auth.user.created", userId: user.id });

        // BEH-EA-113: dispatched, never awaited — response latency must
        // not depend on mail-provider latency, and per
        // research/05-oauth-oidc.md Q48, a slow-vs-fast response is
        // itself an enumeration side channel.
        yield* dispatchVerificationMail(user);

        return issued;
      });

      const signUpConcealed: PasswordShape["signUpConcealed"] = Effect.fnUntraced(
        function* (input) {
          const { vetoedSignUp, hash } = yield* prepareSignUp(input);
          // TMS-005: the hash above is computed in both branches, so the
          // expensive work does not depend on whether the address exists. The
          // duplicate is caught outside the transaction (which rolls back), and
          // no session is issued either way.
          const created = yield* sqlTransaction
            .withTransaction(
              Effect.gen(function* () {
                const user = yield* users
                  .create({
                    identity: { _tag: "Email", email: vetoedSignUp.email },
                    name: vetoedSignUp.name,
                  })
                  .pipe(
                    Effect.catchTag(
                      "Users/EmailAlreadyExists",
                      () => new PasswordApi.EmailAlreadyExists(),
                    ),
                    // FAMS-002: `create` is Email-identity here, so a phone conflict is unreachable.
                    Effect.catchTag("Users/PhoneAlreadyExists", Effect.die),
                  );
                yield* accounts
                  .link({
                    userId: user.id,
                    providerId: Accounts.PASSWORD_PROVIDER_ID,
                    subject: user.id,
                    credentialHash: Redacted.make(hash),
                  })
                  .pipe(Effect.orDie);
                return user;
              }),
            )
            .pipe(
              Effect.map(Option.some),
              Effect.catchTag("EmailAlreadyExists", () => Effect.succeed(Option.none())),
              Effect.catchTag("SqlError", Effect.die),
            );
          if (Option.isSome(created)) {
            yield* events.publish({ _tag: "auth.user.created", userId: created.value.id });
            yield* dispatchVerificationMail(created.value);
            return;
          }
          // The address is taken: tell its owner (no token, nothing to act on),
          // looked up inside the background work so the response path is the same.
          yield* mailDispatcher.dispatch(
            { template: "account-exists" },
            Effect.gen(function* () {
              const owner = yield* users.findByEmail(vetoedSignUp.email);
              if (Option.isNone(owner)) return;
              const to = Users.emailOf(owner.value);
              if (Option.isNone(to)) return;
              yield* mailer.send({ to: to.value, template: "account-exists" });
            }),
          );
        },
      );

      const signIn: PasswordShape["signIn"] = Effect.fnUntraced(function* (input) {
        // RBS-001/CSD-002: the per-IP budget runs first — cheaper to
        // enforce (no DB lookup) and bounds a distributed spray across
        // many distinct emails before the per-account check below ever
        // sees them.
        yield* rateLimit(rules.signInByIp, input);
        yield* rateLimit(rules.signIn, input);
        // TSS-006: the whole credential check is held to `timingFloorMillis`.
        const { userOpt, accountOpt, hashOpt, verified } = yield* withTimingFloor(
          Effect.gen(function* () {
            const userOpt = yield* users.findByEmail(input.email);
            const accountOpt = yield* Option.match(userOpt, {
              onNone: () => Effect.succeed(Option.none<Accounts.AccountRecord>()),
              onSome: (user) =>
                accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, user.id),
            });
            const hashOpt = yield* Option.match(accountOpt, {
              onNone: () =>
                Effect.succeed(Option.none<Redacted.Redacted<PasswordHasher.PhcHash>>()),
              onSome: (account) => accounts.findCredentialHash(account.id).pipe(Effect.orDie),
            });
            // BEH-EA-114: this call happens on every attempt, real or not —
            // see `dummyHash`'s own comment.
            const verified = yield* hasher.verify(
              input.password,
              Redacted.value(Option.getOrElse(hashOpt, () => dummyHash)),
            );
            return { userOpt, accountOpt, hashOpt, verified };
          }),
        );
        if (
          Option.isNone(userOpt) ||
          Option.isNone(accountOpt) ||
          Option.isNone(hashOpt) ||
          !verified
        ) {
          // ALF-003: the one forensic signal a brute-force/credential-
          // stuffing campaign otherwise leaves nowhere — see
          // `UserSignInFailedEvent`'s own doc comment for why this
          // carries no `userId`/email despite the wire response's own
          // uniform-response discipline not applying here.
          yield* events.publish({
            _tag: "auth.user.signInFailed",
            strategy: "password",
            reason: "invalidCredentials",
          });
          return yield* Effect.fail(new Api.InvalidCredentials());
        }
        const user = userOpt.value;
        const account = accountOpt.value;
        const hash = hashOpt.value;

        // Upstream-hardening ticket 04: checked only now that a genuinely
        // correct password is confirmed — never before, so this can't be
        // used to probe whether a guessed password is even close to right.
        if (config.requireVerifiedEmail && !Users.isEmailVerified(user)) {
          yield* events.publish({
            _tag: "auth.user.signInFailed",
            strategy: "password",
            reason: "emailNotVerified",
          });
          return yield* Effect.fail(new PasswordApi.EmailNotVerified());
        }

        // SCP-001/BAM-005: THE shared sign-in gate, likewise only after the
        // password is proven correct (a wrong password never learns the
        // account is suspended).
        yield* Users.assertCanSignIn(user).pipe(
          Effect.tapError(() =>
            events.publish({
              _tag: "auth.user.signInFailed",
              strategy: "password",
              reason: "suspended",
            }),
          ),
        );

        if (config.rehashOnLogin && hasher.needsRehash(Redacted.value(hash))) {
          const rehashed = yield* hasher.hash(input.password);
          yield* accounts
            .updateCredentialHash(account.id, Redacted.make(rehashed))
            .pipe(Effect.orDie);
        }

        // BCR-004/THS-002: THE canonical MFA attachment point — consulted
        // here, right before this flow's own `sessions.issue`, never
        // centralized inside `Sessions.issue` itself (which is also
        // called for admin impersonation and same-session token rotation,
        // neither of which is "a first factor just succeeded").
        const point = yield* beforeSessionIssue.run({ userId: user.id, strategy: "password" });
        if (point._tag === "Diverted") {
          return yield* Effect.fail(point.value);
        }
        const issued = yield* sessions
          .issue({ userId: user.id, request: sessionRequest(input), amr: ["pwd"] })
          .pipe(Effect.orDie);
        yield* events.publish({
          _tag: "auth.user.signedIn",
          userId: user.id,
          strategy: "password",
        });
        yield* afterSignIn.run({ userId: user.id, strategy: "password" });
        return issued;
      });

      const requestReset: PasswordShape["requestReset"] = Effect.fnUntraced(function* (input) {
        // AGA-001/NHS-003: per-IP first, bounds one source spraying
        // reset requests across many distinct, unrelated emails.
        yield* rateLimit(rules.requestResetByIp, input);
        yield* rateLimit(rules.requestReset, input);
        const userOpt = yield* users.findByEmail(input.email);
        // TSS-001/EEM-001/MLO-001: BEH-EA-064 requires the response to be
        // uniform whether or not `email` resolves to an account — status
        // and body alone aren't enough, since an inline-awaited
        // `verification.issue` + real `mailer.send` (network I/O) only
        // ever runs in this branch, making response *latency* (and, if
        // the mail provider is down, response *status*) an enumeration
        // oracle. `signUp`'s own background dispatch (above) fixes the
        // identical hazard there; mirrored here so both branches cost one
        // user lookup and return with the same latency distribution
        // regardless of mail-provider health.
        if (Option.isSome(userOpt)) {
          const user = userOpt.value;
          yield* mailDispatcher.dispatch(
            { template: "reset-password", userId: user.id },
            Effect.gen(function* () {
              // ARF-004: an OAuth-/passkey-only account has no password to
              // reset — a token would only lead to a dead link. Looked up
              // here, inside the dispatched work, so both branches still cost
              // the same on the response path (BEH-EA-064).
              const to = Users.emailOf(user);
              if (Option.isNone(to)) return;
              const account = yield* accounts.findByProviderSubject(
                Accounts.PASSWORD_PROVIDER_ID,
                user.id,
              );
              if (Option.isNone(account)) {
                yield* mailer.send({ to: to.value, template: "reset-password-unavailable" });
                return;
              }
              const issued = yield* VerificationLink.issue(
                { verification, crypto },
                { purpose: RESET_PURPOSE, ttl: config.resetTtl, userId: user.id },
              );
              yield* mailer.send({
                to: to.value,
                template: "reset-password",
                data: VerificationLink.mailData({
                  token: issued.token,
                  expiresAt: issued.expiresAt,
                  link: config.links.resetPassword,
                }),
              });
            }),
          );
        }
      });

      const resendVerification: PasswordShape["resendVerification"] = Effect.fnUntraced(
        function* (input) {
          // MLO-003: per-source first, like the sibling email flows.
          yield* rateLimit(rules.resendVerificationByIp, input);
          yield* rateLimit(rules.resendVerification, input);
          const userOpt = yield* users.findByEmail(input.email);
          // TSS-002: same background-dispatch posture as `requestReset`
          // above — without it this branch is the only one paying for a
          // `verification.issue` + awaited `mailer.send`, which (combined
          // with `requestReset`'s own timing) lets a caller classify any
          // address as unknown / known-unverified / known-verified purely
          // by latency.
          if (Option.isSome(userOpt) && !Users.isEmailVerified(userOpt.value)) {
            const user = userOpt.value;
            yield* dispatchVerificationMail(user);
          }
        },
      );

      const confirmReset: PasswordShape["confirmReset"] = Effect.fnUntraced(function* (input) {
        // ARF-007: a token of another purpose (a verify-email token) or a
        // malformed one is refused before it is rate-limited or consumed.
        const decoded = VerificationLink.decode(Redacted.value(input.token), RESET_PURPOSE);
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(new PasswordApi.TokenConsumed());
        }
        const { identifier, publicId, value } = decoded.value;
        // Keyed on the token's own public id rather than email — already
        // available for free at this point, and ties the limit to the
        // specific token without a second lookup (ARF-009: it names no user).
        yield* rateLimit(rules.confirmReset, { identifier: publicId });

        // ARF-002: the policy (including the breach check's network call)
        // is decided before the token is touched, so a weak password never
        // burns the single-use token under any `Verification` store — and
        // no network I/O happens while the transaction below is open.
        const hints = yield* checkPolicy(httpClient, crypto, input.password, config);
        if (hints.length > 0) {
          return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
        }

        // ARF-001: BEH-EA-058/117 require consuming the token, setting the
        // new password, and revoking every other session to commit as one
        // unit — three independent commits previously left a crash-window
        // where the token was burned but the old password still live, or
        // the new password live while an attacker's pre-reset sessions
        // survived. Mirrors `OAuth.ts`'s own `sqlTransaction.withTransaction`
        // usage: only the transaction's own `SqlError` dies below —
        // `TokenConsumed` is a real, expected outcome and must still reach
        // the caller as itself.
        const userId = yield* sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              const consumed = yield* verification.consume(identifier, value).pipe(
                Effect.catchTag("Verification/TokenConsumed", () => new PasswordApi.TokenConsumed()),
              );
              // ARF-009: the user comes from the consumed row, never from the
              // token; a row with none is no reset token this plugin issued.
              if (Option.isNone(consumed.userId)) {
                return yield* Effect.fail(new PasswordApi.TokenConsumed());
              }
              const userId = consumed.userId.value;

              const account = yield* accounts
                .findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId)
                .pipe(
                  Effect.flatMap(
                    Option.match({
                      // ARF-004: `requestReset` no longer mints a token for a
                      // credential-less account, but one issued before that
                      // fix (or a credential unlinked since) can still land
                      // here — a dead token, not a defect.
                      onNone: () => Effect.fail(new PasswordApi.TokenConsumed()),
                      onSome: Effect.succeed,
                    }),
                  ),
                );
              const hash = yield* hasher.hash(input.password);
              yield* accounts
                .updateCredentialHash(account.id, Redacted.make(hash))
                .pipe(Effect.orDie);

              // ARF-008: consuming a token mailed to the address proves the
              // same mailbox control `verifyEmail` demands — otherwise a
              // user who resets is still refused at `signIn`. Idempotent.
              yield* users.verifyEmail(userId).pipe(
                Effect.catchTags({
                  UserNotFound: () =>
                    Defects.invariantViolation(
                      "ResetTokenUserMissing",
                      "awthaq: reset token's own user missing",
                    ),
                  // FAMS-002: a password account's owner has an email identity.
                  IdentityMismatch: Effect.die,
                }),
              );

              // BEH-EA-117: every session, no exceptions — the caller
              // isn't authenticated at all here, so there is no "current"
              // session to keep. Upstream-hardening ticket 02: the real
              // `revokeAll` primitive, retiring the empty-string-id
              // `revokeOthers` trick this call site used to stand in for
              // it.
              // ESA-006/TIR-008: `Sessions.revokeAll` itself publishes the
              // `auth.session.revoked` (reason `passwordReset`) — after this
              // transaction's own write, like every other revocation.
              yield* sessions.revokeAll(userId, "passwordReset");
              return userId;
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
        // ALF-004: published only after the transaction above has actually
        // committed — mirroring `signUp`'s own `auth.user.created`
        // placement, never inside the transaction itself.
        yield* events.publish({ _tag: "auth.password.resetCompleted", userId });
      });

      const verifyEmail: PasswordShape["verifyEmail"] = Effect.fnUntraced(function* (input) {
        // APS-003: per-IP first — guards against a flood of garbage
        // tokens before even attempting to decode one, mirroring
        // `signIn`/`requestReset`'s own IP-then-identity ordering.
        yield* rateLimit(rules.verifyEmailByIp, input);
        // ARF-007: mirror of `confirmReset`'s purpose check.
        const decoded = VerificationLink.decode(Redacted.value(input.token), VERIFY_PURPOSE);
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(new PasswordApi.TokenConsumed());
        }
        const { identifier, publicId, value } = decoded.value;
        // Keyed on the token's own public id, mirroring `confirmReset`.
        yield* rateLimit(rules.verifyEmail, { identifier: publicId });

        // RRC-002: same class of bug `ARF-001` closes for `confirmReset` —
        // a crash between `consume` and `verifyEmail` previously burned
        // the token without ever flipping `emailVerified`, permanently
        // stranding the account unverified with no usable token left to
        // retry. `resendVerification` mints a fresh token, so it isn't
        // fatal, but it's still the identical consume-then-apply
        // atomicity gap `SqlTransaction` exists to close.
        yield* sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              const consumed = yield* verification.consume(identifier, value).pipe(
                Effect.catchTag("Verification/TokenConsumed", () => new PasswordApi.TokenConsumed()),
              );
              // ARF-009: the user comes from the consumed row, not the token.
              if (Option.isNone(consumed.userId)) {
                return yield* Effect.fail(new PasswordApi.TokenConsumed());
              }
              const userId = consumed.userId.value;

              // Mirrors `confirmReset`'s own posture on the analogous
              // case: this token was only ever issued right after
              // `signUp` created this exact user (BEH-EA-113), so a
              // missing user here is a defect, not a request-level
              // condition the caller can act on — never re-surfaced as
              // `TokenConsumed`, which would misleadingly imply a
              // bad/replayed token rather than a genuine invariant
              // violation.
              yield* users.verifyEmail(userId).pipe(
                Effect.catchTags({
                  UserNotFound: () =>
                    Defects.invariantViolation(
                      "VerifyEmailTokenUserMissing",
                      "awthaq: verify-email token's own user missing",
                    ),
                  IdentityMismatch: Effect.die,
                }),
              );
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
      });

      const changePassword: PasswordShape["changePassword"] = Effect.fnUntraced(function* (input) {
        // Keyed on `userId` directly — this endpoint is authenticated, so
        // (unlike `signIn`/`requestReset`) there's no need to look up an
        // email first.
        yield* rateLimit(rules.changePassword, input);
        const accountOpt = yield* accounts.findByProviderSubject(
          Accounts.PASSWORD_PROVIDER_ID,
          input.userId,
        );
        const hashOpt = yield* Option.match(accountOpt, {
          onNone: () => Effect.succeed(Option.none<Redacted.Redacted<PasswordHasher.PhcHash>>()),
          onSome: (account) => accounts.findCredentialHash(account.id).pipe(Effect.orDie),
        });
        // Same uniform-cost shape as `signIn`'s own `dummyHash` check —
        // this endpoint is authenticated (no enumeration concern), but
        // there is no reason to let a caller with no password credential
        // at all distinguish "wrong password" from "no password set" by
        // timing, so the real hasher call always runs regardless (TSS-006:
        // held to the same timing floor as `signIn`).
        const verified = yield* withTimingFloor(
          hasher.verify(
            input.currentPassword,
            Redacted.value(Option.getOrElse(hashOpt, () => dummyHash)),
          ),
        );
        if (Option.isNone(accountOpt) || Option.isNone(hashOpt) || !verified) {
          return yield* Effect.fail(new PasswordApi.WrongPassword());
        }
        const account = accountOpt.value;

        const hints = yield* checkPolicy(httpClient, crypto, input.newPassword, config);
        if (hints.length > 0) {
          return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
        }

        const hash = yield* hasher.hash(input.newPassword);
        yield* accounts.updateCredentialHash(account.id, Redacted.make(hash)).pipe(Effect.orDie);
        yield* events.publish({ _tag: "auth.password.changed", userId: input.userId });

        // BEH-EA-053: revoke every *other* session first, while
        // `currentSessionId` still names a live row — then supersede that
        // row with a freshly minted one. Reversing this order would leave
        // `revokeOthers` nothing to `keep` (the superseded id no longer
        // exists once `issue` has run).
        yield* sessions.revokeOthers(input.userId, input.currentSessionId, "passwordChanged");
        const issued = yield* sessions
          .issue({
            userId: input.userId,
            supersedes: input.currentSessionId,
            request: sessionRequest(input),
            amr: ["pwd"],
          })
          .pipe(Effect.orDie);
        return issued;
      });

      const reauthenticate: PasswordShape["reauthenticate"] = Effect.fnUntraced(function* (input) {
        // Keyed on `userId` directly — this endpoint is authenticated,
        // mirroring `changePassword`'s own posture.
        yield* rateLimit(rules.reauthenticate, input);
        const accountOpt = yield* accounts.findByProviderSubject(
          Accounts.PASSWORD_PROVIDER_ID,
          input.userId,
        );
        const hashOpt = yield* Option.match(accountOpt, {
          onNone: () => Effect.succeed(Option.none<Redacted.Redacted<PasswordHasher.PhcHash>>()),
          onSome: (account) => accounts.findCredentialHash(account.id).pipe(Effect.orDie),
        });
        // Same uniform-cost shape as `changePassword`'s own `dummyHash`
        // check — this endpoint is authenticated (no enumeration
        // concern), but there is no reason to let a caller with no
        // password credential at all distinguish "wrong password" from
        // "no password set" by timing (TSS-006: same timing floor).
        const verified = yield* withTimingFloor(
          hasher.verify(
            input.currentPassword,
            Redacted.value(Option.getOrElse(hashOpt, () => dummyHash)),
          ),
        );
        if (Option.isNone(accountOpt) || Option.isNone(hashOpt) || !verified) {
          return yield* Effect.fail(new PasswordApi.WrongPassword());
        }
        yield* sessions.reauthenticate(input.currentSessionId, ["pwd"]).pipe(
          Effect.catchTag("Sessions/NotFound", () =>
            // `changePassword`'s own `Authentication` middleware already
            // proved this exact session live moments ago — a
            // `SessionNotFound` here would mean it was revoked in the
            // narrow window since, a race this endpoint has no
            // request-level recovery for.
            Defects.invariantViolation("RowVanished", "awthaq: reauthenticate's own current session vanished"),
          ),
        );
      });

      return Password.of({
        signUp,
        signUpConcealed,
        signIn,
        requestReset,
        resendVerification,
        confirmReset,
        verifyEmail,
        changePassword,
        reauthenticate,
      });
    }),
  });
}
