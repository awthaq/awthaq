// @awthaq/passkey — PasskeyApi
//
// spec/behaviors/17-passkey.md, BEH-EA-129 through BEH-EA-136. This
// plugin's own contract, three groups all named `passkey` or a dotted
// sub-id of it (BEH-EA-004) — built the same way `@awthaq/password`'s
// own `PasswordApi.ts` builds its:
//
// - `passkey` — the registration ceremony (BEH-EA-130) and Conditional
//   Create (ticket 07). Both require an existing session
//   (`.middleware(Api.Authentication)`): this spec does not support
//   passkey-first sign-up (see `spec.md`'s own Out of Scope) — a passkey is
//   always added to an *existing* account, never the account's first
//   credential.
// - `passkey.authenticate` — the sign-in ceremony (BEH-EA-131). Public, no
//   middleware at all: this is how an otherwise-anonymous caller
//   authenticates in the first place.
// - `passkey.credentials` — list/rename/delete (BEH-EA-134), also
//   `.middleware(Api.Authentication)`.
//
// AVS-003: the `.../options` endpoints answer real, typed schemas
// (`PublicKeyCredentialCreationOptionsSchema`/`PublicKeyCredentialRequestOptionsSchema`
// below) mirroring the WebAuthn L3 `...OptionsJSON` dictionaries, so a
// generated client and the OpenAPI document see the actual shape instead of
// `{}`. They are owned by the WebAuthn spec, not by this plugin, so they are
// modeled member-for-member and shaped to be assignable to
// `@simplewebauthn/browser`'s own option types — the client hands them
// straight to `startRegistration`/`startAuthentication` with no runtime guard.
// `register/verify`/`authenticate/verify`'s own request bodies
// (`RegistrationCredentialSchema`/`AuthenticationCredentialSchema` below)
// are narrower — they capture only the handful of fields this plugin
// actually reads (never the caller's real `clientExtensionResults`, which
// this plugin ignores entirely) rather than accepting the full
// `Schema.Unknown` a client posts.
//
// **Enumeration safety (BEH-EA-136), a real design decision, not an
// oversight:** `authenticate/verify` declares only `PasskeyChallengeInvalid`,
// `PasskeyUserVerificationRequired`, `PasskeyCounterAnomaly` (only reachable
// after a valid signature from a registered credential), rate-limiting and
// `Api.InvalidCredentials` as its errors — never `PasskeyCredentialNotFound`
// or the generic `PasskeyVerificationFailed`. Neither a stale/replayed
// challenge nor a missing-UV rejection reveals anything about whether any
// credential was ever registered for the presented identifier (BEH-EA-136's
// own enumeration-safety text), so reporting those distinctly is safe;
// every other authentication failure (unknown credential id, a wrong
// signature, an origin/rpId mismatch) *would* leak that distinction, so
// `Passkey.ts`'s handler collapses all of them into the same
// `Api.InvalidCredentials` uniform response `@awthaq/password`'s own
// `signIn` already uses for the identical reason. TC-001: the envelope
// covers the *options* half too — `authenticate/options` answers an unknown
// email with deterministic decoy `allowCredentials` shaped like a registered
// user's (and is rate-limited), never an empty list that gives the
// registered/unregistered distinction away. `register/verify`, in
// contrast, only ever runs for an already-authenticated caller adding a
// credential to their own account — there is no identifier to enumerate —
// so it reports the full, precise BEH-EA-136 taxonomy.

import { Api, SessionContract } from "@awthaq/api";
import { HookPoint, Hooks } from "@awthaq/core";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

export class PasskeyChallengeInvalid extends Schema.TaggedError<PasskeyChallengeInvalid>()(
  "PasskeyChallengeInvalid",
  {},
  { httpApiStatus: 400 },
) {}

export class PasskeyOriginMismatch extends Schema.TaggedError<PasskeyOriginMismatch>()(
  "PasskeyOriginMismatch",
  {},
  { httpApiStatus: 400 },
) {}

