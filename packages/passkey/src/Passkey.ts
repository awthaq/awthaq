// @awthaq/passkey — Passkey
//
// spec/behaviors/17-passkey.md, BEH-EA-129 through BEH-EA-136. `Auth.make([Passkey])`
// composes: `dependsOn` is left unset on `AuthPlugin.layer` (like
// `@awthaq/password`'s own `Password.layer`, not like a cross-*plugin*
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
// (`spec.md`'s own Out of Scope). What each ceremony's challenge is scoped by
// (the caller's session id, or the anonymous sign-in's `ceremonyId`), and the
// one order in which a verify spends it, checks the origin, calls the port and
// applies policy, live in `PasskeyCeremony.ts`; this file keeps what differs
// per endpoint: admission, the posture of each refusal (BEH-EA-136), what a
// registration persists, and sign-in / step-up completion. See `PasskeyApi.ts`'s
// own header comment for how the anonymous authenticate ceremony correlates
// its two calls.

import { Api, SessionContract } from "@awthaq/api";
import {
  Accounts,
  AuthEvents,
  AuthPlugin,
  ConfigDescriptor,
  DataExport,
  Erasure,
  Errors,
  HookPoint,
  Hooks,
  Migrations,
  Observability,
  RateLimits,
  Retention,
  Sessions,
  SignIn,
  Tenant,
  Users,
} from "@awthaq/core";
import { ClientAddress, Defects, RateLimiter, WebAuthn } from "@awthaq/ports";
import { SessionDelivery } from "@awthaq/server";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Headers from "effect/unstable/http/Headers";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ChallengeStore from "./ChallengeStore.ts";
import { hmacSha256 } from "./Hmac.ts";
import * as PasskeyApi from "./PasskeyApi.ts";
import * as PasskeyCeremony from "./PasskeyCeremony.ts";
import { PasskeyConfig, type PasskeyConfigShape } from "./PasskeyConfig.ts";
import * as PasskeyCredentials from "./PasskeyCredentials.ts";
import * as PasskeyUserHandles from "./PasskeyUserHandles.ts";

export { PasskeyConfig, config } from "./PasskeyConfig.ts";
export type { AttestationPolicy, PasskeyConfigShape } from "./PasskeyConfig.ts";

/** BEH-EA-044-style reserved provider id, this plugin's own concern (BEH-EA-004: confined to its own scope). */
const PASSKEY_PROVIDER_ID = "passkey";

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

const toBase64Url = (bytes: Uint8Array): string => Encoding.encodeBase64Url(bytes);

/**
 * TC-001: shapes a decoy descriptor set can take, picked deterministically per
 * email — the mix of transports real credentials report (a synced passkey, a
 * roaming key, both).
 */
const DECOY_TRANSPORT_SETS: ReadonlyArray<ReadonlyArray<string>> = [
  ["internal", "hybrid"],
  ["internal"],
  ["usb", "nfc"],
  ["usb"],
];

/**
 * TSS-004/TC-001/WPS-005: the anonymous authenticate ceremony's rules. Three rules, all per-source or
 * per-target: a per-IP budget on each of `authenticateOptions`/`authenticateVerify` (mints server
 * state / does signature work for anyone) and a per-email budget on the username-first options call
 * (the enumeration-probing surface). Declared once: the static `rateLimits` listing is derived from
 * this table and the layer registers it with `RateLimits.budget`, where a breach is made observable
 * (EOTS-007). The per-email key is the shared TMS-006 normaliser, so `victim+1@x.com` and
 * `victim+2@x.com` share one bucket instead of each getting a fresh options budget.
 */
const rules = {
  authenticateOptionsByIp: RateLimits.rule({
    group: "passkey.authenticate",
    endpoint: "authenticateOptions",
    key: RateLimits.Key.ip,
    limit: 60,
    window: Duration.minutes(15),
  }),
  // Username-first is one call per attempt, so this is looser than a
  // password's per-account budget but still bounds probing one address.
  authenticateOptionsByEmail: RateLimits.rule({
    group: "passkey.authenticate",
    endpoint: "authenticateOptions",
    key: RateLimits.Key.email,
    limit: 10,
    window: Duration.minutes(15),
  }),
  authenticateVerifyByIp: RateLimits.rule({
    group: "passkey.authenticate",
    endpoint: "authenticateVerify",
    key: RateLimits.Key.ip,
    limit: 60,
    window: Duration.minutes(15),
  }),
};

/** TC-001: no user has this id, so listing its (empty) credentials costs what a real user's listing does. */
const DECOY_USER_ID = Users.UserId("awthaq-decoy-user");

const toCredentialDto = (
  record: PasskeyCredentials.PasskeyCredentialRecord,
): PasskeyApi.PasskeyCredentialDto =>
  new PasskeyApi.PasskeyCredentialDto({
    id: record.id,
    name: record.name,
    deviceType: record.deviceType,
    backedUp: record.backedUp,
    transports: record.transports,
    aaguid: record.aaguid,
    createdAt: DateTime.formatIso(record.createdAt),
    lastUsedAt: DateTime.formatIso(record.lastUsedAt),
    counterAnomalyAt: Option.match(record.counterAnomalyAt, {
      onNone: () => null,
      onSome: DateTime.formatIso,
    }),
  });

/** BPAS-006/TC-004: what the browser's Signals API needs for one user. */
export interface PasskeySignals {
  readonly rpId: string;
  readonly userId: string;
  readonly name: string;
  readonly displayName: string;
  readonly allAcceptedCredentialIds: ReadonlyArray<string>;
}

