// @awthaq/magic-link — EmailOtp
//
// SOS-001, BCR-005, SOS-004, MLO-002 (BEH-EA-268 to BEH-EA-271, wayfinder ticket 05 §3): the shared
// channel-OTP substrate — a short numeric code mailed to an address, traded for a session. It is
// the same channel credential as `MagicLink` (see `Channel.ts`) with a different artifact: where a
// link is 256 bits nobody can guess, a six-digit code is a million possibilities, so everything
// that makes it safe is stated here and enforced in layers:
//
// - **Hashed and single-use**, like every `Verification` value; minted inside `Verification`
//   (`format: Numeric`, rejection sampling, no modulo bias), never chosen by this plugin (BCR-005).
// - **A per-code attempt budget** (`maxAttempts`, default 3): each wrong presentation against the
//   live code counts, and the code is burned at the limit — the right code no longer works
//   (SOS-004). The type system requires the budget for a numeric value.
// - **A short life** (`ttl`, default five minutes) and **one live code per address**: issuing a new
//   code supersedes the old one.
// - **A resend window** (`Verification.reserve`, default 60 s, MLO-002): an address is mailed at most
//   one code per window, so re-requesting cannot be used to re-roll the attempt budget or mail-bomb.
// - **Rate limits on both endpoints**, per source and per (normalised) address — the layer that
//   bounds how many codes an attacker can ask for, and so how many total guesses.
//
// `request` is uniform (`202` for every address, nothing that varies by account existence happens
// on the response path, BEH-EA-064). `verify`'s every failure is the one `InvalidEmailOtp`. A proven
// mailbox goes through `Channel.complete`, so a 2FA-enrolled user is diverted to `TwoFactorRequired`
// and the session records `["otp", "email"]` — one factor's worth of assurance (see `Assurance`).
//
// SMS is deliberately not here (ADR-EA-021): an SMS-delivered code is a *restricted* authenticator
// (NIST SP 800-63B-4). It would be a separate, explicitly degraded plugin over this substrate —
// never an account's only factor, recorded as `sms` (not `otp`) so a policy can rank it lower, and
// emitting a distinguishable audit event.

import { Api, SessionContract } from "@awthaq/api";
import {
  AuthEvents,
  AuthPlugin,
  HookPoint,
  Hooks,
  MailDispatch,
  RateLimits,
  Sessions,
  Users,
  Verification,
} from "@awthaq/core";
import type { Errors } from "@awthaq/core";
import { ClientAddress, Mailer, RateLimiter } from "@awthaq/ports";
import { SessionDelivery } from "@awthaq/server";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Headers from "effect/unstable/http/Headers";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as Channel from "./Channel.ts";
import * as EmailOtpApi from "./EmailOtpApi.ts";
import * as RateLimitRules from "./RateLimitRules.ts";

// ---- config -----------------------------------------------------------------------------------------

export interface EmailOtpConfigShape {
  /** Digits per code (4 to 10; 6 is what people expect). */
  readonly digits: number;
  /** How long a code stays valid. Short on purpose: a code is low-entropy. */
  readonly ttl: Duration.Duration;
  /** Wrong presentations one code survives before it is burned. */
  readonly maxAttempts: number;
  /** An address is mailed at most one code per window. */
  readonly resendWindow: Duration.Duration;
  /** Whether an address with no account may create one by presenting a code. */
  readonly allowSignUp: boolean;
}

const defaults: EmailOtpConfigShape = {
  digits: 6,
  ttl: Duration.minutes(5),
  maxAttempts: 3,
  resendWindow: Duration.seconds(60),
  allowSignUp: true,
};

export const EmailOtpConfig = Context.Reference<EmailOtpConfigShape>("awthaq/email-otp/Config", {
  defaultValue: () => defaults,
});

export const config = (partial: Partial<EmailOtpConfigShape>) =>
  Layer.succeed(EmailOtpConfig, { ...defaults, ...partial });

// ---- rate limits ------------------------------------------------------------------------------------

