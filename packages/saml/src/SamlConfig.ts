// @awthaq/saml — SamlConfig
//
// PDR-005's reasoning, as `@awthaq/oauth` applies it: `baseUrl` decides the ACS URL, the SP entity id, and so the
// audience and recipient every assertion is bound to, so it is a *required* field with no default — `SamlConfig` is a
// plain `Context.Service`, and composing SAML without `config({ baseUrl })` fails to type-check instead of shipping a
// `localhost` audience. Everything else has a default.

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Defects } from "@awthaq/ports";

export interface SamlRateLimit {
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
  /** Per-source-IP budgets on the two unauthenticated endpoints. */
  readonly rateLimits: { readonly login: SamlRateLimit; readonly acs: SamlRateLimit };
}

export class SamlConfig extends Context.Service<SamlConfig, SamlConfigShape>()("awthaq/saml/Config") {}

export type SamlConfigInput = { readonly baseUrl: string } & Partial<Omit<SamlConfigShape, "baseUrl">>;

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
      if (Duration.toMillis(clockSkew) > Duration.toMillis(MAX_SKEW) || Duration.toMillis(clockSkew) < 0) {
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
        spEntityId: input.spEntityId ?? ((connectionId) => `${baseUrl}/auth/saml/sp/${connectionId}`),
        clockSkew,
        requestTtl: input.requestTtl ?? Duration.minutes(10),
        maxResponseBytes: input.maxResponseBytes ?? 256 * 1024,
        tenantScoped: input.tenantScoped ?? true,
        allowPrivateTargets: input.allowPrivateTargets ?? false,
        rateLimits: input.rateLimits ?? {
          login: { limit: 30, window: Duration.minutes(1) },
          acs: { limit: 30, window: Duration.minutes(1) },
        },
      };
      return value;
    }),
  );

export const acsUrl = (settings: SamlConfigShape): string => `${settings.baseUrl}/auth/saml/acs`;
