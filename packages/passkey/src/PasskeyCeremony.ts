// @awthaq/passkey — PasskeyCeremony (internal: not re-exported from `index.ts`)
//
// spec/behaviors/17-passkey.md, BEH-EA-130..133, 136, 256, 257. The one implementation of what a
// passkey ceremony verifies and in which order. An endpoint names the ceremony (and so its challenge
// scope), hands over the browser's response and the config in force, and gets back a verified
// credential or a refusal *reason*. How loudly to say why is the endpoint's posture (BEH-EA-136),
// never this module's.
//
// One order for every kind; BEH-EA-132 comes first, always:
//   1. claim:  spend the ceremony's challenge, whether or not the client data can be read;
//   2. origin: BEH-EA-133 / MNA-007 / CB-003 / TC-008, one policy;
//   3. port:   `WebAuthn.verify*` (registration: UP per mode; assertion: the stored key, or the
//              decoy key for a credential this ceremony may not use, TSS-004);
//   4. policy: registration: UV, attestation. Assertion: user handle, UV, counter, then the usage write.
import type { Api } from "@awthaq/api";
import { AuthEvents, type Sessions, type Users } from "@awthaq/core";
import { WebAuthn } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChallengeStore from "./ChallengeStore.ts";
import type * as PasskeyApi from "./PasskeyApi.ts";
import type { PasskeyConfigShape } from "./PasskeyConfig.ts";
import * as PasskeyCredentials from "./PasskeyCredentials.ts";

// ---- what a ceremony is, and its challenge scope ----

export type Ceremony = Data.TaggedEnum<{
  /** BEH-EA-130/256: `mode` is the payload's `ceremony` (absent means modal, WPS-003). */
  Registration: { readonly sessionId: string; readonly mode: "modal" | "conditional" };
  /** BEH-EA-131: anonymous, correlated by the `ceremonyId` its options call minted. */
  SignIn: { readonly ceremonyId: string };
  /** Ticket 15: the caller's own session; only the caller's own credential may answer it. */
  StepUp: { readonly sessionId: string; readonly userId: Users.UserId };
}>;
export const Ceremony = Data.taggedEnum<Ceremony>();
export type Registration = Data.TaggedEnum.Value<Ceremony, "Registration">;
export type Assertion = Data.TaggedEnum.Value<Ceremony, "SignIn" | "StepUp">;

/**
 * BEH-EA-132/256: one challenge scope per ceremony. These strings are stored
 * (`passkey_challenge.scope`) and signed into `layerCookie` values: never change them, or a
 * deploy strands every live challenge.
 */
export const scopeOf = Ceremony.$match({
  Registration: ({ sessionId, mode }) =>
    mode === "conditional"
      ? `passkey.register.conditional:${sessionId}`
      : `passkey.register:${sessionId}`,
  SignIn: ({ ceremonyId }) => `passkey.authenticate:${ceremonyId}`,
  StepUp: ({ sessionId }) => `passkey.reauthenticate:${sessionId}`,
});

// ---- the policy a ceremony reads, and how it refuses ----

/** EP-007: the endpoint reads the config in force per operation and hands this part of it in. */
export type CeremonyPolicy = Pick<
  PasskeyConfigShape,
  | "rpId"
  | "origins"
  | "allowedTopOrigins"
  | "relatedOrigins"
  | "authenticatorSelection"
  | "attestationPolicy"
  | "counterAnomalyPolicy"
>;

export type RegistrationRefusal =
  | "challenge" // unreadable client data, or the scope's challenge is missing, expired or different
  | "origin" // not an accepted origin, or embedded under a top origin nobody allowed
  | "rpId" // an accepted web origin whose host is not `rpId` or under it
  | "signature" // the port refused the response
  | "userVerification" // UV required by the conveyed policy and absent
  | "attestation"; // HSK-002 policy unmet

export type AssertionRefusal =
  | "challenge"
  | "origin"
  | "rpId"
  | "unknownCredential" // no such credential, or (step-up) not the caller's; the decoy was verified
  | "signature"
  | "userHandle" // BPAS-003: the assertion's handle is not the one the credential was registered under
  | "userVerification"
  | "counterAnomaly"; // CB-004 regression under `counterAnomalyPolicy: "reject"`

export class RegistrationRefused extends Data.TaggedError("PasskeyCeremony/RegistrationRefused")<{
  readonly reason: RegistrationRefusal;
}> {}
export class AssertionRefused extends Data.TaggedError("PasskeyCeremony/AssertionRefused")<{
  readonly reason: AssertionRefusal;
}> {}

