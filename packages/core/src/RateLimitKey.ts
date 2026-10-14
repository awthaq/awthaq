// @awthaq/core — RateLimitKey
//
// spec/behaviors/14-rate-limiting.md, BEH-EA-108 — the bucket-key strategies a rate-limit rule is
// built over, and the one email normaliser. A leaf module (it imports nothing of the plugin or
// rate-limit machinery) so `RateLimitModel.ts` and `AuthPlugin.ts` can use it without a cycle.
//
// A strategy names the one small, secret-free field it reads and carries the `Schema` that narrows
// `unknown` to it, so the type a `spend` call must supply and the runtime guard are one definition.
// Field names are fixed (`ip`, `email`, `identifier`, `userId`, `sessionId`, `clientId`, `phone`):
// a computed field name would need a cast to type the struct. Call sites already build these small
// inputs at the handler edge, where the IP and the principal are resolved.

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Phone from "./Phone.ts";

/** What a breach is attributed to (`auth.rateLimit.exceeded.dimension`). */
export type Dimension = "identity" | "ip" | "principal" | "custom";

/** Per-budget settings a key may read; today only the email normaliser (`PasswordConfig.rateLimitEmailKey`). */
export interface KeyContext {
  readonly email: (address: string) => string;
}

/** A bucket-key strategy over input `I`: a printable name, a dimension, a guard, and the key part. */
export interface Key<I> {
  readonly strategy:
    | "ip"
    | "email"
    | "identifier"
    | "user"
    | "session"
    | "client"
    | "phone"
    | "custom";
  readonly dimension: Dimension;
  /** `Schema.is` of the strategy's own input struct: narrows `unknown`, never a cast. */
  readonly accepts: (input: unknown) => input is I;
  readonly part: (input: I, context: KeyContext) => string;
}

const make = <S extends Schema.Constraint>(spec: {
  readonly strategy: Key<S["Type"]>["strategy"];
  readonly dimension: Dimension;
  readonly input: S;
  readonly part: (input: S["Type"], context: KeyContext) => string;
}) => {
  const key: Key<S["Type"]> = {
    strategy: spec.strategy,
    dimension: spec.dimension,
    accepts: Schema.is(spec.input),
    part: spec.part,
  };
  return key;
};

/**
 * TMS-006: THE per-address bucket normaliser (was `PasswordRateLimits.defaultEmailRateKey`,
 * `Channel.emailRateKey` and passkey's bare `toLowerCase`). Trims, lower-cases and strips a `+tag`
 * from a local part that does not start with `+`. Only the key is normalised; delivery and storage
 * keep the literal address.
 */
export const emailKey = (address: string) => {
  const lowered = address.trim().toLowerCase();
  const at = lowered.lastIndexOf("@");
  if (at === -1) return lowered;
  const local = lowered.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}${lowered.slice(at)}`;
};

/** The source address the handler resolved through `ClientAddress`; unresolvable falls into one shared `unknown` bucket. */
export const ip = make({
  strategy: "ip",
  dimension: "ip",
  input: Schema.Struct({ ip: Schema.optional(Schema.String) }),
  part: (input) => `ip:${input.ip ?? "unknown"}`,
});

/** A target address (mail-bombing, enumeration). Normalised by the budget's `KeyContext.email`. */
export const email = make({
  strategy: "email",
  dimension: "identity",
  input: Schema.Struct({ email: Schema.String }),
  part: (input, context) => `email:${context.email(input.email)}`,
});

/** A token's public id (never its secret half). */
export const identifier = make({
  strategy: "identifier",
  dimension: "identity",
  input: Schema.Struct({ identifier: Schema.String }),
  part: (input) => `identifier:${input.identifier}`,
});

/** The signed-in user the caller is (the handler passes `CurrentPrincipal`'s id). */
export const user = make({
  strategy: "user",
  dimension: "principal",
  input: Schema.Struct({ userId: Schema.String }),
  part: (input) => `user:${input.userId}`,
});

/** A session id (a code-guesser holding one session). */
export const session = make({
  strategy: "session",
  dimension: "principal",
  input: Schema.Struct({ sessionId: Schema.String }),
  part: (input) => `session:${input.sessionId}`,
});

/** An OAuth/device client id: the target a secret- or code-guesser aims at. */
export const client = make({
  strategy: "client",
  dimension: "identity",
  input: Schema.Struct({ clientId: Schema.String }),
  part: (input) => `client:${input.clientId}`,
});

/** SOS-007 (was `RateLimits.phoneKey`): E.164-normalised; non-numbers share one `invalid` bucket. */
export const phone = (options?: Phone.NormalizeOptions) =>
  make({
    strategy: "phone",
    dimension: "identity",
    input: Schema.Struct({ phone: Schema.String }),
    part: (input) =>
      `phone:${Option.getOrElse(Phone.normalizePhone(input.phone, options), () => "invalid")}`,
  });

/** BEH-EA-108's explicit opt-in: the author names the dimension and the input schema and owns the reasoning. */
export const custom = <S extends Schema.Constraint>(
  dimension: Dimension,
  input: S,
  part: (input: S["Type"]) => string,
) => make({ strategy: "custom", dimension, input, part: (value) => `custom:${part(value)}` });
