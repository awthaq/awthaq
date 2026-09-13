// @effect-auth/passkey — Passkey
//
// spec/behaviors/17-passkey.md, BEH-EA-129 through BEH-EA-136. `Auth.make([Passkey])`
// composes: `dependsOn` is left unset on `AuthPlugin.layer` (like
// `@effect-auth/password`'s own `Password.layer`, not like a cross-*plugin*
// dependency) — `Users`/`Sessions`/`Accounts`/`AuthEvents` are core domain
// services this plugin's own `make` Effect simply `yield*`s directly, the
// same way every other plugin in this codebase already does; `dependsOn`
// itself is reserved for depending on *another plugin*, which this one
// doesn't.
//
// Ticket 06's own text said `dependsOn: [Sessions, Users]` — corrected here
// to match the real, established `AuthPlugin.layer` convention once actual
// implementation exposed the mismatch (see this package's own ticket
// results for the fuller note).
//
// Passkey registration is always adding a credential to an *existing*,
// already-authenticated account — this spec has no passkey-first sign-up
// (`spec.md`'s own Out of Scope) — so both registration ceremonies key
// their own `ChallengeStore` scope by the caller's session id, known at
// both `.../options` and `.../verify` time. The authenticate ceremony has
// no session yet (it's how one is created); see `PasskeyApi.ts`'s own
// header comment for how it correlates its two anonymous calls instead.

import { Api, SessionContract } from "@effect-auth/api";
import { AuthEvents, AuthPlugin, Accounts, Sessions, Users } from "@effect-auth/core";
import { WebAuthn } from "@effect-auth/ports";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import * as ChallengeStore from "./ChallengeStore.ts";
import * as PasskeyApi from "./PasskeyApi.ts";
import * as PasskeyCredentials from "./PasskeyCredentials.ts";

/** BEH-EA-044-style reserved provider id, this plugin's own concern (BEH-EA-004: confined to its own scope). */
const PASSKEY_PROVIDER_ID = "passkey";

export interface PasskeyConfigShape {
  readonly rpId: string;
  readonly rpName: string;
  /** BEH-EA-133: exact `(scheme, host, port)` tuples — never a bare host. */
  readonly origins: ReadonlyArray<string>;
  /** BEH-EA-135: defaults to `"none"`. */
  readonly attestation: WebAuthn.AttestationConveyance;
  readonly authenticatorSelection: WebAuthn.AuthenticatorSelection;
  /** Ticket 07: defaults to `true`, per this spec's own "richness over complexity" decision. */
  readonly conditionalCreate: boolean;
}

const defaultPasskeyConfig: PasskeyConfigShape = {
  // Deliberately insecure-looking dev defaults, the same posture
  // `@effect-auth/oauth`'s own `OAuthConfig.baseUrl` default takes — real
  // deployments are expected to override every one of these via `config()`.
  rpId: "localhost",
  rpName: "effect-auth",
  origins: ["http://localhost:3000"],
  attestation: "none",
  authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  conditionalCreate: true,
};

/** BEH-EA-017's `Context.Reference`-with-default pattern, applied to this plugin's own policy knobs. */
export const PasskeyConfig: Context.Reference<PasskeyConfigShape> = Context.Reference(
  "effect-auth/passkey/Config",
  { defaultValue: () => defaultPasskeyConfig },
);

export const config = (partial: Partial<PasskeyConfigShape>): Layer.Layer<never> =>
  Layer.succeed(PasskeyConfig, { ...defaultPasskeyConfig, ...partial });

// ---- AAGUID-derived friendly labels (BEH-EA — ticket 06/09) -----------------

/**
 * A tiny, deliberately non-exhaustive lookup — a real, complete AAGUID
 * registry is the FIDO Metadata Service (MDS3), which `spec.md`'s Out of
 * Scope explicitly defers (the enterprise-attestation module). A handful of
 * common consumer authenticators are named directly; everything else
 * (including the all-zero AAGUID synced/software authenticators often
 * report) falls back to a generic label rather than a raw, meaningless hex
 * string.
 */
const KNOWN_AAGUID_LABELS: Record<string, string> = {
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "iCloud Keychain",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
};

