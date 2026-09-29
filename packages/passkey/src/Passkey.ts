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
// (`spec.md`'s own Out of Scope) — so both registration ceremonies key
// their own `ChallengeStore` scope by the caller's session id, known at
// both `.../options` and `.../verify` time. The authenticate ceremony has
// no session yet (it's how one is created); see `PasskeyApi.ts`'s own
// header comment for how it correlates its two anonymous calls instead.

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
  Sessions,
  Users,
} from "@awthaq/core";
import { ClientAddress, Defects, RateLimiter, WebAuthn } from "@awthaq/ports";
import { SessionDelivery } from "@awthaq/server";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Headers from "effect/unstable/http/Headers";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ChallengeStore from "./ChallengeStore.ts";
import { hmacSha256 } from "./Hmac.ts";
import * as PasskeyApi from "./PasskeyApi.ts";
import * as PasskeyCredentials from "./PasskeyCredentials.ts";
import * as PasskeyUserHandles from "./PasskeyUserHandles.ts";

/**
 * HSK-005/THS-003 (BEH-EA-258): how a verified assertion authenticated the user, as RFC 8176
 * method references — `hwk` for a device-bound (`singleDevice`) credential, `swk` for a synced
 * (`multiDevice`) one, plus `user` when the authenticator performed user verification. This is
 * what lets a policy require a hardware-bound key (`amr contains "hwk"`) or user verification,
 * and what `Assurance` maps onto aal2/aal3.
 */
const passkeyAmr = (verified: {
  readonly credentialDeviceType: "singleDevice" | "multiDevice";
  readonly userVerified: boolean;
}): ReadonlyArray<Sessions.AuthMethod> => {
  const key: Sessions.AuthMethod = verified.credentialDeviceType === "singleDevice" ? "hwk" : "swk";
  return verified.userVerified ? [key, "user"] : [key];
};

/** BEH-EA-044-style reserved provider id, this plugin's own concern (BEH-EA-004: confined to its own scope). */
const PASSKEY_PROVIDER_ID = "passkey";

/**
 * HSK-002: what a registration's attestation must satisfy. Conveyance
 * (`PasskeyConfigShape.attestation`) is only a *request* — it decides nothing
 * by itself. With a policy, `register/verify` rejects (as
 * `PasskeyAttestationRejected`) a registration that carries no attestation,
 * a self-signed one (unless `rejectSelfAttestation: false`), or whose
 * authenticator model (AAGUID) is not in `trustedAaguids`.
 *
 * What this is **not**: FIDO Metadata Service (MDS3) validation, which stays
 * deferred (BEH-EA-135). An AAGUID is only as trustworthy as the attestation
 * carrying it — for a `certificate` attestation the wrapped library checks the
 * statement's signature, and validates the certificate chain against a root
 * store only if the host has installed one in `@simplewebauthn/server`'s
 * (process-global) settings service. Without roots, `trustedAaguids` is a
 * model *allow-list*, not proof of provenance.
 */
export interface AttestationPolicy {
  /** Authenticator models (canonical `8-4-4-4-12` AAGUIDs, case-insensitive) a registration may come from. */
  readonly trustedAaguids: ReadonlyArray<string>;
  /** Defaults to `true`: a self-attestation says nothing about the authenticator model, so it cannot satisfy an allow-list. */
  readonly rejectSelfAttestation?: boolean;
}

