// @awthaq/password — Password
//
// spec/behaviors/15-password.md, BEH-EA-113 through BEH-EA-120.
// spec/models/01-password.md's plugin-class sketch, reproduced with the
// gaps that sketch leaves open (a duplicate email, the missing `name` a
// `User` record requires, the reset token's own encoding, the breach-check
// transport) filled in and documented at each site rather than left to
// silently die or guessed at without a comment explaining the choice.

import { Api, SessionContract, SessionLifecycle } from "@awthaq/api";
import {
  CurrentUser,
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  EmailChange,
  Errors,
  HookPoint,
  Hooks,
  MailDispatch,
  Observability,
  RateLimits,
  Sessions,
  SignIn,
  SignUp,
  Tenant,
  Users,
  Verification,
  VerificationLink,
} from "@awthaq/core";
import { Defects, Hmac, Mailer, PasswordHasher, RateLimiter, SqlTransaction } from "@awthaq/ports";
import { SessionDelivery } from "@awthaq/server";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Mac from "effect/crypto/Mac";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as PasswordApi from "./PasswordApi.ts";
import { PasswordConfigScoped } from "./PasswordConfig.ts";
import * as PasswordCredential from "./PasswordCredential.ts";
import * as PasswordEvents from "./PasswordEvents.ts";

export { PasswordConfig, PasswordConfigScoped, config } from "./PasswordConfig.ts";
export type { PasswordConfigShape } from "./PasswordConfig.ts";

// ---- rate limits ------------------------------------------------------------------------------------

// BEH-EA-105/107/111, RBS-006: every password rate-limit rule, declared once. The static `rateLimits`
// listing is derived from this table and the layer registers it with `RateLimits.budget`, so what
// `plugin list --rules` prints is what is enforced. A rule's key reads only the small, secret-free
// input its endpoint names (`{ email }`, `{ identifier }`, `{ userId }`), never a request
// payload: a reset token plus the new password never becomes a "key" (ESS-005).
//
// CSD-006: two dimensions. Identity-keyed budgets bound brute force against one account; per-source
// budgets bound one origin spraying across many accounts. The per-source key is the request's own
// address, read from `Api.AuthRequestContext` (ADR-EA-047); an address that cannot be resolved shares a
// single "unknown" bucket rather than going unthrottled.
const minutes15 = Duration.minutes(15);

const rules = {
  signUp: RateLimits.rule({
    group: "password",
    endpoint: "signUp",
    key: RateLimits.Key.email,
    limit: 5,
    window: Duration.hours(1),
  }),
  // AGA-001/NHS-003: bounds mass account creation from one source independently of the (freely
  // chosen) email each attempt names.
  signUpByIp: RateLimits.rule({
    group: "password",
    endpoint: "signUp",
    key: RateLimits.Key.ip,
    limit: 20,
    window: Duration.hours(1),
  }),
  signIn: RateLimits.rule({
    group: "password",
    endpoint: "signIn",
    key: RateLimits.Key.email,
    limit: 5,
    window: minutes15,
  }),
  // RBS-001/CSD-002: the per-account budget above is keyed on an attacker-controlled email: an
  // attacker can burn a victim's 5 attempts to lock them out, and distributed spraying across many
  // distinct addresses never trips it at all. This per-IP rule bounds spraying independently of which
  // account is targeted; looser than the per-account limit so one shared office NAT can't lock out
  // every real user behind it.
  signInByIp: RateLimits.rule({
    group: "password",
    endpoint: "signIn",
    key: RateLimits.Key.ip,
    limit: 30,
    window: minutes15,
  }),
  requestReset: RateLimits.rule({
    group: "password",
    endpoint: "requestReset",
    key: RateLimits.Key.email,
    limit: 5,
    window: minutes15,
  }),
  // AGA-001/NHS-003: mirrors `signInByIp`: bounds one source spraying reset requests across many
  // distinct, unrelated emails.
  requestResetByIp: RateLimits.rule({
    group: "password",
    endpoint: "requestReset",
    key: RateLimits.Key.ip,
    limit: 30,
    window: minutes15,
  }),
  // Keyed on the token's decoded public id (never the token's secret half, and never the request
  // payload, which also carries the new password).
  confirmReset: RateLimits.rule({
    group: "password",
    endpoint: "confirmReset",
    key: RateLimits.Key.identifier,
    limit: 5,
    window: minutes15,
  }),
  // Plan 18 / APS-003: bounds one source driving the breach check and the claim across many
  // distinct, unrelated forged tokens. The numbers of `verifyEmailByIp`.
  confirmResetByIp: RateLimits.rule({
    group: "password",
    endpoint: "confirmReset",
    key: RateLimits.Key.ip,
    limit: 30,
    window: minutes15,
  }),
  // Shipping-gap map (.scratch/shipping-gaps), ticket 14. Keyed on the authenticated caller's user
  // id, mirroring its own posture.
  changePassword: RateLimits.rule({
    group: "password.account",
    endpoint: "changePassword",
    key: RateLimits.Key.user,
    limit: 5,
    window: minutes15,
  }),
  // Wayfinder ticket 15: mirrors `changePassword`, the identical authenticated-password-recheck shape.
  reauthenticate: RateLimits.rule({
    group: "password.account",
    endpoint: "reauthenticate",
    key: RateLimits.Key.user,
    limit: 5,
    window: minutes15,
  }),
  // Upstream-hardening ticket 04: tighter than the generic 5-per-15-min default: resend-verification
  // abuse is an inbox-flooding harassment vector against the *target*, not an account-takeover one.
  resendVerification: RateLimits.rule({
    group: "password",
    endpoint: "resendVerification",
    key: RateLimits.Key.email,
    limit: 3,
    window: minutes15,
  }),
  // MLO-003: without it one source could rotate across victims' addresses at 3 mails per 15 minutes
  // each with no per-source ceiling.
  resendVerificationByIp: RateLimits.rule({
    group: "password",
    endpoint: "resendVerification",
    key: RateLimits.Key.ip,
    limit: 20,
    window: minutes15,
  }),
  // APS-003: each failed `consume` publishes `auth.token.replay`; an unbounded flood of guesses is
  // hopeless against a 256-bit token but is pointless churn/log-spam. Same numbers as `confirmReset`,
  // its closest sibling.
  verifyEmail: RateLimits.rule({
    group: "password",
    endpoint: "verifyEmail",
    key: RateLimits.Key.identifier,
    limit: 5,
    window: minutes15,
  }),
  // Mirrors `signInByIp`/`requestResetByIp`: bounds one source spraying guesses across many
  // distinct, unrelated tokens/accounts.
  verifyEmailByIp: RateLimits.rule({
    group: "password",
    endpoint: "verifyEmail",
    key: RateLimits.Key.ip,
    limit: 30,
    window: minutes15,
  }),
  // BAM-009: the authenticated requester's own budget, keyed on their user id.
  changeEmail: RateLimits.rule({
    group: "password.account",
    endpoint: "changeEmail",
    key: RateLimits.Key.user,
    limit: 5,
    window: Duration.hours(1),
  }),
  // BAM-009: a signed-in account can name any address, so the *target* inbox is budgeted too: one
  // address cannot be mail-bombed with confirmation links by many accounts (same posture as
  // `resendVerification`, whose abuse is likewise harassment of the target).
  changeEmailTarget: RateLimits.rule({
    group: "password.account",
    endpoint: "changeEmail",
    key: RateLimits.Key.email,
    limit: 3,
    window: minutes15,
  }),
  // BAM-009: token-guess flood control, like `verifyEmail`'s pair (keyed on the token's public id and
  // on the source).
  confirmEmailChange: RateLimits.rule({
    group: "password",
    endpoint: "confirmEmailChange",
    key: RateLimits.Key.identifier,
    limit: 5,
    window: minutes15,
  }),
  confirmEmailChangeByIp: RateLimits.rule({
    group: "password",
    endpoint: "confirmEmailChange",
    key: RateLimits.Key.ip,
    limit: 30,
    window: minutes15,
  }),
};

