// @awthaq/two-factor — TwoFactor
//
// THS-001 steps 6, 9-11; AOMS-003, ARF-005 (BEH-EA-233 to BEH-EA-239, wayfinder ticket 05 §1-§2).
// The plugin: TOTP two-factor authentication with hashed recovery codes, attached to the divert
// point ticket 03 seeded (`Hooks.BeforeSessionIssue`) and the reset veto ticket 05 §2 adds
// (`Hooks.BeforeCredentialReset`).
//
// **The gates are separate layers, and the plugin refuses to build without them.** A tap is a layer
// that requires its hook point, and a point's tap list freezes at its first run (BEH-EA-024), so
// the taps cannot be folded into `TwoFactor.layer` without ordering hazards; they ship as
// `sessionGate` and `credentialResetGate`. Forgetting one would be a silent MFA bypass — every
// first-factor flow would issue a session, or a stolen mailbox would reset the password — so
// `TwoFactor.layer` *requires* a marker service only its gate provides. Omitting a gate is a
// compile error (an unsatisfied requirement), not a runtime surprise. A composition with no
// password-reset flow says so explicitly with `noCredentialReset`.
//
// **Composition** (dependencies first, JH-006):
//
//   const Auth2 = Auth.make([Password, TwoFactor]);
//   // layers: SecondFactor.layer (over the stores, Encryption, PasswordHasher, Verification, ...),
//   //         TwoFactor.layer, sessionGate, credentialResetGate — plus HooksLive for the points.
//
// See `README.md` for the full recipe and `test/` for a working composition.

import { Api, SessionContract } from "@awthaq/api";
import {
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  DataExport,
  Erasure,
  Errors,
  HookPoint,
  Hooks,
  RateLimits,
  Sessions,
  Users,
} from "@awthaq/core";
import { ClientAddress, Defects, RateLimiter } from "@awthaq/ports";
import { SessionDelivery } from "@awthaq/server";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Headers from "effect/unstable/http/Headers";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { type TwoFactorMethodUsed, type VerifiedChallenge, verified } from "./Challenge.ts";
import { SecondFactor, type Purpose } from "./SecondFactor.ts";
import { TwoFactorConfig } from "./TwoFactorConfig.ts";
import * as TwoFactorApi from "./TwoFactorApi.ts";
import * as TwoFactorRateLimits from "./TwoFactorRateLimits.ts";
import { TwoFactorRecoveryCodes, TwoFactorSecrets, migrations } from "./TwoFactorStore.ts";

// ---- the markers: what makes forgetting a gate a compile error --------------------------------

/** Provided only by `sessionGate`; `TwoFactor.layer` requires it, so the plugin cannot be composed without the divert. */
export class TwoFactorGateInstalled extends Context.Service<
  TwoFactorGateInstalled,
  { readonly gate: "session" }
>()("awthaq/two-factor/GateInstalled") {}

/** Provided only by `credentialResetGate` (or the explicit `noCredentialReset`); `TwoFactor.layer` requires it. */
export class TwoFactorResetGuard extends Context.Service<
  TwoFactorResetGuard,
  { readonly guard: "credentialReset" | "notApplicable" }
>()("awthaq/two-factor/ResetGuard") {}

/**
 * The explicit statement that this composition has no password-reset flow to guard (no `Password`
 * plugin, or a host that disables reset). Provides the marker without tapping anything.
 */
export const noCredentialReset = Layer.succeed(TwoFactorResetGuard, { guard: "notApplicable" });

// ---- the service shape ---------------------------------------------------------------------------

export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

export interface Enrollment {
  readonly secret: string;
  readonly otpauthUri: string;
}

