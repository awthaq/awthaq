// @awthaq/magic-link — MagicLink
//
// BAM-007, MLO-005, MLO-002 (BEH-EA-240 to BEH-EA-243, wayfinder ticket 05 §2 Fix A): passwordless
// sign-in by a single-use emailed link, built on the `Verification` substrate — no table of its own.
//
// - **Request** (`POST /magic-link/request`): rate limited per source and per (normalised) address,
//   then answers `202` — always the same answer. Everything that could differ by whether an account
//   exists (the user lookup, the token, the mail) happens in the background through a `MailDispatch`
//   dispatcher, so neither the body nor the timing of the response says. An address inside its resend
//   window (`Verification.reserve`, MLO-002) is not mailed a second link; a brand-new address is
//   mailed one only when `allowSignUp` is on. The token is `VerificationLink`'s `<identifier>.<secret>`
//   under the purpose `magic-link` with a random public id — never the user id or address — and the
//   address rides in the row's server-side `payload`, so a link for a not-yet-existing user still
//   knows whom to create.
// - **Verify** (`POST /magic-link/verify`): the only way to consume a link. Decode and purpose-check
//   it, rate limit, `Verification.consume` (single use), then `Channel.complete` — find or create the
//   user, mark the mailbox verified, run the sign-in gate, veto and MFA divert, and mint a session
//   recorded as `["email"]`. A 2FA-enrolled user is diverted to `TwoFactorRequired` (ARF-005 Fix A).
// - **The link carries its token in the URL fragment** (`baseUrl`/`link` config), so it is never sent
//   to a server, logged or put in a `Referer`, and **no GET route consumes it** — see `MagicLinkApi.ts`.

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
  VerificationLink,
} from "@awthaq/core";
import type { Errors } from "@awthaq/core";
import { ClientAddress, Mailer, RateLimiter } from "@awthaq/ports";
import { SessionDelivery } from "@awthaq/server";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
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
import * as MagicLinkApi from "./MagicLinkApi.ts";
import * as RateLimitRules from "./RateLimitRules.ts";

// ---- config -----------------------------------------------------------------------------------------

export interface MagicLinkConfigShape {
  /** How long an emailed link stays valid (single use either way). */
  readonly ttl: Duration.Duration;
  /** Whether an address with no account may create one by presenting a link. `false`: only existing users can sign in. */
  readonly allowSignUp: boolean;
  /** An address is mailed at most one link per window (`Verification.reserve`); requests inside it are answered but not mailed. */
  readonly resendWindow: Duration.Duration;
  /**
   * The page that reads the token from the URL fragment and POSTs it — `<baseUrl>/magic-link#token=<token>`.
   * Unset (and no `link`): the mail carries the token and its expiry but no URL, and the template builds one.
   */
  readonly baseUrl?: string;
  /** A full link builder, overriding `baseUrl`. Put the token in the fragment, never a query string. */
  readonly link?: (token: string) => string;
}

const defaults: MagicLinkConfigShape = {
  ttl: Duration.minutes(10),
  allowSignUp: true,
  resendWindow: Duration.seconds(60),
};

export const MagicLinkConfig = Context.Reference<MagicLinkConfigShape>(
  "awthaq/magic-link/Config",
  { defaultValue: () => defaults },
);

export const config = (partial: Partial<MagicLinkConfigShape>) =>
  Layer.succeed(MagicLinkConfig, { ...defaults, ...partial });

const linkBuilder = (settings: MagicLinkConfigShape): ((token: string) => string) | undefined =>
  settings.link ??
  (settings.baseUrl === undefined
    ? undefined
    : (token) => `${settings.baseUrl}/magic-link#token=${encodeURIComponent(token)}`);

// ---- rate limits ------------------------------------------------------------------------------------