export class PasskeyRpIdMismatch extends Schema.TaggedError<PasskeyRpIdMismatch>()(
  "PasskeyRpIdMismatch",
  {},
  { httpApiStatus: 400 },
) {}

export class PasskeyVerificationFailed extends Schema.TaggedError<PasskeyVerificationFailed>()(
  "PasskeyVerificationFailed",
  {},
  { httpApiStatus: 400 },
) {}

export class PasskeyUserVerificationRequired extends Schema.TaggedError<PasskeyUserVerificationRequired>()(
  "PasskeyUserVerificationRequired",
  {},
  { httpApiStatus: 400 },
) {}

export class PasskeyCredentialNotFound extends Schema.TaggedError<PasskeyCredentialNotFound>()(
  "PasskeyCredentialNotFound",
  {},
  { httpApiStatus: 404 },
) {}

/** HSK-002: the registration's attestation does not satisfy `PasskeyConfig.attestationPolicy` (no attestation at all, a self-signed one, or an authenticator model outside the allow-list). Only reachable from the authenticated `register/verify`, so it can be precise. */
export class PasskeyAttestationRejected extends Schema.TaggedError<PasskeyAttestationRejected>()(
  "PasskeyAttestationRejected",
  {},
  { httpApiStatus: 400 },
) {}

/** WPS-010: the credential id is already registered (to this account or another). Only reachable from the authenticated `register/verify`, so it is safe to say precisely. */
export class PasskeyAlreadyRegistered extends Schema.TaggedError<PasskeyAlreadyRegistered>()(
  "PasskeyAlreadyRegistered",
  {},
  { httpApiStatus: 409 },
) {}

/** BEH-EA-045/134: mapped from core's `Accounts.LastAccountRefusal` at this plugin's own handler boundary. */
export class PasskeyLastCredential extends Schema.TaggedError<PasskeyLastCredential>()(
  "PasskeyLastCredential",
  {},
  { httpApiStatus: 409 },
) {}

/**
 * Ticket 07: `PasskeyConfig.conditionalCreate: false` disables `register/options/conditional` — reported the same way a genuinely absent endpoint would be, not a distinguishable "feature flag off" response.
 *
 * Also answered under `authenticatorSelection.userVerification: "required"` (CB-009: Conditional Create cannot produce UV=1). HSK-007: Conditional Create always requests a discoverable credential (`residentKey: "required"`), so U2F-only and early-CTAP2 security keys cannot complete it — a fleet of them should set `conditionalCreate: false`.
 */
export class PasskeyConditionalCreateDisabled extends Schema.TaggedError<PasskeyConditionalCreateDisabled>()(
  "PasskeyConditionalCreateDisabled",
  {},
  { httpApiStatus: 404 },
) {}

/**
 * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
 * (BPAS-001): the current session's own `authenticatedAt` is older than
 * `PasskeyConfig.reauthMaxAgeSeconds` — enrollment (and this plugin's own
 * step-up ceremony's `options` call) refuses until the caller re-proves a
 * credential, closing the "hijacked-cookie enrolls a durable credential"
 * gap. `403`, matching `@awthaq/password`'s `EmailNotVerified` reasoning:
 * the session is genuinely live, but its own freshness forbids this
 * specific action.
 */
export class PasskeyReauthRequired extends Schema.TaggedError<PasskeyReauthRequired>()(
  "PasskeyReauthRequired",
  { maxAgeSeconds: Schema.Number },
  { httpApiStatus: 403 },
) {}

/**
 * BEH-EA-136's eighth named error. Ticket 08's "log + step-up, not an
 * instant kill" is the default (`PasskeyConfig.counterAnomalyPolicy:
 * "flag"`): a counter regression is published as
 * `AuthEvents.PasskeyCounterAnomalyEvent`, the credential is flagged and
 * the ceremony still succeeds. Under `"reject"` the ceremony instead fails
 * with this error — raised only after the assertion's signature verified
 * against a registered credential, so it reveals nothing an anonymous
 * caller could not already learn by holding that credential.
 */