/**
 * BEH-EA-136: an endpoint's answer to every refusal its ceremony can produce. It is total, so a new
 * reason fails to compile at every endpoint until that endpoint chooses its wire error.
 */
export type Posture<Reason extends string> = { readonly [R in Reason]: () => unknown };

/**
 * What a verifier fails with: its own refusal reasons, plus the store outage that propagates
 * untouched (ADR-EA-028). Named here so declaration emit can reach `StoreUnavailable`.
 */
export type CeremonyFailure<Refused> = Refused | Api.StoreUnavailable;

export interface VerifiedAssertion {
  readonly credential: PasskeyCredentials.PasskeyCredentialRecord;
  readonly verified: WebAuthn.VerifiedAuthentication;
  /** HSK-005/THS-003 (BEH-EA-258): `hwk`/`swk`, plus `user` when the authenticator verified the user. */
  readonly amr: ReadonlyArray<Sessions.AuthMethod>;
}

// ---- wire-response decoding (glue, not crypto — see WebAuthn.ts's own header) ----

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
 * Client data whose challenge this attempt has already spent. Only `claim` makes one, and the origin
 * check and the port call take one, so no step can run before the spend (BEH-EA-132).
 */
type Claimed = Brand.Branded<ClientData, "PasskeyCeremony/Claimed">;
const Claimed = Brand.nominal<Claimed>();

/**
 * What an unreadable client data presents. It can never equal an issued (32 random bytes, base64url)
 * challenge, and `ChallengeStore.consume` deletes the scope's entry "either way" (its contract), so
 * the attempt still spends the challenge.
 */
const NO_CHALLENGE = "";

/**
 * Reads only `origin`/`challenge`/`type` (and the cross-origin members) out of
 * the browser's `clientDataJSON` — plain base64url + JSON decoding, not
 * attestation or signature verification (BEH-EA-129's own prohibition is about
 * the latter, never about reading a JSON field).
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

/** TC-008: every origin a ceremony may report: the exact `origins` plus the Related Origin Requests list. */
const acceptedOrigins = (policy: CeremonyPolicy): ReadonlyArray<string> => [
  ...policy.origins,
  ...policy.relatedOrigins,
];

/**
 * The one origin policy every ceremony applies (BEH-EA-133, MNA-007, CB-003, TC-008), as the reason
 * it fails:
 * 1. the ceremony's origin is an exact member of `origins` (or the related origins);
 * 2. a ceremony run cross-origin (`crossOrigin: true`, i.e. inside an
 *    iframe) must name a `topOrigin` the host explicitly allows — the wrapped
 *    library only rejects this for authentication, and only when the browser
 *    reports `topOrigin`, so registration and step-up would otherwise accept
 *    an embedded ceremony;
 * 3. a web origin's host is `rpId` or a subdomain of it (never a bare host
 *    match); an `android:apk-key-hash:` origin is exempt from that web-only
 *    check — it is accepted only by being listed verbatim in `origins`.
 */
const originRefusal = (
  claimed: Claimed,
  policy: CeremonyPolicy,
): Option.Option<"origin" | "rpId"> => {
  if (!acceptedOrigins(policy).includes(claimed.origin)) return Option.some("origin");
  if (
    claimed.crossOrigin === true &&
    (claimed.topOrigin === undefined || !policy.allowedTopOrigins.includes(claimed.topOrigin))
  ) {
    return Option.some("origin");
  }
  if (claimed.origin.startsWith(ANDROID_APK_KEY_HASH_ORIGIN_PREFIX)) return Option.none();
  // TC-008: a related origin is by definition not under `rpId`.
  if (policy.relatedOrigins.includes(claimed.origin)) return Option.none();
  return originMatchesRpId(claimed.origin, policy.rpId) ? Option.none() : Option.some("rpId");
};

/** TC-008: a related origin is an exact `https` origin — the shape `new URL(x).origin` round-trips. */
export const isHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
};

/** CB-003: only forwarded to the port when the host allows any embedded ceremony at all. */
const topOriginExpectation = (
  policy: CeremonyPolicy,
): { readonly expectedTopOrigin?: ReadonlyArray<string> } =>
  policy.allowedTopOrigins.length === 0 ? {} : { expectedTopOrigin: policy.allowedTopOrigins };

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

