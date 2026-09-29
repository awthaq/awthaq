// @awthaq/oauth/presets — Claims
//
// Small, cast-free accessors the vendor presets' `mapProfile` functions share.
// A provider's claim set is `Record<string, unknown>`; each accessor narrows
// with `typeof`, so a missing or mistyped claim is `undefined` (or `""` for
// an id), never a wrong-typed value.

import type * as Config from "effect/Config";
import type * as Redacted from "effect/Redacted";
import type { OAuthProfile, OAuthProviderConfig } from "../OAuthProvider.ts";

/** What every vendor preset takes: the app's credentials, and optional overrides. */
export interface PresetInput {
  /** A literal or a `Config` — a client id is not a secret. */
  readonly clientId: string | Config.Config<string>;
  /** Always a `Config.Redacted` (BEH-EA-126). */
  readonly clientSecret: Config.Config<Redacted.Redacted<string>>;
  /** Replaces the preset's default scopes. */
  readonly scopes?: ReadonlyArray<string>;
  /** Registers the provider under another id (default: the preset's name), e.g. two Google apps. */
  readonly id?: string;
  /** Replaces the preset's default claim mapping. */
  readonly mapProfile?: OAuthProviderConfig["mapProfile"];
}

export const stringClaim = (claims: Record<string, unknown>, key: string): string | undefined => {
  const value = claims[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

export const booleanClaim = (claims: Record<string, unknown>, key: string): boolean | undefined => {
  const value = claims[key];
  return typeof value === "boolean" ? value : undefined;
};

/**
 * A stable provider-side identifier that may arrive as a string or a JSON
 * number (GitHub's numeric `id`) — always returned as a string. `""` when
 * absent; the callback refuses a profile with an empty subject.
 */
export const idClaim = (claims: Record<string, unknown>, key: string): string => {
  const value = claims[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
};

/** Builds an `OAuthProfile`, leaving out (not setting to `undefined`) every field that is absent. */
export const profileOf = (fields: {
  readonly subject: string;
  readonly email?: string | undefined;
  readonly emailVerified?: boolean | undefined;
  readonly name?: string | undefined;
}): OAuthProfile => ({
  subject: fields.subject,
  ...(fields.email === undefined ? {} : { email: fields.email }),
  ...(fields.emailVerified === undefined ? {} : { emailVerified: fields.emailVerified }),
  ...(fields.name === undefined ? {} : { name: fields.name }),
});