export class PasskeyCounterAnomaly extends Schema.TaggedError<PasskeyCounterAnomaly>()(
  "PasskeyCounterAnomaly",
  {},
  { httpApiStatus: 409 },
) {}

// ---- Wire shapes for the two `...verify` payloads --------------------------

export const AttestationResponseSchema = Schema.Struct({
  clientDataJSON: Schema.String,
  attestationObject: Schema.String,
  /**
   * HSK-003: what the browser reported via `getTransports()`, so the stored
   * credential's `transports` (and later `excludeCredentials`/
   * `allowCredentials` hints) reflect the real authenticator. Any string is
   * accepted on the wire (a future transport must not fail registration);
   * `Passkey.ts` keeps only the ones it recognizes.
   */
  transports: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const RegistrationCredentialSchema = Schema.Struct({
  id: Schema.String,
  rawId: Schema.String,
  response: AttestationResponseSchema,
  type: Schema.Literal("public-key"),
});
export type RegistrationCredentialInput = typeof RegistrationCredentialSchema.Type;

export const AssertionResponseSchema = Schema.Struct({
  clientDataJSON: Schema.String,
  authenticatorData: Schema.String,
  signature: Schema.String,
  userHandle: Schema.optional(Schema.String),
});

export const AuthenticationCredentialSchema = Schema.Struct({
  id: Schema.String,
  rawId: Schema.String,
  response: AssertionResponseSchema,
  type: Schema.Literal("public-key"),
});
export type AuthenticationCredentialInput = typeof AuthenticationCredentialSchema.Type;

/**
 * WPS-003: which registration ceremony this response completes. The two
 * ceremonies each keep their own `ChallengeStore` scope; naming the ceremony
 * lets `register/verify` consume exactly one of them instead of probing both
 * (which destroyed the sibling's still-valid challenge). Absent means the
 * ordinary, modal one.
 */
export const RegistrationCeremony = Schema.Literals(["modal", "conditional"]);
export type RegistrationCeremony = typeof RegistrationCeremony.Type;

export const RegisterVerifyPayload = Schema.Struct({
  credential: RegistrationCredentialSchema,
  ceremony: Schema.optionalKey(RegistrationCeremony),
});
export type RegisterVerifyPayload = typeof RegisterVerifyPayload.Type;

export const AuthenticateOptionsPayload = Schema.Struct({
  email: Schema.optional(Schema.String),
});
export type AuthenticateOptionsPayload = typeof AuthenticateOptionsPayload.Type;

// ---- WebAuthn L3 options dictionaries (AVS-003) ---------------------------
//
// Mutable arrays throughout (`Schema.mutable`): `@simplewebauthn/browser`'s
// own option types declare mutable arrays, and these schemas' `Type` must be
// assignable to them for the client to pass an options payload straight to
// `startRegistration`/`startAuthentication`.

const CredentialDescriptorSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  transports: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

const PublicKeyCredentialHintSchema = Schema.Literals(["hybrid", "security-key", "client-device"]);

const ExtensionsSchema = Schema.Struct({
  appid: Schema.optionalKey(Schema.String),
  credProps: Schema.optionalKey(Schema.Boolean),
  hmacCreateSecret: Schema.optionalKey(Schema.Boolean),
  minPinLength: Schema.optionalKey(Schema.Boolean),
});

export const PublicKeyCredentialCreationOptionsSchema = Schema.Struct({
  rp: Schema.Struct({ name: Schema.String, id: Schema.optionalKey(Schema.String) }),
  user: Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }),
  challenge: Schema.String,
  pubKeyCredParams: Schema.mutable(
    Schema.Array(Schema.Struct({ alg: Schema.Number, type: Schema.Literal("public-key") })),
  ),
  timeout: Schema.optionalKey(Schema.Number),
  excludeCredentials: Schema.optionalKey(Schema.mutable(Schema.Array(CredentialDescriptorSchema))),
  authenticatorSelection: Schema.optionalKey(
    Schema.Struct({
      authenticatorAttachment: Schema.optionalKey(Schema.Literals(["cross-platform", "platform"])),
      requireResidentKey: Schema.optionalKey(Schema.Boolean),
      residentKey: Schema.optionalKey(Schema.Literals(["discouraged", "preferred", "required"])),
      userVerification: Schema.optionalKey(
        Schema.Literals(["discouraged", "preferred", "required"]),
      ),
    }),
  ),
  hints: Schema.optionalKey(Schema.mutable(Schema.Array(PublicKeyCredentialHintSchema))),
  attestation: Schema.optionalKey(Schema.Literals(["direct", "enterprise", "indirect", "none"])),
  attestationFormats: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(
        Schema.Literals([
          "fido-u2f",
          "packed",
          "android-safetynet",
          "android-key",
          "tpm",
          "apple",
          "none",
        ]),
      ),
    ),
  ),
  extensions: Schema.optionalKey(ExtensionsSchema),
});
export type PublicKeyCredentialCreationOptions =
  typeof PublicKeyCredentialCreationOptionsSchema.Type;