const friendlyCredentialName = (aaguid: string): string => KNOWN_AAGUID_LABELS[aaguid] ?? "Passkey";

// ---- Wire-response decoding (glue, not crypto — see WebAuthn.ts's own header) ----

const ClientDataSchema = Schema.Struct({
  type: Schema.String,
  challenge: Schema.String,
  origin: Schema.String,
});

/**
 * Reads only `origin`/`challenge`/`type` out of the browser's
 * `clientDataJSON` — plain base64url + JSON decoding, not attestation or
 * signature verification (BEH-EA-129's own prohibition is about the
 * latter, never about reading a JSON field). Used to look up the right
 * `ChallengeStore` scope and to pre-check origin/rpId before ever calling
 * the `WebAuthn` port.
 */
const decodeClientData = (
  clientDataJSON: string,
): Option.Option<{
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
}> => {
  const decoded = Encoding.decodeBase64Url(clientDataJSON);
  if (Result.isFailure(decoded)) return Option.none();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decoded.success));
  } catch {
    return Option.none();
  }
  return Schema.decodeUnknownOption(ClientDataSchema)(parsed);
};

/** BEH-EA-133: `rpId` MUST be validated as a registrable-domain suffix of the origin, never a bare host match. */
const originMatchesRpId = (origin: string, rpId: string): boolean => {
  try {
    const host = new URL(origin).hostname;
    return host === rpId || host.endsWith(`.${rpId}`);
  } catch {
    return false;
  }
};

const toRegistrationResponseJSON = (
  input: PasskeyApi.RegistrationCredentialInput,
): Parameters<WebAuthn.WebAuthnShape["verifyRegistration"]>[0]["response"] => ({
  id: input.id,
  rawId: input.rawId,
  response: {
    clientDataJSON: input.response.clientDataJSON,
    attestationObject: input.response.attestationObject,
  },
  clientExtensionResults: {},
  type: "public-key",
});

const toAuthenticationResponseJSON = (
  input: PasskeyApi.AuthenticationCredentialInput,
): Parameters<WebAuthn.WebAuthnShape["verifyAuthentication"]>[0]["response"] => ({
  id: input.id,
  rawId: input.rawId,
  response: {
    clientDataJSON: input.response.clientDataJSON,
    authenticatorData: input.response.authenticatorData,
    signature: input.response.signature,
    ...(input.response.userHandle === undefined ? {} : { userHandle: input.response.userHandle }),
  },
  clientExtensionResults: {},
  type: "public-key",
});

const toBase64Url = (bytes: Uint8Array): string => Encoding.encodeBase64Url(bytes);

const registrationScope = (sessionId: string): string => `passkey.register:${sessionId}`;
const conditionalScope = (sessionId: string): string => `passkey.register.conditional:${sessionId}`;
const authenticateScope = (ceremonyId: string): string => `passkey.authenticate:${ceremonyId}`;

const toCredentialDto = (
  record: PasskeyCredentials.PasskeyCredentialRecord,
): PasskeyApi.PasskeyCredentialDto =>
  new PasskeyApi.PasskeyCredentialDto({
    id: record.id,
    name: record.name,
    deviceType: record.deviceType,
    backedUp: record.backedUp,
    createdAt: DateTime.formatIso(record.createdAt),
    lastUsedAt: DateTime.formatIso(record.lastUsedAt),
  });

const toSessionDto = (session: Sessions.SessionView): SessionContract.SessionDto =>
  new SessionContract.SessionDto({
    id: session.id,
    createdAt: DateTime.formatIso(session.createdAt),
    lastActiveAt: DateTime.formatIso(session.lastActiveAt),
    expiresAt: DateTime.formatIso(session.absoluteExpiresAt),
    userAgent: Option.getOrNull(session.userAgent),
    current: true,
  });

export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