export interface PasskeyConfigShape {
  readonly rpId: string;
  readonly rpName: string;
  /**
   * BEH-EA-133: exact `(scheme, host, port)` tuples — never a bare host.
   * MNA-007: a native Android app's assertions carry an
   * `android:apk-key-hash:<base64url SHA-256 of the signing certificate>`
   * origin instead of a web one — list it here verbatim (and publish the
   * matching Digital Asset Links statement for `rpId`). Such an origin is an
   * exact-match origin exempt from the web rpId-suffix check; the RP-ID
   * binding itself is still enforced by the authenticator data's `rpIdHash`.
   */
  readonly origins: ReadonlyArray<string>;
  /**
   * CB-003: top-level origins a ceremony may run *embedded* under (a
   * cross-origin iframe). A ceremony whose client data reports
   * `crossOrigin: true` is refused unless its `topOrigin` is listed here;
   * the default `[]` refuses every embedded ceremony.
   */
  readonly allowedTopOrigins: ReadonlyArray<string>;
  /** BEH-EA-135: defaults to `"none"`. Conveyance ≠ verification — see `attestationPolicy`. */
  readonly attestation: WebAuthn.AttestationConveyance;
  /** HSK-002: absent ⇒ no trust decision is made on attestation, and `Passkey.layer` warns when `attestation` asks for one anyway. */
  readonly attestationPolicy?: AttestationPolicy;
  readonly authenticatorSelection: WebAuthn.AuthenticatorSelection;
  /**
   * Ticket 07: defaults to `true`, per this spec's own "richness over complexity" decision.
   *
   * HSK-007: Conditional Create always requests `residentKey: "required"` (a
   * discoverable credential is also what makes autofill possible), so U2F-only
   * and early-CTAP2 security keys — which cannot store one — cannot complete
   * it. A fleet of such keys should set this to `false`.
   *
   * CB-009: Chrome's Conditional Create cannot produce UV=1, so it is
   * implicitly disabled whenever `authenticatorSelection.userVerification` is
   * `"required"` — `registerOptionsConditional` answers
   * `PasskeyConditionalCreateDisabled` rather than issue options that could
   * only yield a credential the policy would refuse.
   */
  readonly conditionalCreate: boolean;
  /**
   * TC-003: how long the *browser* lets a ceremony run, sent as the options'
   * `timeout`. Must not exceed the server's challenge TTL
   * (`ChallengeStore.CHALLENGE_TTL`, five minutes, fixed by BEH-EA-132) —
   * `Passkey.layer` refuses to build otherwise — so the browser's prompt never
   * outlives the challenge it answers. Defaults to 4m30s.
   */
  readonly ceremonyTimeout: Duration.Duration;
  /** TC-003: WebAuthn L3 `hints` sent with every options response (which kind of authenticator to prompt for). */
  readonly hints?: ReadonlyArray<WebAuthn.CeremonyHint>;
  /** TC-003: client extension inputs requested on registration/authentication (absent ⇒ the wrapped library's defaults, `credProps` on registration). */
  readonly extensions?: WebAuthn.CeremonyExtensions;
  /**
   * CB-004/WPS-006: what a signature-counter regression (a possibly cloned
   * authenticator) does. `"flag"` (default, wayfinder ticket 08's "log +
   * step-up, not an instant kill"): publish `auth.passkey.counterAnomaly`,
   * flag the credential, still complete the ceremony — the flagged credential
   * then needs user verification on every later use. `"reject"`: additionally
   * fail the ceremony with `PasskeyCounterAnomaly`.
   */
  readonly counterAnomalyPolicy: "flag" | "reject";
  /**
   * TC-001: keys the deterministic decoy `allowCredentials` an unknown email
   * receives. Absent ⇒ a random per-process secret is generated at layer
   * build (with a warning): decoys are then stable only within one process, so
   * a multi-instance deployment should set one shared secret.
   */
  readonly enumerationSecret?: Redacted.Redacted<string>;
  /**
   * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
   * (BPAS-001): a baked-in, fail-closed freshness gate on enrollment —
   * mirroring `@awthaq/admin`'s own `AdminConfig.canImpersonate`
   * precedent (a core safety invariant a plugin bakes in itself, not left
   * to an app-composed qadi policy the host might forget to attach).
   * Defaults to 5 minutes, matching the `reauth(300)` example already in
   * `@awthaq/qadi`'s own `Resolvers.ts` doc comments.
   */
  readonly reauthMaxAgeSeconds: Duration.Duration;
}

const defaultPasskeyConfig: PasskeyConfigShape = {
  // Deliberately insecure-looking dev defaults, the same posture
  // `@awthaq/oauth`'s own `OAuthConfig.baseUrl` default takes — real
  // deployments are expected to override every one of these via `config()`.
  rpId: "localhost",
  rpName: "awthaq",
  origins: ["http://localhost:3000"],
  allowedTopOrigins: [],
  attestation: "none",
  authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  conditionalCreate: true,
  reauthMaxAgeSeconds: Duration.minutes(5),
  ceremonyTimeout: Duration.seconds(270),
  counterAnomalyPolicy: "flag",
};

/** BEH-EA-017's `Context.Reference`-with-default pattern, applied to this plugin's own policy knobs. */
export const PasskeyConfig: Context.Reference<PasskeyConfigShape> = Context.Reference(
  "awthaq/passkey/Config",
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
  /** CB-003: reported by the browser for a ceremony run inside a cross-origin iframe. */
  crossOrigin: Schema.optionalKey(Schema.Boolean),
  topOrigin: Schema.optionalKey(Schema.String),
});

type ClientData = typeof ClientDataSchema.Type;

/**
 * Reads only `origin`/`challenge`/`type` (and the cross-origin members) out of
 * the browser's `clientDataJSON` — plain base64url + JSON decoding, not
 * attestation or signature verification (BEH-EA-129's own prohibition is about
 * the latter, never about reading a JSON field). Used to look up the right
 * `ChallengeStore` scope and to pre-check origin/rpId before ever calling
 * the `WebAuthn` port.
 */