export const PublicKeyCredentialRequestOptionsSchema = Schema.Struct({
  challenge: Schema.String,
  timeout: Schema.optionalKey(Schema.Number),
  rpId: Schema.optionalKey(Schema.String),
  allowCredentials: Schema.optionalKey(Schema.mutable(Schema.Array(CredentialDescriptorSchema))),
  userVerification: Schema.optionalKey(Schema.Literals(["discouraged", "preferred", "required"])),
  hints: Schema.optionalKey(Schema.mutable(Schema.Array(PublicKeyCredentialHintSchema))),
  extensions: Schema.optionalKey(ExtensionsSchema),
});
export type PublicKeyCredentialRequestOptions = typeof PublicKeyCredentialRequestOptionsSchema.Type;

/**
 * The registration ceremonies (BEH-EA-130, ticket 07) scope their own
 * `ChallengeStore` entry by the caller's already-authenticated session id,
 * known at both `.../options` and `.../verify` time. The authenticate
 * ceremony (BEH-EA-131) has no such session yet — it's how a caller
 * *becomes* authenticated — so `authenticateOptions` mints an opaque
 * `ceremonyId` correlator the caller must echo back verbatim to
 * `authenticateVerify`, the same scoping role a session id plays for
 * registration.
 */
export const AuthenticateOptionsResult = Schema.Struct({
  ceremonyId: Schema.String,
  options: PublicKeyCredentialRequestOptionsSchema,
});
export type AuthenticateOptionsResult = typeof AuthenticateOptionsResult.Type;

export const AuthenticateVerifyPayload = Schema.Struct({
  ceremonyId: Schema.String,
  credential: AuthenticationCredentialSchema,
});
export type AuthenticateVerifyPayload = typeof AuthenticateVerifyPayload.Type;

/**
 * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
 * (AAPS-001/BPAS-001): unlike `AuthenticateVerifyPayload`, no `ceremonyId`
 * correlator — this ceremony always runs for an already-authenticated
 * caller, so the challenge is scoped server-side by the caller's own
 * session id (the same scoping `registerOptions`/`registerVerify` already
 * use), not a client-echoed value.
 */
export const ReauthenticateVerifyPayload = Schema.Struct({
  credential: AuthenticationCredentialSchema,
});
export type ReauthenticateVerifyPayload = typeof ReauthenticateVerifyPayload.Type;

export const RenamePayload = Schema.Struct({ name: Schema.String });
export type RenamePayload = typeof RenamePayload.Type;

