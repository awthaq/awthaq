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
  AuthEvents,
  AuthPlugin,
  Accounts,
  Hooks,
  HookPoint,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import { ClientAddress, Mailer, PasswordHasher, RateLimiter, SqlTransaction } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as PasswordApi from "./PasswordApi.ts";

export interface PasswordConfigShape {
  readonly minLength: number;
  readonly breachCheck: boolean | { readonly onUnavailable: "allow" | "reject" };
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
}

const defaultPasswordConfig: PasswordConfigShape = {
  minLength: 12,
  breachCheck: false,
  resetTtl: Duration.hours(1),
  rehashOnLogin: true,
  signInTimingFloor: "calibrated",
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
  }) => Effect.Effect<
    IssuedSession,
    | PasswordApi.WeakPassword
    | PasswordApi.EmailAlreadyExists
    | Api.RateLimited
    | HookPoint.HookAborted
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
  }) => Effect.Effect<
    IssuedSession,
    | Api.InvalidCredentials
    | PasswordApi.EmailNotVerified
    | Api.RateLimited
    | Hooks.TwoFactorRequired
  >;
  /** BEH-EA-064/117: identical response whether or not `email` resolves to an account — the caller (the HTTP handler) always answers 202. */
  readonly requestReset: (input: {
    readonly email: string;
    /** AGA-001/NHS-003: same per-source dimension as `signIn`'s own `ip`. */
    readonly ip?: string;
  }) => Effect.Effect<void, Api.RateLimited>;
  /**
   * Upstream-hardening ticket 04: identical response whether `email`
   * doesn't exist, the account is already verified, or a mail genuinely
   * goes out — same enumeration-safe shape as `requestReset`.
   */
  readonly resendVerification: (input: {
    readonly email: string;
  }) => Effect.Effect<void, Api.RateLimited>;
  /** BEH-EA-117: consumes the reset token and sets the new password in one call, then revokes every other session. */
  readonly confirmReset: (input: {
    readonly token: Redacted.Redacted<string>;
    readonly password: Redacted.Redacted<string>;
  }) => Effect.Effect<void, PasswordApi.TokenConsumed | PasswordApi.WeakPassword | Api.RateLimited>;
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
  }) => Effect.Effect<void, PasswordApi.TokenConsumed | Api.RateLimited>;
  /**
   * Shipping-gap map (.scratch/shipping-gaps), ticket 11: authenticated
   * change-password — distinct from the unauthenticated `requestReset`/
   * `confirmReset` pair, which no capability here provided at all before
   * this ticket.
   */
  /**
   * PIL-002/RRS-001/SMS-001: BEH-EA-053 — every privilege-changing
   * operation mints a fresh session and deletes the row it supersedes.
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
  }) => Effect.Effect<
    IssuedSession,
    PasswordApi.WrongPassword | PasswordApi.WeakPassword | Api.RateLimited
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
  }) => Effect.Effect<void, PasswordApi.WrongPassword | Api.RateLimited>;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * `RateLimits.RateLimitKey`'s own `input` is untyped (`unknown`) — one
 * registry list covers every endpoint's differently-shaped payload — so
 * pulling `email` back out needs a real narrowing check rather than a type
 * assertion (this repo forbids `as`/`as unknown as`/`as any` in library
 * source). Empty string on a shape mismatch is a defect elsewhere, not a
 * condition this key derivation needs its own error channel for.
 */
const emailFromRateLimitInput = (input: unknown): string =>
  typeof input === "object" && input !== null && "email" in input && typeof input.email === "string"
    ? input.email
    : "";

/** Same narrowing shape as `emailFromRateLimitInput`, for `signIn`'s per-IP rule (RBS-001/CSD-002). */
const ipFromRateLimitInput = (input: unknown): string =>
  typeof input === "object" && input !== null && "ip" in input && typeof input.ip === "string"
    ? input.ip
    : "unknown";