export interface PasswordShape {
  /** BEH-EA-113: creates the user, links a password credential, issues a session, and dispatches (never awaits) a verification mail. */
  readonly signUp: (input: {
    readonly email: string;
    readonly password: Redacted.Redacted<string>;
  }) => Effect.Effect<
    Sessions.IssuedSession,
    | PasswordApi.WeakPassword
    | PasswordApi.EmailAlreadyExists
    | Api.RateLimited
    | HookPoint.HookAborted
    | Hooks.TwoFactorRequired
    | Errors.StoreUnavailable,
    Api.AuthRequestContext
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
  }) => Effect.Effect<
    void,
    PasswordApi.WeakPassword | Api.RateLimited | HookPoint.HookAborted | Errors.StoreUnavailable,
    Api.AuthRequestContext
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
  }) => Effect.Effect<
    Sessions.IssuedSession,
    | Api.InvalidCredentials
    | PasswordApi.EmailNotVerified
    | Users.UserSuspended
    | Api.RateLimited
    | HookPoint.HookAborted
    | Hooks.TwoFactorRequired
    | Errors.StoreUnavailable,
    Api.AuthRequestContext
  >;
  /** BEH-EA-064/117: identical response whether or not `email` resolves to an account — the caller (the HTTP handler) always answers 202. */
  readonly requestReset: (input: {
    readonly email: string;
  }) => Effect.Effect<void, Api.RateLimited | Errors.StoreUnavailable, Api.AuthRequestContext>;
  /**
   * Upstream-hardening ticket 04: identical response whether `email`
   * doesn't exist, the account is already verified, or a mail genuinely
   * goes out — same enumeration-safe shape as `requestReset`.
   */
  readonly resendVerification: (input: {
    readonly email: string;
  }) => Effect.Effect<void, Api.RateLimited | Errors.StoreUnavailable, Api.AuthRequestContext>;
  /** BEH-EA-117: consumes the reset token and sets the new password in one call, then revokes every other session. */
  readonly confirmReset: (input: {
    readonly token: Redacted.Redacted<string>;
    readonly password: Redacted.Redacted<string>;
    /** ARF-005: a TOTP or recovery code — needed only when a `BeforeCredentialReset` tap (the two-factor plugin) demands one. */
    readonly secondFactorCode?: Redacted.Redacted<string>;
  }) => Effect.Effect<
    void,
    | PasswordApi.TokenConsumed
    | PasswordApi.WeakPassword
    | PasswordApi.SecondFactorRequired
    | HookPoint.HookAborted
    | Api.RateLimited
    | Errors.StoreUnavailable,
    Api.AuthRequestContext
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
  }) => Effect.Effect<
    void,
    PasswordApi.TokenConsumed | Api.RateLimited | Errors.StoreUnavailable,
    Api.AuthRequestContext
  >;
  /**
   * BAM-009: starts an address change for the signed-in user: mails a `change-email`
   * token (`EmailChange`, the purpose an administrator's `setUserEmail` shares) to
   * `newEmail` and changes nothing yet. The requester is authenticated, so a mail
   * failure is surfaced as `EmailDeliveryFailed`; the same address as the current one
   * is a no-op; a taken address is not revealed here (see `confirmEmailChange`).
   */
  readonly requestEmailChange: (input: {
    readonly userId: Users.UserId;
    /** BEH-EA-320: the caller's own session; it must have proved a credential within `PasswordConfig.reauthMaxAge`. */
    readonly currentSessionId: Sessions.SessionId;
    readonly newEmail: string;
  }) => Effect.Effect<
    void,
    | PasswordApi.PasswordReauthRequired
    | PasswordApi.EmailChangeNotSupported
    | PasswordApi.EmailDeliveryFailed
    | Api.RateLimited
    | Errors.StoreUnavailable
  >;
  /**
   * BAM-009/BEH-EA-058: consumes a `change-email` token and, in the same transaction,
   * replaces the account's address (`Users.changeEmail`) and marks it verified — the
   * token's delivery to the new mailbox is the proof. Publishes `auth.user.emailChanged`
   * after the commit and tells the *previous* address about it (dispatched, never awaited).
   */
  readonly confirmEmailChange: (input: {
    readonly token: Redacted.Redacted<string>;
  }) => Effect.Effect<
    void,
    | PasswordApi.TokenConsumed
    | PasswordApi.EmailAlreadyExists
    | Api.RateLimited
    | Errors.StoreUnavailable,
    Api.AuthRequestContext
  >;
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
  }) => Effect.Effect<
    Sessions.IssuedSession,
    | PasswordApi.WrongPassword
    | PasswordApi.WeakPassword
    | Api.RateLimited
    | Errors.StoreUnavailable,
    Api.AuthRequestContext
  >;
  /**
   * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
   * (AAPS-001): re-verifies `currentPassword` and, on success, calls
   * `Sessions.reauthenticate(userId, currentSessionId)` — refreshes the session's
   * own `authenticatedAt` without superseding it (distinct from
   * `changePassword`, which mints a fresh session because the credential
   * itself changed).
   */
  readonly reauthenticate: (input: {
    readonly userId: Users.UserId;
    readonly currentSessionId: Sessions.SessionId;
    readonly currentPassword: Redacted.Redacted<string>;
  }) => Effect.Effect<
    void,
    PasswordApi.WrongPassword | Api.RateLimited | Api.Unauthenticated | Errors.StoreUnavailable
  >;
}