export interface PasskeyShape {
  readonly registerOptions: (userId: Users.UserId, sessionId: string) => Effect.Effect<unknown>;
  readonly registerOptionsConditional: (
    userId: Users.UserId,
    sessionId: string,
  ) => Effect.Effect<unknown, PasskeyApi.PasskeyConditionalCreateDisabled>;
  readonly registerVerify: (
    userId: Users.UserId,
    sessionId: string,
    input: PasskeyApi.RegisterVerifyPayload,
  ) => Effect.Effect<
    PasskeyCredentials.PasskeyCredentialRecord,
    | PasskeyApi.PasskeyChallengeInvalid
    | PasskeyApi.PasskeyOriginMismatch
    | PasskeyApi.PasskeyRpIdMismatch
    | PasskeyApi.PasskeyVerificationFailed
    | PasskeyApi.PasskeyUserVerificationRequired
  >;
  readonly authenticateOptions: (
    email: string | undefined,
  ) => Effect.Effect<{ readonly ceremonyId: string; readonly options: unknown }>;
  readonly authenticateVerify: (
    input: PasskeyApi.AuthenticateVerifyPayload,
  ) => Effect.Effect<
    IssuedSession,
    | Api.InvalidCredentials
    | PasskeyApi.PasskeyChallengeInvalid
    | PasskeyApi.PasskeyUserVerificationRequired
  >;
  readonly listCredentials: (
    userId: Users.UserId,
  ) => Effect.Effect<ReadonlyArray<PasskeyCredentials.PasskeyCredentialRecord>>;
  readonly renameCredential: (
    userId: Users.UserId,
    id: string,
    name: string,
  ) => Effect.Effect<
    PasskeyCredentials.PasskeyCredentialRecord,
    PasskeyApi.PasskeyCredentialNotFound
  >;
  readonly removeCredential: (
    userId: Users.UserId,
    id: string,
  ) => Effect.Effect<void, PasskeyApi.PasskeyCredentialNotFound | PasskeyApi.PasskeyLastCredential>;
}

/** Same forward-reference pattern `@effect-auth/password`'s own `PasswordHandlers` documents. */
const currentUserPrincipal: Effect.Effect<Api.UserPrincipal, never, Api.CurrentPrincipal> =
  Effect.gen(function* () {
    const principal = yield* Api.CurrentPrincipal;
    if (principal._tag !== "User") {
      return yield* Effect.die(
        new Error(
          `effect-auth: passkey group reached with a non-User principal: ${principal._tag}`,
        ),
      );
    }
    return principal;
  });

export const PasskeyHandlers = Layer.mergeAll(
  HttpApiBuilder.group(
    PasskeyApi.PasskeyApi,
    "passkey",
    Effect.fnUntraced(function* (handlers) {
      const passkey = yield* Passkey;
      return handlers.handleAll({
        registerOptions: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          return yield* passkey.registerOptions(
            Users.UserId(principal.ref.id),
            principal.sessionId,
          );
        }),
        registerOptionsConditional: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          return yield* passkey.registerOptionsConditional(
            Users.UserId(principal.ref.id),
            principal.sessionId,
          );
        }),
        registerVerify: Effect.fnUntraced(function* ({
          payload,
        }: {
          payload: PasskeyApi.RegisterVerifyPayload;
        }) {
          const principal = yield* currentUserPrincipal;
          const record = yield* passkey.registerVerify(
            Users.UserId(principal.ref.id),
            principal.sessionId,
            payload,
          );
          return toCredentialDto(record);
        }),
      });
    }),
  ),
  HttpApiBuilder.group(
    PasskeyApi.PasskeyApi,
    "passkey.authenticate",
    Effect.fnUntraced(function* (handlers) {
      const passkey = yield* Passkey;
      return handlers.handleAll({
        authenticateOptions: Effect.fnUntraced(function* ({
          payload,
        }: {
          payload: PasskeyApi.AuthenticateOptionsPayload;
        }) {
          return yield* passkey.authenticateOptions(payload.email);
        }),
        authenticateVerify: Effect.fnUntraced(function* ({
          payload,
        }: {
          payload: PasskeyApi.AuthenticateVerifyPayload;
        }) {
          const issued = yield* passkey.authenticateVerify(payload);
          yield* HttpApiBuilder.securitySetCookie(
            Api.SessionCookie,
            Redacted.value(issued.token),
            Sessions.SESSION_COOKIE_ATTRIBUTES,
          );
          return toSessionDto(issued.session);
        }),
      });
    }),
  ),
  HttpApiBuilder.group(
    PasskeyApi.PasskeyApi,
    "passkey.credentials",
    Effect.fnUntraced(function* (handlers) {
      const passkey = yield* Passkey;
      return handlers.handleAll({
        list: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          const records = yield* passkey.listCredentials(Users.UserId(principal.ref.id));
          return records.map(toCredentialDto);
        }),
        rename: Effect.fnUntraced(function* ({
          params,
          payload,
        }: {
          params: PasskeyApi.CredentialIdParams;
          payload: PasskeyApi.RenamePayload;
        }) {
          const principal = yield* currentUserPrincipal;
          const record = yield* passkey.renameCredential(
            Users.UserId(principal.ref.id),
            params.id,
            payload.name,
          );
          return toCredentialDto(record);
        }),
        remove: Effect.fnUntraced(function* ({
          params,
        }: {
          params: PasskeyApi.CredentialIdParams;
        }) {
          const principal = yield* currentUserPrincipal;
          yield* passkey.removeCredential(Users.UserId(principal.ref.id), params.id);
        }),
      });
    }),
  ),
);

