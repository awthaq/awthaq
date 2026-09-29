// AH-007: the two custom parameter types 15-password.feature's steps use in place of a bare
// `{string}` catch-all. A step whose whole text was one quoted string had to dispatch on
// `configExpr.includes(...)`, and any literal it did not recognise silently fell through to a
// default. Here every literal the feature may name is an exact table key, and an unknown one
// fails the step loudly instead of configuring something else.
import { ParameterTypeStore } from "@effect-cucumber/vitest";
import type { Password } from "@awthaq/password";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export type PasswordConfigOptions = Partial<Password.PasswordConfigShape>;

/** Every `Password.config`-style expression the feature names, unquoted and with the feature's `\"` escapes resolved. */
const CONFIG_EXPRESSIONS: Readonly<Record<string, PasswordConfigOptions>> = {
  "password({ breachCheck: true })": { breachCheck: true },
  'password({ breachCheck: { onUnavailable: "reject" } })': {
    breachCheck: { onUnavailable: "reject" },
  },
  "password({ breachCheck: true, minLength: 12 })": { breachCheck: true, minLength: 12 },
  "Password.config({ minLength: 16 })": { minLength: 16 },
};

/** The literal as it appears in the feature: quoted, inner quotes written `\"`. */
const CONFIG_LITERAL = /"[Pp]assword(?:\.config)?\(\{(?:[^"\\]|\\.)*\}\)"/;

export const passwordConfigFromLiteral = (literal: string): PasswordConfigOptions => {
  const expression = literal.slice(1, -1).replaceAll('\\"', '"');
  const found = CONFIG_EXPRESSIONS[expression];
  if (found === undefined) {
    throw new Error(
      `unrecognised Password config expression ${literal} — add it to CONFIG_EXPRESSIONS (AH-007) rather than letting it configure a default`,
    );
  }
  return found;
};

/** CSD-009: the breach-provider failure modes an outline row names. */
export type BreachFailureName = "timeout" | "5xx" | "malformed";

export const passwordParameterTypes = ParameterTypeStore.layer([
  {
    name: "passwordConfig",
    regexp: CONFIG_LITERAL,
    transform: passwordConfigFromLiteral,
    definedAt: Option.some("features/step-definitions/PasswordParameterTypes.ts"),
    useForSnippets: Option.none(),
    preferForRegexpMatch: Option.none(),
  },
  {
    name: "breachFailure",
    regexp: /timeout|5xx|malformed/,
    transform: (name: string): BreachFailureName => {
      if (name === "timeout" || name === "5xx" || name === "malformed") return name;
      throw new Error(`unrecognised breach-provider failure mode "${name}"`);
    },
    definedAt: Option.some("features/step-definitions/PasswordParameterTypes.ts"),
    useForSnippets: Option.none(),
    preferForRegexpMatch: Option.none(),
  },
]).pipe(Layer.orDie);