export const CredentialIdParams = Schema.Struct({ id: Schema.String });
export type CredentialIdParams = typeof CredentialIdParams.Type;

/** One row of `credentials` list — the wire shape of `PasskeyCredentials.PasskeyCredentialRecord`. */
export class PasskeyCredentialDto extends Schema.Class<PasskeyCredentialDto>(
  "PasskeyCredentialDto",
)({
  id: Schema.String,
  name: Schema.String,
  deviceType: Schema.Literals(["singleDevice", "multiDevice"]),
  backedUp: Schema.Boolean,
  /** HSK-003: the authenticator transports recorded at registration. */
  transports: Schema.Array(Schema.String),
  /** HSK-003: the authenticator model id (`00000000-...` when the authenticator does not disclose one). */
  aaguid: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.String,
  /** WPS-006: when a signature-counter regression (a possibly cloned key) was last seen on this credential, or `null`. */
  counterAnomalyAt: Schema.NullOr(Schema.String),
}) {}

/**
 * BPAS-006/TC-004: what the browser's WebAuthn Signals API needs to reconcile
 * its credential manager with the server — `signalAllAcceptedCredentials`
 * keyed on the user's stable handle (BPAS-003), `signalCurrentUserDetails`
 * for a profile change. Authenticated, so no enumeration concern.
 */
export class PasskeySignalsDto extends Schema.Class<PasskeySignalsDto>("PasskeySignalsDto")({
  rpId: Schema.String,
  /** The user's stable WebAuthn user handle (base64url) — `user.id` of every registration ceremony. */
  userId: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  allAcceptedCredentialIds: Schema.Array(Schema.String),
}) {}

export const PasskeyGroup = HttpApiGroup.make("passkey")
  .add(
    HttpApiEndpoint.post("registerOptions", "/passkey/register/options", {
      success: PublicKeyCredentialCreationOptionsSchema,
      // Ticket 15: gated behind the same freshness check as `registerVerify`.
      error: PasskeyReauthRequired,
    }),
  )
  .add(
    HttpApiEndpoint.post("registerOptionsConditional", "/passkey/register/options/conditional", {
      success: PublicKeyCredentialCreationOptionsSchema,
      error: [PasskeyConditionalCreateDisabled, PasskeyReauthRequired],
    }),
  )
  .add(
    HttpApiEndpoint.post("registerVerify", "/passkey/register/verify", {
      payload: RegisterVerifyPayload,
      success: PasskeyCredentialDto,
      error: [
        PasskeyChallengeInvalid,
        PasskeyOriginMismatch,
        PasskeyRpIdMismatch,
        PasskeyVerificationFailed,
        PasskeyUserVerificationRequired,
        PasskeyAttestationRejected,
        PasskeyAlreadyRegistered,
        // Ticket 15 (BPAS-001): re-checked here too, not just at
        // `.../options` time — closes the window between a caller
        // fetching options while still fresh and presenting the
        // completed ceremony after their session has since gone stale.
        PasskeyReauthRequired,
      ],
    }),
  )
  // See `@awthaq/api`'s `Session.ts`: `CsrfProtection` declared last so it
  // runs first.
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