export class Passkey extends AuthPlugin.Service<Passkey, PasskeyShape>()("passkey", {
  apiVersion: 1,
  contract: PasskeyApi.PasskeyApi,
  tables: ["passkey_credential", "passkey_challenge"],
}) {
  static readonly layer = AuthPlugin.layer(Passkey, {
    handlers: PasskeyHandlers,
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const accounts = yield* Accounts.Accounts;
      const events = yield* AuthEvents.AuthEvents;
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challengeStore = yield* ChallengeStore.ChallengeStore;
      const credentials = yield* PasskeyCredentials.PasskeyCredentials;
      const config = yield* PasskeyConfig;
      const crypto = yield* Crypto.Crypto;

      const registerOptions: PasskeyShape["registerOptions"] = Effect.fnUntraced(
        function* (userId, sessionId) {
          const user = yield* users.findById(userId).pipe(Effect.orDie);
          const existing = yield* credentials.listByUser(userId);
          const challenge = yield* challengeStore.issue(registrationScope(sessionId));
          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          return yield* webAuthn.registrationOptions({
            rpId: config.rpId,
            rpName: config.rpName,
            challenge: Redacted.value(challenge),
            userId: webauthnUserId,
            userName: user.email,
            userDisplayName: user.name,
            excludeCredentials: existing.map((row) => ({ id: row.id, transports: row.transports })),
            attestation: config.attestation,
            authenticatorSelection: config.authenticatorSelection,
          });
        },
      );

      const registerOptionsConditional: PasskeyShape["registerOptionsConditional"] =
        Effect.fnUntraced(function* (userId, sessionId) {
          if (!config.conditionalCreate) {
            return yield* Effect.fail(new PasskeyApi.PasskeyConditionalCreateDisabled());
          }
          const user = yield* users.findById(userId).pipe(Effect.orDie);
          const existing = yield* credentials.listByUser(userId);
          const challenge = yield* challengeStore.issue(conditionalScope(sessionId));
          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          return yield* webAuthn.registrationOptions({
            rpId: config.rpId,
            rpName: config.rpName,
            challenge: Redacted.value(challenge),
            userId: webauthnUserId,
            userName: user.email,
            userDisplayName: user.name,
            excludeCredentials: existing.map((row) => ({ id: row.id, transports: row.transports })),
            attestation: config.attestation,
            // BEH-EA-relaxed: Chrome's Conditional Create flow produces
            // UP=0/UV=0 — a `residentKey: "required"` discoverable
            // credential is also what makes autofill possible at all.
            authenticatorSelection: {
              ...config.authenticatorSelection,
              residentKey: "required",
              userVerification: "discouraged",
            },
          });
        });

      const registerVerify: PasskeyShape["registerVerify"] = Effect.fnUntraced(
        function* (userId, sessionId, input) {
          const clientDataOpt = decodeClientData(input.credential.response.clientDataJSON);
          if (Option.isNone(clientDataOpt)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyChallengeInvalid());
          }
          const clientData = clientDataOpt.value;

          if (!config.origins.includes(clientData.origin)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyOriginMismatch());
          }
          if (!originMatchesRpId(clientData.origin, config.rpId)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyRpIdMismatch());
          }

          const consumedOrdinary = yield* challengeStore.consume(
            registrationScope(sessionId),
            clientData.challenge,
          );
          let enforceUserVerification = consumedOrdinary;
          if (!consumedOrdinary) {
            const consumedConditional = yield* challengeStore.consume(
              conditionalScope(sessionId),
              clientData.challenge,
            );
            if (!consumedConditional) {
              return yield* Effect.fail(new PasskeyApi.PasskeyChallengeInvalid());
            }
            enforceUserVerification = false;
          }

          const verified = yield* webAuthn
            .verifyRegistration({
              response: toRegistrationResponseJSON(input.credential),
              expectedChallenge: clientData.challenge,
              expectedOrigin: config.origins,
              expectedRpId: config.rpId,
            })
            .pipe(
              Effect.catchTag("PasskeyVerificationFailed", () =>
                Effect.fail(new PasskeyApi.PasskeyVerificationFailed()),
              ),
            );

          if (enforceUserVerification && !verified.userVerified) {
            return yield* Effect.fail(new PasskeyApi.PasskeyUserVerificationRequired());
          }

          const webauthnUserId = toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie));
          const record = yield* credentials.create({
            id: verified.credentialId,
            userId,
            webauthnUserId,
            publicKey: verified.publicKey,
            counter: verified.counter,
            deviceType: verified.credentialDeviceType,
            backedUp: verified.credentialBackedUp,
            transports: verified.transports,
            aaguid: verified.aaguid,
            name: friendlyCredentialName(verified.aaguid),
          });
          // BEH-EA-134: an ordinary `Accounts` link — the existing
          // cross-plugin last-credential invariant (`LastAccountRefusal`)
          // applies to this credential type automatically from here on.
          yield* accounts
            .link({ userId, providerId: PASSKEY_PROVIDER_ID, subject: verified.credentialId })
            .pipe(Effect.orDie);
          return record;
        },
      );

      const authenticateOptions: PasskeyShape["authenticateOptions"] = Effect.fnUntraced(
        function* (email) {
          const ceremonyId = toBase64Url(yield* crypto.randomBytes(16).pipe(Effect.orDie));
          const challenge = yield* challengeStore.issue(authenticateScope(ceremonyId));
          let allowCredentials: ReadonlyArray<{
            readonly id: string;
            readonly transports?: ReadonlyArray<string>;
          }> = [];
          if (email !== undefined) {
            const userOpt = yield* users.findByEmail(email);
            if (Option.isSome(userOpt)) {
              const owned = yield* credentials.listByUser(userOpt.value.id);
              allowCredentials = owned.map((row) => ({ id: row.id, transports: row.transports }));
            }
          }
          const options = yield* webAuthn.authenticationOptions({
            rpId: config.rpId,
            challenge: Redacted.value(challenge),
            allowCredentials,
            ...(config.authenticatorSelection.userVerification === undefined
              ? {}
              : { userVerification: config.authenticatorSelection.userVerification }),
          });
          return { ceremonyId, options };
        },
      );

      const authenticateVerify: PasskeyShape["authenticateVerify"] = Effect.fnUntraced(
        function* (input) {
          const clientDataOpt = decodeClientData(input.credential.response.clientDataJSON);
          if (Option.isNone(clientDataOpt)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyChallengeInvalid());
          }
          const clientData = clientDataOpt.value;

          const consumed = yield* challengeStore.consume(
            authenticateScope(input.ceremonyId),
            clientData.challenge,
          );
          if (!consumed) {
            return yield* Effect.fail(new PasskeyApi.PasskeyChallengeInvalid());
          }

          // BEH-EA-136: from here on, every failure collapses into the same
          // `Api.InvalidCredentials` an unknown password-sign-in email
          // already answers — see `PasskeyApi.ts`'s own header comment.
          const storedOpt = yield* credentials.findById(input.credential.id);
          if (Option.isNone(storedOpt)) {
            return yield* Effect.fail(new Api.InvalidCredentials());
          }
          const stored = storedOpt.value;

          const verified = yield* webAuthn
            .verifyAuthentication({
              response: toAuthenticationResponseJSON(input.credential),
              expectedChallenge: clientData.challenge,
              expectedOrigin: config.origins,
              expectedRpId: config.rpId,
              credential: {
                id: stored.id,
                publicKey: new Uint8Array(stored.publicKey),
                counter: stored.counter,
              },
            })
            .pipe(
              Effect.catchTag("PasskeyVerificationFailed", () =>
                Effect.fail(new Api.InvalidCredentials()),
              ),
            );

          if (
            config.authenticatorSelection.userVerification === "required" &&
            !verified.userVerified
          ) {
            return yield* Effect.fail(new PasskeyApi.PasskeyUserVerificationRequired());
          }

          // BEH-EA-131: "log + step-up, not an instant kill" — never fails
          // the ceremony itself. `0 === 0` is the normal, expected case for
          // an authenticator that never reports a counter at all (most
          // cloud-synced passkeys), not an anomaly.
          const counterRegressed =
            verified.newCounter <= stored.counter &&
            !(verified.newCounter === 0 && stored.counter === 0);
          if (counterRegressed) {
            yield* events.publish({
              _tag: "auth.passkey.counterAnomaly",
              userId: stored.userId,
              credentialId: stored.id,
            });
          }
          yield* credentials
            .recordUsage(stored.id, verified.newCounter, verified.credentialBackedUp)
            .pipe(Effect.orDie);

          const issued = yield* sessions.issue({ userId: stored.userId }).pipe(Effect.orDie);
          yield* events.publish({
            _tag: "auth.user.signedIn",
            userId: stored.userId,
            strategy: "passkey",
          });
          return issued;
        },
      );

      const listCredentials: PasskeyShape["listCredentials"] = (userId) =>
        credentials.listByUser(userId);

      const renameCredential: PasskeyShape["renameCredential"] = (userId, id, name) =>
        credentials
          .rename(id, userId, name)
          .pipe(
            Effect.catchTag("PasskeyCredentialNotFound", () =>
              Effect.fail(new PasskeyApi.PasskeyCredentialNotFound()),
            ),
          );

      const removeCredential: PasskeyShape["removeCredential"] = Effect.fnUntraced(
        function* (userId, id) {
          const storedOpt = yield* credentials.findById(id);
          if (Option.isNone(storedOpt) || storedOpt.value.userId !== userId) {
            return yield* Effect.fail(new PasskeyApi.PasskeyCredentialNotFound());
          }
          const accountOpt = yield* accounts.findByProviderSubject(PASSKEY_PROVIDER_ID, id);
          if (Option.isNone(accountOpt)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyCredentialNotFound());
          }
          // BEH-EA-045/134: the existing cross-plugin invariant, not a
          // passkey-specific reimplementation of "don't strand the account".
          // Unlink MUST run first — it's the only place the last-credential
          // guard is enforced, so deleting the credential row before this
          // check could destroy a user's only credential despite the guard.
          // The two writes are not wrapped in one SQL transaction (`Accounts`
          // and `PasskeyCredentials` each own their own persistence, the same
          // boundary every other plugin in this codebase already respects —
          // neither `Password` nor `OAuth` spans a transaction across two
          // services either): a `credentials.delete` failure right after a
          // successful `unlink` is an environment-level failure (e.g. a
          // dropped DB connection), not a business-logic path, which is why
          // it's treated as a defect (`Effect.orDie`) rather than recovered
          // from here.
          yield* accounts.unlink(accountOpt.value.id).pipe(
            Effect.catchTags({
              AccountNotFound: () => Effect.fail(new PasskeyApi.PasskeyCredentialNotFound()),
              LastAccountRefusal: () => Effect.fail(new PasskeyApi.PasskeyLastCredential()),
            }),
          );
          yield* credentials.delete(id, userId).pipe(Effect.orDie);
        },
      );

      return Passkey.of({
        registerOptions,
        registerOptionsConditional,
        registerVerify,
        authenticateOptions,
        authenticateVerify,
        listCredentials,
        renameCredential,
        removeCredential,
      });
    }),
  });
}