const rules = {
  requestByIp: RateLimitRules.rule({
    group: "magicLink",
    name: "requestByIp",
    endpoint: "request",
    dimension: "ip",
    input: RateLimitRules.IpInput,
    keyOf: RateLimitRules.ipKey("magic-link:request"),
    limit: 30,
    window: RateLimitRules.minutes15,
  }),
  requestByEmail: RateLimitRules.rule({
    group: "magicLink",
    name: "requestByEmail",
    endpoint: "request",
    dimension: "identity",
    input: RateLimitRules.EmailInput,
    keyOf: RateLimitRules.emailKey("magic-link:request"),
    limit: 5,
    window: RateLimitRules.minutes15,
  }),
  verifyByIp: RateLimitRules.rule({
    group: "magicLink",
    name: "verifyByIp",
    endpoint: "verify",
    dimension: "ip",
    input: RateLimitRules.IpInput,
    keyOf: RateLimitRules.ipKey("magic-link:verify"),
    limit: 30,
    window: RateLimitRules.minutes15,
  }),
  // Keyed on the token's decoded public id (never its secret half): a flood of guesses at one link.
  verifyByToken: RateLimitRules.rule({
    group: "magicLink",
    name: "verifyByToken",
    endpoint: "verify",
    dimension: "identity",
    input: RateLimitRules.IdentifierInput,
    keyOf: (input) => `magic-link:verify:${input.identifier}`,
    limit: 5,
    window: RateLimitRules.minutes15,
  }),
};

// ---- the service -------------------------------------------------------------------------------------

const PURPOSE = "magic-link";

/** The server-side payload a link carries: the address it was issued for (normalised). */
const LinkPayload = Schema.Struct({ email: Schema.String });

/** What `verify` returns: the session and the raw token to deliver it (cookie or bearer, `SessionDelivery`). */
export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

export interface MagicLinkShape {
  /** BEH-EA-241: always resolves (or is rate limited) — never says whether an account exists. */
  readonly requestLink: (input: {
    readonly email: string;
    readonly ip?: string | undefined;
  }) => Effect.Effect<void, Api.RateLimited>;
  /** BEH-EA-242: the only way to consume a link. */
  readonly verify: (
    input: { readonly token: Redacted.Redacted<string>; readonly ip?: string | undefined },
    context?: { readonly userAgent?: string | undefined },
  ) => Effect.Effect<
    IssuedSession,
    | MagicLinkApi.MagicLinkConsumed
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

export const MagicLinkHandlers = HttpApiBuilder.group(
  MagicLinkApi.MagicLinkApi,
  "magicLink",
  Effect.fnUntraced(function* (handlers) {
    const magicLink = yield* MagicLink;
    const clientAddress = yield* ClientAddress.ClientAddress;
    return handlers.handleAll({
      request: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: MagicLinkApi.RequestPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const client = yield* currentClient(clientAddress, request);
        yield* magicLink.requestLink({ email: payload.email, ip: client.ip });
      }),
      verify: Effect.fnUntraced(function* ({
        payload,
        request,
      }: {
        payload: MagicLinkApi.VerifyPayload;
        request: HttpServerRequest.HttpServerRequest;
      }) {
        const delivery = yield* SessionDelivery.mode(request);
        const client = yield* currentClient(clientAddress, request);
        const issued = yield* magicLink.verify({ token: payload.token, ip: client.ip }, client.context);
        // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
        const response: SessionContract.SessionDto = yield* SessionDelivery.deliver(delivery, issued);
        return response;
      }),
    });
  }),
);