/**
 * Shipping-gap map (.scratch/shipping-gaps), ticket 12: one rule per
 * rate-limited endpoint — mirrors `usage-examples-v4.md` §16's own worked
 * `signin:${email}` example for `signIn`'s numbers exactly. Every rule
 * here keys on identity/email, never IP: this codebase has no client-IP-
 * extraction mechanism anywhere yet (no handler threads a request's
 * origin into a domain capability today), and building one speculatively
 * for this one rate-limit key would be exactly the kind of unrequested
 * infrastructure this codebase's own standing preference warns against.
 * IP-based keying (ticket 02's own "sign-in keys on both identity and
 * IP") is real follow-on work, not silently dropped — tracked, not built
 * here.
 */
const RATE_LIMITS = {
  signUp: { limit: 5, window: Duration.hours(1) },
  // AGA-001/NHS-003: same reasoning as `signInByIp` below — bounds mass
  // account creation from one source independently of the (freely
  // chosen) email each attempt names.
  signUpByIp: { limit: 20, window: Duration.hours(1) },
  signIn: { limit: 5, window: Duration.minutes(15) },
  // RBS-001/CSD-002: the per-account budget above is keyed on an
  // attacker-controlled email — an attacker can burn a victim's 5
  // attempts to lock them out, and distributed spraying across many
  // distinct addresses never trips it at all. This second, per-IP rule
  // bounds spraying independently of which account is targeted; looser
  // than the per-account limit so one shared office NAT can't lock out
  // every real user behind it.
  signInByIp: { limit: 30, window: Duration.minutes(15) },
  requestReset: { limit: 5, window: Duration.minutes(15) },
  // AGA-001/NHS-003: mirrors `signInByIp` — bounds one source spraying
  // reset requests across many distinct, unrelated emails.
  requestResetByIp: { limit: 30, window: Duration.minutes(15) },
  confirmReset: { limit: 5, window: Duration.minutes(15) },
  // Shipping-gap map (.scratch/shipping-gaps), ticket 14.
  changePassword: { limit: 5, window: Duration.minutes(15) },
  // Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15:
  // mirrors `changePassword`'s own numbers — the identical
  // authenticated-password-recheck shape.
  reauthenticate: { limit: 5, window: Duration.minutes(15) },
  // Upstream-hardening map, ticket 04: tighter than the generic 5-per-15-
  // min default — resend-verification abuse is an inbox-flooding
  // harassment vector against the *target*, not an account-takeover one.
  resendVerification: { limit: 3, window: Duration.minutes(15) },
  // APS-003: `verifyEmail` had no rule at all — an unlimited flood of
  // wrong guesses against `/verify-email` is hopeless against a 256-bit
  // token, but each failed `consume` still publishes `auth.token.replay`
  // (now a lossy, non-suspending publish — BEH-EA-098 — but still
  // pointless churn/log-spam to leave completely unbounded). Same numbers
  // as `confirmReset`, the closest structural sibling (also a bare
  // token-consume endpoint).
  verifyEmail: { limit: 5, window: Duration.minutes(15) },
  // Mirrors `signInByIp`/`requestResetByIp`: bounds one source spraying
  // guesses across many distinct, unrelated tokens/accounts.
  verifyEmailByIp: { limit: 30, window: Duration.minutes(15) },
} as const satisfies Record<string, { readonly limit: number; readonly window: Duration.Duration }>;

/**
 * EOTS-007: the fixed labels a breach of `rule` is reported under — the
 * `RATE_LIMITS` entry's name, never the (email/IP-bearing) bucket key.
 */
const ruleMeta = (rule: {
  readonly limit: number;
  readonly window: Duration.Duration;
}): RateLimits.EnforceMeta => {
  const name =
    Object.entries(RATE_LIMITS).find(([, candidate]) => candidate === rule)?.[0] ?? "unknown";
  return {
    group: "password",
    endpoint: name.replace(/ByIp$/, ""),
    rule: name,
    dimension: name.endsWith("ByIp") ? "ip" : "identity",
  };
};