const decodeClientData = (clientDataJSON: string): Option.Option<ClientData> => {
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

/** MNA-007: the origin a native Android app's assertions carry (`android:apk-key-hash:<base64url SHA-256 of the signing cert>`). */
const ANDROID_APK_KEY_HASH_ORIGIN_PREFIX = "android:apk-key-hash:";

/**
 * The one origin policy every ceremony applies (BEH-EA-133, MNA-007, CB-003):
 * 1. the ceremony's origin is an exact member of `origins`;
 * 2. a ceremony run cross-origin (`crossOrigin: true`, i.e. inside an
 *    iframe) must name a `topOrigin` the host explicitly allows — the wrapped
 *    library only rejects this for authentication, and only when the browser
 *    reports `topOrigin`, so registration and step-up would otherwise accept
 *    an embedded ceremony;
 * 3. a web origin's host is `rpId` or a subdomain of it (never a bare host
 *    match); an `android:apk-key-hash:` origin is exempt from that web-only
 *    check — it is accepted only by being listed verbatim in `origins`.
 */
const checkOrigin = (
  clientData: ClientData,
  config: PasskeyConfigShape,
): Effect.Effect<void, PasskeyApi.PasskeyOriginMismatch | PasskeyApi.PasskeyRpIdMismatch> => {
  if (!config.origins.includes(clientData.origin)) {
    return Effect.fail(new PasskeyApi.PasskeyOriginMismatch());
  }
  if (
    clientData.crossOrigin === true &&
    (clientData.topOrigin === undefined || !config.allowedTopOrigins.includes(clientData.topOrigin))
  ) {
    return Effect.fail(new PasskeyApi.PasskeyOriginMismatch());
  }
  if (clientData.origin.startsWith(ANDROID_APK_KEY_HASH_ORIGIN_PREFIX)) return Effect.void;
  if (!originMatchesRpId(clientData.origin, config.rpId)) {
    return Effect.fail(new PasskeyApi.PasskeyRpIdMismatch());
  }
  return Effect.void;
};

/** CB-003: only forwarded to the port when the host allows any embedded ceremony at all. */
const topOriginExpectation = (
  config: PasskeyConfigShape,
): { readonly expectedTopOrigin?: ReadonlyArray<string> } =>
  config.allowedTopOrigins.length === 0 ? {} : { expectedTopOrigin: config.allowedTopOrigins };

/** HSK-003: the authenticator transports this plugin stores and echoes back into `excludeCredentials`/`allowCredentials`; anything else a browser reports is dropped. */
const KNOWN_TRANSPORTS: ReadonlyArray<string> = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
];

