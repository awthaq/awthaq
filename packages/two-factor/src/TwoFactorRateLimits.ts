// @awthaq/two-factor — TwoFactorRateLimits
//
// BEH-EA-107/108/110/111, RBS-006 (the `@awthaq/password` convention): one typed definition per rule
// feeds BOTH the introspectable registry and the enforcement call, so `registered()` reports exactly
// the keys enforced. A rule's key is derived only from the small, secret-free input its endpoint
// names (`{ ip }`, `{ userId }`), never from a payload — a challenge id or a code never becomes a
// bucket key.
//
// Three rules:
//
// - `verifyByIp` — bounds one source spraying `/two-factor/verify*` across many challenges.
// - `manageByUser` — bounds enrol/confirm/disable/regenerate per account.
// - `failureBudget` — BCR-006's shared per-account budget. It is *enforced* inside `SecondFactor`
//   (which needs the read half, `RateLimiter.check`, and charges failures only); it is listed here so
//   the registry, `awthaq routes` and the docs show it beside the other two.

import type { RateLimits } from "@awthaq/core";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { TwoFactorConfigShape } from "./TwoFactorConfig.ts";
import { failureKey } from "./SecondFactor.ts";

export interface TwoFactorRule<Input> {
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

const rule = <S extends Schema.Decoder<unknown>>(spec: {
  readonly group: string;
  readonly name: string;
  readonly endpoint: string;
  readonly dimension: RateLimits.EnforceMeta["dimension"];
  readonly input: S;
  readonly keyOf: (input: S["Type"]) => string;
  readonly limit: number;
  readonly window: Duration.Duration;
}): TwoFactorRule<S["Type"]> => {
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
        onNone: () => `two_factor:${spec.name}:unknown`,
        onSome: spec.keyOf,
      }),
  };
};

const IpInput = Schema.Struct({ ip: Schema.optional(Schema.String) });
const UserInput = Schema.Struct({ userId: Schema.String });

export const makeRules = (config: TwoFactorConfigShape) => ({
  verifyByIp: rule({
    group: "two_factor",
    name: "verifyByIp",
    endpoint: "verify",
    dimension: "ip",
    input: IpInput,
    keyOf: (input) => `two_factor:verify:ip:${input.ip ?? "unknown"}`,
    limit: 30,
    window: Duration.minutes(15),
  }),
  manageByUser: rule({
    group: "two_factor.account",
    name: "manageByUser",
    endpoint: "manage",
    dimension: "principal",
    input: UserInput,
    keyOf: (input) => `two_factor:manage:${input.userId}`,
    limit: 20,
    window: Duration.minutes(15),
  }),
  failureBudget: rule({
    group: "two_factor",
    name: "failureBudget",
    endpoint: "verify",
    dimension: "identity",
    input: UserInput,
    keyOf: (input) => failureKey(input.userId),
    limit: config.failureLimit,
    window: config.failureWindow,
  }),
});

export type TwoFactorRules = ReturnType<typeof makeRules>;

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
export const registryEntries = (rules: TwoFactorRules) =>
  Object.values(rules).map((definition) => ({
    group: definition.group,
    endpoint: definition.endpoint,
    key: definition.registryKey,
    limit: definition.limit,
    window: definition.window,
  }));