/**
 * TSS-004: a fixed, well-formed COSE ES256 public key nobody holds the private
 * half of (generated once, offline). An assertion naming a credential the ceremony may not use is
 * verified against it and the result discarded, so that path performs the same signature
 * verification a usable credential's does — the way `@awthaq/password`'s `dummyHash` equalizes an
 * unknown email.
 */
const DECOY_COSE_PUBLIC_KEY =
  "pQECAyYgASFYIDUd8pj_isGtVhaCN1Bo9s3jMUGZnyfu_woIMrJon1KjIlggExq74U54Cegms_CY6g320bYfldpa89-O72ccIzqVy9s";

const decoyPublicKey = (): Uint8Array<ArrayBuffer> => {
  const decoded = Encoding.decodeBase64Url(DECOY_COSE_PUBLIC_KEY);
  return Result.isSuccess(decoded) ? new Uint8Array(decoded.success) : new Uint8Array();
};

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

/**
 * HSK-002: whether a verified registration's attestation satisfies the
 * configured policy (vacuously, when none is configured).
 */
const attestationAcceptable = (
  verified: WebAuthn.VerifiedRegistration,
  policy: CeremonyPolicy,
): boolean => {
  const attestation = policy.attestationPolicy;
  if (attestation === undefined) return true;
  // No statement at all: nothing to base any trust in the claimed model on.
  if (verified.attestationType === "none") return false;
  if (verified.attestationType === "self" && (attestation.rejectSelfAttestation ?? true)) {
    return false;
  }
  const aaguid = verified.aaguid.toLowerCase();
  return attestation.trustedAaguids.some((trusted) => trusted.toLowerCase() === aaguid);
};