/**
 * The mailed reset/verification link's token embeds `Verification`'s own
 * `identifier` alongside its secret value (`<identifier>.<secret>`) — the
 * domain service's `consume` needs `identifier` to look the row up at all,
 * and the caller who receives this link has nothing else to supply it with.
 * Neither half can contain a literal `.` (`identifier`'s own `:`-delimited
 * scheme, BEH-EA-057; `value`'s hex digest), so splitting on the last `.`
 * round-trips exactly.
 */
const encodeVerificationToken = (identifier: string, value: Redacted.Redacted<string>): string =>
  `${identifier}.${Redacted.value(value)}`;

const decodeVerificationToken = (
  raw: string,
): Option.Option<{ readonly identifier: string; readonly value: Redacted.Redacted<string> }> => {
  const separator = raw.lastIndexOf(".");
  if (separator === -1) return Option.none();
  return Option.some({
    identifier: raw.slice(0, separator),
    value: Redacted.make(raw.slice(separator + 1)),
  });
};

const RESET_PREFIX = "reset-password:";
const VERIFY_PREFIX = "verify-email:";

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
    return body.split("\n").some((line) => line.split(":")[0]?.trim().toUpperCase() === suffix);
  }).pipe(Effect.catch(() => Effect.succeed(onUnavailable === "reject")));

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
      if (yield* isBreached(httpClient, crypto, password, onUnavailable)) {
        hints.push("appears in known breaches");
      }
    }
    return hints;
  });

