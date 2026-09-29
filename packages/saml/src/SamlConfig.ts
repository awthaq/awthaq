// @awthaq/saml — SamlConfig
//
// PDR-005's reasoning, as `@awthaq/oauth` applies it: `baseUrl` decides the ACS URL, the SP entity id, and so the
// audience and recipient every assertion is bound to, so it is a *required* field with no default — `SamlConfig` is a
// plain `Context.Service`, and composing SAML without `config({ baseUrl })` fails to type-check instead of shipping a
// `localhost` audience. Everything else has a default.

import type { AuthSubject } from "@qadi/core";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Defects } from "@awthaq/ports";

interface SamlRateLimit {
  readonly limit: number;
  readonly window: Duration.Duration;
}

export interface SamlConfigShape {
  /** The public scheme+host(+port) of this application: no path, query, fragment or credentials. */
  readonly baseUrl: string;
  /** Where a login returns to when no (trusted) `callbackURL` was asked for. */
  readonly defaultCallbackURL: string;
  /** Origins a `callbackURL` may name; a relative path (`/dashboard`) is always fine, a foreign origin falls back to the default. */
  readonly trustedOrigins: ReadonlyArray<string>;
  /** The SP entity id of a connection. Default: `<baseUrl>/auth/saml/sp/<connectionId>`. */
  readonly spEntityId: (connectionId: string) => string;
  /** Clock skew tolerated on the assertion's time window (BEH-EA-243). Default 60 s; maximum 300 s. */
  readonly clockSkew: Duration.Duration;
  /** How long an AuthnRequest id stays redeemable (BEH-EA-244). Default 10 minutes. */
  readonly requestTtl: Duration.Duration;
  /** Refuse a `SAMLResponse` whose decoded size exceeds this (BEH-EA-238). Default 256 KiB. */
  readonly maxResponseBytes: number;
  /** Stamp the users, accounts and sessions a sign-in creates with the connection's organization as tenant (ADR-EA-018). Default true. */
  readonly tenantScoped: boolean;
  /** Development and test only: allow `http:` and private IdP URLs on a connection. */
  readonly allowPrivateTargets: boolean;
  /** Per-source-IP budgets on the unauthenticated endpoints. */
  readonly rateLimits: {
    readonly login: SamlRateLimit;
    readonly acs: SamlRateLimit;
    /** BEH-EA-315: the Single Logout endpoint (IdP-initiated and the response to ours). */
    readonly slo: SamlRateLimit;
    /** BEH-EA-317: `POST /auth/sso/start`, which tells a caller whether an email domain has single sign-on. */
    readonly sso: SamlRateLimit;
  };
  /**
   * BEH-EA-315: how far from now a Single Logout message's `IssueInstant` may be (both directions, clock skew added). A captured
   * `LogoutRequest` replayed later would log the user out again on demand; default 5 minutes.
   */
  readonly logoutFreshness: Duration.Duration;
  /** BEH-EA-315: how long a session row (NameID and SessionIndex of a sign-in) is kept for a logout to find; default 90 days. */
  readonly sessionRecordRetention: Duration.Duration;
  /** BEH-EA-314: the validity of a generated SP signing certificate, in days; default 1825 (5 years). */
  readonly signingKeyValidityDays: number;
  /** BEH-EA-318: refuse IdP metadata larger than this (bytes) when fetching it from a URL; default 512 KiB. */
  readonly maxMetadataBytes: number;
  /** BEH-EA-318: the deadline for fetching IdP metadata from a URL; default 10 seconds. */
  readonly metadataTimeout: Duration.Duration;
  /**
   * BEH-EA-318: the administrator's gate, DENYING BY DEFAULT (an application that installs the admin group and never
   * configures this exposes nothing). `action` names the operation; `organizationId` the organization it concerns, when
   * there is one (`createConnection`, `getConnection`, ...), so a host can let one administrator manage one tenant.
   */
  readonly canManageSaml: (input: {
    readonly admin: AuthSubject;
    readonly action: string;
    readonly organizationId: string | undefined;
  }) => Effect.Effect<boolean>;
  /** BEH-EA-318: calls per administrator per window on the admin group, past the gate. */
  readonly adminRate: SamlRateLimit;
  /**
   * BEH-EA-316: whether a connection's role mapping may ever confer `owner` (its ceiling, a rule or the defaults naming it).
   * Off by default: an identity provider's assertion promoting somebody to owner is a decision, not a default.
   */
  readonly allowOwnerRoleMapping: boolean;
}