export interface IssuedSession {
  readonly session: Sessions.SessionView;
  readonly token: Redacted.Redacted<string>;
}

export interface PasskeyShape {
  readonly registerOptions: (
    userId: Users.UserId,
    sessionId: string,
  ) => Effect.Effect<
    PasskeyApi.PublicKeyCredentialCreationOptions,
    PasskeyApi.PasskeyReauthRequired | Errors.StoreUnavailable
  >;
  readonly registerOptionsConditional: (
    userId: Users.UserId,
    sessionId: string,
  ) => Effect.Effect<
    PasskeyApi.PublicKeyCredentialCreationOptions,
    | PasskeyApi.PasskeyConditionalCreateDisabled
    | PasskeyApi.PasskeyReauthRequired
    | Errors.StoreUnavailable
  >;
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
    | PasskeyApi.PasskeyAttestationRejected
    | PasskeyApi.PasskeyAlreadyRegistered
    | PasskeyApi.PasskeyReauthRequired
    | Errors.StoreUnavailable
  >;
  /**
   * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
   * (AAPS-001/BPAS-001): the passkey-credential half of the step-up
   * discharge path — see `PasskeyApi.PasskeyReauthenticateGroup`'s own
   * doc comment.
   */
  readonly reauthenticateOptions: (
    userId: Users.UserId,
    sessionId: string,
  ) => Effect.Effect<PasskeyApi.PublicKeyCredentialRequestOptions, Errors.StoreUnavailable>;
  readonly reauthenticateVerify: (
    userId: Users.UserId,
    sessionId: string,
    input: PasskeyApi.ReauthenticateVerifyPayload,
  ) => Effect.Effect<
    void,
    | PasskeyApi.PasskeyChallengeInvalid
    | PasskeyApi.PasskeyOriginMismatch
    | PasskeyApi.PasskeyRpIdMismatch
    | PasskeyApi.PasskeyVerificationFailed
    | PasskeyApi.PasskeyUserVerificationRequired
    | PasskeyApi.PasskeyCredentialNotFound
    | PasskeyApi.PasskeyCounterAnomaly
    | Api.Unauthenticated
    | Errors.StoreUnavailable
  >;
  readonly authenticateOptions: (input: {
    readonly email?: string | undefined;
    /** TC-001/WPS-005: the caller's address (via the `ClientAddress` port) for the per-source budget; `undefined` shares one "unknown origin" bucket, never unthrottled. */
    readonly ip?: string | undefined;
  }) => Effect.Effect<
    {
      readonly ceremonyId: string;
      readonly options: PasskeyApi.PublicKeyCredentialRequestOptions;
    },
    Api.RateLimited | Errors.StoreUnavailable
  >;
  readonly authenticateVerify: (
    input: PasskeyApi.AuthenticateVerifyPayload & { readonly ip?: string | undefined },
    /** CSD-003: extra request context recorded on the issued session (its `User-Agent`; capped by `Sessions.issue`). The address is `input.ip`. */
    context?: { readonly userAgent?: string },
  ) => Effect.Effect<
    IssuedSession,
    | Api.InvalidCredentials
    | Api.RateLimited
    | PasskeyApi.PasskeyChallengeInvalid
    | PasskeyApi.PasskeyUserVerificationRequired
    | PasskeyApi.PasskeyCounterAnomaly
    | HookPoint.HookAborted
    | Users.UserSuspended
    | Hooks.TwoFactorRequired
    | Errors.StoreUnavailable
  >;
  readonly listCredentials: (
    userId: Users.UserId,
  ) => Effect.Effect<
    ReadonlyArray<PasskeyCredentials.PasskeyCredentialRecord>,
    Errors.StoreUnavailable
  >;
  /** BPAS-006/TC-004: the rpId, stable user handle and accepted credential ids a browser's Signals API call needs. */
  readonly signals: (
    userId: Users.UserId,
  ) => Effect.Effect<PasskeySignals, Errors.StoreUnavailable>;
  /** TC-008: the origins `GET /.well-known/webauthn` serves — `PasskeyConfig.relatedOrigins` of the config in force for the request. */
  readonly relatedOrigins: Effect.Effect<ReadonlyArray<string>>;
  readonly renameCredential: (
    userId: Users.UserId,
    id: string,
    name: string,
  ) => Effect.Effect<
    PasskeyCredentials.PasskeyCredentialRecord,
    PasskeyApi.PasskeyCredentialNotFound | Errors.StoreUnavailable
  >;
  readonly removeCredential: (
    userId: Users.UserId,
    id: string,
  ) => Effect.Effect<
    void,
    | PasskeyApi.PasskeyCredentialNotFound
    | PasskeyApi.PasskeyLastCredential
    | Errors.StoreUnavailable
  >;
}