export class MagicLink extends AuthPlugin.Service<MagicLink, MagicLinkShape>()("magicLink", {
  apiVersion: 1,
  contract: MagicLinkApi.MagicLinkApi,
  // BEH-EA-243: no table — the links are `Verification` rows (`verification_tokens`, core's).
  tables: [],
}) {
  static readonly layer = AuthPlugin.layer(MagicLink, {
    handlers: MagicLinkHandlers,
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const verification = yield* Verification.Verification;
      const events = yield* AuthEvents.AuthEvents;
      const mailer = yield* Mailer.Mailer;
      const crypto = yield* Crypto.Crypto;
      const limiter = yield* RateLimiter.RateLimiter;
      const rateLimitsRegistry = yield* RateLimits.RateLimitsRegistry;
      const settings = yield* MagicLinkConfig;
      const channel = yield* Channel.make;
      // ERS-002: mail is dispatched in the background, owned by this plugin's scope.
      const mailDispatcher = yield* MailDispatch.make;

      // RBS-006: one typed definition per rule feeds both the registry and the enforcement calls. A
      // `RateLimitScopeViolation` is only reachable if a rule named a group outside this plugin's own
      // contract — a coding defect here, hence `Effect.orDie`.
      yield* Effect.all(
        // The callback's return type is annotated to break the inference cycle through `MagicLink.layer`
        // (its own initializer names `MagicLink`) — the narrow exception `Password`/`Passkey` document too.
        RateLimitRules.registryEntries(rules).map(
          (entry): Effect.Effect<void, RateLimits.RateLimitScopeViolation> =>
            rateLimitsRegistry.register(MagicLink, entry),
        ),
      ).pipe(Effect.orDie);

      const rateLimit = <I>(
        rule: RateLimitRules.Rule<I>,
        input: I,
      ): Effect.Effect<void, Api.RateLimited> =>
        // EOTS-007: `RateLimits.enforce` also publishes the breach event, logs and counts it.
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

      const link = linkBuilder(settings);
      const decodePayload = Schema.decodeUnknownOption(LinkPayload);

      const requestLink: MagicLinkShape["requestLink"] = Effect.fnUntraced(function* (input) {
        yield* rateLimit(rules.requestByIp, { ip: input.ip });
        yield* rateLimit(rules.requestByEmail, { email: input.email });
        // The lookup, the token and the mail are all background work: the response is the same
        // whether or not this address has an account (BEH-EA-064), in body and in timing.
        yield* mailDispatcher.dispatch(
          { template: "magic-link" },
          Effect.gen(function* () {
            const email = Channel.normalizeEmail(input.email);
            const existing = yield* users.findByEmail(email);
            // An unknown address with sign-up off is answered like any other and simply not mailed.
            if (Option.isNone(existing) && !settings.allowSignUp) return;
            // MLO-002: at most one link per address per window, however many requests race in.
            const fresh = yield* verification.reserve({
              identifier: `magic-link-resend:${email}`,
              ttl: settings.resendWindow,
            });
            if (!fresh) return;
            const issued = yield* VerificationLink.issue(
              { verification, crypto },
              {
                purpose: PURPOSE,
                ttl: settings.ttl,
                ...(Option.isSome(existing) ? { userId: existing.value.id } : {}),
                payload: { email },
              },
            );
            // Delivered to the address as typed; the row and every key use the normalised one.
            yield* mailer.send({
              to: input.email,
              template: "magic-link",
              data: VerificationLink.mailData({
                token: issued.token,
                expiresAt: issued.expiresAt,
                link,
              }),
            });
          }),
        );
      });

      const verify: MagicLinkShape["verify"] = Effect.fnUntraced(function* (input, context) {
        yield* rateLimit(rules.verifyByIp, { ip: input.ip });
        // ARF-007-style purpose check before anything is rate limited or consumed.
        const decoded = VerificationLink.decode(Redacted.value(input.token), PURPOSE);
        const refused = Effect.gen(function* () {
          yield* events.publish({
            _tag: "auth.user.signInFailed",
            strategy: "magicLink",
            reason: "invalidCredentials",
            ...(input.ip === undefined ? {} : { clientIp: input.ip }),
          });
          return yield* Effect.fail(new MagicLinkApi.MagicLinkConsumed());
        });
        if (Option.isNone(decoded)) return yield* refused;
        yield* rateLimit(rules.verifyByToken, { identifier: decoded.value.publicId });
        const consumed = yield* verification
          .consume(decoded.value.identifier, decoded.value.value)
          .pipe(Effect.catchTag("Verification/TokenConsumed", () => refused));
        return yield* channel
          .complete({
            strategy: "magicLink",
            amr: ["email"],
            email: Option.map(decodePayload(consumed.payload), (payload) => payload.email),
            userId: consumed.userId,
            allowSignUp: settings.allowSignUp,
            ip: input.ip,
            userAgent: context?.userAgent,
          })
          .pipe(
            Effect.catchTag("MagicLink/ChannelInvalid", (invalid) =>
              Channel.logInvalid("magicLink", invalid).pipe(Effect.andThen(refused)),
            ),
          );
      });

      return MagicLink.of({ requestLink, verify });
    }),
  });
}