export const make = Effect.gen(function* () {
  const challenges = yield* ChallengeStore.ChallengeStore;
  const webAuthn = yield* WebAuthn.WebAuthn;
  const credentials = yield* PasskeyCredentials.PasskeyCredentials;
  const events = yield* AuthEvents.AuthEvents;
  // TSS-004: verified against, never trusted.
  const decoyCredential = { id: "awthaq-decoy-credential", publicKey: decoyPublicKey() };

  /** The options half: mints the challenge for exactly this ceremony's scope. */
  const begin = (ceremony: Ceremony) => challenges.issue(scopeOf(ceremony));

  /** Step 1 (BEH-EA-132): spends the challenge first, readable client data or not. Only a match yields a `Claimed`. */
  const claim = Effect.fnUntraced(function* (ceremony: Ceremony, clientDataJSON: string) {
    const clientData = decodeClientData(clientDataJSON);
    const spent = yield* challenges.consume(
      scopeOf(ceremony),
      Option.match(clientData, { onNone: () => NO_CHALLENGE, onSome: (data) => data.challenge }),
    );
    return spent ? Option.map(clientData, Claimed) : Option.none();
  });

  const verifyRegistration = Effect.fnUntraced(function* (input: {
    readonly ceremony: Registration;
    readonly credential: PasskeyApi.RegistrationCredentialInput;
    readonly policy: CeremonyPolicy;
  }) {
    const refuse = (reason: RegistrationRefusal) =>
      Effect.fail(new RegistrationRefused({ reason }));
    const claimed = yield* claim(input.ceremony, input.credential.response.clientDataJSON);
    if (Option.isNone(claimed)) return yield* refuse("challenge");
    const origin = originRefusal(claimed.value, input.policy);
    if (Option.isSome(origin)) return yield* refuse(origin.value);
    const verified = yield* webAuthn
      .verifyRegistration({
        response: toRegistrationResponseJSON(input.credential),
        expectedChallenge: claimed.value.challenge,
        expectedOrigin: acceptedOrigins(input.policy),
        expectedRpId: input.policy.rpId,
        // CB-002: only Conditional Create, which Chrome runs without a user gesture, may omit UP.
        requireUserPresence: input.ceremony.mode === "modal",
      })
      .pipe(Effect.catchTag("WebAuthn/VerificationFailed", () => refuse("signature")));
    // CB-001/CB-009: UV follows the conveyed policy, for both modes.
    if (
      input.policy.authenticatorSelection.userVerification === "required" &&
      !verified.userVerified
    ) {
      return yield* refuse("userVerification");
    }
    if (!attestationAcceptable(verified, input.policy)) return yield* refuse("attestation");
    return verified;
  });

  /** WPS-006 and ticket 15: step-up always needs UV; sign-in does when the policy says so or the credential is flagged. */
  const userVerificationRequired = (
    ceremony: Assertion,
    policy: CeremonyPolicy,
    credential: PasskeyCredentials.PasskeyCredentialRecord,
  ) =>
    ceremony._tag === "StepUp" ||
    policy.authenticatorSelection.userVerification === "required" ||
    Option.isSome(credential.counterAnomalyAt);

  /**
   * CB-004/WPS-006: a regression (`newCounter <= stored`, except the normal `0 === 0`) is published
   * and flagged; whether it also refuses is the policy's call. The stored counter never moves
   * backwards (`PasskeyCredentials.recordUsage`).
   */
  const counterVerdict = Effect.fnUntraced(function* (
    credential: PasskeyCredentials.PasskeyCredentialRecord,
    verified: WebAuthn.VerifiedAuthentication,
    policy: CeremonyPolicy,
  ) {
    const regressed =
      verified.newCounter <= credential.counter &&
      !(verified.newCounter === 0 && credential.counter === 0);
    if (!regressed) return "accepted" as const;
    yield* events.publish({
      _tag: "auth.passkey.counterAnomaly",
      userId: credential.userId,
      credentialId: credential.id,
    });
    // The row was read a moment ago in this ceremony: a vanished row is a bug, not a domain outcome.
    yield* credentials
      .flagCounterAnomaly(credential.id)
      .pipe(Effect.catchTag("PasskeyCredentials/NotFound", Effect.die));
    return policy.counterAnomalyPolicy === "reject" ? ("rejected" as const) : ("accepted" as const);
  });

  /** Sign-in may use any registered credential; step-up only one the caller owns. */
  const usableBy = (ceremony: Assertion, credential: PasskeyCredentials.PasskeyCredentialRecord) =>
    ceremony._tag === "SignIn" || credential.userId === ceremony.userId;

  const verifyAssertion = Effect.fnUntraced(function* (input: {
    readonly ceremony: Assertion;
    readonly credential: PasskeyApi.AuthenticationCredentialInput;
    readonly policy: CeremonyPolicy;
  }) {
    const refuse = (reason: AssertionRefusal) => Effect.fail(new AssertionRefused({ reason }));
    const claimed = yield* claim(input.ceremony, input.credential.response.clientDataJSON);
    if (Option.isNone(claimed)) return yield* refuse("challenge");
    const origin = originRefusal(claimed.value, input.policy);
    if (Option.isSome(origin)) return yield* refuse(origin.value);
    const expected = {
      response: toAuthenticationResponseJSON(input.credential),
      expectedChallenge: claimed.value.challenge,
      expectedOrigin: acceptedOrigins(input.policy),
      expectedRpId: input.policy.rpId,
      ...topOriginExpectation(input.policy),
    };
    const found = Option.filter(yield* credentials.findById(input.credential.id), (row) =>
      usableBy(input.ceremony, row),
    );
    if (Option.isNone(found)) {
      // TSS-004: a credential this ceremony may not use costs the one signature verification a
      // usable credential's bad signature does. The result is discarded.
      yield* webAuthn
        .verifyAuthentication({ ...expected, credential: decoyCredential })
        .pipe(Effect.exit);
      return yield* refuse("unknownCredential");
    }
    const credential = found.value;
    const verified = yield* webAuthn
      .verifyAuthentication({
        ...expected,
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(credential.publicKey),
          transports: credential.transports,
        },
      })
      .pipe(Effect.catchTag("WebAuthn/VerificationFailed", () => refuse("signature")));
    // BPAS-003/BEH-EA-257: a discoverable credential returns the handle it was registered under.
    const handle = input.credential.response.userHandle;
    if (handle !== undefined && handle !== credential.webauthnUserId) {
      return yield* refuse("userHandle");
    }
    if (
      userVerificationRequired(input.ceremony, input.policy, credential) &&
      !verified.userVerified
    ) {
      return yield* refuse("userVerification");
    }
    if ((yield* counterVerdict(credential, verified, input.policy)) === "rejected") {
      return yield* refuse("counterAnomaly");
    }
    yield* credentials
      .recordUsage(credential.id, verified.newCounter, verified.credentialBackedUp)
      .pipe(Effect.catchTag("PasskeyCredentials/NotFound", Effect.die));
    return { credential, verified, amr: passkeyAmr(verified) };
  });

  return { begin, verifyRegistration, verifyAssertion };
});