/** The response to `signUp`/`signIn` — the just-created/just-verified session is always `current`. */
const toSessionDto = (session: Sessions.SessionView): SessionContract.SessionDto =>
  new SessionContract.SessionDto({
    id: session.id,
    createdAt: DateTime.formatIso(session.createdAt),
    lastActiveAt: DateTime.formatIso(session.lastActiveAt),
    expiresAt: DateTime.formatIso(session.absoluteExpiresAt),
    userAgent: Option.getOrNull(session.userAgent),
    current: true,
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

    return handlers.handleAll({
      signUp: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: PasswordApi.SignUpPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const resolvedAddress = yield* clientAddress.resolve(request);
        const issued = yield* password.signUp({
          ...payload,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
        });
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
        return toSessionDto(issued.session);
      }),

      signIn: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: PasswordApi.SignInPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        // AGA-001/NHS-003: resolved through the application-provided
        // `ClientAddress` port rather than `request.remoteAddress`
        // directly, so a trusted-proxy-aware composition gets a real
        // client IP here too, not just for `OAuth`'s own callback.
        const resolvedAddress = yield* clientAddress.resolve(request);
        const issued = yield* password.signIn({
          ...payload,
          ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
        });
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
        return toSessionDto(issued.session);
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
      }: {
        payload: PasswordApi.ResendVerificationPayload;
      }) {
        yield* password.resendVerification(payload);
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

      changePassword: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: PasswordApi.ChangePasswordPayload;
      }) {
        const principal = yield* Api.CurrentPrincipal;
        // `changePassword`'s own `Authentication` middleware already
        // refused an unauthenticated request; a non-`User` principal
        // reaching it is a wiring defect, mirroring `Session.ts`'s own
        // `currentUserPrincipal` guard.
        if (principal._tag !== "User") {
          return yield* Effect.die(
            new Error(
              `awthaq: change-password reached with a non-User principal: ${principal._tag}`,
            ),
          );
        }
        const issued = yield* password.changePassword({
          userId: Users.UserId(principal.ref.id),
          currentSessionId: Sessions.SessionId(principal.sessionId),
          currentPassword: payload.currentPassword,
          newPassword: payload.newPassword,
        });
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
        return toSessionDto(issued.session);
      }),

      reauthenticate: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: PasswordApi.ReauthenticatePayload;
      }) {
        const principal = yield* Api.CurrentPrincipal;
        if (principal._tag !== "User") {
          return yield* Effect.die(
            new Error(
              `awthaq: reauthenticate reached with a non-User principal: ${principal._tag}`,
            ),
          );
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
}) {
  /**
   * BEH-EA-001/008 (`AuthPlugin.ts`'s own doc comment): a plugin's `layer`
   * static is added by the plugin author, not by `AuthPlugin.Service`
   * itself — `Auth.make` reads it directly off the class
   * (`AuthPlugin.Any["layer"]`), so it must live here rather than as a
   * sibling export.
   */
  static readonly layer = AuthPlugin.layer(Password, {
    handlers: PasswordHandlers,
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
      // AOMS-006/BCR-004 (.issues/high, wayfinder ticket 03): the mechanism
      // an Auth0-Rule-style sign-up policy, and the MFA divert point a
      // future `TwoFactor` plugin taps, both attach through.
      const beforeSignUp = yield* Hooks.BeforeSignUp;
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;

      /**
       * Ticket 12: registers this plugin's own limits into the
       * introspectable registry (BEH-EA-107/110/111) — declarative,
       * matching the `limit`/`window` each `rateLimit(...)` call below
       * actually enforces (`RATE_LIMITS` is the single source of truth
       * both sides draw from). A `RateLimitScopeViolation` here is only
       * reachable if `group` below ever named something other than this
       * plugin's own `"password"` contract group — a coding defect in
       * this file, not a condition any caller composing `Password` could
       * trigger, hence `Effect.orDie` rather than adding it to this
       * plugin's own public error surface.
       */
      yield* Effect.all(
        (
          [
            {
              endpoint: "signUp",
              key: (input) => `password:signup:${(input as { readonly email: string }).email}`,
              ...RATE_LIMITS.signUp,
            },
            {
              // AGA-001/NHS-003: a second, independent rule for the same
              // endpoint, mirroring `signIn`'s own IP rule below.
              endpoint: "signUp",
              key: (input) => `password:signup:ip:${ipFromRateLimitInput(input)}`,
              ...RATE_LIMITS.signUpByIp,
            },
            {
              endpoint: "signIn",
              key: (input) => `password:signin:${(input as { readonly email: string }).email}`,
              ...RATE_LIMITS.signIn,
            },
            {
              // RBS-001/CSD-002: a second, independent rule for the same
              // endpoint — the registry has no one-rule-per-endpoint
              // constraint, and `OAuth.ts`'s own `callback` rule already
              // establishes the "declare a `key: \"ip\"` rule alongside a
              // manually-keyed `rateLimit(...)` call" pattern this follows.
              endpoint: "signIn",
              key: (input) => `password:signin:ip:${ipFromRateLimitInput(input)}`,
              ...RATE_LIMITS.signInByIp,
            },
            {
              endpoint: "requestReset",
              key: (input) =>
                `password:reset-request:${(input as { readonly email: string }).email}`,
              ...RATE_LIMITS.requestReset,
            },
            {
              // AGA-001/NHS-003: a second, independent rule for the same
              // endpoint, mirroring `signIn`'s own IP rule above.
              endpoint: "requestReset",
              key: (input) => `password:reset-request:ip:${ipFromRateLimitInput(input)}`,
              ...RATE_LIMITS.requestResetByIp,
            },
            {
              endpoint: "confirmReset",
              // Keyed on the token's own decoded identifier at enforcement
              // time, not a payload field — this description is necessarily
              // approximate.
              key: (input) => `password:reset-confirm:${JSON.stringify(input)}`,
              ...RATE_LIMITS.confirmReset,
            },
            {
              endpoint: "changePassword",
              // Keyed on `CurrentPrincipal`'s own userId at enforcement
              // time (the authenticated caller), not a payload field.
              key: (input) => `password:change-password:${JSON.stringify(input)}`,
              ...RATE_LIMITS.changePassword,
            },
            {
              endpoint: "reauthenticate",
              // Keyed on `CurrentPrincipal`'s own userId at enforcement
              // time, mirroring `changePassword`'s own posture.
              key: (input) => `password:reauthenticate:${JSON.stringify(input)}`,
              ...RATE_LIMITS.reauthenticate,
            },
            {
              endpoint: "resendVerification",
              key: (input) => `password:resend-verification:${emailFromRateLimitInput(input)}`,
              ...RATE_LIMITS.resendVerification,
            },
            {
              endpoint: "verifyEmail",
              // Keyed on the token's own decoded identifier at enforcement
              // time, not a payload field — mirrors `confirmReset`'s own
              // identical description-is-approximate posture.
              key: (input) => `password:verify-email:${JSON.stringify(input)}`,
              ...RATE_LIMITS.verifyEmail,
            },
            {
              endpoint: "verifyEmail",
              key: (input) => `password:verify-email:ip:${ipFromRateLimitInput(input)}`,
              ...RATE_LIMITS.verifyEmailByIp,
            },
          ] satisfies ReadonlyArray<{
            readonly endpoint: string;
            readonly key: RateLimits.RateLimitKey;
            readonly limit: number;
            readonly window: Duration.Duration;
          }>
        ).map((rule): Effect.Effect<void, RateLimits.RateLimitScopeViolation> =>
          rateLimitsRegistry.register(Password, { group: "password", ...rule }),
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
       * Ticket 12: every call site below passes its own `key`/`limit`/
       * `window` from `RATE_LIMITS`, and maps the port's own domain
       * `RateLimitExceeded` (`@awthaq/ports`) onto the wire-level
       * `Api.RateLimited` — the same class `PasswordShape`'s own error
       * unions declare and `PasswordApi`'s endpoints carry, so no separate
       * mapping is needed again at the HTTP handler layer.
       */
      const rateLimit = (
        key: string,
        rule: { readonly limit: number; readonly window: Duration.Duration },
      ): Effect.Effect<void, Api.RateLimited> =>
        // EOTS-007: `RateLimits.enforce` also publishes the breach event, logs and counts it.
        RateLimits.enforce({ key, limit: rule.limit, window: rule.window, meta: ruleMeta(rule) }).pipe(
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

      const signUp: PasswordShape["signUp"] = Effect.fnUntraced(function* (input) {
        // AGA-001/NHS-003: per-IP first, cheaper to enforce, bounds mass
        // account creation from one source before the per-email check.
        yield* rateLimit(`password:signup:ip:${input.ip ?? "unknown"}`, RATE_LIMITS.signUpByIp);
        yield* rateLimit(`password:signup:${input.email.toLowerCase()}`, RATE_LIMITS.signUp);
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
                .create({ email: vetoedSignUp.email, name: vetoedSignUp.name })
                .pipe(
                  Effect.catchTag("EmailAlreadyExists", () => new PasswordApi.EmailAlreadyExists()),
                  Effect.catchTag("PlatformError", Effect.die),
                );
              yield* accounts
                .link({
                  userId: user.id,
                  providerId: Accounts.PASSWORD_PROVIDER_ID,
                  subject: user.id,
                  credentialHash: Redacted.make(hash),
                })
                .pipe(Effect.orDie);
              const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
              return { user, issued };
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
        yield* events.publish({ _tag: "auth.user.created", userId: user.id });
        yield* events.publish({
          _tag: "auth.session.issued",
          sessionId: issued.session.id,
          userId: user.id,
        });

        // BEH-EA-113: dispatched, never awaited — response latency must
        // not depend on mail-provider latency, and per
        // research/05-oauth-oidc.md Q48, a slow-vs-fast response is
        // itself an enumeration side channel.
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const identifier = `${VERIFY_PREFIX}${user.id}`;
            const { value } = yield* verification.issue({
              identifier,
              ttl: Duration.hours(24),
              userId: user.id,
            });
            yield* mailer.send({
              to: user.email,
              template: "verify-email",
              data: { token: encodeVerificationToken(identifier, value) },
            });
          }).pipe(Effect.ignore),
        );

        return issued;
      });

      const signIn: PasswordShape["signIn"] = Effect.fnUntraced(function* (input) {
        // RBS-001/CSD-002: the per-IP budget runs first — cheaper to
        // enforce (no DB lookup) and bounds a distributed spray across
        // many distinct emails before the per-account check below ever
        // sees them.
        yield* rateLimit(`password:signin:ip:${input.ip ?? "unknown"}`, RATE_LIMITS.signInByIp);
        yield* rateLimit(`password:signin:${input.email.toLowerCase()}`, RATE_LIMITS.signIn);
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
              onNone: () => Effect.succeed(Option.none<Redacted.Redacted<string>>()),
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
        if (!user.emailVerified) {
          yield* events.publish({
            _tag: "auth.user.signInFailed",
            strategy: "password",
            reason: "emailNotVerified",
          });
          return yield* Effect.fail(new PasswordApi.EmailNotVerified());
        }

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
        const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        yield* events.publish({
          _tag: "auth.user.signedIn",
          userId: user.id,
          strategy: "password",
        });
        yield* events.publish({
          _tag: "auth.session.issued",
          sessionId: issued.session.id,
          userId: user.id,
        });
        yield* afterSignIn.run({ userId: user.id, strategy: "password" });
        return issued;
      });

      const requestReset: PasswordShape["requestReset"] = Effect.fnUntraced(function* (input) {
        // AGA-001/NHS-003: per-IP first, bounds one source spraying
        // reset requests across many distinct, unrelated emails.
        yield* rateLimit(
          `password:reset-request:ip:${input.ip ?? "unknown"}`,
          RATE_LIMITS.requestResetByIp,
        );
        yield* rateLimit(
          `password:reset-request:${input.email.toLowerCase()}`,
          RATE_LIMITS.requestReset,
        );
        const userOpt = yield* users.findByEmail(input.email);
        // TSS-001/EEM-001/MLO-001: BEH-EA-064 requires the response to be
        // uniform whether or not `email` resolves to an account — status
        // and body alone aren't enough, since an inline-awaited
        // `verification.issue` + real `mailer.send` (network I/O) only
        // ever runs in this branch, making response *latency* (and, if
        // the mail provider is down, response *status*) an enumeration
        // oracle. `signUp`'s own `Effect.forkDetach`+`Effect.ignore`
        // posture (above) fixes the identical hazard there; mirrored here
        // so both branches cost one user lookup and return with the same
        // latency distribution regardless of mail-provider health.
        if (Option.isSome(userOpt)) {
          const user = userOpt.value;
          yield* Effect.forkDetach(
            Effect.gen(function* () {
              const identifier = `${RESET_PREFIX}${user.id}`;
              const { value } = yield* verification.issue({
                identifier,
                ttl: config.resetTtl,
                userId: user.id,
              });
              yield* mailer.send({
                to: user.email,
                template: "reset-password",
                data: { token: encodeVerificationToken(identifier, value) },
              });
            }).pipe(Effect.ignore),
          );
        }
      });

      const resendVerification: PasswordShape["resendVerification"] = Effect.fnUntraced(
        function* (input) {
          yield* rateLimit(
            `password:resend-verification:${input.email.toLowerCase()}`,
            RATE_LIMITS.resendVerification,
          );
          const userOpt = yield* users.findByEmail(input.email);
          // TSS-002: same forkDetach+ignore posture as `requestReset`
          // above — without it this branch is the only one paying for a
          // `verification.issue` + awaited `mailer.send`, which (combined
          // with `requestReset`'s own timing) lets a caller classify any
          // address as unknown / known-unverified / known-verified purely
          // by latency.
          if (Option.isSome(userOpt) && !userOpt.value.emailVerified) {
            const user = userOpt.value;
            yield* Effect.forkDetach(
              Effect.gen(function* () {
                const identifier = `${VERIFY_PREFIX}${user.id}`;
                const { value } = yield* verification.issue({
                  identifier,
                  ttl: Duration.hours(24),
                  userId: user.id,
                });
                yield* mailer.send({
                  to: user.email,
                  template: "verify-email",
                  data: { token: encodeVerificationToken(identifier, value) },
                });
              }).pipe(Effect.ignore),
            );
          }
        },
      );

      const confirmReset: PasswordShape["confirmReset"] = Effect.fnUntraced(function* (input) {
        const decoded = decodeVerificationToken(Redacted.value(input.token));
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(new PasswordApi.TokenConsumed());
        }
        const { identifier, value } = decoded.value;
        // Keyed on the token's own decoded identifier (e.g.
        // `reset-password:<userId>`) rather than email — already available
        // for free at this point, and ties the limit to the specific
        // account the token names, matching `signIn`/`requestReset`'s own
        // identity-keyed posture without a second lookup.
        yield* rateLimit(`password:reset-confirm:${identifier}`, RATE_LIMITS.confirmReset);
        const userId = Users.UserId(identifier.slice(RESET_PREFIX.length));

        // ARF-001: BEH-EA-058/117 require consuming the token, setting the
        // new password, and revoking every other session to commit as one
        // unit — three independent commits previously left a crash-window
        // where the token was burned but the old password still live, or
        // the new password live while an attacker's pre-reset sessions
        // survived. Mirrors `OAuth.ts`'s own `sqlTransaction.withTransaction`
        // usage: only the transaction's own `SqlError` dies below —
        // `TokenConsumed`/`WeakPassword` are real, expected outcomes and
        // must still reach the caller as themselves (and, as a consequence
        // of the wrap, a `WeakPassword` failure now rolls the token
        // consumption back too, rather than burning a single-use token on
        // a rejected password).
        yield* sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              yield* verification.consume(identifier, value).pipe(
                Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
                Effect.catchTag("PlatformError", Effect.die),
              );

              const hints = yield* checkPolicy(httpClient, crypto, input.password, config);
              if (hints.length > 0) {
                return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
              }

              const account = yield* accounts
                .findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId)
                .pipe(
                  Effect.flatMap(
                    Option.match({
                      // The token was only ever issued right after `signUp`
                      // created this exact row (BEH-EA-113/117) — its
                      // absence here is a defect, not a request-level
                      // condition the caller can act on.
                      onNone: () =>
                        Effect.die(
                          new Error(`awthaq: password credential missing for user ${userId}`),
                        ),
                      onSome: Effect.succeed,
                    }),
                  ),
                );
              const hash = yield* hasher.hash(input.password);
              yield* accounts
                .updateCredentialHash(account.id, Redacted.make(hash))
                .pipe(Effect.orDie);

              // BEH-EA-117: every session, no exceptions — the caller
              // isn't authenticated at all here, so there is no "current"
              // session to keep. Upstream-hardening ticket 02: the real
              // `revokeAll` primitive, retiring the empty-string-id
              // `revokeOthers` trick this call site used to stand in for
              // it.
              yield* sessions.revokeAll(userId);
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
        // ALF-004: published only after the transaction above has actually
        // committed — mirroring `signUp`'s own `auth.user.created`
        // placement, never inside the transaction itself.
        yield* events.publish({ _tag: "auth.password.resetCompleted", userId });
        yield* events.publish({
          _tag: "auth.session.revoked",
          userId,
          reason: "passwordReset",
        });
      });

      const verifyEmail: PasswordShape["verifyEmail"] = Effect.fnUntraced(function* (input) {
        // APS-003: per-IP first — guards against a flood of garbage
        // tokens before even attempting to decode one, mirroring
        // `signIn`/`requestReset`'s own IP-then-identity ordering.
        yield* rateLimit(
          `password:verify-email:ip:${input.ip ?? "unknown"}`,
          RATE_LIMITS.verifyEmailByIp,
        );
        const decoded = decodeVerificationToken(Redacted.value(input.token));
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(new PasswordApi.TokenConsumed());
        }
        const { identifier, value } = decoded.value;
        // Keyed on the token's own decoded identifier, mirroring
        // `confirmReset`'s identical posture — already available for
        // free at this point, ties the limit to the specific account the
        // token names.
        yield* rateLimit(`password:verify-email:${identifier}`, RATE_LIMITS.verifyEmail);
        const userId = Users.UserId(identifier.slice(VERIFY_PREFIX.length));

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
              yield* verification.consume(identifier, value).pipe(
                Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
                Effect.catchTag("PlatformError", Effect.die),
              );

              // Mirrors `confirmReset`'s own posture on the analogous
              // case: this token was only ever issued right after
              // `signUp` created this exact user (BEH-EA-113), so a
              // missing user here is a defect, not a request-level
              // condition the caller can act on — never re-surfaced as
              // `TokenConsumed`, which would misleadingly imply a
              // bad/replayed token rather than a genuine invariant
              // violation.
              yield* users
                .verifyEmail(userId)
                .pipe(
                  Effect.catchTag("UserNotFound", () =>
                    Effect.die(
                      new Error(`awthaq: verify-email token's own user missing: ${userId}`),
                    ),
                  ),
                );
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
      });

      const changePassword: PasswordShape["changePassword"] = Effect.fnUntraced(function* (input) {
        // Keyed on `userId` directly — this endpoint is authenticated, so
        // (unlike `signIn`/`requestReset`) there's no need to look up an
        // email first.
        yield* rateLimit(`password:change-password:${input.userId}`, RATE_LIMITS.changePassword);
        const accountOpt = yield* accounts.findByProviderSubject(
          Accounts.PASSWORD_PROVIDER_ID,
          input.userId,
        );
        const hashOpt = yield* Option.match(accountOpt, {
          onNone: () => Effect.succeed(Option.none<Redacted.Redacted<string>>()),
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
        yield* sessions.revokeOthers(input.userId, input.currentSessionId);
        yield* events.publish({
          _tag: "auth.session.revoked",
          userId: input.userId,
          reason: "passwordChanged",
        });
        const issued = yield* sessions
          .issue({ userId: input.userId, supersedes: input.currentSessionId })
          .pipe(Effect.orDie);
        yield* events.publish({
          _tag: "auth.session.issued",
          sessionId: issued.session.id,
          userId: input.userId,
        });
        return issued;
      });

      const reauthenticate: PasswordShape["reauthenticate"] = Effect.fnUntraced(function* (input) {
        // Keyed on `userId` directly — this endpoint is authenticated,
        // mirroring `changePassword`'s own posture.
        yield* rateLimit(`password:reauthenticate:${input.userId}`, RATE_LIMITS.reauthenticate);
        const accountOpt = yield* accounts.findByProviderSubject(
          Accounts.PASSWORD_PROVIDER_ID,
          input.userId,
        );
        const hashOpt = yield* Option.match(accountOpt, {
          onNone: () => Effect.succeed(Option.none<Redacted.Redacted<string>>()),
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
        yield* sessions.reauthenticate(input.currentSessionId).pipe(
          Effect.catchTag("SessionNotFound", () =>
            // `changePassword`'s own `Authentication` middleware already
            // proved this exact session live moments ago — a
            // `SessionNotFound` here would mean it was revoked in the
            // narrow window since, a race this endpoint has no
            // request-level recovery for.
            Effect.die(
              new Error(
                `awthaq: reauthenticate's own current session vanished: ${input.currentSessionId}`,
              ),
            ),
          ),
        );
      });

      return Password.of({
        signUp,
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
