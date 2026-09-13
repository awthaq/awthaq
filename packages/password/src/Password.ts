// @effect-auth/password — Password
//
// spec/behaviors/15-password.md, BEH-EA-113 through BEH-EA-120.
// spec/models/01-password.md's plugin-class sketch, reproduced with the
// gaps that sketch leaves open (a duplicate email, the missing `name` a
// `User` record requires, the reset token's own encoding, the breach-check
// transport) filled in and documented at each site rather than left to
// silently die or guessed at without a comment explaining the choice.

import { Api, SessionContract } from "@effect-auth/api";
import { AuthEvents, AuthPlugin, Accounts, Sessions, Users, Verification } from "@effect-auth/core";
import { Mailer, PasswordHasher } from "@effect-auth/ports";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as PasswordApi from "./PasswordApi.ts";

export interface PasswordConfigShape {
  readonly minLength: number;
  readonly breachCheck: boolean | { readonly onUnavailable: "allow" | "reject" };
  readonly resetTtl: Duration.Duration;
  readonly rehashOnLogin: boolean;
}

const defaultPasswordConfig: PasswordConfigShape = {
  minLength: 12,
  breachCheck: false,
  resetTtl: Duration.hours(1),
  rehashOnLogin: true,
};

/** BEH-EA-017's `Context.Reference`-with-default pattern, applied to this plugin's own policy knobs. */
export const PasswordConfig: Context.Reference<PasswordConfigShape> = Context.Reference(
  "effect-auth/password/Config",
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
  }) => Effect.Effect<IssuedSession, PasswordApi.WeakPassword | PasswordApi.EmailAlreadyExists>;
  /** BEH-EA-114/116: uniform `InvalidCredentials`, constant real hashing cost regardless of which of the three reasons applied; rehashes opportunistically on success. */
  readonly signIn: (input: {
    readonly email: string;
    readonly password: Redacted.Redacted<string>;
  }) => Effect.Effect<IssuedSession, Api.InvalidCredentials>;
  /** BEH-EA-064/117: identical response whether or not `email` resolves to an account — the caller (the HTTP handler) always answers 202. */
  readonly requestReset: (input: { readonly email: string }) => Effect.Effect<void>;
  /** BEH-EA-117: consumes the reset token and sets the new password in one call, then revokes every other session. */
  readonly confirmReset: (input: {
    readonly token: Redacted.Redacted<string>;
    readonly password: Redacted.Redacted<string>;
  }) => Effect.Effect<void, PasswordApi.TokenConsumed | PasswordApi.WeakPassword>;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

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
    const response = yield* httpClient.get(`https://api.pwnedpasswords.com/range/${prefix}`);
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
 * `@effect-auth/server`'s `Session.SessionHandlers` uses and documents: a
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

    return handlers.handleAll({
      signUp: Effect.fnUntraced(function* ({ payload }: { payload: PasswordApi.SignUpPayload }) {
        const issued = yield* password.signUp(payload);
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
        return toSessionDto(issued.session);
      }),

      signIn: Effect.fnUntraced(function* ({ payload }: { payload: PasswordApi.SignInPayload }) {
        const issued = yield* password.signIn(payload);
        yield* HttpApiBuilder.securitySetCookie(
          Api.SessionCookie,
          Redacted.value(issued.token),
          Sessions.SESSION_COOKIE_ATTRIBUTES,
        );
        return toSessionDto(issued.session);
      }),

      requestReset: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: PasswordApi.RequestResetPayload;
      }) {
        yield* password.requestReset(payload);
      }),

      confirmReset: Effect.fnUntraced(function* ({
        payload,
      }: {
        payload: PasswordApi.ConfirmResetPayload;
      }) {
        yield* password.confirmReset(payload);
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

      // BEH-EA-114: paid once at boot, not once per unsuccessful attempt —
      // a real PHC/scrypt-encoded string this plugin's own configured
      // hasher produced, so `hasher.verify` always does the same real
      // work whether or not a matching account/credential actually
      // exists.
      const dummyHash = Redacted.make(
        yield* hasher.hash(Redacted.make("effect-auth/password/dummy")),
      );

      const signUp: PasswordShape["signUp"] = Effect.fnUntraced(function* (input) {
        const hints = yield* checkPolicy(httpClient, crypto, input.password, config);
        if (hints.length > 0) {
          return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
        }
        // BEH-EA-113's own sketch has no `name` input at all — a `User`
        // record requires one (BEH-EA-041), so the email's local part is
        // used as a placeholder the user can change later via
        // `updateProfile`.
        const name = input.email.split("@")[0] ?? input.email;
        const user = yield* users.create({ email: input.email, name }).pipe(
          Effect.catchTag("EmailAlreadyExists", () => new PasswordApi.EmailAlreadyExists()),
          Effect.catchTag("PlatformError", Effect.die),
        );
        const hash = yield* hasher.hash(input.password);
        yield* accounts
          .link({
            userId: user.id,
            providerId: Accounts.PASSWORD_PROVIDER_ID,
            subject: user.id,
            credentialHash: Redacted.make(hash),
          })
          .pipe(Effect.orDie);
        const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        yield* events.publish({ _tag: "auth.user.created", userId: user.id });

        // BEH-EA-113: dispatched, never awaited — response latency must
        // not depend on mail-provider latency, and per
        // research/05-oauth-oidc.md Q48, a slow-vs-fast response is
        // itself an enumeration side channel.
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const identifier = `${VERIFY_PREFIX}${user.id}`;
            const { value } = yield* verification.issue({ identifier, ttl: Duration.hours(24) });
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
        const userOpt = yield* users.findByEmail(input.email);
        const accountOpt = yield* Option.match(userOpt, {
          onNone: () => Effect.succeed(Option.none<Accounts.AccountRecord>()),
          onSome: (user) => accounts.findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, user.id),
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
        if (
          Option.isNone(userOpt) ||
          Option.isNone(accountOpt) ||
          Option.isNone(hashOpt) ||
          !verified
        ) {
          return yield* Effect.fail(new Api.InvalidCredentials());
        }
        const user = userOpt.value;
        const account = accountOpt.value;
        const hash = hashOpt.value;

        if (config.rehashOnLogin && hasher.needsRehash(Redacted.value(hash))) {
          const rehashed = yield* hasher.hash(input.password);
          yield* accounts
            .updateCredentialHash(account.id, Redacted.make(rehashed))
            .pipe(Effect.orDie);
        }

        const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
        yield* events.publish({
          _tag: "auth.user.signedIn",
          userId: user.id,
          strategy: "password",
        });
        return issued;
      });

      const requestReset: PasswordShape["requestReset"] = Effect.fnUntraced(function* (input) {
        const userOpt = yield* users.findByEmail(input.email);
        // BEH-EA-064: nothing distinguishes this branch from "no such
        // email" in the response either handler produces — only whether
        // the mail actually goes out differs, and that's invisible to the
        // caller.
        if (Option.isSome(userOpt)) {
          const user = userOpt.value;
          const identifier = `${RESET_PREFIX}${user.id}`;
          const { value } = yield* verification
            .issue({ identifier, ttl: config.resetTtl })
            .pipe(Effect.orDie);
          yield* mailer.send({
            to: user.email,
            template: "reset-password",
            data: { token: encodeVerificationToken(identifier, value) },
          });
        }
      });

      const confirmReset: PasswordShape["confirmReset"] = Effect.fnUntraced(function* (input) {
        const decoded = decodeVerificationToken(Redacted.value(input.token));
        if (Option.isNone(decoded)) {
          return yield* Effect.fail(new PasswordApi.TokenConsumed());
        }
        const { identifier, value } = decoded.value;
        yield* verification.consume(identifier, value).pipe(
          Effect.catchTag("TokenConsumed", () => new PasswordApi.TokenConsumed()),
          Effect.catchTag("PlatformError", Effect.die),
        );

        const hints = yield* checkPolicy(httpClient, crypto, input.password, config);
        if (hints.length > 0) {
          return yield* Effect.fail(new PasswordApi.WeakPassword({ hints }));
        }

        const userId = Users.UserId(identifier.slice(RESET_PREFIX.length));
        const account = yield* accounts
          .findByProviderSubject(Accounts.PASSWORD_PROVIDER_ID, userId)
          .pipe(
            Effect.flatMap(
              Option.match({
                // The token was only ever issued right after `signUp`
                // created this exact row (BEH-EA-113/117) — its absence
                // here is a defect, not a request-level condition the
                // caller can act on.
                onNone: () =>
                  Effect.die(
                    new Error(`effect-auth: password credential missing for user ${userId}`),
                  ),
                onSome: Effect.succeed,
              }),
            ),
          );
        const hash = yield* hasher.hash(input.password);
        yield* accounts.updateCredentialHash(account.id, Redacted.make(hash)).pipe(Effect.orDie);

        // BEH-EA-117: every *other* session — there is no "current"
        // session to keep here (the caller isn't authenticated at all),
        // so an id no real session can ever have revokes all of them.
        yield* sessions.revokeOthers(userId, Sessions.SessionId(""));
      });

      return Password.of({ signUp, signIn, requestReset, confirmReset });
    }),
  });
}
