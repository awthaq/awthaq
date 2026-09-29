// @awthaq/magic-link — RateLimitRules
//
// BEH-EA-107/108/110/111, RBS-006 (the `@awthaq/password` convention): one typed definition per rule
// feeds BOTH the introspectable registry and the enforcement call, so `registered()` reports exactly
// the keys enforced. A rule's key is derived only from the small, secret-free input its endpoint
// names (`{ ip }`, `{ email }`, `{ identifier }`), never from a payload — a token or a code never
// becomes a bucket key. Shared by `MagicLink` and `EmailOtp`, which differ only in their groups
// and numbers.

import type { RateLimits } from "@awthaq/core";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { emailRateKey } from "./Channel.ts";

export interface Rule<Input> {
  readonly group: string;
  readonly name: string;
  readonly endpoint: string;
  readonly dimension: RateLimits.EnforceMeta["dimension"];
  readonly limit: number;
  readonly window: Duration.Duration;
  readonly keyOf: (input: Input) => string;
  /** The same key as a registry `RateLimitKey`: narrows `unknown` with the rule's schema, never with a cast. */
  readonly registryKey: (input: unknown) => string;
}

export const rule = <S extends Schema.Decoder<unknown>>(spec: {
  readonly group: string;
  readonly name: string;
  readonly endpoint: string;
  readonly dimension: RateLimits.EnforceMeta["dimension"];
  readonly input: S;
  readonly keyOf: (input: S["Type"]) => string;
  readonly limit: number;
  readonly window: Duration.Duration;
}): Rule<S["Type"]> => {
  const decode = Schema.decodeUnknownOption(spec.input);
  return {
    group: spec.group,
    name: spec.name,
    endpoint: spec.endpoint,
    dimension: spec.dimension,
    limit: spec.limit,
    window: spec.window,
    keyOf: spec.keyOf,
    registryKey: (input) =>
      Option.match(decode(input), {
        onNone: () => `${spec.group}:${spec.name}:unknown`,
        onSome: spec.keyOf,
      }),
  };
};

export const IpInput = Schema.Struct({ ip: Schema.optional(Schema.String) });
export const EmailInput = Schema.Struct({ email: Schema.String });
export const IdentifierInput = Schema.Struct({ identifier: Schema.String });

/** The bucket for a request whose address the `ClientAddress` port could not resolve: one shared "unknown" bucket, never unthrottled. */
export const ipKey = (prefix: string) => (input: { readonly ip?: string | undefined }) =>
  `${prefix}:ip:${input.ip ?? "unknown"}`;

export const emailKey = (prefix: string) => (input: { readonly email: string }) =>
  `${prefix}:email:${emailRateKey(input.email)}`;

export const minutes15 = Duration.minutes(15);

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

/** The registry's view of every rule, in registration order. */
export const registryEntries = (
  rules: Readonly<Record<string, Rule<never>>>,
): ReadonlyArray<RateLimits.RuleInput> =>
  Object.values(rules).map((definition) => ({
    group: definition.group,
    endpoint: definition.endpoint,
    key: definition.registryKey,
    limit: definition.limit,
    window: definition.window,
  }));