export class SamlConfig extends Context.Service<SamlConfig, SamlConfigShape>()(
  "awthaq/saml/Config",
) {}

export type SamlConfigInput = { readonly baseUrl: string } & Partial<
  Omit<SamlConfigShape, "baseUrl">
>;

const MAX_SKEW = Duration.seconds(300);

/** Validates at layer build: a malformed `baseUrl`, or a skew over the maximum, is a deployment defect. */
export const config = (input: SamlConfigInput) =>
  Layer.effect(
    SamlConfig,
    Effect.gen(function* () {
      const parsed = URL.parse(input.baseUrl);
      if (
        parsed === null ||
        (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        parsed.username !== "" ||
        parsed.password !== ""
      ) {
        return yield* Defects.invalidConfiguration(
          "baseUrl",
          `awthaq/saml: baseUrl "${input.baseUrl}" must be the public scheme+host (e.g. "https://app.example.com") with no path, query, fragment or credentials`,
        );
      }
      const clockSkew = input.clockSkew ?? Duration.seconds(60);
      if (
        Duration.toMillis(clockSkew) > Duration.toMillis(MAX_SKEW) ||
        Duration.toMillis(clockSkew) < 0
      ) {
        return yield* Defects.invalidConfiguration(
          "clockSkew",
          "awthaq/saml: clockSkew must be between 0 and 300 seconds (BEH-EA-243)",
        );
      }
      const baseUrl = parsed.origin;
      const value: SamlConfigShape = {
        baseUrl,
        defaultCallbackURL: input.defaultCallbackURL ?? "/",
        trustedOrigins: input.trustedOrigins ?? [],
        spEntityId:
          input.spEntityId ?? ((connectionId) => `${baseUrl}/auth/saml/sp/${connectionId}`),
        clockSkew,
        requestTtl: input.requestTtl ?? Duration.minutes(10),
        maxResponseBytes: input.maxResponseBytes ?? 256 * 1024,
        tenantScoped: input.tenantScoped ?? true,
        allowPrivateTargets: input.allowPrivateTargets ?? false,
        rateLimits: input.rateLimits ?? {
          login: { limit: 30, window: Duration.minutes(1) },
          acs: { limit: 30, window: Duration.minutes(1) },
          slo: { limit: 30, window: Duration.minutes(1) },
          sso: { limit: 30, window: Duration.minutes(1) },
        },
        logoutFreshness: input.logoutFreshness ?? Duration.minutes(5),
        sessionRecordRetention: input.sessionRecordRetention ?? Duration.days(90),
        signingKeyValidityDays: input.signingKeyValidityDays ?? 1825,
        maxMetadataBytes: input.maxMetadataBytes ?? 512 * 1024,
        metadataTimeout: input.metadataTimeout ?? Duration.seconds(10),
        canManageSaml: input.canManageSaml ?? (() => Effect.succeed(false)),
        adminRate: input.adminRate ?? { limit: 60, window: Duration.minutes(1) },
        allowOwnerRoleMapping: input.allowOwnerRoleMapping ?? false,
      };
      return value;
    }),
  );

export const acsUrl = (settings: SamlConfigShape): string => `${settings.baseUrl}/auth/saml/acs`;

/**
 * BEH-EA-315: this SP's Single Logout endpoint FOR ONE CONNECTION (both bindings, one URL): the `Destination` every signed logout
 * message carries. The connection is in the path so an IdP-initiated `LogoutRequest`, which has no state of ours to consult,
 * still selects its trust set from what this server published, never from the document.
 */
export const sloUrl = (settings: SamlConfigShape, connectionId: string): string =>
  `${settings.baseUrl}/auth/saml/slo/${encodeURIComponent(connectionId)}`;