/** Same forward-reference pattern `@awthaq/password`'s own `PasswordHandlers` documents. */
const currentUserPrincipal: Effect.Effect<Api.UserPrincipal, never, Api.CurrentPrincipal> =
  Effect.gen(function* () {
    const principal = yield* Api.CurrentPrincipal;
    if (principal._tag !== "User") {
      return yield* Defects.invariantViolation(
        "NonUserPrincipal",
        `awthaq: passkey group reached with a non-User principal: ${principal._tag}`,
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
      const clientAddress = yield* ClientAddress.ClientAddress;
      return handlers.handleAll({
        authenticateOptions: Effect.fnUntraced(function* ({
          payload,
          request,
        }: {
          payload: PasskeyApi.AuthenticateOptionsPayload;
          request: HttpServerRequest.HttpServerRequest;
        }) {
          // Resolved through the application-provided `ClientAddress` port
          // (AGA-001/NHS-003), like `@awthaq/password`'s own sign-in.
          const resolvedAddress = yield* clientAddress.resolve(request);
          return yield* passkey.authenticateOptions({
            email: payload.email,
            ip: Option.getOrUndefined(resolvedAddress),
          });
        }),
        authenticateVerify: Effect.fnUntraced(function* ({
          payload,
          request,
        }: {
          payload: PasskeyApi.AuthenticateVerifyPayload;
          request: HttpServerRequest.HttpServerRequest;
        }) {
          // CSD-003: address via the application-provided `ClientAddress`
          // port (trusted-proxy aware), user agent from the header.
          // Typed local (not inferred) so declaration emit can name `SessionDto` in the group's type (TS2883).
          const response: SessionContract.SessionDto = yield* SessionDelivery.respond(
            request,
            Effect.gen(function* () {
              const resolvedAddress = yield* clientAddress.resolve(request);
              const userAgent = Headers.get(request.headers, "user-agent");
              return yield* passkey.authenticateVerify(
                { ...payload, ip: Option.getOrUndefined(resolvedAddress) },
                Option.isSome(userAgent) ? { userAgent: userAgent.value } : {},
              );
            }),
          );
          return response;
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
        listCredentials: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          const records = yield* passkey.listCredentials(Users.UserId(principal.ref.id));
          return records.map(toCredentialDto);
        }),
        signals: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          const signals = yield* passkey.signals(Users.UserId(principal.ref.id));
          return new PasskeyApi.PasskeySignalsDto(signals);
        }),
        renameCredential: Effect.fnUntraced(function* ({
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
        removeCredential: Effect.fnUntraced(function* ({
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
  HttpApiBuilder.group(
    PasskeyApi.PasskeyApi,
    "passkey.wellKnown",
    Effect.fnUntraced(function* (handlers) {
      const passkey = yield* Passkey;
      return handlers.handleAll({
        // TC-008: public by design (a browser fetches it, credentialless, from the rpId host) and 404
        // unless related origins are configured, so a deployment that never opted in exposes nothing.
        relatedOrigins: Effect.fnUntraced(function* () {
          const origins = yield* passkey.relatedOrigins;
          if (origins.length === 0)
            return yield* new PasskeyApi.PasskeyRelatedOriginsNotConfigured();
          return new PasskeyApi.RelatedOriginsDto({ origins });
        }),
      });
    }),
  ),
  HttpApiBuilder.group(
    PasskeyApi.PasskeyApi,
    "passkey.reauthenticate",
    Effect.fnUntraced(function* (handlers) {
      const passkey = yield* Passkey;
      return handlers.handleAll({
        reauthenticateOptions: Effect.fnUntraced(function* () {
          const principal = yield* currentUserPrincipal;
          return yield* passkey.reauthenticateOptions(
            Users.UserId(principal.ref.id),
            principal.sessionId,
          );
        }),
        reauthenticateVerify: Effect.fnUntraced(function* ({
          payload,
        }: {
          payload: PasskeyApi.ReauthenticateVerifyPayload;
        }) {
          const principal = yield* currentUserPrincipal;
          yield* passkey.reauthenticateVerify(
            Users.UserId(principal.ref.id),
            principal.sessionId,
            payload,
          );
        }),
      });
    }),
  ),
);

/**
 * BAM-002 (.issues/high): first migrations this plugin declares — ported
 * verbatim from `PasskeyCredentials.test.ts`'s/`ChallengeStore.test.ts`'s
 * own inline `CREATE TABLE` (each table's canonical, already-working
 * shape), dialect-branched via `sql.onDialectOrElse` like `@awthaq/sql`'s
 * own `CoreMigrations.ts`. `backedUp` mirrors `users.emailVerified`'s own
 * `BOOLEAN`(pg)/`INTEGER`(sqlite) split — `PasskeyCredentials.ts`'s own
 * `Schema.BooleanFromBit` on that column. `passkey_credential.userId` is
 * `PasskeyCredentials.ts`'s own real filter key (`listByUser`), unindexed
 * until now, the same class of gap `CoreMigrations.ts`'s own
 * `accounts_user_id`/`sessions_user_id` migrations closed;
 * `passkey_challenge.scope` needs no separate index — it's already this
 * table's own primary key. Columns left unquoted under `pg` (unlike
 * `CoreMigrations.ts`'s own `users`/`sessions` tables, like `@awthaq/jwt`'s
 * own `jwtMigrations`): both `PasskeyCredentials.ts`'s and
 * `ChallengeStore.ts`'s own queries already reference every column
 * unquoted, so Postgres's automatic lowercase-folding is what keeps
 * migration and query consistent here.
 *
 * Appended since (migrations are identified by position — never reorder):
 * WPS-005's `expiresAt` index (so reclaiming expired challenges stays a range
 * scan), WPS-006's two counter-anomaly columns, and BPAS-003's per-user
 * handle table.
 */
const passkeyMigrations: Migrations.Migrations = [
  {
    name: "create_passkey_credential",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE passkey_credential (
            id TEXT PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "webauthnUserId" TEXT NOT NULL,
            "publicKey" TEXT NOT NULL,
            counter INTEGER NOT NULL,
            "deviceType" TEXT NOT NULL,
            "backedUp" BOOLEAN NOT NULL,
            transports TEXT NOT NULL,
            aaguid TEXT NOT NULL,
            name TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "lastUsedAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE passkey_credential (
            id TEXT PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "webauthnUserId" TEXT NOT NULL,
            "publicKey" TEXT NOT NULL,
            counter INTEGER NOT NULL,
            "deviceType" TEXT NOT NULL,
            "backedUp" INTEGER NOT NULL,
            transports TEXT NOT NULL,
            aaguid TEXT NOT NULL,
            name TEXT NOT NULL,
            "createdAt" TEXT NOT NULL,
            "lastUsedAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_passkey_credential_user_id_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`CREATE INDEX passkey_credential_user_id ON passkey_credential("userId")`,
        sqlite: () => sql`CREATE INDEX passkey_credential_user_id ON passkey_credential("userId")`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_passkey_challenge",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE passkey_challenge (
            scope TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            "expiresAt" TIMESTAMPTZ NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE passkey_challenge (
            scope TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            "expiresAt" TEXT NOT NULL,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_passkey_challenge_expires_at_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`CREATE INDEX passkey_challenge_expires_at ON passkey_challenge("expiresAt")`,
        sqlite: () =>
          sql`CREATE INDEX passkey_challenge_expires_at ON passkey_challenge("expiresAt")`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "add_passkey_credential_counter_anomaly_at",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`ALTER TABLE passkey_credential ADD COLUMN "counterAnomalyAt" TIMESTAMPTZ`,
        sqlite: () => sql`ALTER TABLE passkey_credential ADD COLUMN "counterAnomalyAt" TEXT`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "add_passkey_credential_counter_anomaly_count",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`ALTER TABLE passkey_credential ADD COLUMN "counterAnomalyCount" INTEGER NOT NULL DEFAULT 0`,
        sqlite: () =>
          sql`ALTER TABLE passkey_credential ADD COLUMN "counterAnomalyCount" INTEGER NOT NULL DEFAULT 0`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_passkey_user_handle",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE passkey_user_handle (
            "userId" TEXT PRIMARY KEY,
            "webauthnUserId" TEXT NOT NULL UNIQUE,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE passkey_user_handle (
            "userId" TEXT PRIMARY KEY,
            "webauthnUserId" TEXT NOT NULL UNIQUE,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
];

/**
 * CSG-005: this plugin's section of the data-subject export — each credential's metadata
 * (a name, when it was registered and last used, device class, transports, authenticator
 * model). Never the public key, the WebAuthn user handle or the signature counter: they are
 * key material or a cloning signal, not something a person needs back (Art. 20), and the
 * export must hold no secret.
 */
export const passkeyExport = DataExport.contribute({
  id: "passkey",
  make: Effect.gen(function* () {
    const credentials = yield* PasskeyCredentials.PasskeyCredentials;
    return (subject: DataExport.DataExportSubject) =>
      credentials.listByUser(subject.userId).pipe(
        Effect.map((rows) => ({
          credentials: rows.map((row) => ({
            id: row.id,
            name: row.name,
            deviceType: row.deviceType,
            backedUp: row.backedUp,
            transports: [...row.transports],
            aaguid: row.aaguid,
            createdAt: DateTime.formatIso(row.createdAt),
            lastUsedAt: DateTime.formatIso(row.lastUsedAt),
          })),
        })),
      );
  }),
});

/**
 * Plan 10 item 6: the scheduled half of `ChallengeStore.sweepExpired` (`issue` still prunes inline: it bounds a
 * table fed by an anonymous endpoint). The store reads its own clock; `now` is the sweep's, the same instant.
 */
export const passkeyChallengeRetention = Retention.contribute({
  id: "passkey.challenges",
  make: Effect.gen(function* () {
    const challenges = yield* ChallengeStore.ChallengeStore;
    return () => challenges.sweepExpired;
  }),
});

/**
 * CSG-001/DRS-002 (.issues/high), wayfinder ticket 30: this plugin's part of
 * `AccountErasure.eraseAccount`, part of `Passkey.layer` itself (it requires
 * `Erasure.ErasureRegistry`, so a composition without one does not compile). It
 * removes the user's `passkey_credential` rows and — since BPAS-003 — their
 * stable WebAuthn user handle, inside `eraseAccount`'s transaction.
 */
export const passkeyErasure = Erasure.contribute({
  id: "passkey",
  make: Effect.gen(function* () {
    const credentials = yield* PasskeyCredentials.PasskeyCredentials;
    const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
    return (subject: Erasure.ErasureSubject) =>
      credentials
        .deleteAllByUser(subject.userId)
        .pipe(Effect.andThen(handles.deleteByUser(subject.userId)));
  }),
});

const invalidCredentials = () => new Api.InvalidCredentials();

/** BEH-EA-136: `register/verify` is authenticated and names no one else's identifier, so it reports every refusal precisely. */
const registrationPosture = {
  challenge: () => new PasskeyApi.PasskeyChallengeInvalid(),
  origin: () => new PasskeyApi.PasskeyOriginMismatch(),
  rpId: () => new PasskeyApi.PasskeyRpIdMismatch(),
  signature: () => new PasskeyApi.PasskeyVerificationFailed(),
  userVerification: () => new PasskeyApi.PasskeyUserVerificationRequired(),
  attestation: () => new PasskeyApi.PasskeyAttestationRejected(),
} satisfies PasskeyCeremony.Posture<PasskeyCeremony.RegistrationRefusal>;

/**
 * BEH-EA-136: the anonymous sign-in collapses every refusal past the challenge into the same
 * `InvalidCredentials` an unknown password-sign-in email answers. The two exceptions are refusals a
 * client must act on (verify the user; a counter anomaly), and both are reachable only after a valid
 * signature from a registered credential.
 */
const signInPosture = {
  challenge: () => new PasskeyApi.PasskeyChallengeInvalid(),
  origin: invalidCredentials,
  rpId: invalidCredentials,
  unknownCredential: invalidCredentials,
  signature: invalidCredentials,
  userHandle: invalidCredentials,
  userVerification: () => new PasskeyApi.PasskeyUserVerificationRequired(),
  counterAnomaly: () => new PasskeyApi.PasskeyCounterAnomaly(),
} satisfies PasskeyCeremony.Posture<PasskeyCeremony.AssertionRefusal>;

/** Ticket 15: step-up is authenticated as the credential's would-be owner, so it reports precisely, like registration. */
const stepUpPosture = {
  challenge: () => new PasskeyApi.PasskeyChallengeInvalid(),
  origin: () => new PasskeyApi.PasskeyOriginMismatch(),
  rpId: () => new PasskeyApi.PasskeyRpIdMismatch(),
  unknownCredential: () => new PasskeyApi.PasskeyCredentialNotFound(),
  signature: () => new PasskeyApi.PasskeyVerificationFailed(),
  userHandle: () => new PasskeyApi.PasskeyVerificationFailed(),
  userVerification: () => new PasskeyApi.PasskeyUserVerificationRequired(),
  counterAnomaly: () => new PasskeyApi.PasskeyCounterAnomaly(),
} satisfies PasskeyCeremony.Posture<PasskeyCeremony.AssertionRefusal>;

export class Passkey extends AuthPlugin.Service<Passkey, PasskeyShape>()("passkey", {
  apiVersion: 1,
  contract: PasskeyApi.PasskeyApi,
  // PV-241: the typed rule table; the static `rateLimits` listing is derived from it.
  rateLimitRules: rules,
  tables: {
    passkey_credential: AuthPlugin.Table.global(
      "user-attached credential; the directory is global",
    ),
    passkey_challenge: AuthPlugin.Table.global("a ceremony starts before any tenant is known"),
    passkey_user_handle: AuthPlugin.Table.global("user-attached; the directory is global"),
  },
  migrations: passkeyMigrations,
  // Plan 08 (BEH-EA-T4): the credential, user-handle and challenge stores, memory and SQL, matched.
  records: {
    memory: Layer.mergeAll(
      PasskeyCredentials.layerMemory,
      PasskeyUserHandles.layerMemory,
      ChallengeStore.layerMemory,
    ),
    sql: Layer.mergeAll(
      PasskeyCredentials.layerSql,
      PasskeyUserHandles.layerSql,
      ChallengeStore.layerSql,
    ),
  },
  // ECS-008/BEH-EA-229: the dev defaults (`localhost`, an `http` origin) are the classic thing left in production.
  config: [
    ConfigDescriptor.make(PasskeyConfig, {
      sensitive: [],
      audit: (value, environment) => [
        ...(environment.production && value.rpId === "localhost"
          ? [
              ConfigDescriptor.finding(
                "warning",
                "passkey-rp-id-localhost",
                "the relying-party id is still the development default `localhost`",
              ),
            ]
          : []),
        ...(environment.production && value.origins.some((origin) => origin.startsWith("http://"))
          ? [
              ConfigDescriptor.finding(
                "warning",
                "passkey-origin-not-https",
                "an allowed origin uses plain http",
              ),
            ]
          : []),
      ],
    }),
  ],
}) {
  static readonly layer = AuthPlugin.layer(Passkey, {
    ports: [ClientAddress.ClientAddress, RateLimiter.RateLimiter, WebAuthn.WebAuthn],
    handlers: PasskeyHandlers,
    contributes: Layer.mergeAll(passkeyErasure, passkeyExport, passkeyChallengeRetention),
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const accounts = yield* Accounts.Accounts;
      const events = yield* AuthEvents.AuthEvents;
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challengeStore = yield* ChallengeStore.ChallengeStore;
      const credentials = yield* PasskeyCredentials.PasskeyCredentials;
      const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
      // EP-007 (ADR-EA-018 Decision 8): the ceremony policy — rpId, origins, attestation,
      // user verification, counter-anomaly posture, reauth window — is decided per operation, so a
      // tenant's `Passkey.config(...)` provided in the calling fiber applies to that request; with
      // none, the build-time value applies exactly as before. The boot validations below and the
      // decoy `enumerationSecret` are boot-scoped by nature and read the built value.
      const builtConfig = yield* PasskeyConfig;
      const configNow = Tenant.configInForce(PasskeyConfig, builtConfig);
      const crypto = yield* Crypto.Crypto;
      // ADR-EA-038: the gate, the sign-in veto, the MFA divert point and the announcement.
      const signIn = yield* SignIn.make;
      // The one implementation of what a ceremony verifies and in which order (BEH-EA-132).
      const ceremonies = yield* PasskeyCeremony.make;

      // ---- layer-build validation and operator warnings --------------------

      // TC-003: the browser's prompt must not outlive the challenge it answers.
      if (
        Duration.toMillis(builtConfig.ceremonyTimeout) >
        Duration.toMillis(ChallengeStore.CHALLENGE_TTL)
      ) {
        return yield* Defects.invalidConfiguration(
          "ceremonyTimeout",
          "awthaq: PasskeyConfig.ceremonyTimeout must not exceed the challenge TTL (five minutes, BEH-EA-132)",
        );
      }
      // TC-008: a related origin the browser could never match (or that would widen the origin policy
      // beyond an exact https origin) is a configuration error, not something to serve at the well-known URL.
      const badRelated = builtConfig.relatedOrigins.find(
        (origin) => !PasskeyCeremony.isHttpsOrigin(origin),
      );
      if (badRelated !== undefined) {
        return yield* Defects.invalidConfiguration(
          "relatedOrigins",
          "awthaq: PasskeyConfig.relatedOrigins must be exact https origins (scheme and host[:port], no path or trailing slash)",
        );
      }
      // HSK-002: conveyance is a request, not a verification.
      if (builtConfig.attestation !== "none" && builtConfig.attestationPolicy === undefined) {
        yield* Effect.logWarning(
          `awthaq: PasskeyConfig.attestation is "${builtConfig.attestation}" but no attestationPolicy is set — attestation is requested but nothing is verified or enforced (conveyance is not verification). Set attestationPolicy.trustedAaguids to make it binding.`,
        );
      }
      // WPS-009/BEH-EA-132: a stateless store bounds replay by TTL only.
      if (!challengeStore.guarantees.singleUse) {
        yield* Effect.logWarning(
          "awthaq: the configured ChallengeStore does not guarantee single-use challenges (BEH-EA-132's statefulness requirement) — a captured challenge stays replayable until its TTL. Prefer ChallengeStore.layerMemory or layerSql.",
        );
      }
      // TC-001: decoys are keyed by a secret so they are unguessable and stable per email.
      const enumerationSecret =
        builtConfig.enumerationSecret ??
        (yield* Effect.gen(function* () {
          yield* Effect.logWarning(
            "awthaq: PasskeyConfig.enumerationSecret is not set — a random per-process secret is used for the decoy allowCredentials of unknown emails, so decoys differ across instances/restarts. Set one shared secret for multi-instance deployments.",
          );
          return Redacted.make(toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie)));
        }));
      const enumerationKey = new TextEncoder().encode(Redacted.value(enumerationSecret));

      // BEH-EA-107/110/111: the table above is registered (introspectable) and spent through one
      // budget; a breach is published, logged and counted, and answers `Api.RateLimited` (EOTS-007).
      const limits = yield* RateLimits.budget(Passkey);

      /**
       * Ticket 15 (BPAS-001): the freshness gate `registerOptions`/
       * `registerOptionsConditional`/`registerVerify` all apply before doing anything
       * else. The rule is `Sessions.requireFresh` (BEH-EA-320): a session that is not
       * live for its owner fails closed the same as a stale one. This maps it to the
       * plugin's own wire error.
       */
      const requireFreshSession = (userId: Users.UserId, sessionId: string) =>
        Effect.gen(function* () {
          const config = yield* configNow;
          yield* sessions
            .requireFresh(userId, Sessions.SessionId(sessionId), config.reauthMaxAgeSeconds)
            .pipe(
              Effect.catchTag("Sessions/Stale", (stale) =>
                Effect.fail(
                  new PasskeyApi.PasskeyReauthRequired({ maxAgeSeconds: stale.maxAgeSeconds }),
                ),
              ),
            );
        });

      /** TC-003: the knobs every options generator sets explicitly. */
      const ceremonyKnobsOf = (config: PasskeyConfigShape) => ({
        timeout: config.ceremonyTimeout,
        ...(config.hints === undefined ? {} : { hints: config.hints }),
        ...(config.extensions === undefined ? {} : { extensions: config.extensions }),
      });

      /** BPAS-003: one stable per-user handle in every registration's options; `credentials.create` stores exactly it. */
      const creationOptions = Effect.fnUntraced(function* (
        userId: Users.UserId,
        ceremony: PasskeyCeremony.Registration,
        authenticatorSelection: WebAuthn.AuthenticatorSelection,
      ) {
        const config = yield* configNow;
        const user = yield* users.findById(userId).pipe(Effect.orDie);
        const existing = yield* credentials.listByUser(userId);
        const challenge = yield* ceremonies.begin(ceremony);
        const webauthnUserId = yield* handles.getOrCreate(userId);
        const options = yield* webAuthn.registrationOptions({
          rpId: config.rpId,
          rpName: config.rpName,
          challenge: Redacted.value(challenge),
          userId: webauthnUserId,
          userName: Users.accountLabel(user),
          userDisplayName: user.name,
          excludeCredentials: existing.map((row) => ({ id: row.id, transports: row.transports })),
          attestation: config.attestation,
          authenticatorSelection,
          ...ceremonyKnobsOf(config),
        });
        return yield* Schema.decodeUnknownEffect(
          PasskeyApi.PublicKeyCredentialCreationOptionsSchema,
        )(options).pipe(Effect.orDie);
      });

      const requestOptions = Effect.fnUntraced(function* (
        input: WebAuthn.AuthenticationOptionsInput,
      ) {
        const options = yield* webAuthn.authenticationOptions(input);
        return yield* Schema.decodeUnknownEffect(
          PasskeyApi.PublicKeyCredentialRequestOptionsSchema,
        )(options).pipe(Effect.orDie);
      });

      const registerOptions: PasskeyShape["registerOptions"] = Effect.fnUntraced(
        function* (userId, sessionId) {
          const config = yield* configNow;
          yield* requireFreshSession(userId, sessionId);
          return yield* creationOptions(
            userId,
            PasskeyCeremony.Ceremony.Registration({ sessionId, mode: "modal" }),
            config.authenticatorSelection,
          );
        },
      );

      const registerOptionsConditional: PasskeyShape["registerOptionsConditional"] =
        Effect.fnUntraced(function* (userId, sessionId) {
          const config = yield* configNow;
          yield* requireFreshSession(userId, sessionId);
          // CB-009: Conditional Create cannot produce UV=1, so it is unavailable
          // whenever the RP requires user verification.
          if (
            !config.conditionalCreate ||
            config.authenticatorSelection.userVerification === "required"
          ) {
            return yield* Effect.fail(new PasskeyApi.PasskeyConditionalCreateDisabled());
          }
          // BEH-EA-256: Chrome's Conditional Create flow produces
          // UP=0/UV=0 — a `residentKey: "required"` discoverable
          // credential is also what makes autofill possible at all.
          return yield* creationOptions(
            userId,
            PasskeyCeremony.Ceremony.Registration({ sessionId, mode: "conditional" }),
            {
              ...config.authenticatorSelection,
              residentKey: "required",
              userVerification: "discouraged",
            },
          );
        });

      const registerVerify: PasskeyShape["registerVerify"] = Effect.fnUntraced(
        function* (userId, sessionId, input) {
          const config = yield* configNow;
          // Admission (BEH-EA-255): a stale session is refused before the attempt starts, so its
          // challenge survives the step-up that discharges the gate (BEH-EA-132).
          yield* requireFreshSession(userId, sessionId);
          const verified = yield* ceremonies
            .verifyRegistration({
              ceremony: PasskeyCeremony.Ceremony.Registration({
                sessionId,
                mode: input.ceremony ?? "modal",
              }),
              credential: input.credential,
              policy: config,
            })
            .pipe(
              Effect.catchTag("PasskeyCeremony/RegistrationRefused", (refused) =>
                Effect.fail(registrationPosture[refused.reason]()),
              ),
            );

          // BPAS-003: exactly the handle the options ceremony sent — the
          // authenticator bound this same per-user value.
          const webauthnUserId = yield* handles.getOrCreate(userId);
          const record = yield* credentials
            .create({
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
            })
            .pipe(
              // WPS-010: nothing is linked to `Accounts` for a duplicate.
              Effect.catchTag("PasskeyCredentialAlreadyExists", () =>
                Effect.fail(new PasskeyApi.PasskeyAlreadyRegistered()),
              ),
            );
          // BEH-EA-134: an ordinary `Accounts` link — the existing
          // cross-plugin last-credential invariant (`LastAccountRefusal`)
          // applies to this credential type automatically from here on.
          yield* accounts
            .link({ userId, providerId: PASSKEY_PROVIDER_ID, subject: verified.credentialId })
            .pipe(Effect.orDie);
          return record;
        },
      );

      /**
       * TC-001: deterministic decoy descriptors for an email with no usable
       * credentials — `k = 1 + (h[0] mod 2)` ids, each the HMAC of
       * `(secret, email, i)` (so stable per email, unguessable without the
       * secret), with a transports mix picked from the same digest. Shaped
       * like a registered user's `allowCredentials`, so the options response
       * does not reveal which emails exist.
       */
      const decoyDescriptors = (email: string) =>
        Effect.gen(function* () {
          const normalized = email.toLowerCase();
          const seed = yield* hmacSha256(
            crypto,
            enumerationKey,
            new TextEncoder().encode(`passkey.decoy:${normalized}`),
          );
          const count = 1 + ((seed[0] ?? 0) % 2);
          return yield* Effect.forEach(
            Array.from({ length: count }, (_, i) => i),
            (i) =>
              Effect.gen(function* () {
                const digest = yield* hmacSha256(
                  crypto,
                  enumerationKey,
                  new TextEncoder().encode(`passkey.decoy:${normalized}:${i}`),
                );
                const transports =
                  DECOY_TRANSPORT_SETS[(digest[1] ?? 0) % DECOY_TRANSPORT_SETS.length] ?? [];
                return { id: toBase64Url(digest), transports };
              }),
          );
        });

      const authenticateOptions: PasskeyShape["authenticateOptions"] = Effect.fnUntraced(
        function* ({ email, ip }) {
          const config = yield* configNow;
          yield* limits.spend("authenticateOptionsByIp", { ip });
          if (email !== undefined) {
            yield* limits.spend("authenticateOptionsByEmail", { email });
          }
          const ceremonyId = toBase64Url(yield* crypto.randomBytes(16).pipe(Effect.orDie));
          const challenge = yield* ceremonies.begin(
            PasskeyCeremony.Ceremony.SignIn({ ceremonyId }),
          );
          let allowCredentials: ReadonlyArray<{
            readonly id: string;
            readonly transports?: ReadonlyArray<string>;
          }> = [];
          if (email !== undefined) {
            // The same lookups run whether or not the email exists, so the
            // work (and the shape of the answer) does not tell the two apart.
            const userOpt = yield* users.findByEmail(email);
            const owned = yield* credentials.listByUser(
              Option.isSome(userOpt) ? userOpt.value.id : DECOY_USER_ID,
            );
            allowCredentials =
              owned.length > 0
                ? owned.map((row) => ({ id: row.id, transports: row.transports }))
                : yield* decoyDescriptors(email);
          }
          const options = yield* requestOptions({
            rpId: config.rpId,
            challenge: Redacted.value(challenge),
            allowCredentials,
            ...(config.authenticatorSelection.userVerification === undefined
              ? {}
              : { userVerification: config.authenticatorSelection.userVerification }),
            ...ceremonyKnobsOf(config),
          });
          return { ceremonyId, options };
        },
      );

      const authenticateCeremony: PasskeyShape["authenticateVerify"] = Effect.fnUntraced(
        function* (input, context) {
          const config = yield* configNow;
          // Admission (plan 06): the per-source budget first: cheap to enforce, bounds signature
          // work and challenge probing from one address, and spent before the attempt starts.
          yield* limits.spend("authenticateVerifyByIp", { ip: input.ip });
          const { credential, amr } = yield* ceremonies
            .verifyAssertion({
              ceremony: PasskeyCeremony.Ceremony.SignIn({ ceremonyId: input.ceremonyId }),
              credential: input.credential,
              policy: config,
            })
            .pipe(
              Effect.catchTag("PasskeyCeremony/AssertionRefused", (refused) =>
                Effect.fail(signInPosture[refused.reason]()),
              ),
            );

          // ADR-EA-038: core's sign-in completes it (lookup, gate, veto, MFA divert, session,
          // announcement). WPS-001: a deleted user's passkey credential row can outlive the
          // account (no FK, no cascade), and cryptographic verification above only proves possession
          // of *a* registered authenticator, never that the account it names still exists; a missing
          // user collapses to the same uniform `InvalidCredentials` as every other failure in this
          // ceremony (BEH-EA-136). THS-003/HSK-005: `amr` is the kind of key (hardware-bound or
          // synced), plus user verification when the authenticator performed it.
          return yield* signIn
            .complete(
              { userId: credential.userId, strategy: "passkey", amr },
              { ip: input.ip, userAgent: context?.userAgent },
            )
            .pipe(
              Effect.catchTag("SignIn/UserGone", () => Effect.fail(new Api.InvalidCredentials())),
            );
        },
      );

      /**
       * CSD-004: a failed assertion is the passkey strategy's failure signal —
       * `auth.user.signInFailed`, so a stuffing/probing detector sees every
       * strategy. Only the ceremony's own refusals count; a rate-limit, a
       * `BeforeSignIn` veto or a second-factor divert are not failed assertions.
       */
      const authenticateVerify: PasskeyShape["authenticateVerify"] = (input, context) =>
        authenticateCeremony(input, context).pipe(
          Effect.tapError((error) =>
            error._tag === "InvalidCredentials" ||
            error._tag === "PasskeyChallengeInvalid" ||
            error._tag === "PasskeyUserVerificationRequired" ||
            error._tag === "PasskeyCounterAnomaly"
              ? events.publish({
                  _tag: "auth.user.signInFailed",
                  strategy: "passkey",
                  reason: "assertionInvalid",
                  ...(input.ip === undefined ? {} : { clientIp: input.ip }),
                })
              : Effect.void,
          ),
          // EOTS-001: `awthaq.passkey.authenticateVerify`.
          Observability.authSpan("awthaq.passkey.authenticateVerify", {
            "awthaq.plugin": "passkey",
            [Observability.Field.strategy]: "passkey",
          }),
        );

      const listCredentials: PasskeyShape["listCredentials"] = (userId) =>
        credentials.listByUser(userId);

      const relatedOrigins: PasskeyShape["relatedOrigins"] = Effect.map(
        configNow,
        (config) => config.relatedOrigins,
      );

      const signals: PasskeyShape["signals"] = Effect.fnUntraced(function* (userId) {
        const config = yield* configNow;
        const user = yield* users.findById(userId).pipe(Effect.orDie);
        const owned = yield* credentials.listByUser(userId);
        return {
          rpId: config.rpId,
          userId: yield* handles.getOrCreate(userId),
          name: Users.accountLabel(user),
          displayName: user.name,
          allAcceptedCredentialIds: owned.map((row) => row.id),
        };
      });

      const renameCredential: PasskeyShape["renameCredential"] = (userId, id, name) =>
        credentials
          .rename(id, userId, name)
          .pipe(
            Effect.catchTag("PasskeyCredentials/NotFound", () =>
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
          yield* credentials
            .delete(id, userId)
            .pipe(Effect.catchTag("PasskeyCredentials/NotFound", Effect.die));
        },
      );

      const reauthenticateOptions: PasskeyShape["reauthenticateOptions"] = Effect.fnUntraced(
        function* (userId, sessionId) {
          const config = yield* configNow;
          const owned = yield* credentials.listByUser(userId);
          const challenge = yield* ceremonies.begin(
            PasskeyCeremony.Ceremony.StepUp({ sessionId, userId }),
          );
          return yield* requestOptions({
            rpId: config.rpId,
            challenge: Redacted.value(challenge),
            allowCredentials: owned.map((row) => ({ id: row.id, transports: row.transports })),
            // Ticket 15: UV=1, unconditionally — this ceremony's whole
            // purpose is proving fresh possession-plus-verification, not
            // merely possession, unlike ordinary `authenticateOptions`
            // which defers to `config.authenticatorSelection`.
            userVerification: "required",
            ...ceremonyKnobsOf(config),
          });
        },
      );

      const reauthenticateVerify: PasskeyShape["reauthenticateVerify"] = Effect.fnUntraced(
        function* (userId, sessionId, input) {
          const config = yield* configNow;
          const { amr } = yield* ceremonies
            .verifyAssertion({
              ceremony: PasskeyCeremony.Ceremony.StepUp({ sessionId, userId }),
              credential: input.credential,
              policy: config,
            })
            .pipe(
              Effect.catchTag("PasskeyCeremony/AssertionRefused", (refused) =>
                Effect.fail(stepUpPosture[refused.reason]()),
              ),
            );

          // BEH-EA-319: ended since the middleware's verify (revoked, superseded,
          // expired) is "no longer authenticated": 401, not a defect.
          yield* sessions
            .reauthenticate(userId, Sessions.SessionId(sessionId), amr)
            .pipe(
              Effect.catchTag("Sessions/NotFound", () => Effect.fail(new Api.Unauthenticated())),
            );
        },
      );

      return Passkey.of({
        registerOptions,
        registerOptionsConditional,
        registerVerify,
        authenticateOptions,
        authenticateVerify,
        listCredentials,
        signals,
        relatedOrigins,
        renameCredential,
        removeCredential,
        reauthenticateOptions,
        reauthenticateVerify,
      });
    }),
  });
}
