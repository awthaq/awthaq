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
// `register/options`/`authenticate/options` both answer `Schema.Unknown` —
// `PublicKeyCredentialCreationOptionsJSON`/`PublicKeyCredentialRequestOptionsJSON`
// are the browser's own WebAuthn dictionary shapes (`@simplewebauthn/server`
// merely reproduces them), not a domain concept this contract owns; the
// same "the shape belongs to someone else, so it travels as opaque JSON"
// reasoning `Verification.ts`'s own `payload: unknown` already documents.
// `register/verify`/`authenticate/verify`'s own request bodies
// (`RegistrationCredentialSchema`/`AuthenticationCredentialSchema` below)
// are narrower — they capture only the handful of fields this plugin
// actually reads (never the caller's real `clientExtensionResults`, which
// this plugin ignores entirely) rather than accepting the full
// `Schema.Unknown` a client posts.
//
// **Enumeration safety (BEH-EA-136), a real design decision, not an
// oversight:** `authenticate/verify` declares only `PasskeyChallengeInvalid`,
// `PasskeyUserVerificationRequired`, and `Api.InvalidCredentials` as its
// errors — never `PasskeyCredentialNotFound` or the generic
// `PasskeyVerificationFailed`. Neither a stale/replayed challenge nor a
// missing-UV rejection reveals anything about whether any credential was
// ever registered for the presented identifier (BEH-EA-136's own
// enumeration-safety text), so reporting those two distinctly is safe;
// every other authentication failure (unknown credential id, a wrong
// signature, an origin/rpId mismatch) *would* leak that distinction, so
// `Passkey.ts`'s handler collapses all of them into the same
// `Api.InvalidCredentials` uniform response `@awthaq/password`'s own
// `signIn` already uses for the identical reason. `register/verify`, in
// contrast, only ever runs for an already-authenticated caller adding a
// credential to their own account — there is no identifier to enumerate —
// so it reports the full, precise BEH-EA-136 taxonomy.

import { Api, SessionContract } from "@awthaq/api";
import { Hooks } from "@awthaq/core";
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

/** BEH-EA-045/134: mapped from core's `Accounts.LastAccountRefusal` at this plugin's own handler boundary. */
export class PasskeyLastCredential extends Schema.TaggedError<PasskeyLastCredential>()(
  "PasskeyLastCredential",
  {},
  { httpApiStatus: 409 },
) {}

/** Ticket 07: `PasskeyConfig.conditionalCreate: false` disables `register/options/conditional` — reported the same way a genuinely absent endpoint would be, not a distinguishable "feature flag off" response. */
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
 * BEH-EA-136's eighth named error. Declared here for completeness with that
 * behavior's own closed list, but deliberately never appears in any
 * endpoint's `error` union below: ticket 08's "log + step-up, not an
 * instant kill" means a counter regression is published as
 * `AuthEvents.PasskeyCounterAnomalyEvent` and the ceremony still succeeds —
 * this type exists so a future caller has a real tag to `catchTag` against
 * if that policy ever changes, not because any current response can carry it.
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

export const RegisterVerifyPayload = Schema.Struct({ credential: RegistrationCredentialSchema });
export type RegisterVerifyPayload = typeof RegisterVerifyPayload.Type;

export const AuthenticateOptionsPayload = Schema.Struct({
  email: Schema.optional(Schema.String),
});
export type AuthenticateOptionsPayload = typeof AuthenticateOptionsPayload.Type;

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
  options: Schema.Unknown,
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
  createdAt: Schema.String,
  lastUsedAt: Schema.String,
}) {}

export const PasskeyGroup = HttpApiGroup.make("passkey")
  .add(
    HttpApiEndpoint.post("registerOptions", "/passkey/register/options", {
      success: Schema.Unknown,
      // Ticket 15: gated behind the same freshness check as `registerVerify`.
      error: PasskeyReauthRequired,
    }),
  )
  .add(
    HttpApiEndpoint.post("registerOptionsConditional", "/passkey/register/options/conditional", {
      success: Schema.Unknown,
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
    }),
  )
  .add(
    HttpApiEndpoint.post("authenticateVerify", "/passkey/authenticate/verify", {
      payload: AuthenticateVerifyPayload,
      success: SessionContract.SessionDto,
      // Wayfinder ticket 03 (BCR-004/THS-002): `Hooks.TwoFactorRequired`
      // when a `Hooks.BeforeSessionIssue` tap diverts.
      error: [
        PasskeyChallengeInvalid,
        PasskeyUserVerificationRequired,
        Api.InvalidCredentials,
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
    HttpApiEndpoint.get("list", "/passkey/credentials", {
      success: Schema.Array(PasskeyCredentialDto),
    }),
  )
  .add(
    HttpApiEndpoint.patch("rename", "/passkey/credentials/:id", {
      params: CredentialIdParams,
      payload: RenamePayload,
      success: PasskeyCredentialDto,
      error: PasskeyCredentialNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.make("DELETE")("remove", "/passkey/credentials/:id", {
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
      success: Schema.Unknown,
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