// MLO-009: the mailed token's codec is `VerificationLink`'s, shared with every
// plugin that mails a `Verification` token; these are this plugin's purposes.
const ResetLink = VerificationLink.forUser({ name: "reset-password" });
const VerifyLink = VerificationLink.forUser({ name: "verify-email" });
const VERIFY_TTL = Duration.hours(24);

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
    // EP-007: the enumeration posture is per tenant too — decided in the request's own fiber.
    const configNow = yield* Tenant.inForce(PasswordConfigScoped);

    // ADR-EA-047: no handler reads the address or the user agent. The group declares `Api.RequestContext`, so every
    // operation below records and keys on the request's facts through `Api.AuthRequestContext`.
    return handlers.handleAll({
      signUp: Effect.fnUntraced(function* ({ payload }: { payload: PasswordApi.SignUpPayload }) {
        // TMS-005: `conceal` answers 202 with no session for a fresh and an
        // existing address alike (ADR-EA-026). It mints nothing, so it declines the
        // `Mints` declaration; the marker validated the delivery header before this ran.
        if ((yield* configNow).signUpEnumeration === "conceal") {
          yield* SessionDelivery.decline(SessionLifecycle.MintGrant);
          return yield* password.signUpConcealed(payload);
        }
        // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
        const response: SessionContract.SessionDto = yield* SessionDelivery.respond(
          password.signUp(payload),
        );
        return response;
      }),

      signIn: Effect.fnUntraced(function* ({ payload }: { payload: PasswordApi.SignInPayload }) {
        // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
        const response: SessionContract.SessionDto = yield* SessionDelivery.respond(
          password.signIn(payload),
        );
        return response;
      }),

      requestReset: ({ payload }: { payload: PasswordApi.RequestResetPayload }) =>
        password.requestReset(payload),

      resendVerification: ({ payload }: { payload: PasswordApi.ResendVerificationPayload }) =>
        password.resendVerification(payload),

      confirmReset: ({ payload }: { payload: PasswordApi.ConfirmResetPayload }) =>
        password.confirmReset(payload),

      verifyEmail: ({ payload }: { payload: PasswordApi.VerifyEmailPayload }) =>
        password.verifyEmail(payload),

      confirmEmailChange: ({ payload }: { payload: PasswordApi.ConfirmEmailChangePayload }) =>
        password.confirmEmailChange(payload),
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

    return handlers.handleAll({
      changePassword: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: PasswordApi.ChangePasswordPayload;
      }) {
        const { userId, sessionId } = yield* CurrentUser.current;
        // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
        const response: SessionContract.SessionDto = yield* SessionDelivery.respond(
          password.changePassword({
            userId: userId,
            currentSessionId: sessionId,
            currentPassword: payload.currentPassword,
            newPassword: payload.newPassword,
          }),
        );
        return response;
      }),

      changeEmail: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: PasswordApi.ChangeEmailPayload;
      }) {
        const { userId, sessionId } = yield* CurrentUser.current;
        yield* password.requestEmailChange({
          userId: userId,
          currentSessionId: sessionId,
          newEmail: payload.newEmail,
        });
      }),

      reauthenticate: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: PasswordApi.ReauthenticatePayload;
      }) {
        const { userId, sessionId } = yield* CurrentUser.current;
        yield* password.reauthenticate({
          userId: userId,
          currentSessionId: sessionId,
          currentPassword: payload.password,
        });
      }),
    });
  }),
);

