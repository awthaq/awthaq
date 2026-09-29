// @awthaq/core — EffectiveConfig
//
// spec/behaviors/26-cli.md BEH-EA-229, ADR-EA-006 revision 1.2 (ECS-008, EP-009).
//
// The two ways to answer "what is this application's configuration":
//
//   - `read(context, ...)` is a pure function over a `Context`. The CLI builds
//     an application's *configuration Layer* on its own (`Password.config(...)`
//     needs no ports and no database), and reads the descriptors back out of the
//     resulting `Context` — no application is running.
//   - `snapshot(...)` is the same read from inside a running application (or a
//     per-tenant scope, EP-009): it reads the ambient `Context`, so a value a
//     `LayerMap` overrides for one tenant shows up for that tenant.
//
// Neither ever unwraps a `Redacted` or a field a descriptor declares sensitive
// (`ConfigDescriptor.flatten` renders it `<redacted>`).

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AuditChain from "./AuditChain.ts";
import * as ConfigDescriptor from "./ConfigDescriptor.ts";
import * as MailDispatch from "./MailDispatch.ts";
import * as SessionCookie from "./SessionCookie.ts";
import * as Sessions from "./Sessions.ts";

/** A descriptor and who declared it: a plugin id, or `core`/`server` for services that are not plugins. */
export interface Owned {
  readonly owner: string;
  readonly descriptor: ConfigDescriptor.ConfigDescriptor;
}

/** One rendered descriptor value. */
export interface Item extends ConfigDescriptor.View {
  readonly owner: string;
}

export const owned = (
  owner: string,
  descriptors: ReadonlyArray<ConfigDescriptor.ConfigDescriptor>,
): ReadonlyArray<Owned> => descriptors.map((descriptor) => ({ owner, descriptor }));

const cookieAudit = (
  value: SessionCookie.SessionCookieConfigShape,
  environment: ConfigDescriptor.Environment,
): ReadonlyArray<ConfigDescriptor.Finding> => {
  const findings: Array<ConfigDescriptor.Finding> = [];
  const severity = environment.production ? "warning" : "info";
  if (value.mode._tag === "SecureDomain" && value.mode.sameSite !== "strict") {
    findings.push(
      ConfigDescriptor.finding(
        severity,
        "cookie-samesite-relaxed",
        `the session cookie is SameSite=${value.mode.sameSite}: the CSRF double-submit middleware is then the only cross-site defence`,
      ),
    );
  }
  if (value.mode._tag === "HostEmbedded") {
    findings.push(
      ConfigDescriptor.finding(
        severity,
        "cookie-samesite-relaxed",
        "the session cookie is SameSite=None; Partitioned (embedded mode): the CSRF double-submit middleware is then the only cross-site defence",
      ),
    );
  }
  return findings;
};

const NINETY_DAYS = Duration.days(90);

/**
 * The configuration references `@awthaq/core` itself reads. They belong to no
 * plugin (the domain services are not plugins), so the manifest cannot list
 * them: the CLI adds this list next to `manifest.config`.
 */
export const core: ReadonlyArray<Owned> = owned("core", [
  ConfigDescriptor.make(Sessions.SessionConfig, {
    audit: (value) =>
      Duration.isGreaterThan(value.absolute, NINETY_DAYS)
        ? [
            ConfigDescriptor.finding(
              "warning",
              "session-lifetime-long",
              "the absolute session lifetime exceeds 90 days",
            ),
          ]
        : [],
  }),
  ConfigDescriptor.make(SessionCookie.SessionCookieConfig, { audit: cookieAudit }),
  ConfigDescriptor.make(MailDispatch.MailDispatchConfig),
  ConfigDescriptor.make(AuditChain.AuditChainConfig, {
    audit: (value, environment) =>
      environment.production && Option.isNone(value.key)
        ? [
            ConfigDescriptor.finding(
              "warning",
              "audit-chain-unkeyed",
              "the audit hash chain has no key: an attacker with database write access can recompute it",
            ),
          ]
        : [],
  }),
]);

/** Renders every descriptor's value as read from `context` (a default when the context never set it). */
export const read = (
  context: Context.Context<never>,
  descriptors: ReadonlyArray<Owned>,
): ReadonlyArray<Item> =>
  descriptors.map(({ owner, descriptor }) => ({ owner, ...descriptor.view(context) }));

/** Audits every descriptor against `context`; a finding is tagged with its owner. */
export const audit = (
  context: Context.Context<never>,
  descriptors: ReadonlyArray<Owned>,
  environment: ConfigDescriptor.Environment,
): ReadonlyArray<ConfigDescriptor.Finding & { readonly owner: string }> =>
  descriptors.flatMap(({ owner, descriptor }) =>
    descriptor.audit(context, environment).map((found) => ({ owner, ...found })),
  );

/**
 * The same read from inside a running application: the ambient `Context` is
 * the application's own, so what it reports is what is in effect right now
 * (for the tenant scope it runs in, when there is one). Sensitive values are
 * `<redacted>`; a caller exposing this over HTTP still gates it (an admin
 * permission), because the *shape* of configuration is operational detail.
 */
export const snapshot = (descriptors: ReadonlyArray<Owned>) =>
  Effect.context<never>().pipe(Effect.map((context) => read(context, descriptors)));