export const PasskeyAuthenticateGroup = HttpApiGroup.make("passkey.authenticate")
  .add(
    HttpApiEndpoint.post("authenticateOptions", "/passkey/authenticate/options", {
      payload: AuthenticateOptionsPayload,
      success: AuthenticateOptionsResult,
      // TC-001/WPS-005: anonymous and mints server state per call.
      error: Api.RateLimited,
    }),
  )
  .add(
    HttpApiEndpoint.post("authenticateVerify", "/passkey/authenticate/verify", {
      payload: AuthenticateVerifyPayload,
      success: SessionContract.SessionDto,
      // Wayfinder ticket 03 (BCR-004/THS-002): `Hooks.TwoFactorRequired`
      // when a `Hooks.BeforeSessionIssue` tap diverts. NAM-002:
      // `HookPoint.HookAborted` from a `Hooks.BeforeSignIn` veto.
      error: [
        PasskeyChallengeInvalid,
        PasskeyUserVerificationRequired,
        // CB-004: only under `counterAnomalyPolicy: "reject"`.
        PasskeyCounterAnomaly,
        Api.InvalidCredentials,
        Api.RateLimited,
        HookPoint.HookAborted,
        Hooks.TwoFactorRequired,
      ],
    }),
  )
  // Public and anonymous by design (see this file's header), but still two
  // unsafe-method (POST) endpoints a browser client reaches — CSRF-worth
  // protecting the same as `PasswordApi.ts`'s public `signIn`/`signUp`,
  // even though WebAuthn's own origin binding is a second, independent
  // defense here.
  .middleware(Api.CsrfProtection);

export const PasskeyCredentialsGroup = HttpApiGroup.make("passkey.credentials")
  .add(
    HttpApiEndpoint.get("listCredentials", "/passkey/credentials", {
      success: Schema.Array(PasskeyCredentialDto),
    }),
  )
  .add(
    HttpApiEndpoint.get("signals", "/passkey/signals", {
      success: PasskeySignalsDto,
    }),
  )
  .add(
    HttpApiEndpoint.patch("renameCredential", "/passkey/credentials/:id", {
      params: CredentialIdParams,
      payload: RenamePayload,
      success: PasskeyCredentialDto,
      error: PasskeyCredentialNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.delete("removeCredential", "/passkey/credentials/:id", {
      params: CredentialIdParams,
      success: HttpApiSchema.Empty(204),
      error: [PasskeyCredentialNotFound, PasskeyLastCredential],
    }),
  )
  // See `@awthaq/api`'s `Session.ts`: `CsrfProtection` declared last so it
  // runs first.
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

/**
 * Wayfinder map (.scratch/resolve-ready-for-human-findings), ticket 15
 * (AAPS-001/BPAS-001): the passkey-credential half of the step-up
 * discharge path — a normal WebAuthn authentication ceremony scoped to
 * the caller's own already-live session (not a fresh sign-in, unlike
 * `passkey.authenticate`), requiring UV=1, refreshing `authenticatedAt`
 * on success. Lets a passkey-only user step up without ever having set a
 * password. Both endpoints run only for an already-authenticated caller
 * re-proving their own credential — no identifier to enumerate, so
 * (mirroring `registerVerify`'s own reasoning) failures report the full,
 * precise BEH-EA-136 taxonomy rather than collapsing into
 * `Api.InvalidCredentials`.
 */
export const PasskeyReauthenticateGroup = HttpApiGroup.make("passkey.reauthenticate")
  .add(
    HttpApiEndpoint.post("reauthenticateOptions", "/passkey/reauthenticate/options", {
      success: PublicKeyCredentialRequestOptionsSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post("reauthenticateVerify", "/passkey/reauthenticate/verify", {
      payload: ReauthenticateVerifyPayload,
      success: HttpApiSchema.Empty(204),
      error: [
        PasskeyChallengeInvalid,
        PasskeyOriginMismatch,
        PasskeyRpIdMismatch,
        PasskeyVerificationFailed,
        PasskeyUserVerificationRequired,
        PasskeyCredentialNotFound,
        PasskeyCounterAnomaly,
      ],
    }),
  )
  // See `@awthaq/api`'s `Session.ts`: `CsrfProtection` declared last so it
  // runs first.
  .middleware(Api.Authentication)
  .middleware(Api.CsrfProtection);

export const PasskeyApi = HttpApi.make("auth")
  .add(PasskeyGroup)
  .add(PasskeyAuthenticateGroup)
  .add(PasskeyCredentialsGroup)
  .add(PasskeyReauthenticateGroup);