export interface TwoFactorShape {
  /** BEH-EA-236: needs a fresh session; stores a pending secret and returns it once. */
  readonly enable: (
    userId: Users.UserId,
    sessionId: string,
  ) => Effect.Effect<
    Enrollment,
    | TwoFactorApi.TwoFactorAlreadyEnabled
    | TwoFactorApi.TwoFactorReauthRequired
    | Api.RateLimited
    | Errors.StoreUnavailable
  >;
  /** BEH-EA-236/237: confirms with a first valid code, activates the factor and returns the recovery codes once. */
  readonly confirm: (
    userId: Users.UserId,
    code: Redacted.Redacted<string>,
  ) => Effect.Effect<
    ReadonlyArray<string>,
    | TwoFactorApi.InvalidTwoFactorCode
    | TwoFactorApi.TwoFactorNotEnabled
    | TwoFactorApi.TwoFactorAlreadyEnabled
    | TwoFactorApi.SecondFactorLocked
    | Api.RateLimited
  >;
  /** BEH-EA-235: completes a diverted sign-in with a TOTP code and mints the session. */
  readonly verify: (
    input: {
      readonly challengeId: Redacted.Redacted<string>;
      readonly code: Redacted.Redacted<string>;
      readonly ip?: string;
    },
    context?: { readonly userAgent?: string },
  ) => Effect.Effect<IssuedSession, VerifyError>;
  /** BEH-EA-237: completes a diverted sign-in with a recovery code (spent). */
  readonly verifyRecovery: (
    input: {
      readonly challengeId: Redacted.Redacted<string>;
      readonly recoveryCode: Redacted.Redacted<string>;
      readonly ip?: string;
    },
    context?: { readonly userAgent?: string },
  ) => Effect.Effect<IssuedSession, VerifyError>;
  /** BEH-EA-236: needs a fresh session and a valid TOTP or recovery code; removes the factor. */
  readonly disable: (
    userId: Users.UserId,
    sessionId: string,
    code: Redacted.Redacted<string>,
  ) => Effect.Effect<void, ManageError>;
  /** BEH-EA-237/BCR-002: replaces the recovery-code set atomically; needs a fresh session and a valid code. */
  readonly regenerateRecoveryCodes: (
    userId: Users.UserId,
    sessionId: string,
    code: Redacted.Redacted<string>,
  ) => Effect.Effect<ReadonlyArray<string>, ManageError>;
  readonly status: (userId: Users.UserId) => Effect.Effect<{
    readonly enabled: boolean;
    readonly remainingRecoveryCodes: number;
  }>;
}

type VerifyError =
  | TwoFactorApi.InvalidTwoFactorCode
  | TwoFactorApi.SecondFactorLocked
  | Api.RateLimited
  | Users.UserSuspended
  | Errors.StoreUnavailable;

type ManageError =
  | TwoFactorApi.InvalidTwoFactorCode
  | TwoFactorApi.TwoFactorNotEnabled
  | TwoFactorApi.TwoFactorReauthRequired
  | TwoFactorApi.SecondFactorLocked
  | Api.RateLimited
  | Errors.StoreUnavailable;

// ---- the hook gates ------------------------------------------------------------------------------

/**
 * BEH-EA-234 (ticket 05 §1): taps `Hooks.BeforeSessionIssue`. When the user has a *confirmed* second
 * factor (and the first factor's strategy is not in `bypassStrategies`), the divert answers
 * `TwoFactorRequired { userId, challengeId }` and no session is minted until `/two-factor/verify`
 * succeeds. A pending, unconfirmed secret never diverts — an abandoned `enable` cannot lock anyone out.
 * Infrastructure failures die (the divert has no error channel): failing closed, a 500 rather than a session.
 */
export const sessionGate = Layer.unwrap(
  Effect.gen(function* () {
    const factor = yield* SecondFactor;
    const config = yield* TwoFactorConfig;
    const tap = Hooks.BeforeSessionIssue.tap(
      (input) =>
        Effect.gen(function* () {
          if (config.bypassStrategies.includes(input.strategy)) return Option.none();
          const userId = Users.UserId(input.userId);
          if (!(yield* factor.isEnrolled(userId))) return Option.none();
          const challengeId = yield* factor.issueChallenge({
            userId,
            strategy: input.strategy,
            amr: (input.amr ?? []).filter(Sessions.isAuthMethod),
            attempt: 0,
          });
          return Option.some(new Hooks.TwoFactorRequired({ userId: input.userId, challengeId }));
        }).pipe(Effect.orDie),
      { owner: TwoFactor },
    );
    return Layer.merge(tap, Layer.succeed(TwoFactorGateInstalled, { gate: "session" }));
  }),
);

/**
 * BEH-EA-232 (ticket 05 §2 Fix B): taps `Hooks.BeforeCredentialReset`. For an account with a confirmed
 * second factor a password reset must carry a valid TOTP or recovery code: none aborts
 * `TWO_FACTOR_REQUIRED` (which `Password` surfaces as `SecondFactorRequired`), a wrong one
 * `SECOND_FACTOR_INVALID`, a spent budget `SECOND_FACTOR_LOCKED`. The tap runs inside `confirmReset`'s
 * transaction, so a valid code is spent only when the reset itself commits.
 */
