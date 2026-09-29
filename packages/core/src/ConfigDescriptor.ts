// @awthaq/core — ConfigDescriptor
//
// spec/behaviors/26-cli.md BEH-EA-229, ADR-EA-006 revision 1.2 (ECS-008, EP-009).
//
// ADR-EA-006 keeps a plugin's configuration in a `Context.Reference` with a
// default, overridden by an ordinary `Layer.provide` — no options-merging
// subsystem. Its first revision accepted that no artifact then lists "every
// configuration value this application has set". A *descriptor* closes that
// gap without a second description of configuration: it wraps the reference
// itself (so it cannot drift from what the plugin reads), says which fields
// hold secrets, and optionally audits a value against the insecure-default
// rules. `Auth.make` exposes every installed plugin's descriptors as
// `manifest.config`, derived without evaluating any Layer; the CLI (`doctor`,
// `config list`) and `EffectiveConfig.snapshot` read values through them.
//
// Reading is done against a `Context`, not a live application: a configuration
// Layer such as `Password.config(...)` needs no ports and no database, so
// building it on its own and reading the reference back out of the resulting
// `Context` yields the effective value it sets, and a reference the Layer never
// provided reads back as its default (`source: "default"`).

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as ByteSize from "effect/ByteSize";

/** What a finding is worth acting on. */
export type Severity = "error" | "warning" | "info";

/**
 * One audited problem with a configuration value. `message` MUST NOT contain a
 * sensitive value: it names the field and the rule, never what the field holds.
 */
export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
}

/** Where a configuration is being audited: an insecure default only matters in production. */
export interface Environment {
  readonly production: boolean;
}

/** One leaf of a configuration value, already rendered for output. */
export interface Entry {
  readonly path: string;
  /** `"<redacted>"` for a sensitive leaf — never the value itself. */
  readonly value: string;
  readonly sensitive: boolean;
}

export const REDACTED = "<redacted>";

/** The effective value of one descriptor, rendered. */
export interface View {
  readonly key: string;
  readonly source: "default" | "override";
  readonly entries: ReadonlyArray<Entry>;
}

/** Non-generic surface of a descriptor, so descriptors of different shapes share one list. */
export interface ConfigDescriptor {
  /** The reference's own key, e.g. `awthaq/password/Config`. */
  readonly key: string;
  /** Top-level fields declared sensitive (a plain string secret, say). `Redacted` values are always redacted regardless. */
  readonly sensitive: ReadonlyArray<string>;
  readonly view: (context: Context.Context<never>) => View;
  readonly audit: (
    context: Context.Context<never>,
    environment: Environment,
  ) => ReadonlyArray<Finding>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * ECS-005: a connection string carries its password (`postgres://app:hunter2@host/db`). A
 * descriptor that does not declare the field sensitive still never prints that password.
 */
const scrubCredentials = (value: string) =>
  value.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@\s]*):[^@/\s]*@/i, `$1:${REDACTED}@`);

const leaf = (path: string, value: string, sensitive: boolean): Entry => ({
  path,
  value: sensitive ? REDACTED : scrubCredentials(value),
  sensitive,
});

/**
 * Renders a configuration value to leaves. A leaf is redacted when its
 * top-level field is declared sensitive or when it is a `Redacted` at any depth
 * — declaring a secret in the type (`Redacted<string>`) is enough, the
 * descriptor's `sensitive` list exists for secrets that are plain strings.
 */
const flatten = (path: string, value: unknown, sensitive: boolean): ReadonlyArray<Entry> => {
  if (sensitive || Redacted.isRedacted(value)) return [leaf(path, REDACTED, true)];
  if (value === null || value === undefined) return [leaf(path, String(value), false)];
  if (typeof value === "function") return [leaf(path, "[function]", false)];
  if (typeof value === "string") return [leaf(path, value, false)];
  if (ByteSize.isByteSize(value)) return [leaf(path, ByteSize.format(value), false)];
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return [leaf(path, String(value), false)];
  }
  if (Duration.isDuration(value)) return [leaf(path, Duration.format(value), false)];
  if (Option.isOption(value)) {
    return Option.isSome(value) ? flatten(path, value.value, false) : [leaf(path, "none", false)];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [leaf(path, "[]", false)];
    return value.flatMap((item, index) => flatten(`${path}[${index}]`, item, false));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return [leaf(path, "{}", false)];
    return keys.flatMap((key) => flatten(`${path}.${key}`, value[key], false));
  }
  const proto: unknown = Object.getPrototypeOf(value);
  const name =
    isRecord(proto) && typeof proto["constructor"] === "function" ? proto["constructor"].name : "";
  return [leaf(path, name === "" ? "[object]" : `[${name}]`, false)];
};

/**
 * Wraps a `Context.Reference` as a descriptor. `sensitive` is checked against
 * the value's own keys at the type level, so a renamed field cannot leave a
 * stale entry behind. `audit` receives the effective value; the descriptor does
 * the reading, so an audit rule is a plain function of the value.
 */
export const make = <A>(
  reference: Context.Reference<A>,
  options?: {
    readonly sensitive?: ReadonlyArray<Extract<keyof A, string>>;
    readonly audit?: (value: A, environment: Environment) => ReadonlyArray<Finding>;
    /** Narrows what `view` renders (a role catalog is listed by name, not dumped): the value is still audited whole. */
    readonly project?: (value: A) => unknown;
  },
): ConfigDescriptor => {
  const sensitive: ReadonlyArray<string> = options?.sensitive ?? [];
  const read = (context: Context.Context<never>): A =>
    Context.getOrElse(context, reference, () => reference.defaultValue());
  return {
    key: reference.key,
    sensitive,
    view: (context) => {
      const value = options?.project === undefined ? read(context) : options.project(read(context));
      const entries = isPlainObject(value)
        ? Object.keys(value).flatMap((field) =>
            flatten(field, value[field], sensitive.includes(field)),
          )
        : flatten("value", value, false);
      return {
        key: reference.key,
        source: context.mapUnsafe.has(reference.key) ? "override" : "default",
        entries,
      };
    },
    audit: (context, environment) => options?.audit?.(read(context), environment) ?? [],
  };
};

/** A finding builder that keeps the rule's shape uniform across plugins. */
export const finding = (severity: Severity, code: string, message: string): Finding => ({
  severity,
  code,
  message,
});