const toRegistrationResponseJSON = (
  input: PasskeyApi.RegistrationCredentialInput,
): Parameters<WebAuthn.WebAuthnShape["verifyRegistration"]>[0]["response"] => ({
  id: input.id,
  rawId: input.rawId,
  response: {
    clientDataJSON: input.response.clientDataJSON,
    attestationObject: input.response.attestationObject,
    ...(input.response.transports === undefined
      ? {}
      : {
          transports: input.response.transports.filter((transport) =>
            KNOWN_TRANSPORTS.includes(transport),
          ),
        }),
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

/**
 * TSS-004: a fixed, well-formed COSE ES256 public key nobody holds the private
 * half of (generated once, offline). An assertion naming an unknown credential
 * id is verified against it and the result discarded, so the unknown-credential
 * path performs the same signature verification a known credential's does —
 * the way `@awthaq/password`'s `dummyHash` equalizes an unknown email.
 */
const DECOY_COSE_PUBLIC_KEY =
  "pQECAyYgASFYIDUd8pj_isGtVhaCN1Bo9s3jMUGZnyfu_woIMrJon1KjIlggExq74U54Cegms_CY6g320bYfldpa89-O72ccIzqVy9s";

const decoyPublicKey = (): Uint8Array<ArrayBuffer> => {
  const decoded = Encoding.decodeBase64Url(DECOY_COSE_PUBLIC_KEY);
  return Result.isSuccess(decoded) ? new Uint8Array(decoded.success) : new Uint8Array();
};

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
 * TSS-004/TC-001/WPS-005: the anonymous authenticate ceremony's rules. Three
 * rules, all per-source or per-target — a per-IP budget on each of
 * `authenticateOptions`/`authenticateVerify` (mints server state / does
 * signature work for anyone) and a per-email budget on the username-first
 * options call (the enumeration-probing surface). `RateLimits.enforce` is the
 * one place a breach becomes observable (EOTS-007).
 */
const RATE_LIMITS = {
  authenticateOptionsByIp: {
    endpoint: "authenticateOptions",
    dimension: "ip",
    limit: 60,
    window: Duration.minutes(15),
  },
  // Username-first is one call per attempt, so this is looser than a
  // password's per-account budget but still bounds probing one address.
  authenticateOptionsByEmail: {
    endpoint: "authenticateOptions",
    dimension: "identity",
    limit: 10,
    window: Duration.minutes(15),
  },
  authenticateVerifyByIp: {
    endpoint: "authenticateVerify",
    dimension: "ip",
    limit: 60,
    window: Duration.minutes(15),
  },
} as const satisfies Record<
  string,
  {
    readonly endpoint: string;
    readonly dimension: "ip" | "identity";
    readonly limit: number;
    readonly window: Duration.Duration;
  }
>;

type RateLimitRuleName = keyof typeof RATE_LIMITS;

const ruleMeta = (name: RateLimitRuleName): RateLimits.EnforceMeta => ({
  group: "passkey.authenticate",
  endpoint: RATE_LIMITS[name].endpoint,
  rule: name,
  dimension: RATE_LIMITS[name].dimension,
});

/** `RateLimits.RateLimitKey`'s `input` is untyped, so pulling `email` back out needs a real narrowing check, not a cast. */
const emailFromRateLimitInput = (input: unknown): string =>
  typeof input === "object" && input !== null && "email" in input && typeof input.email === "string"
    ? input.email
    : "";

/** TC-001: no user has this id, so listing its (empty) credentials costs what a real user's listing does. */
const DECOY_USER_ID = Users.UserId("awthaq-decoy-user");

const registrationScope = (sessionId: string): string => `passkey.register:${sessionId}`;
const conditionalScope = (sessionId: string): string => `passkey.register.conditional:${sessionId}`;
const authenticateScope = (ceremonyId: string): string => `passkey.authenticate:${ceremonyId}`;
/** Ticket 15: scoped by the caller's own session id, mirroring `registrationScope` — this ceremony always has one, unlike `passkey.authenticate`'s anonymous `ceremonyId`. */
const reauthenticateScope = (sessionId: string): string => `passkey.reauthenticate:${sessionId}`;

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
  ) => Effect.Effect<PasskeyApi.PublicKeyCredentialRequestOptions>;
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
  ) => Effect.Effect<ReadonlyArray<PasskeyCredentials.PasskeyCredentialRecord>>;
  /** BPAS-006/TC-004: the rpId, stable user handle and accepted credential ids a browser's Signals API call needs. */
  readonly signals: (userId: Users.UserId) => Effect.Effect<PasskeySignals>;
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
          const delivery = yield* SessionDelivery.mode(request);
          const resolvedAddress = yield* clientAddress.resolve(request);
          const userAgent = Headers.get(request.headers, "user-agent");
          const issued = yield* passkey.authenticateVerify(
            { ...payload, ip: Option.getOrUndefined(resolvedAddress) },
            Option.isSome(userAgent) ? { userAgent: userAgent.value } : {},
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
 * CSG-001/DRS-002 (.issues/high), wayfinder ticket 30: this plugin's part of
 * `AccountErasure.eraseAccount`, part of `Passkey.layer` itself (it requires
 * `Erasure.ErasureRegistry`, so a composition without one does not compile). It
 * removes the user's `passkey_credential` rows and — since BPAS-003 — their
 * stable WebAuthn user handle, inside `eraseAccount`'s transaction.
 */
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

export class Passkey extends AuthPlugin.Service<Passkey, PasskeyShape>()("passkey", {
  apiVersion: 1,
  contract: PasskeyApi.PasskeyApi,
  tables: ["passkey_credential", "passkey_challenge", "passkey_user_handle"],
  migrations: passkeyMigrations,
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
    handlers: PasskeyHandlers,
    contributes: Layer.mergeAll(passkeyErasure, passkeyExport),
    make: Effect.gen(function* () {
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const accounts = yield* Accounts.Accounts;
      const events = yield* AuthEvents.AuthEvents;
      const webAuthn = yield* WebAuthn.WebAuthn;
      const challengeStore = yield* ChallengeStore.ChallengeStore;
      const credentials = yield* PasskeyCredentials.PasskeyCredentials;
      const handles = yield* PasskeyUserHandles.PasskeyUserHandles;
      const config = yield* PasskeyConfig;
      const crypto = yield* Crypto.Crypto;
      const limiter = yield* RateLimiter.RateLimiter;
      const rateLimitsRegistry = yield* RateLimits.RateLimitsRegistry;
      // AOMS-006/BCR-004 (wayfinder ticket 03): the MFA divert point a
      // future `TwoFactor` plugin taps.
      const beforeSessionIssue = yield* Hooks.BeforeSessionIssue;
      const afterSignIn = yield* Hooks.AfterSignIn;
      const beforeSignIn = yield* Hooks.BeforeSignIn;

      // ---- layer-build validation and operator warnings --------------------

      // TC-003: the browser's prompt must not outlive the challenge it answers.
      if (
        Duration.toMillis(config.ceremonyTimeout) > Duration.toMillis(ChallengeStore.CHALLENGE_TTL)
      ) {
        return yield* Defects.invalidConfiguration(
          "ceremonyTimeout",
          "awthaq: PasskeyConfig.ceremonyTimeout must not exceed the challenge TTL (five minutes, BEH-EA-132)",
        );
      }
      // HSK-002: conveyance is a request, not a verification.
      if (config.attestation !== "none" && config.attestationPolicy === undefined) {
        yield* Effect.logWarning(
          `awthaq: PasskeyConfig.attestation is "${config.attestation}" but no attestationPolicy is set — attestation is requested but nothing is verified or enforced (conveyance is not verification). Set attestationPolicy.trustedAaguids to make it binding.`,
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
        config.enumerationSecret ??
        (yield* Effect.gen(function* () {
          yield* Effect.logWarning(
            "awthaq: PasskeyConfig.enumerationSecret is not set — a random per-process secret is used for the decoy allowCredentials of unknown emails, so decoys differ across instances/restarts. Set one shared secret for multi-instance deployments.",
          );
          return Redacted.make(toBase64Url(yield* crypto.randomBytes(32).pipe(Effect.orDie)));
        }));
      const enumerationKey = new TextEncoder().encode(Redacted.value(enumerationSecret));
      const decoyCredential = { id: "awthaq-decoy-credential", publicKey: decoyPublicKey() };

      /**
       * Registers this plugin's own limits into the introspectable registry
       * (BEH-EA-107/110/111) — declarative, matching the `limit`/`window` each
       * `rateLimit(...)` call below actually enforces (`RATE_LIMITS` is the
       * single source of truth both sides draw from). A
       * `RateLimitScopeViolation` is only reachable if `group` below ever
       * named something other than this plugin's own contract group — a
       * coding defect here, hence `Effect.orDie`.
       */
      // The explicit return-type annotation on the `.map` callback is the
      // narrow, necessary exception `@awthaq/password`'s and `@awthaq/oauth`'s
      // own rule registration already document: passing this class into
      // anything typed `AuthPlugin.Any` from inside its own `static readonly
      // layer` initializer is a real TS circularity.
      yield* Effect.all(
        (
          [
            {
              endpoint: RATE_LIMITS.authenticateOptionsByIp.endpoint,
              key: "ip",
              limit: RATE_LIMITS.authenticateOptionsByIp.limit,
              window: RATE_LIMITS.authenticateOptionsByIp.window,
            },
            {
              endpoint: RATE_LIMITS.authenticateOptionsByEmail.endpoint,
              key: (input) =>
                `passkey:authenticate-options:${emailFromRateLimitInput(input).toLowerCase()}`,
              limit: RATE_LIMITS.authenticateOptionsByEmail.limit,
              window: RATE_LIMITS.authenticateOptionsByEmail.window,
            },
            {
              endpoint: RATE_LIMITS.authenticateVerifyByIp.endpoint,
              key: "ip",
              limit: RATE_LIMITS.authenticateVerifyByIp.limit,
              window: RATE_LIMITS.authenticateVerifyByIp.window,
            },
          ] satisfies ReadonlyArray<{
            readonly endpoint: string;
            readonly key: RateLimits.RateLimitKey;
            readonly limit: number;
            readonly window: Duration.Duration;
          }>
        ).map((rule): Effect.Effect<void, RateLimits.RateLimitScopeViolation> =>
          rateLimitsRegistry.register(Passkey, { group: "passkey.authenticate", ...rule }),
        ),
        { discard: true },
      ).pipe(Effect.orDie);

      const rateLimit = (
        name: RateLimitRuleName,
        key: string,
      ): Effect.Effect<void, Api.RateLimited> =>
        // EOTS-007: `RateLimits.enforce` also publishes the breach event, logs and counts it.
        RateLimits.enforce({
          key,
          limit: RATE_LIMITS[name].limit,
          window: RATE_LIMITS[name].window,
          meta: ruleMeta(name),
        }).pipe(
          Effect.provideService(RateLimiter.RateLimiter, limiter),
          Effect.provideService(AuthEvents.AuthEvents, events),
          Effect.catchTag(
            "RateLimitExceeded",
            (error) => new Api.RateLimited({ retryAfterMillis: error.retryAfterMillis }),
          ),
        );

      /**
       * Ticket 15 (BPAS-001): the shared freshness gate `registerOptions`/
       * `registerOptionsConditional`/`registerVerify` all apply before
       * doing anything else — `Sessions.findOwned` (TIR-003: a keyed
       * lookup, never a `list` + `find` that a 200-row page cap could
       * blind) mirrors `@awthaq/qadi`'s own `reauthHandler`. A session
       * that is not live for its owner (already revoked/tombstoned/
       * expired) fails closed the same as a stale one — there is no live
       * session left to have proven anything recently.
       */
      const requireFreshSession = (
        userId: Users.UserId,
        sessionId: string,
      ): Effect.Effect<void, PasskeyApi.PasskeyReauthRequired | Errors.StoreUnavailable> =>
        Effect.gen(function* () {
          const maxAgeSeconds = Duration.toSeconds(config.reauthMaxAgeSeconds);
          const current = yield* sessions.findOwned(userId, Sessions.SessionId(sessionId));
          if (Option.isNone(current)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyReauthRequired({ maxAgeSeconds }));
          }
          const now = yield* DateTime.now;
          if (Sessions.isStale(current.value.authenticatedAt, maxAgeSeconds, now)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyReauthRequired({ maxAgeSeconds }));
          }
        });

      /** TC-003: the knobs every options generator sets explicitly. */
      const ceremonyKnobs = {
        timeout: config.ceremonyTimeout,
        ...(config.hints === undefined ? {} : { hints: config.hints }),
        ...(config.extensions === undefined ? {} : { extensions: config.extensions }),
      };

      /** BPAS-003: one stable per-user handle in every registration's options; `credentials.create` stores exactly it. */
      const creationOptions = Effect.fnUntraced(function* (
        userId: Users.UserId,
        scope: string,
        authenticatorSelection: WebAuthn.AuthenticatorSelection,
      ) {
        const user = yield* users.findById(userId).pipe(Effect.orDie);
        const existing = yield* credentials.listByUser(userId);
        const challenge = yield* challengeStore.issue(scope);
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
          ...ceremonyKnobs,
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
          yield* requireFreshSession(userId, sessionId);
          return yield* creationOptions(
            userId,
            registrationScope(sessionId),
            config.authenticatorSelection,
          );
        },
      );

      const registerOptionsConditional: PasskeyShape["registerOptionsConditional"] =
        Effect.fnUntraced(function* (userId, sessionId) {
          yield* requireFreshSession(userId, sessionId);
          // CB-009: Conditional Create cannot produce UV=1, so it is unavailable
          // whenever the RP requires user verification.
          if (
            !config.conditionalCreate ||
            config.authenticatorSelection.userVerification === "required"
          ) {
            return yield* Effect.fail(new PasskeyApi.PasskeyConditionalCreateDisabled());
          }
          // BEH-EA-relaxed: Chrome's Conditional Create flow produces
          // UP=0/UV=0 — a `residentKey: "required"` discoverable
          // credential is also what makes autofill possible at all.
          return yield* creationOptions(userId, conditionalScope(sessionId), {
            ...config.authenticatorSelection,
            residentKey: "required",
            userVerification: "discouraged",
          });
        });

      /**
       * HSK-002: whether a verified registration's attestation satisfies the
       * configured policy (vacuously, when none is configured).
       */
      const attestationAcceptable = (verified: WebAuthn.VerifiedRegistration): boolean => {
        const policy = config.attestationPolicy;
        if (policy === undefined) return true;
        // No statement at all: nothing to base any trust in the claimed model on.
        if (verified.attestationType === "none") return false;
        if (verified.attestationType === "self" && (policy.rejectSelfAttestation ?? true)) {
          return false;
        }
        const aaguid = verified.aaguid.toLowerCase();
        return policy.trustedAaguids.some((trusted) => trusted.toLowerCase() === aaguid);
      };

      const registerVerify: PasskeyShape["registerVerify"] = Effect.fnUntraced(
        function* (userId, sessionId, input) {
          yield* requireFreshSession(userId, sessionId);
          const clientDataOpt = decodeClientData(input.credential.response.clientDataJSON);
          if (Option.isNone(clientDataOpt)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyChallengeInvalid());
          }
          const clientData = clientDataOpt.value;

          yield* checkOrigin(clientData, config);

          // WPS-003: the payload names its ceremony, and only that ceremony's
          // scope is consumed — probing both destroyed a sibling's still-valid
          // challenge (BEH-EA-132 deletes the addressed one on every attempt).
          const conditional = input.ceremony === "conditional";
          const consumed = yield* challengeStore.consume(
            conditional ? conditionalScope(sessionId) : registrationScope(sessionId),
            clientData.challenge,
          );
          if (!consumed) {
            return yield* Effect.fail(new PasskeyApi.PasskeyChallengeInvalid());
          }

          const verified = yield* webAuthn
            .verifyRegistration({
              response: toRegistrationResponseJSON(input.credential),
              expectedChallenge: clientData.challenge,
              expectedOrigin: config.origins,
              expectedRpId: config.rpId,
              // CB-002: an ordinary (user-initiated) registration MUST show
              // user presence; only Conditional Create, which Chrome performs
              // without a user gesture, is allowed UP=0.
              requireUserPresence: !conditional,
            })
            .pipe(
              Effect.catchTag("WebAuthn/VerificationFailed", () =>
                Effect.fail(new PasskeyApi.PasskeyVerificationFailed()),
              ),
            );

          // CB-001 (.issues/high): enforcement follows the RP's own conveyed
          // `userVerification` policy (WebAuthn §7.1). CB-009: the same policy
          // binds Conditional Create too, so the UV exemption can never
          // outlive a "required" policy (`registerOptionsConditional` already
          // refuses to issue that ceremony under it).
          if (
            config.authenticatorSelection.userVerification === "required" &&
            !verified.userVerified
          ) {
            return yield* Effect.fail(new PasskeyApi.PasskeyUserVerificationRequired());
          }

          if (!attestationAcceptable(verified)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyAttestationRejected());
          }

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
          yield* rateLimit(
            "authenticateOptionsByIp",
            `passkey:authenticate-options:ip:${ip ?? "unknown"}`,
          );
          if (email !== undefined) {
            yield* rateLimit(
              "authenticateOptionsByEmail",
              `passkey:authenticate-options:${email.toLowerCase()}`,
            );
          }
          const ceremonyId = toBase64Url(yield* crypto.randomBytes(16).pipe(Effect.orDie));
          const challenge = yield* challengeStore.issue(authenticateScope(ceremonyId));
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
            ...ceremonyKnobs,
          });
          return { ceremonyId, options };
        },
      );

      /**
       * CB-004/WPS-006: the counter-regression policy shared by
       * `authenticateVerify` and `reauthenticateVerify`. A regression
       * (`newCounter <= stored`, except the normal `0 === 0` of an
       * authenticator that never reports a counter) is published, flagged on
       * the credential, and — only under `counterAnomalyPolicy: "reject"` —
       * fails the ceremony. Never advances the stored counter (see
       * `PasskeyCredentials.recordUsage`).
       */
      const applyCounterPolicy = (
        stored: PasskeyCredentials.PasskeyCredentialRecord,
        verified: WebAuthn.VerifiedAuthentication,
      ): Effect.Effect<void, PasskeyApi.PasskeyCounterAnomaly> =>
        Effect.gen(function* () {
          const regressed =
            verified.newCounter <= stored.counter &&
            !(verified.newCounter === 0 && stored.counter === 0);
          if (!regressed) return;
          yield* events.publish({
            _tag: "auth.passkey.counterAnomaly",
            userId: stored.userId,
            credentialId: stored.id,
          });
          yield* credentials.flagCounterAnomaly(stored.id).pipe(Effect.orDie);
          if (config.counterAnomalyPolicy === "reject") {
            return yield* Effect.fail(new PasskeyApi.PasskeyCounterAnomaly());
          }
        });

      const authenticateCeremony: PasskeyShape["authenticateVerify"] = Effect.fnUntraced(
        function* (input, context) {
          // Per-source budget first: cheap to enforce, bounds signature work
          // and challenge probing from one address.
          yield* rateLimit(
            "authenticateVerifyByIp",
            `passkey:authenticate-verify:ip:${input.ip ?? "unknown"}`,
          );
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
          // MNA-007/CB-003: the same origin policy the registration ceremonies apply.
          yield* checkOrigin(clientData, config).pipe(
            Effect.mapError(() => new Api.InvalidCredentials()),
          );

          const storedOpt = yield* credentials.findById(input.credential.id);
          if (Option.isNone(storedOpt)) {
            // TSS-004: still pay for one signature verification (against a
            // decoy key, result discarded) so this path costs what a known
            // credential's bad signature does.
            yield* webAuthn
              .verifyAuthentication({
                response: toAuthenticationResponseJSON(input.credential),
                expectedChallenge: clientData.challenge,
                expectedOrigin: config.origins,
                expectedRpId: config.rpId,
                ...topOriginExpectation(config),
                credential: decoyCredential,
              })
              .pipe(Effect.exit);
            return yield* Effect.fail(new Api.InvalidCredentials());
          }
          const stored = storedOpt.value;

          const verified = yield* webAuthn
            .verifyAuthentication({
              response: toAuthenticationResponseJSON(input.credential),
              expectedChallenge: clientData.challenge,
              expectedOrigin: config.origins,
              expectedRpId: config.rpId,
              ...topOriginExpectation(config),
              credential: {
                id: stored.id,
                publicKey: new Uint8Array(stored.publicKey),
                transports: stored.transports,
              },
            })
            .pipe(
              Effect.catchTag("WebAuthn/VerificationFailed", () =>
                Effect.fail(new Api.InvalidCredentials()),
              ),
            );

          // BPAS-003: a discoverable credential's assertion carries the user
          // handle its authenticator bound at registration — it must be the
          // one this credential was registered under.
          if (
            input.credential.response.userHandle !== undefined &&
            input.credential.response.userHandle !== stored.webauthnUserId
          ) {
            return yield* Effect.fail(new Api.InvalidCredentials());
          }

          if (
            (config.authenticatorSelection.userVerification === "required" ||
              // WPS-006: a credential flagged for a counter anomaly needs UV on
              // every later use — the concrete "step-up" of BEH-EA-131's policy.
              Option.isSome(stored.counterAnomalyAt)) &&
            !verified.userVerified
          ) {
            return yield* Effect.fail(new PasskeyApi.PasskeyUserVerificationRequired());
          }

          // BEH-EA-131: "log + step-up, not an instant kill" by default.
          yield* applyCounterPolicy(stored, verified);
          yield* credentials
            .recordUsage(stored.id, verified.newCounter, verified.credentialBackedUp)
            .pipe(Effect.orDie);

          // WPS-001: a deleted user's passkey credential row can outlive
          // the account (no FK, no cascade) — cryptographic verification
          // above only proves possession of *a* registered authenticator,
          // never that the account it names still exists. Defense in
          // depth, right where `Sessions.issue` would otherwise mint a
          // session for a dead `userId` with no existence check of its
          // own: same uniform `InvalidCredentials` collapse BEH-EA-136
          // already applies to every other failure in this ceremony.
          const user = yield* users
            .findById(stored.userId)
            .pipe(Effect.catchTag("UserNotFound", () => Effect.fail(new Api.InvalidCredentials())));

          // SCP-001/BAM-005: THE shared sign-in gate, after the credential is
          // proven and before any session exists.
          yield* Users.assertCanSignIn(user);

          // NAM-002: the sign-in veto, before the MFA divert point below.
          const signedInEmail = Users.emailOf(user);
          yield* HookPoint.aborted(Hooks.BeforeSignIn)(
            beforeSignIn.run({
              userId: stored.userId,
              ...(Option.isSome(signedInEmail) ? { email: signedInEmail.value } : {}),
              strategy: "passkey",
            }),
          );

          // BCR-004/THS-002: same canonical MFA attachment point
          // `@awthaq/password`'s own `signIn` consults, right before this
          // flow's own `sessions.issue`.
          const amr = passkeyAmr(verified);
          const point = yield* beforeSessionIssue.run({
            userId: stored.userId,
            strategy: "passkey",
            amr,
          });
          if (point._tag === "Diverted") {
            return yield* Effect.fail(point.value);
          }
          const issued = yield* sessions
            .issue({
              userId: stored.userId,
              request: {
                ...(input.ip !== undefined ? { ip: input.ip } : {}),
                ...(context?.userAgent !== undefined ? { userAgent: context.userAgent } : {}),
              },
              // THS-003/HSK-005: the kind of key (hardware-bound or synced), plus user
              // verification when the authenticator performed it.
              amr,
            })
            .pipe(Effect.orDie);
          yield* events.publish({
            _tag: "auth.user.signedIn",
            userId: stored.userId,
            strategy: "passkey",
          });
          yield* afterSignIn.run({ userId: stored.userId, strategy: "passkey" });
          return issued;
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

      const signals: PasskeyShape["signals"] = Effect.fnUntraced(function* (userId) {
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
          yield* credentials.delete(id, userId).pipe(Effect.orDie);
        },
      );

      const reauthenticateOptions: PasskeyShape["reauthenticateOptions"] = Effect.fnUntraced(
        function* (userId, sessionId) {
          const owned = yield* credentials.listByUser(userId);
          const challenge = yield* challengeStore.issue(reauthenticateScope(sessionId));
          return yield* requestOptions({
            rpId: config.rpId,
            challenge: Redacted.value(challenge),
            allowCredentials: owned.map((row) => ({ id: row.id, transports: row.transports })),
            // Ticket 15: UV=1, unconditionally — this ceremony's whole
            // purpose is proving fresh possession-plus-verification, not
            // merely possession, unlike ordinary `authenticateOptions`
            // which defers to `config.authenticatorSelection`.
            userVerification: "required",
            ...ceremonyKnobs,
          });
        },
      );

      const reauthenticateVerify: PasskeyShape["reauthenticateVerify"] = Effect.fnUntraced(
        function* (userId, sessionId, input) {
          const clientDataOpt = decodeClientData(input.credential.response.clientDataJSON);
          if (Option.isNone(clientDataOpt)) {
            return yield* Effect.fail(new PasskeyApi.PasskeyChallengeInvalid());
          }
          const clientData = clientDataOpt.value;

          yield* checkOrigin(clientData, config);

          const consumed = yield* challengeStore.consume(
            reauthenticateScope(sessionId),
            clientData.challenge,
          );
          if (!consumed) {
            return yield* Effect.fail(new PasskeyApi.PasskeyChallengeInvalid());
          }

          const storedOpt = yield* credentials.findById(input.credential.id);
          if (Option.isNone(storedOpt) || storedOpt.value.userId !== userId) {
            // Ticket 15: unlike `authenticateVerify`'s anonymous
            // ceremony, this caller is already authenticated as
            // `userId` — presenting someone else's credential id here
            // is a real, precise condition to report, not an
            // enumeration risk (mirrors `registerVerify`'s own posture,
            // see this file's header comment).
            return yield* Effect.fail(new PasskeyApi.PasskeyCredentialNotFound());
          }
          const stored = storedOpt.value;

          const verified = yield* webAuthn
            .verifyAuthentication({
              response: toAuthenticationResponseJSON(input.credential),
              expectedChallenge: clientData.challenge,
              expectedOrigin: config.origins,
              expectedRpId: config.rpId,
              ...topOriginExpectation(config),
              credential: {
                id: stored.id,
                publicKey: new Uint8Array(stored.publicKey),
                transports: stored.transports,
              },
            })
            .pipe(
              Effect.catchTag("WebAuthn/VerificationFailed", () =>
                Effect.fail(new PasskeyApi.PasskeyVerificationFailed()),
              ),
            );

          // BPAS-003: same handle cross-check as `authenticateVerify`.
          if (
            input.credential.response.userHandle !== undefined &&
            input.credential.response.userHandle !== stored.webauthnUserId
          ) {
            return yield* Effect.fail(new PasskeyApi.PasskeyVerificationFailed());
          }

          if (!verified.userVerified) {
            return yield* Effect.fail(new PasskeyApi.PasskeyUserVerificationRequired());
          }

          // BEH-EA-131: same "log + step-up, not an instant kill" posture as `authenticateVerify`.
          yield* applyCounterPolicy(stored, verified);
          yield* credentials
            .recordUsage(stored.id, verified.newCounter, verified.credentialBackedUp)
            .pipe(Effect.orDie);

          yield* sessions.reauthenticate(Sessions.SessionId(sessionId), passkeyAmr(verified)).pipe(
            Effect.catchTag("Sessions/NotFound", () =>
              // `passkey.reauthenticate`'s own `Authentication` middleware
              // already proved this exact session live moments ago — see
              // `Password.ts`'s own identical `reauthenticate` comment.
              Defects.invariantViolation(
                "RowVanished",
                "awthaq: reauthenticate's own current session vanished",
              ),
            ),
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
        renameCredential,
        removeCredential,
        reauthenticateOptions,
        reauthenticateVerify,
      });
    }),
  });
}