export const credentialResetGate = Layer.unwrap(
  Effect.gen(function* () {
    const factor = yield* SecondFactor;
    const tap = Hooks.BeforeCredentialReset.tap(
      (input) =>
        Effect.gen(function* () {
          const userId = Users.UserId(input.userId);
          if (!(yield* factor.isEnrolled(userId))) return input;
          if (input.secondFactorCode === undefined) {
            return yield* Effect.fail(new HookPoint.HookAbort({ code: "TWO_FACTOR_REQUIRED" }));
          }
          yield* factor.check(userId, input.secondFactorCode, "credentialReset").pipe(
            Effect.catchTag("InvalidTwoFactorCode", () =>
              Effect.fail(new HookPoint.HookAbort({ code: "SECOND_FACTOR_INVALID" })),
            ),
            Effect.catchTag("SecondFactorLocked", () =>
              Effect.fail(new HookPoint.HookAbort({ code: "SECOND_FACTOR_LOCKED" })),
            ),
          );
          return input;
        }),
      { owner: TwoFactor },
    );
    return Layer.merge(tap, Layer.succeed(TwoFactorResetGuard, { guard: "credentialReset" }));
  }),
);

// ---- erasure and export (CSG-001/CSG-005) -------------------------------------------------------------

/** Account erasure: the secret and every recovery code. No foreign keys, so this is the cascade. */
export const twoFactorErasure = Erasure.contribute({
  id: "two_factor",
  make: Effect.gen(function* () {
    const secrets = yield* TwoFactorSecrets;
    const codes = yield* TwoFactorRecoveryCodes;
    return (subject: Erasure.ErasureSubject) =>
      secrets.delete(subject.userId).pipe(Effect.andThen(codes.deleteAllByUser(subject.userId)));
  }),
});

/** Data-subject export: *that* a factor exists and how many recovery codes remain — never the secret or a hash. */
export const twoFactorExport = DataExport.contribute({
  id: "two_factor",
  make: Effect.gen(function* () {
    const secrets = yield* TwoFactorSecrets;
    const codes = yield* TwoFactorRecoveryCodes;
    return (subject: DataExport.DataExportSubject) =>
      Effect.gen(function* () {
        const record = yield* secrets.find(subject.userId);
        const confirmedAt = Option.flatMap(record, (row) => row.confirmedAt);
        return {
          enabled: Option.isSome(confirmedAt),
          confirmedAt: Option.match(confirmedAt, {
            onNone: () => null,
            onSome: DateTime.formatIso,
          }),
          remainingRecoveryCodes: Option.isSome(confirmedAt)
            ? yield* codes.countUnused(subject.userId)
            : 0,
        };
      });
  }),
});

// ---- handlers ------------------------------------------------------------------------------------------

const currentUserPrincipal = Effect.gen(function* () {
  const principal = yield* Api.CurrentPrincipal;
  if (principal._tag !== "User") {
    return yield* Defects.invariantViolation(
      "NonUserPrincipal",
      `awthaq: two-factor account group reached with a non-User principal: ${principal._tag}`,
    );
  }
  return principal;
});

