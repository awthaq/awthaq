// @awthaq/password — PasswordRateLimits
//
// BEH-EA-107/108/110/111. RBS-006: one typed definition per rule feeds BOTH
// the introspectable registry and the enforcement call, so the two can no
// longer drift (they used to be two hand-maintained lists that disagreed on
// case-folding, and four registered keys `JSON.stringify`d whole request
// payloads — a reset token plus the new password — into a "key" spec).
//
// A rule's key is derived only from the small, secret-free input its
// endpoint names (`{ email }`, `{ ip }`, `{ identifier }`, `{ userId }`),
// never from a request payload. Each rule's `Schema` both types that input
// for enforcement and narrows the untyped input the registry's key function
// is handed (`RateLimitKey`'s `input` is `unknown` — one registry list covers
// every endpoint's differently-shaped payload), so no type assertion is
// needed anywhere (ESS-005).
//
// CSD-006: two dimensions. Identity-keyed budgets bound brute force against
// one account; per-source budgets bound one origin spraying across many
// accounts. The per-source key comes from the application-provided
// `ClientAddress` port (`layerDirect`, or `layerTrustedProxy` behind a
// reverse proxy); requests whose address it cannot resolve share a single
// "unknown" bucket rather than going unthrottled.

import type { RateLimits } from "@awthaq/core";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * TMS-006: the per-email bucket a sign-up/sign-in/reset/resend request is
 * counted against. Lower-cases and strips a `+tag` from the local part, so
 * `victim+1@x.com` and `victim+2@x.com` share one budget instead of each
 * being a fresh five-per-hour bucket that mail-bombs the same inbox. Only
 * the key is normalized — the address a mail is delivered to, and the one
 * `Users` stores, stay literal (identity is not decided here). Providers
 * with other tag conventions (`-` tags, gmail's dots) override it through
 * `PasswordConfig.rateLimitEmailKey`.
 */
export const defaultEmailRateKey = (email: string): string => {
  const lowered = email.toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at === -1) return lowered;
  const local = lowered.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}${lowered.slice(at)}`;
};

export interface PasswordRule<Input> {
  /** The contract group the endpoint belongs to (`password`, or `password.account` for the authenticated pair, EHA-007). */
  readonly group: string;
  /** The rule's fixed label (never a bucket key) — reported with a breach. */
  readonly name: string;
  readonly endpoint: string;
  readonly dimension: RateLimits.EnforceMeta["dimension"];
  readonly limit: number;
  readonly window: Duration.Duration;
  /** The bucket key enforcement consumes for `input`. */
  readonly keyOf: (input: Input) => string;
  /** The same key as a registry `RateLimitKey`: narrows `unknown` with the rule's schema, never with a cast. */
  readonly registryKey: (input: unknown) => string;
}

const rule = <S extends Schema.Decoder<unknown>>(spec: {
  readonly group?: string;
  readonly name: string;
  readonly endpoint: string;
  readonly dimension: RateLimits.EnforceMeta["dimension"];
  readonly input: S;
  readonly keyOf: (input: S["Type"]) => string;
  readonly limit: number;
  readonly window: Duration.Duration;
}): PasswordRule<S["Type"]> => {
  const decode = Schema.decodeUnknownOption(spec.input);
  return {
    group: spec.group ?? "password",
    name: spec.name,
    endpoint: spec.endpoint,
    dimension: spec.dimension,
    limit: spec.limit,
    window: spec.window,
    keyOf: spec.keyOf,
    // A mismatch means the registry was handed an input of the wrong shape —
    // report an inert key rather than an error channel introspection lacks.
    registryKey: (input) =>
      Option.match(decode(input), {
        onNone: () => `password:${spec.name}:unknown`,
        onSome: spec.keyOf,
      }),
  };
};

const EmailInput = Schema.Struct({ email: Schema.String });
const IpInput = Schema.Struct({ ip: Schema.optional(Schema.String) });
const IdentifierInput = Schema.Struct({ identifier: Schema.String });
const UserInput = Schema.Struct({ userId: Schema.String });

/** `rateLimit(...)`'s bucket for a request whose address the `ClientAddress` port could not resolve. */
const ipKey = (prefix: string) => (input: { readonly ip?: string | undefined }) =>
  `${prefix}:ip:${input.ip ?? "unknown"}`;

/**
 * Every password rate-limit rule, built once per plugin instance because the
 * per-email key normalization is configurable (TMS-006).
 */
export const makeRules = (emailKey: (email: string) => string) => {
  const signUp = rule({
    name: "signUp",
    endpoint: "signUp",
    dimension: "identity",
    input: EmailInput,
    keyOf: (input) => `password:signup:${emailKey(input.email)}`,
    limit: 5,
    window: Duration.hours(1),
  });
  // AGA-001/NHS-003: bounds mass account creation from one source
  // independently of the (freely chosen) email each attempt names.
  const signUpByIp = rule({
    name: "signUpByIp",
    endpoint: "signUp",
    dimension: "ip",
    input: IpInput,
    keyOf: ipKey("password:signup"),
    limit: 20,
    window: Duration.hours(1),
  });
  const signIn = rule({
    name: "signIn",
    endpoint: "signIn",
    dimension: "identity",
    input: EmailInput,
    keyOf: (input) => `password:signin:${emailKey(input.email)}`,
    limit: 5,
    window: Duration.minutes(15),
  });
  // RBS-001/CSD-002: the per-account budget above is keyed on an
  // attacker-controlled email — an attacker can burn a victim's 5 attempts to
  // lock them out, and distributed spraying across many distinct addresses
  // never trips it at all. This per-IP rule bounds spraying independently of
  // which account is targeted; looser than the per-account limit so one
  // shared office NAT can't lock out every real user behind it.
  const signInByIp = rule({
    name: "signInByIp",
    endpoint: "signIn",
    dimension: "ip",
    input: IpInput,
    keyOf: ipKey("password:signin"),
    limit: 30,
    window: Duration.minutes(15),
  });
  const requestReset = rule({
    name: "requestReset",
    endpoint: "requestReset",
    dimension: "identity",
    input: EmailInput,
    keyOf: (input) => `password:reset-request:${emailKey(input.email)}`,
    limit: 5,
    window: Duration.minutes(15),
  });
  // AGA-001/NHS-003: mirrors `signInByIp` — bounds one source spraying reset
  // requests across many distinct, unrelated emails.
  const requestResetByIp = rule({
    name: "requestResetByIp",
    endpoint: "requestReset",
    dimension: "ip",
    input: IpInput,
    keyOf: ipKey("password:reset-request"),
    limit: 30,
    window: Duration.minutes(15),
  });
  // Keyed on the token's decoded public id (never the token's secret half, and
  // never the request payload, which also carries the new password).
  const confirmReset = rule({
    name: "confirmReset",
    endpoint: "confirmReset",
    dimension: "identity",
    input: IdentifierInput,
    keyOf: (input) => `password:reset-confirm:${input.identifier}`,
    limit: 5,
    window: Duration.minutes(15),
  });
  // Shipping-gap map (.scratch/shipping-gaps), ticket 14. Keyed on the
  // authenticated caller's user id, mirroring its own posture.
  const changePassword = rule({
    group: "password.account",
    name: "changePassword",
    endpoint: "changePassword",
    dimension: "identity",
    input: UserInput,
    keyOf: (input) => `password:change-password:${input.userId}`,
    limit: 5,
    window: Duration.minutes(15),
  });
  // Wayfinder ticket 15: mirrors `changePassword` — the identical
  // authenticated-password-recheck shape.
  const reauthenticate = rule({
    group: "password.account",
    name: "reauthenticate",
    endpoint: "reauthenticate",
    dimension: "identity",
    input: UserInput,
    keyOf: (input) => `password:reauthenticate:${input.userId}`,
    limit: 5,
    window: Duration.minutes(15),
  });
  // Upstream-hardening ticket 04: tighter than the generic 5-per-15-min
  // default — resend-verification abuse is an inbox-flooding harassment
  // vector against the *target*, not an account-takeover one.
  const resendVerification = rule({
    name: "resendVerification",
    endpoint: "resendVerification",
    dimension: "identity",
    input: EmailInput,
    keyOf: (input) => `password:resend-verification:${emailKey(input.email)}`,
    limit: 3,
    window: Duration.minutes(15),
  });
  // MLO-003: without it one source could rotate across victims' addresses at
  // 3 mails per 15 minutes each with no per-source ceiling.
  const resendVerificationByIp = rule({
    name: "resendVerificationByIp",
    endpoint: "resendVerification",
    dimension: "ip",
    input: IpInput,
    keyOf: ipKey("password:resend-verification"),
    limit: 20,
    window: Duration.minutes(15),
  });
  // APS-003: each failed `consume` publishes `auth.token.replay`; an unbounded
  // flood of guesses is hopeless against a 256-bit token but is pointless
  // churn/log-spam. Same numbers as `confirmReset`, its closest sibling.
  const verifyEmail = rule({
    name: "verifyEmail",
    endpoint: "verifyEmail",
    dimension: "identity",
    input: IdentifierInput,
    keyOf: (input) => `password:verify-email:${input.identifier}`,
    limit: 5,
    window: Duration.minutes(15),
  });
  // Mirrors `signInByIp`/`requestResetByIp`: bounds one source spraying guesses
  // across many distinct, unrelated tokens/accounts.
  const verifyEmailByIp = rule({
    name: "verifyEmailByIp",
    endpoint: "verifyEmail",
    dimension: "ip",
    input: IpInput,
    keyOf: ipKey("password:verify-email"),
    limit: 30,
    window: Duration.minutes(15),
  });

  return {
    signUp,
    signUpByIp,
    signIn,
    signInByIp,
    requestReset,
    requestResetByIp,
    confirmReset,
    changePassword,
    reauthenticate,
    resendVerification,
    resendVerificationByIp,
    verifyEmail,
    verifyEmailByIp,
  };
};

export type PasswordRules = ReturnType<typeof makeRules>;

/** The registry's view of every rule, in registration order. */
export const registryEntries = (rules: PasswordRules) =>
  Object.values(rules).map((definition) => ({
    group: definition.group,
    endpoint: definition.endpoint,
    key: definition.registryKey,
    limit: definition.limit,
    window: definition.window,
  }));

export const metaOf = (definition: {
  readonly group: string;
  readonly name: string;
  readonly endpoint: string;
  readonly dimension: RateLimits.EnforceMeta["dimension"];
}): RateLimits.EnforceMeta => ({
  group: definition.group,
  endpoint: definition.endpoint,
  rule: definition.name,
  dimension: definition.dimension,
});