const rules = {
  requestByIp: RateLimitRules.rule({
    group: "emailOtp",
    name: "requestByIp",
    endpoint: "request",
    dimension: "ip",
    input: RateLimitRules.IpInput,
    keyOf: RateLimitRules.ipKey("email-otp:request"),
    limit: 30,
    window: RateLimitRules.minutes15,
  }),
  requestByEmail: RateLimitRules.rule({
    group: "emailOtp",
    name: "requestByEmail",
    endpoint: "request",
    dimension: "identity",
    input: RateLimitRules.EmailInput,
    keyOf: RateLimitRules.emailKey("email-otp:request"),
    limit: 5,
    window: RateLimitRules.minutes15,
  }),
  verifyByIp: RateLimitRules.rule({
    group: "emailOtp",
    name: "verifyByIp",
    endpoint: "verify",
    dimension: "ip",
    input: RateLimitRules.IpInput,
    keyOf: RateLimitRules.ipKey("email-otp:verify"),
    limit: 30,
    window: RateLimitRules.minutes15,
  }),
  // The layer above the per-code budget: bounds guesses at one address across many codes.
  verifyByEmail: RateLimitRules.rule({
    group: "emailOtp",
    name: "verifyByEmail",
    endpoint: "verify",
    dimension: "identity",
    input: RateLimitRules.EmailInput,
    keyOf: RateLimitRules.emailKey("email-otp:verify"),
    limit: 10,
    window: RateLimitRules.minutes15,
  }),
};

// ---- the service -------------------------------------------------------------------------------------

const identifierOf = (email: string): string => `email-otp:${email}`;

/** The server-side payload a code carries: the address it was issued for (normalised). */
const CodePayload = Schema.Struct({ email: Schema.String });

/** What `verify` returns: the session and the raw token to deliver it (cookie or bearer, `SessionDelivery`). */
export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

export interface EmailOtpShape {
  /** BEH-EA-269: always resolves (or is rate limited) — never says whether an account exists or a code was mailed. */
  readonly requestCode: (input: {
    readonly email: string;
    readonly ip?: string | undefined;
  }) => Effect.Effect<void, Api.RateLimited>;
  /** BEH-EA-270: trades a code for a session. */
  readonly verify: (
    input: {
      readonly email: string;
      readonly code: Redacted.Redacted<string>;
      readonly ip?: string | undefined;
    },
    context?: { readonly userAgent?: string | undefined },
  ) => Effect.Effect<
    IssuedSession,
    | EmailOtpApi.InvalidEmailOtp
    | Api.RateLimited
    | HookPoint.HookAborted
    | Hooks.TwoFactorRequired
    | Users.UserSuspended
    | Errors.StoreUnavailable
  >;
}

/** The address (through the application-provided `ClientAddress` port, AGA-001/NHS-003) and user agent of a request. */
const currentClient = Effect.fnUntraced(function* (
  clientAddress: ClientAddress.ClientAddressShape,
  request: HttpServerRequest.HttpServerRequest,
) {
  const resolved = yield* clientAddress.resolve(request);
  const userAgent = Headers.get(request.headers, "user-agent");
  return {
    ip: Option.getOrUndefined(resolved),
    context: Option.isSome(userAgent) ? { userAgent: userAgent.value } : {},
  };
});

export const EmailOtpHandlers = HttpApiBuilder.group(
  EmailOtpApi.EmailOtpApi,
  "emailOtp",
  Effect.fnUntraced(function* (handlers) {
    const emailOtp = yield* EmailOtp;
    const clientAddress = yield* ClientAddress.ClientAddress;
    return handlers.handleAll({
      request: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: EmailOtpApi.RequestPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const client = yield* currentClient(clientAddress, request);
        yield* emailOtp.requestCode({ email: payload.email, ip: client.ip });
      }),
      verify: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: EmailOtpApi.VerifyPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const delivery = yield* SessionDelivery.mode(request);
        const client = yield* currentClient(clientAddress, request);
        const issued = yield* emailOtp.verify(
          { email: payload.email, code: payload.code, ip: client.ip },
          client.context,
        );
        // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
        const response: SessionContract.SessionDto = yield* SessionDelivery.deliver(
          delivery,
          issued,
        );
        return response;
      }),
    });
  }),
);