export class Password extends AuthPlugin.Service<Password, PasswordShape>()("password", {
  apiVersion: 1,
  contract: PasswordApi.PasswordApi,
  // PV-241: the typed rule table; the static `rateLimits` listing is derived from it (a configured
  // email-key normaliser changes a bucket's key, never a rule's number).
  rateLimitRules: rules,
  // BEH-EA-044: a password credential is an ordinary `accounts` row — this
  // plugin owns no table of its own, so there is nothing to declare here.
  tables: {},
  // ADR-EA-049: the events this plugin publishes, defined in `PasswordEvents.ts`.
  events: PasswordEvents.events,
  // ECS-008/BEH-EA-229: the policy knobs `doctor` audits and `config list` prints.
  config: [
    ConfigDescriptor.make(PasswordConfigScoped, {
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
    ports: [
      Mailer.Mailer,
      PasswordHasher.PasswordHasher,
      RateLimiter.RateLimiter,
      SqlTransaction.SqlTransaction,
    ],
    // ADR-EA-040 (plan 27): the password credential, built once beneath `make`, for this plugin
    // and the trusted dependents that list `Password` in `dependsOn`.
    exposes: {
      services: [PasswordCredential.PasswordCredential],
      layer: PasswordCredential.PasswordCredential.layer,
    },
    handlers: Layer.mergeAll(PasswordHandlers, PasswordAccountHandlers),
    make: Effect.gen(function* () {
      const credential = yield* PasswordCredential.PasswordCredential;
      const sqlTransaction = yield* SqlTransaction.SqlTransaction;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const verification = yield* Verification.Verification;
      const mailer = yield* Mailer.Mailer;
      const events = yield* AuthEvents.AuthEvents;
      // EP-007 (ADR-EA-018 Decision 8): the policy in force is decided per operation, so a
      // tenant's `Password.config(...)` provided in the calling fiber applies to that request;
      // with none, the build-time value applies exactly as before. What is derived once at boot
      // from the *built* value stays boot-scoped: the rate-limit email-key function and the
      // identifier-digest key (the calibrated timing floor is `PasswordCredential`'s).
      const configNow = yield* Tenant.inForce(PasswordConfigScoped);
      // read once at build: the build value (BEH-EA-355 boot fields)
      const builtConfig = yield* configNow;
      const random = yield* SecureRandom.SecureRandom;
      const mac = yield* Mac.Mac;
      // ERS-002: mail is dispatched in the background (BEH-EA-064/113) by a
      // dispatcher this layer owns — supervised, retried, bounded, observable
      // and drained on shutdown — in place of unowned `forkDetach` fibers.
      const mailDispatcher = yield* MailDispatch.make;
      // CSD-004: a keyed, non-reversible digest of the *attempted* identifier,
      // for the failure event. Computed identically for a real and a
      // nonexistent account, so it is no existence oracle; keyed so it cannot
      // be dictionary-reversed from the audit table.
      const digestKey = Option.isSome(builtConfig.identifierDigestKey)
        ? new TextEncoder().encode(Redacted.value(builtConfig.identifierDigestKey.value))
        : yield* random.randomBytes(32);
      const identifierDigest = (email: string) =>
        Hmac.hmacSha256(
          mac,
          digestKey,
          new TextEncoder().encode(`signin-identifier:${builtConfig.rateLimitEmailKey(email)}`),
        ).pipe(Effect.map(Hmac.toHex), Effect.orDie);
      /**
       * EOTS-001: every operation is one `awthaq.password.<operation>` span
       * (`awthaq.plugin`, `auth.strategy`); the handlers annotate `user.id` once the
       * user is known. Never the email, the password or a token.
       */
      const traced =
        <Args extends ReadonlyArray<unknown>, A, E, R>(
          operation: string,
          run: (...args: Args) => Effect.Effect<A, E, R>,
        ) =>
        (...args: Args) =>
          run(...args).pipe(
            Observability.authSpan(`awthaq.password.${operation}`, {
              "awthaq.plugin": "password",
              [Observability.Field.strategy]: "password",
            }),
          );
      // AOMS-006/BCR-004 (.issues/high, wayfinder ticket 03): the mechanism
      // an Auth0-Rule-style sign-up policy, and the MFA divert point a
      // future `TwoFactor` plugin taps, both attach through.
      const completion = yield* SignIn.make;
      /**
       * ALF-003/CSD-004: the failure signal, with the two dimensions a stuffing detector keys on. Core's
       * `SignIn.failed` publishes it and stamps the request's address (ADR-EA-047); this adds the digest.
       */
      const publishSignInFailed = Effect.fnUntraced(function* (
        reason: "invalidCredentials" | "emailNotVerified",
        input: { readonly email: string },
      ) {
        yield* completion.failed({
          strategy: "password",
          reason,
          identifierDigest: yield* identifierDigest(input.email),
        });
      });
      const creation = yield* SignUp.make;
      // ARF-005: consulted by `confirmReset` inside its transaction (the two-factor plugin taps it).
      const beforeCredentialReset = yield* Hooks.BeforeCredentialReset;

      // RBS-006: the table above feeds both the registry (BEH-EA-107/110/111 introspection) and the
      // enforcement calls below. EOTS-007: a breach is published, logged and counted, and answers
      // `Api.RateLimited`. The email normaliser is boot-scoped, like the digest key.
      const limits = yield* RateLimits.budget(Password, {
        emailKey: builtConfig.rateLimitEmailKey,
      });

      /** Issues a verify-email token and mails it; dispatched, never awaited. */
      const dispatchVerificationMail = Effect.fnUntraced(function* (user: Users.UserRecord) {
        // Read here, in the request's fiber: the dispatched work runs detached from it (EP-007).
        const config = yield* configNow;
        return yield* mailDispatcher.dispatch(
          { template: "verify-email", userId: user.id },
          Effect.gen(function* () {
            const issued = yield* VerificationLink.issue({ verification, random }, VerifyLink, {
              ttl: VERIFY_TTL,
              userId: user.id,
            });
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
      });

      /**
       * The checks `signUp` and `signUpConcealed` share, in the same order: rate limits, the
       * password policy, the `BeforeSignUp` veto, then the hash (`linkFor`). The credential is
       * linked inside the sign-up's own unit; its subject is the new user's id.
       */
      const prepareSignUp = Effect.fnUntraced(function* (input: {
        readonly email: string;
        readonly password: Redacted.Redacted<string>;
      }) {
        // AGA-001/NHS-003: per-IP first, cheaper to enforce, bounds mass
        // account creation from one source before the per-email check.
        yield* limits.spend(["signUpByIp", "signUp"], input);
        const password = yield* credential.accept(input.password);
        // BEH-EA-113's own sketch has no `name` input at all — a `User`
        // record requires one (BEH-EA-041), so the email's local part is
        // used as a placeholder the user can change later via
        // `updateProfile`.
        const name = input.email.split("@")[0] ?? input.email;
        // AOMS-006: an Auth0-Rule-style policy (e.g. an email-domain
        // allow-list) may reject the sign-up outright, or amend the input
        // for whatever taps run after it — before the (comparatively
        // expensive) password hash is even computed (ADR-EA-026).
        const vetted = yield* creation.vet({
          identity: { _tag: "Email", email: input.email },
          name,
          strategy: "password",
        });
        // TMS-005: the hash runs here, before the unit, in both enumeration branches.
        const link = yield* credential.linkFor(password);
        return { vetted, link };
      });

      const signUp: PasswordShape["signUp"] = Effect.fnUntraced(function* (input) {
        const { vetted, link } = yield* prepareSignUp(input);

        // RRC-002/BEH-EA-113: "MUST create the user and session in one transaction". ADR-EA-038:
        // `createSignedIn` is that unit, and the first session is a cleared sign-in like any other
        // (the sign-in veto and divert apply, `auth.user.signedIn` is published).
        const issued = yield* creation
          .createSignedIn(vetted, { link, amr: ["pwd"] })
          .pipe(
            Effect.catchTag("SignUp/IdentityTaken", (taken) =>
              taken.kind === "Email"
                ? Effect.fail(new PasswordApi.EmailAlreadyExists())
                : Defects.invariantViolation("PasswordSignUpConflict", taken.message),
            ),
          );

        // BEH-EA-113: dispatched, never awaited — response latency must
        // not depend on mail-provider latency, and per
        // research/05-oauth-oidc.md Q48, a slow-vs-fast response is
        // itself an enumeration side channel.
        const user = yield* users
          .findById(issued.session.userId)
          .pipe(Effect.catchTag("UserNotFound", Effect.die));
        yield* dispatchVerificationMail(user);

        return issued;
      });

      const signUpConcealed: PasswordShape["signUpConcealed"] = Effect.fnUntraced(
        function* (input) {
          const { vetted, link } = yield* prepareSignUp(input);
          // TMS-005: the hash above is computed in both branches, so the
          // expensive work does not depend on whether the address exists. A
          // duplicate is caught as a value, and no session is issued either way.
          const created = yield* creation.create(vetted, { link }).pipe(
            Effect.map(Option.some),
            Effect.catchTag("SignUp/IdentityTaken", (taken) =>
              taken.kind === "Email"
                ? Effect.succeed(Option.none<Users.UserRecord>())
                : Defects.invariantViolation("PasswordSignUpConflict", taken.message),
            ),
          );
          if (Option.isSome(created)) {
            yield* dispatchVerificationMail(created.value);
            return;
          }
          // The address is taken: tell its owner (no token, nothing to act on),
          // looked up inside the background work so the response path is the same.
          yield* mailDispatcher.dispatch(
            { template: "account-exists" },
            Effect.gen(function* () {
              const owner = yield* users.findByEmail(
                vetted.identity._tag === "Email" ? vetted.identity.email : input.email,
              );
              if (Option.isNone(owner)) return;
              const to = Users.emailOf(owner.value);
              if (Option.isNone(to)) return;
              yield* mailer.send({ to: to.value, template: "account-exists" });
            }),
          );
        },
      );

      const signIn: PasswordShape["signIn"] = Effect.fnUntraced(function* (input) {
        const config = yield* configNow;
        // RBS-001/CSD-002: the per-IP budget runs first — cheaper to
        // enforce (no DB lookup) and bounds a distributed spray across
        // many distinct emails before the per-account check below ever
        // sees them.
        yield* limits.spend(["signInByIp", "signIn"], input);
        // BEH-EA-114/TSS-006: the lookup and the verify, one answer for every refusal, held to the floor.
        const verdict = yield* credential.verify(users.findByEmail(input.email), input.password);
        if (verdict._tag === "Refused") {
          // ALF-003: the one forensic signal a brute-force/credential-
          // stuffing campaign otherwise leaves nowhere — see
          // `UserSignInFailedEvent`'s own doc comment for why this
          // carries no `userId`/email despite the wire response's own
          // uniform-response discipline not applying here.
          yield* publishSignInFailed("invalidCredentials", input);
          return yield* Effect.fail(new Api.InvalidCredentials());
        }
        const user = verdict.claimant;
        // EOTS-001: the credential is proven, so the span may name the user (an id, never the email).
        yield* Effect.annotateCurrentSpan("user.id", user.id);

        // Upstream-hardening ticket 04: checked only now that a genuinely
        // correct password is confirmed — never before, so this can't be
        // used to probe whether a guessed password is even close to right.
        if (config.requireVerifiedEmail && !Users.isEmailVerified(user)) {
          yield* publishSignInFailed("emailNotVerified", input);
          return yield* Effect.fail(new PasswordApi.EmailNotVerified());
        }

        // BEH-EA-116: after the verified-email gate, on the proof `verify` minted.
        yield* credential.rehashIfStale(verdict.proof);

        // ADR-EA-038: the credential is proven, so core's sign-in takes over: the suspension gate
        // (published as `signInFailed{suspended}`), the `BeforeSignIn` veto (NAM-002), the MFA
        // divert (BCR-004/THS-002), the session and its announcement. An erasure can run between
        // the proof and here; the user is then refused like any wrong credential.
        return yield* completion
          .complete({ userId: user.id, strategy: "password", amr: ["pwd"] })
          .pipe(
            Effect.catchTag("SignIn/UserGone", () =>
              publishSignInFailed("invalidCredentials", input).pipe(
                Effect.andThen(Effect.fail(new Api.InvalidCredentials())),
              ),
            ),
          );
      });

      const requestReset: PasswordShape["requestReset"] = Effect.fnUntraced(function* (input) {
        const config = yield* configNow;
        // AGA-001/NHS-003: per-IP first, bounds one source spraying
        // reset requests across many distinct, unrelated emails.
        yield* limits.spend(["requestResetByIp", "requestReset"], input);
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
          // ARF-006: the earliest takeover signal, published from *inside* the
          // detached branch (an audit write on the response path would make an
          // existing account slower than an unknown one) and at most once even
          // if the mail work is retried.
          const announced = Ref.makeUnsafe(false);
          yield* mailDispatcher.dispatch(
            { template: "reset-password", userId: user.id },
            Effect.gen(function* () {
              if (!(yield* Ref.getAndSet(announced, true))) {
                yield* events.emit(PasswordEvents.PasswordResetRequestedEvent, { userId: user.id });
              }
              // ARF-004: an OAuth-/passkey-only account has no password to
              // reset — a token would only lead to a dead link. Looked up
              // here, inside the dispatched work, so both branches still cost
              // the same on the response path (BEH-EA-064).
              const to = Users.emailOf(user);
              if (Option.isNone(to)) return;
              if (!(yield* credential.has(user.id))) {
                yield* mailer.send({ to: to.value, template: "reset-password-unavailable" });
                return;
              }
              const issued = yield* VerificationLink.issue({ verification, random }, ResetLink, {
                ttl: config.resetTtl,
                userId: user.id,
              });
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
          yield* limits.spend(["resendVerificationByIp", "resendVerification"], input);
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

      // ADR-EA-039 decision 9: each link purpose is bound once, with both budgets declared. The
      // source budget is spent before the token is decoded (APS-003: a flood of garbage tokens
      // never reaches the store, nor `confirmReset`'s breach-check network call); the token budget is
      // keyed on the public id, which names no user (ARF-009).
      const resetLinks = VerificationLink.redeemer(ResetLink, {
        verification,
        budget: {
          source: limits.spend("confirmResetByIp"),
          token: (publicId) => limits.spend("confirmReset", { identifier: publicId }),
        },
      });
      const verifyLinks = VerificationLink.redeemer(VerifyLink, {
        verification,
        budget: {
          source: limits.spend("verifyEmailByIp"),
          token: (publicId) => limits.spend("verifyEmail", { identifier: publicId }),
        },
      });
      const emailChangeLinks = VerificationLink.redeemer(EmailChange.Link, {
        verification,
        budget: {
          source: limits.spend("confirmEmailChangeByIp"),
          token: (publicId) => limits.spend("confirmEmailChange", { identifier: publicId }),
        },
      });

      /** ARF-008/FAMS-002: the link proved the mailbox; a missing user is an invariant, an identity mismatch a defect. */
      const proveMailbox = (userId: Users.UserId, invariant: string) =>
        users.verifyEmail(userId).pipe(
          Effect.catchTags({
            UserNotFound: () => Defects.invariantViolation(invariant, `awthaq: ${invariant}`),
            IdentityMismatch: Effect.die,
          }),
        );

      const refusedToken = () => Effect.fail(new PasswordApi.TokenConsumed());

      const confirmReset: PasswordShape["confirmReset"] = Effect.fnUntraced(function* (input) {
        // ARF-001: BEH-EA-058/117 require consuming the token, setting the new password, and
        // revoking every other session to commit as one unit. `Verification.redeem` owns that
        // transaction (ADR-EA-039) and `resetLinks` the order around it: source budget, purpose
        // check, token budget, then the policy below, then the claim. A refusal inside `use` (a
        // veto, `SecondFactorRequired`, a crash) gives the token back; an outage of the
        // transaction itself is the typed `StoreUnavailable` (ADR-EA-028), never a defect.
        //
        // The policy's verdict, decided in `beforeClaim` (before the token is touched) and written
        // in `use` (once it is consumed). The redeemer always runs `beforeClaim` first.
        const accepted = yield* Deferred.make<PasswordCredential.Accepted>();
        const userId = yield* resetLinks(
          { token: input.token },
          ({ userId }) =>
            Effect.gen(function* () {
              // ARF-005 (BEH-EA-259): mailbox possession alone must not rewrite the credential of
              // an account a second factor protects. The veto runs inside this transaction, after
              // the token is consumed and before anything is changed, so a refusal rolls the
              // consume back (SQL) and nothing is written. `TWO_FACTOR_REQUIRED` gets its own typed
              // error clients can branch on; any other code is the generic `HookAborted`.
              yield* beforeCredentialReset
                .run({
                  userId,
                  ...(input.secondFactorCode === undefined
                    ? {}
                    : { secondFactorCode: input.secondFactorCode }),
                })
                .pipe(
                  Effect.catchTag("HookAbort", (abort) =>
                    Effect.fail(
                      abort.code === "TWO_FACTOR_REQUIRED"
                        ? new PasswordApi.SecondFactorRequired()
                        : new HookPoint.HookAborted({
                            point: Hooks.BeforeCredentialReset.id,
                            code: abort.code,
                            message: abort.message,
                          }),
                    ),
                  ),
                );

              // ARF-004: `requestReset` mints no token for a credential-less account, but one issued
              // before that fix (or a credential unlinked since) can still land here: a dead token,
              // not a defect. The new password is hashed only now that the token is consumed, so an
              // unknown token costs no KDF. An outage is `StoreUnavailable` (503, ADR-EA-028) and
              // rolls the consume back.
              if (!(yield* credential.replace(userId, yield* Deferred.await(accepted)))) {
                return yield* Effect.fail(new PasswordApi.TokenConsumed());
              }

              // ARF-008: consuming a token mailed to the address proves the same mailbox control
              // `verifyEmail` demands: otherwise a user who resets is still refused at `signIn`.
              yield* proveMailbox(userId, "ResetTokenUserMissing");

              // BEH-EA-117: every session, no exceptions — the caller
              // isn't authenticated at all here, so there is no "current"
              // session to keep. Upstream-hardening ticket 02: the real
              // `revokeAll` primitive, retiring the empty-string-id
              // `revokeOthers` trick this call site used to stand in for
              // it.
              // ESA-006/TIR-008: `Sessions.revokeAll` itself publishes the
              // `auth.session.revoked` (reason `passwordReset`): its audit row joins
              // this transaction, and its bus copy is released only when it commits
              // (ADR-EA-037).
              yield* sessions.revokeAll(userId, "passwordReset");
              return userId;
            }),
          {
            // ARF-002: the policy (including the breach check's network call) is decided before
            // the token is touched, so a weak password never burns the single-use token under any
            // `Verification` store, and no network I/O happens while the transaction is open.
            beforeClaim: credential.accept(input.password).pipe(
              Effect.flatMap((password) => Deferred.succeed(accepted, password)),
              Effect.asVoid,
            ),
          },
        ).pipe(Effect.catchTag("VerificationLink/Refused", refusedToken));
        // ALF-004: published only after the transaction above has actually committed, mirroring
        // `signUp`'s own `auth.user.created` placement, never inside the transaction itself.
        yield* events.emit(PasswordEvents.PasswordResetCompletedEvent, { userId });
      });

      const verifyEmail: PasswordShape["verifyEmail"] = Effect.fnUntraced(function* (input) {
        // RRC-002: `Verification.redeem` closes the consume-then-apply atomicity gap (ADR-EA-039).
        // A missing user is a defect, not a request-level condition: this token was only ever
        // issued right after `signUp` created this exact user (BEH-EA-113).
        const verifiedUserId = yield* verifyLinks(input, ({ userId }) =>
          proveMailbox(userId, "VerifyEmailTokenUserMissing").pipe(Effect.as(userId)),
        ).pipe(Effect.catchTag("VerificationLink/Refused", refusedToken));
        // ARF-006: after the commit, like `resetCompleted`.
        yield* events.emit(PasswordEvents.UserEmailVerifiedEvent, { userId: verifiedUserId });
      });

      const requestEmailChange: PasswordShape["requestEmailChange"] = Effect.fnUntraced(
        function* (input) {
          const config = yield* configNow;
          // The requester's own budget, then the target inbox's (see the rules' comments).
          yield* limits.spend("changeEmail", input);
          // BEH-EA-320: the shared fresh-session gate; a stale one never reaches the target inbox's budget.
          yield* sessions
            .requireFresh(input.userId, input.currentSessionId, config.reauthMaxAge)
            .pipe(
              Effect.catchTag("Sessions/Stale", (stale) =>
                Effect.fail(
                  new PasswordApi.PasswordReauthRequired({ maxAgeSeconds: stale.maxAgeSeconds }),
                ),
              ),
            );
          yield* limits.spend("changeEmailTarget", { email: input.newEmail });
          const user = yield* users.findById(input.userId).pipe(
            Effect.catchTag("UserNotFound", () =>
              // The caller's session was proven live by `Authentication` a moment ago.
              Defects.invariantViolation(
                "ChangeEmailUserMissing",
                "awthaq: change-email's own authenticated user is missing",
              ),
            ),
          );
          const current = Users.emailOf(user);
          if (Option.isNone(current)) {
            return yield* Effect.fail(new PasswordApi.EmailChangeNotSupported());
          }
          // `Users` stores addresses lower-cased (BEH-EA-041): the same address in another case is no change.
          if (current.value.toLowerCase() === input.newEmail.toLowerCase()) return;
          yield* EmailChange.request(
            { verification, random, mailer },
            { userId: input.userId, newEmail: input.newEmail, link: config.links.changeEmail },
          ).pipe(
            Effect.catchTag("MailDeliveryFailed", () => new PasswordApi.EmailDeliveryFailed()),
          );
        },
      );

      const confirmEmailChange: PasswordShape["confirmEmailChange"] = Effect.fnUntraced(
        function* (input) {
          // BEH-EA-058: the token's consumption, the address replacement and its verification
          // commit together: a conflict on the new address rolls the consumption back too.
          const changed = yield* emailChangeLinks(input, ({ userId, payload }) =>
            Effect.gen(function* () {
              // An account deleted (or turned phone-only) since the token was issued: a dead token.
              const before = yield* users
                .findById(userId)
                .pipe(Effect.catchTag("UserNotFound", () => new PasswordApi.TokenConsumed()));
              yield* users.changeEmail(userId, payload.newEmail).pipe(
                Effect.catchTags({
                  UserNotFound: () => new PasswordApi.TokenConsumed(),
                  IdentityMismatch: () => new PasswordApi.TokenConsumed(),
                  "Users/EmailAlreadyExists": () => new PasswordApi.EmailAlreadyExists(),
                }),
              );
              // Delivery to the new mailbox is the proof `verifyEmail` demands.
              yield* proveMailbox(userId, "ChangeEmailUserMissing");
              // BEH-EA-053: an email change is a privilege change. The confirming request is the
              // mailed link — possibly opened in another browser, with no session of its own — so
              // there is no caller session to rotate: every session of the account ends, in the
              // same transaction, and the owner signs in afresh under the new address.
              yield* sessions.revokeAll(userId, "emailChanged");
              return { userId, previous: Users.emailOf(before) };
            }),
          ).pipe(Effect.catchTag("VerificationLink/Refused", refusedToken));
          yield* events.emit(PasswordEvents.UserEmailChangedEvent, { userId: changed.userId });
          // The previous address learns of the change (a takeover signal) — dispatched, never
          // awaited, and carrying nothing but the template.
          if (Option.isSome(changed.previous)) {
            const to = changed.previous.value;
            yield* mailDispatcher.dispatch(
              { template: "email-changed", userId: changed.userId },
              mailer.send({ to, template: "email-changed" }),
            );
          }
        },
      );

      const changePassword: PasswordShape["changePassword"] = Effect.fnUntraced(function* (input) {
        // Keyed on `userId` directly — this endpoint is authenticated, so
        // (unlike `signIn`/`requestReset`) there's no need to look up an
        // email first.
        yield* limits.spend("changePassword", input);
        // BEH-EA-114/TSS-006: the same uniform cost as `signIn`, though this endpoint is
        // authenticated: a caller with no password credential cannot tell "no password set" from
        // "wrong password" by timing either.
        const verdict = yield* credential.verify(
          Effect.succeedSome({ id: input.userId }),
          input.currentPassword,
        );
        if (verdict._tag === "Refused") return yield* Effect.fail(new PasswordApi.WrongPassword());

        // Outside the unit: the breach check is a network call (BEH-EA-117).
        const password = yield* credential.accept(input.newPassword);
        // BEH-EA-053: the new hash, the revocation of every other session and the rotation of the
        // caller's own commit together, so a failure part-way leaves no session alive under a
        // password it did not prove. The events are released when the unit commits (ADR-EA-037).
        return yield* sqlTransaction
          .withTransaction(
            Effect.gen(function* () {
              // A credential unlinked since it was verified is the same answer as none at all.
              if (!(yield* credential.replace(input.userId, password))) {
                return yield* Effect.fail(new PasswordApi.WrongPassword());
              }
              yield* events.publish({ _tag: "auth.password.changed", userId: input.userId });
              // Every *other* session first, while `currentSessionId` still names a live row; then
              // that row is superseded by a fresh one (the other order leaves `revokeOthers`
              // nothing to keep).
              yield* sessions.revokeOthers(input.userId, input.currentSessionId, "passwordChanged");
              return yield* sessions.issue({
                userId: input.userId,
                supersedes: input.currentSessionId,
                amr: ["pwd"],
              });
            }),
          )
          // ADR-EA-028: the transaction's own failure is an outage (503), never a defect.
          .pipe(Effect.catchTag("SqlError", Errors.storeUnavailable("Password.changePassword")));
      });

      const reauthenticate: PasswordShape["reauthenticate"] = Effect.fnUntraced(function* (input) {
        // Keyed on `userId` directly — this endpoint is authenticated,
        // mirroring `changePassword`'s own posture.
        yield* limits.spend("reauthenticate", input);
        // BEH-EA-114/TSS-006: the same uniform cost as `changePassword`.
        const verdict = yield* credential.verify(
          Effect.succeedSome({ id: input.userId }),
          input.currentPassword,
        );
        if (verdict._tag === "Refused") return yield* Effect.fail(new PasswordApi.WrongPassword());
        // BEH-EA-319: the middleware proved this session live before the password
        // hash ran; if it ended since (revoked, superseded, expired), the caller
        // is no longer authenticated: 401, the same answer a session revoked
        // between verify and read gets elsewhere (EHA-009).
        yield* sessions
          .reauthenticate(input.userId, input.currentSessionId, ["pwd"])
          .pipe(Effect.catchTag("Sessions/NotFound", () => Effect.fail(new Api.Unauthenticated())));
      });

      return Password.of({
        signUp: traced("signUp", signUp),
        signUpConcealed: traced("signUpConcealed", signUpConcealed),
        signIn: traced("signIn", signIn),
        requestReset: traced("requestReset", requestReset),
        resendVerification: traced("resendVerification", resendVerification),
        confirmReset: traced("confirmReset", confirmReset),
        verifyEmail: traced("verifyEmail", verifyEmail),
        requestEmailChange: traced("requestEmailChange", requestEmailChange),
        confirmEmailChange: traced("confirmEmailChange", confirmEmailChange),
        changePassword: traced("changePassword", changePassword),
        reauthenticate: traced("reauthenticate", reauthenticate),
      });
    }),
  });
}