export const TwoFactorHandlers = Layer.mergeAll(
  HttpApiBuilder.group(
    TwoFactorApi.TwoFactorApi,
    "two_factor",
    Effect.fnUntraced(function* (handlers) {
      const twoFactor = yield* TwoFactor;
      const clientAddress = yield* ClientAddress.ClientAddress;

      /** Shared shape of the two sign-in completion endpoints: delivery, address, user agent, session cookie or bearer token. */
      const complete = Effect.fnUntraced(function* (
        request: HttpServerRequest.HttpServerRequest,
        run: (
          ip: string | undefined,
          context: { readonly userAgent?: string },
        ) => Effect.Effect<IssuedSession, VerifyError>,
      ) {
        const delivery = yield* SessionDelivery.mode(request);
        const resolvedAddress = yield* clientAddress.resolve(request);
        const userAgent = Headers.get(request.headers, "user-agent");
        const issued = yield* run(
          Option.getOrUndefined(resolvedAddress),
          Option.isSome(userAgent) ? { userAgent: userAgent.value } : {},
        );
        // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
        const response: SessionContract.SessionDto = yield* SessionDelivery.deliver(
          delivery,
          issued,
        );
        return response;
      });

      return handlers.handleAll({
        verify: Effect.fnUntraced(function* ({
          payload,
          request,
        }: {
          payload: TwoFactorApi.VerifyPayload;
          request: HttpServerRequest.HttpServerRequest;
        }) {
          return yield* complete(request, (ip, context) =>
            twoFactor.verify(
              {
                challengeId: payload.challengeId,
                code: payload.code,
                ...(ip === undefined ? {} : { ip }),
              },
              context,
            ),
          );
        }),
        verifyRecovery: Effect.fnUntraced(function* ({
          payload,
          request,
        }: {
          payload: TwoFactorApi.VerifyRecoveryPayload;
          request: HttpServerRequest.HttpServerRequest;
        }) {
          return yield* complete(request, (ip, context) =>
            twoFactor.verifyRecovery(
              {
                challengeId: payload.challengeId,
                recoveryCode: payload.recoveryCode,
                ...(ip === undefined ? {} : { ip }),
              },
              context,
            ),
          );
        }),
      });
    }),
  ),
  HttpApiBuilder.group(
    TwoFactorApi.TwoFactorApi,
    "two_factor.account",
    Effect.fnUntraced(function* (handlers) {
      const twoFactor = yield* TwoFactor;
      return handlers.handleAll({
        enable: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          const enrollment = yield* twoFactor.enable(
            Users.UserId(principal.ref.id),
            principal.sessionId,
          );
          return new TwoFactorApi.EnrollmentDto(enrollment);
        }),
        confirm: Effect.fnUntraced(function* ({
          payload,
        }: {
          payload: TwoFactorApi.ConfirmPayload;
        }) {
          const principal = yield* currentUserPrincipal;
          const recoveryCodes = yield* twoFactor.confirm(
            Users.UserId(principal.ref.id),
            payload.code,
          );
          return new TwoFactorApi.RecoveryCodesDto({ recoveryCodes });
        }),
        disable: Effect.fnUntraced(function* ({ payload }: { payload: TwoFactorApi.CodePayload }) {
          const principal = yield* currentUserPrincipal;
          yield* twoFactor.disable(
            Users.UserId(principal.ref.id),
            principal.sessionId,
            payload.code,
          );
        }),
        regenerateRecoveryCodes: Effect.fnUntraced(function* ({
          payload,
        }: {
          payload: TwoFactorApi.CodePayload;
        }) {
          const principal = yield* currentUserPrincipal;
          const recoveryCodes = yield* twoFactor.regenerateRecoveryCodes(
            Users.UserId(principal.ref.id),
            principal.sessionId,
            payload.code,
          );
          return new TwoFactorApi.RecoveryCodesDto({ recoveryCodes });
        }),
        status: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          return new TwoFactorApi.StatusDto(
            yield* twoFactor.status(Users.UserId(principal.ref.id)),
          );
        }),
      });
    }),
  ),
);

// ---- the plugin ----------------------------------------------------------------------------------------------