export class EmailOtp extends AuthPlugin.Service<EmailOtp, EmailOtpShape>()("emailOtp", {
  apiVersion: 1,
  contract: EmailOtpApi.EmailOtpApi,
  // BEH-EA-271: no table — the codes are `Verification` rows (`verification_tokens`, core's).
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(EmailOtp, {
    handlers: EmailOtpHandlers,
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const verification = yield* Verification.Verification;
      const events = yield* AuthEvents.AuthEvents;
      const mailer = yield* Mailer.Mailer;
      const limiter = yield* RateLimiter.RateLimiter;
      const rateLimitsRegistry = yield* RateLimits.RateLimitsRegistry;
      const settings = yield* EmailOtpConfig;
      const channel = yield* Channel.make;
      const mailDispatcher = yield* MailDispatch.make;

      yield* Effect.all(
        // The callback's return type is annotated to break the inference cycle through `EmailOtp.layer`
        // (its own initializer names `EmailOtp`) — the narrow exception `Password`/`Passkey` document too.
        RateLimitRules.registryEntries(rules).map(
          (entry): Effect.Effect<void, RateLimits.RateLimitScopeViolation> =>
            rateLimitsRegistry.register(EmailOtp, entry),
        ),
      ).pipe(Effect.orDie);

      const rateLimit = <I>(
        rule: RateLimitRules.Rule<I>,
        input: I,
      ): Effect.Effect<void, Api.RateLimited> =>
        RateLimits.enforce({
          key: rule.keyOf(input),
          limit: rule.limit,
          window: rule.window,
          meta: RateLimitRules.metaOf(rule),
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );

      const decodePayload = Schema.decodeUnknownOption(CodePayload);
      const wellFormedCode = (code: string): boolean =>
        code.length === settings.digits && /^[0-9]+$/.test(code);

      const requestCode: EmailOtpShape["requestCode"] = Effect.fnUntraced(function* (input) {
        yield* rateLimit(rules.requestByIp, { ip: input.ip });
        yield* rateLimit(rules.requestByEmail, { email: input.email });
        yield* mailDispatcher.dispatch(
          { template: "email-otp" },
          Effect.gen(function* () {
            const email = Channel.normalizeEmail(input.email);
            const existing = yield* users.findByEmail(email);
            if (Option.isNone(existing) && !settings.allowSignUp) return;
            // MLO-002: one code per address per window, however many requests race in.
            const fresh = yield* verification.reserve({
              identifier: `email-otp-resend:${email}`,
              ttl: settings.resendWindow,
            });
            if (!fresh) return;
            // BCR-005/SOS-004: a numeric value minted inside `Verification`, with the attempt budget the type demands.
            const issued = yield* verification.issue({
              identifier: identifierOf(email),
              ttl: settings.ttl,
              ...(Option.isSome(existing) ? { userId: existing.value.id } : {}),
              payload: { email },
              format: { _tag: "Numeric", digits: settings.digits },
              maxAttempts: settings.maxAttempts,
            });
            yield* mailer.send({
              to: input.email,
              template: "email-otp",
              data: { code: issued.value, expiresAt: DateTime.formatIso(issued.token.expiresAt) },
            });
          }),
        );
      });

      const verify: EmailOtpShape["verify"] = Effect.fnUntraced(function* (input, context) {
        yield* rateLimit(rules.verifyByIp, { ip: input.ip });
        yield* rateLimit(rules.verifyByEmail, { email: input.email });
        const email = Channel.normalizeEmail(input.email);
        const refused = Effect.gen(function* () {
          yield* events.publish({
            _tag: "auth.user.signInFailed",
            strategy: "emailOtp",
            reason: "invalidCredentials",
            ...(input.ip === undefined ? {} : { clientIp: input.ip }),
          });
          return yield* Effect.fail(new EmailOtpApi.InvalidEmailOtp());
        });
        const presented = Redacted.value(input.code).trim();
        // A value that cannot be a code is refused without touching the store (and spends nothing of any code's budget).
        if (!wellFormedCode(presented)) return yield* refused;
        const consumed = yield* verification
          .consume(identifierOf(email), Redacted.make(presented))
          .pipe(Effect.catchTag("Verification/TokenConsumed", () => refused));
        return yield* channel
          .complete({
            strategy: "emailOtp",
            amr: ["otp", "email"],
            email: Option.some(
              Option.match(decodePayload(consumed.payload), {
                onNone: () => email,
                onSome: (payload) => payload.email,
              }),
            ),
            userId: consumed.userId,
            allowSignUp: settings.allowSignUp,
            ip: input.ip,
            userAgent: context?.userAgent,
          })
          .pipe(
            Effect.catchTag("MagicLink/ChannelInvalid", (invalid) =>
              Channel.logInvalid("emailOtp", invalid).pipe(Effect.andThen(refused)),
            ),
          );
      });

      return EmailOtp.of({ requestCode, verify });
    }),
  });
}
