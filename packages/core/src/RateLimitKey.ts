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

import { Api } from "@awthaq/api";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Phone from "./Phone.ts";

/** What a breach is attributed to (`auth.rateLimit.exceeded.dimension`). */
export type Dimension = "identity" | "ip" | "principal" | "custom";

/** What a key may read beyond its input: the budget's email normaliser and the call's request context. */
export interface KeyContext {
  readonly email: (address: string) => string;
  /** What the budget read from `Api.AuthRequestContext` for this call (`noRequest` when there was none). ADR-EA-047. */
  readonly request: Api.RequestFacts | Api.NoRequest;
}

/**
 * A bucket-key strategy over input `I`: a printable name, a dimension, a guard, and the key part. `R` is the per-call
 * service the key reads (`Api.AuthRequestContext` for `ip`, ADR-EA-047; `never` for every other strategy).
 */
export interface Key<I, R = never> {
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
  /** `None`: the rule does not apply to this call (only `ip`, under `NoRequest`). */
  readonly part: (input: I, context: KeyContext) => Option.Option<string>;
  /** Whether the budget must read the request context for this key (`ip` only). */
  readonly readsRequest: boolean;
  /** Phantom: the per-call service the key reads. Never assigned (the `"~input"` precedent in `RateLimitModel`). */
  readonly "~requires"?: R;
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
    part: (input, context) => Option.some(spec.part(input, context)),
    readsRequest: false,
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

/**
 * What an `ip` rule takes: nothing. `ip?: never` (not `{}`, which disables the excess-property check) makes
 * `spend("xByIp", { ip })` a compile error.
 */
export interface NoInput {
  readonly ip?: never;
}
const isNoInput = (input: unknown): input is NoInput =>
  typeof input === "object" && input !== null && !("ip" in input && input.ip !== undefined);

/**
 * The request's own address, read from `Api.AuthRequestContext` (ADR-EA-047). No input field: the address is not the
 * caller's to supply. An unresolvable address falls into one shared `unknown` bucket; work that answers no request
 * (`noRequest`) is not throttled per source (the rule does not apply; the identity and principal rules still do).
 */
export const ip: Key<NoInput, Api.AuthRequestContext> = {
  strategy: "ip",
  dimension: "ip",
  accepts: isNoInput,
  part: (_input, context) =>
    Api.isRequest(context.request)
      ? Option.some(`ip:${Option.getOrElse(context.request.ip, () => "unknown")}`)
      : Option.none(),
  readsRequest: true,
};

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