export class TwoFactor extends AuthPlugin.Service<TwoFactor, TwoFactorShape>()("two_factor", {
  apiVersion: 1,
  contract: TwoFactorApi.TwoFactorApi,
  tables: ["two_factor_secret", "two_factor_recovery_code"],
  migrations,
  // ECS-008/BEH-EA-229: the default issuer is the classic thing left in production — the label users see in their authenticator app.
  config: [
    ConfigDescriptor.make(TwoFactorConfig, {
      sensitive: [],
      audit: (value, environment) =>
        environment.production && value.issuer === "awthaq"
          ? [
              ConfigDescriptor.finding(
                "warning",
                "two-factor-issuer-default",
                "the authenticator issuer label is still the default `awthaq`; set your product's name",
              ),
            ]
          : [],
    }),
  ],
}) {
  static readonly layer = AuthPlugin.layer(TwoFactor, {
    handlers: TwoFactorHandlers,
    contributes: Layer.mergeAll(twoFactorErasure, twoFactorExport),
    make: Effect.gen(function* () {
      // Fail-closed composition: these markers exist only if the gates are in the composition.
      yield* TwoFactorGateInstalled;
      yield* TwoFactorResetGuard;

      const factor = yield* SecondFactor;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const events = yield* AuthEvents.AuthEvents;
      const config = yield* TwoFactorConfig;
      const limiter = yield* RateLimiter.RateLimiter;
      const rateLimitsRegistry = yield* RateLimits.RateLimitsRegistry;
      const afterSignIn = yield* Hooks.AfterSignIn;

      // RBS-006: one typed definition per rule feeds both the registry and the enforcement calls. A
      // `RateLimitScopeViolation` is only reachable if a rule named a group outside this plugin's own
      // contract — a coding defect here, hence `Effect.orDie`.
      const rules = TwoFactorRateLimits.makeRules(config);
      yield* Effect.all(
        // The callback's return type is annotated to break the inference cycle through `TwoFactor.layer`
        // (its own initializer names `TwoFactor`) — the narrow exception `Password`/`Passkey` document too.
        TwoFactorRateLimits.registryEntries(rules).map(
          (entry): Effect.Effect<void, RateLimits.RateLimitScopeViolation> =>
            rateLimitsRegistry.register(TwoFactor, entry),
        ),
      ).pipe(Effect.orDie);

      const rateLimit = <I>(
        rule: TwoFactorRateLimits.TwoFactorRule<I>,
        input: I,
      ): Effect.Effect<void, Api.RateLimited> =>
        // EOTS-007: `RateLimits.enforce` also publishes the breach event, logs and counts it.
        RateLimits.enforce({
          key: rule.keyOf(input),
          limit: rule.limit,
          window: rule.window,
          meta: TwoFactorRateLimits.metaOf(rule),
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );

      /**
       * BEH-EA-236: enrolling, disabling and regenerating need a session that proved a credential
       * recently, so a hijacked cookie cannot quietly swap the victim's second factor. A session that
       * is not live for its owner fails closed the same as a stale one.
       */
      const requireFreshSession = (
        userId: Users.UserId,
        sessionId: string,
      ): Effect.Effect<void, TwoFactorApi.TwoFactorReauthRequired | Errors.StoreUnavailable> =>
        Effect.gen(function* () {
          const maxAgeSeconds = Duration.toSeconds(config.reauthMaxAge);
          const current = yield* sessions.findOwned(userId, Sessions.SessionId(sessionId));
          if (Option.isNone(current)) {
            return yield* Effect.fail(new TwoFactorApi.TwoFactorReauthRequired({ maxAgeSeconds }));
          }
          const now = yield* DateTime.now;
          if (Sessions.isStale(current.value.authenticatedAt, maxAgeSeconds, now)) {
            return yield* Effect.fail(new TwoFactorApi.TwoFactorReauthRequired({ maxAgeSeconds }));
          }
        });

      /**
       * THS-001 step 5/11: the ONE place this plugin mints a session, and it accepts only a
       * `VerifiedChallenge` — a spent challenge joined to a proof that the same user's second factor
       * passed — so a session without a verified second factor does not type-check. Records
       * `[...first-factor amr, "otp", "mfa"]` (AOMS-003), and re-runs the sign-in gate: the user may
       * have been suspended in the minutes since the first factor passed.
       */
      const finalizeSignIn = Effect.fnUntraced(function* (
        challenge: VerifiedChallenge,
        request: { readonly ip?: string | undefined; readonly userAgent?: string | undefined },
      ) {
        const user = yield* users
          .findById(challenge.userId)
          .pipe(
            Effect.catchTag("UserNotFound", () =>
              Effect.fail(new TwoFactorApi.InvalidTwoFactorCode({})),
            ),
          );
        yield* Users.assertCanSignIn(user);
        const issued = yield* sessions.issue({
          userId: challenge.userId,
          request: {
            ...(request.ip === undefined ? {} : { ip: request.ip }),
            ...(request.userAgent === undefined ? {} : { userAgent: request.userAgent }),
          },
          amr: Sessions.unionAmr(challenge.amr, ["otp", "mfa"]),
        });
        yield* events.publish({
          _tag: "auth.user.signedIn",
          userId: challenge.userId,
          strategy: challenge.strategy,
        });
        yield* afterSignIn.run({ userId: challenge.userId, strategy: challenge.strategy });
        return issued;
      });

      /**
       * BEH-EA-235 (ticket 05 §1, plus the retry UX the plan adds): consume the challenge BEFORE
       * checking the code, so `auth.token.replay` fires on every bad, expired or reused challenge. A
       * wrong code re-issues a fresh challenge carrying `attempt + 1` — a consumed challenge is never
       * re-used — until `maxAttemptsPerChallenge` are spent, after which the client restarts the sign-in.
       */
      const attempt = Effect.fnUntraced(function* (
        method: TwoFactorMethodUsed,
        input: {
          readonly challengeId: Redacted.Redacted<string>;
          readonly code: Redacted.Redacted<string>;
          readonly ip?: string | undefined;
        },
        context: { readonly userAgent?: string | undefined } | undefined,
      ) {
        yield* rateLimit(rules.verifyByIp, { ip: input.ip });
        const consumed = yield* factor.consumeChallenge(input.challengeId);
        const check = method === "totp" ? factor.verifyTotp : factor.verifyRecoveryCode;
        const proof = yield* check(consumed.userId, input.code, "signIn").pipe(
          Effect.catchTag("InvalidTwoFactorCode", () =>
            consumed.attempt + 1 < config.maxAttemptsPerChallenge
              ? factor
                  .issueChallenge({
                    userId: consumed.userId,
                    strategy: consumed.strategy,
                    amr: consumed.amr,
                    attempt: consumed.attempt + 1,
                  })
                  .pipe(
                    Effect.flatMap((next) =>
                      Effect.fail(new TwoFactorApi.InvalidTwoFactorCode({ challengeId: next })),
                    ),
                  )
              : Effect.fail(new TwoFactorApi.InvalidTwoFactorCode({})),
          ),
        );
        const verifiedChallenge = yield* verified(consumed, proof);
        return yield* finalizeSignIn(verifiedChallenge, {
          ip: input.ip,
          userAgent: context?.userAgent,
        });
      });

      const enable: TwoFactorShape["enable"] = Effect.fnUntraced(function* (userId, sessionId) {
        yield* rateLimit(rules.manageByUser, { userId });
        yield* requireFreshSession(userId, sessionId);
        const user = yield* users
          .findById(userId)
          .pipe(
            Effect.catchTag("UserNotFound", () =>
              Defects.invariantViolation(
                "AuthenticatedUserMissing",
                `awthaq: authenticated user missing: ${userId}`,
              ),
            ),
          );
        const enrolment = yield* factor.beginEnrolment(userId, Users.accountLabel(user));
        return {
          secret: Redacted.value(enrolment.secret),
          otpauthUri: Redacted.value(enrolment.otpauthUri),
        };
      });

      const confirm: TwoFactorShape["confirm"] = Effect.fnUntraced(function* (userId, code) {
        yield* rateLimit(rules.manageByUser, { userId });
        return yield* factor.confirmEnrolment(userId, code);
      });

      const verify: TwoFactorShape["verify"] = (input, context) =>
        attempt(
          "totp",
          { challengeId: input.challengeId, code: input.code, ip: input.ip },
          context,
        );

      const verifyRecovery: TwoFactorShape["verifyRecovery"] = (input, context) =>
        attempt(
          "recovery",
          { challengeId: input.challengeId, code: input.recoveryCode, ip: input.ip },
          context,
        );

      /** Disabling and regenerating share one gate: a fresh session, an enrolled user, a valid code of either kind. */
      const requireFactor = Effect.fnUntraced(function* (
        userId: Users.UserId,
        sessionId: string,
        code: Redacted.Redacted<string>,
        purpose: Purpose,
      ) {
        yield* rateLimit(rules.manageByUser, { userId });
        yield* requireFreshSession(userId, sessionId);
        if (!(yield* factor.isEnrolled(userId))) {
          return yield* Effect.fail(new TwoFactorApi.TwoFactorNotEnabled());
        }
        yield* factor.check(userId, code, purpose);
      });

      const disable: TwoFactorShape["disable"] = Effect.fnUntraced(
        function* (userId, sessionId, code) {
          yield* requireFactor(userId, sessionId, code, "disable");
          yield* factor.disable(userId);
        },
      );

      const regenerateRecoveryCodes: TwoFactorShape["regenerateRecoveryCodes"] = Effect.fnUntraced(
        function* (userId, sessionId, code) {
          yield* requireFactor(userId, sessionId, code, "regenerate");
          return yield* factor.regenerateRecoveryCodes(userId);
        },
      );

      return TwoFactor.of({
        enable,
        confirm,
        verify,
        verifyRecovery,
        disable,
        regenerateRecoveryCodes,
        status: factor.status,
      });
    }),
  });
}
