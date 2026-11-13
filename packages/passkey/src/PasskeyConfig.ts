// @awthaq/passkey — PasskeyConfig
//
// spec/behaviors/17-passkey.md. The plugin's policy knobs (BEH-EA-017's Context.Reference with a
// default). A leaf: `Passkey.ts` (options, boot checks) and `PasskeyCeremony.ts` (verification) both
// read it, and `Passkey.ts` re-exports it, so `Passkey.config(...)` and `Passkey.PasskeyConfig` keep
// their public names.
import { Tenant } from "@awthaq/core";
import type { WebAuthn } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import type * as Redacted from "effect/Redacted";

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
  /**
   * TC-008: WebAuthn Related Origin Requests — extra web origins (exact `https` origins, e.g.
   * `https://example.co.uk`) whose *host is not under `rpId`* but which may still use this relying
   * party's passkeys. A ceremony from one is accepted like one from `origins`, minus the rpId host-suffix
   * check (the authenticator data's `rpIdHash` still binds the credential to `rpId`), and the plugin
   * serves the same list at `GET /.well-known/webauthn` — a document the browser fetches from
   * `https://<rpId>/.well-known/webauthn` to decide whether to let the requesting origin use `rpId` at
   * all, so the app must be reachable there. Off by default (`[]`: the endpoint answers 404); browsers
   * consider only a handful of distinct registrable labels (five is the floor the specification asks
   * clients to honour), so keep the list short.
   */
  readonly relatedOrigins: ReadonlyArray<string>;
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
  relatedOrigins: [],
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

/**
 * BEH-EA-355: tenant-scoped. Boot fields are validated or derived once at build and read only from the build value;
 * `relatedOrigins` and `attestation` are read per operation (the ceremony policy), so they are not boot.
 */
export const PasskeyConfigScoped = Tenant.perTenant(PasskeyConfig, {
  boot: ["ceremonyTimeout", "enumerationSecret"],
});

export const config = (partial: Partial<PasskeyConfigShape>) =>
  PasskeyConfigScoped.layer({ ...defaultPasskeyConfig, ...partial });
