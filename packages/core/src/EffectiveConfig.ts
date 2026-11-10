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
//   - `snapshot(built, ...)` is the same read from inside a running application
//     (or a per-tenant scope, EP-009): `built` is what the application's layer
//     was built in, the calling fiber's context is the ambient one, and each
//     descriptor resolves the two by its key's scope (BEH-EA-355), so a value a
//     `LayerMap` sets for one tenant shows up for that tenant only where an
//     operation reads it.
//
// Neither ever unwraps a `Redacted` or a field a descriptor declares sensitive
// (`ConfigDescriptor.flatten` renders it `<redacted>`).

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Accounts from "./Accounts.ts";
import * as ConfigDescriptor from "./ConfigDescriptor.ts";
import * as MailDispatch from "./MailDispatch.ts";
import * as RateLimits from "./RateLimits.ts";
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
  if (value.mode._tag === "HostLax") {
    findings.push(
      ConfigDescriptor.finding(
        severity,
        "cookie-samesite-relaxed",
        "the session cookie is SameSite=Lax: it rides top-level cross-site GET navigations, so nothing state-changing may hang off a GET; the CSRF double-submit middleware covers unsafe methods",
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
 * The configuration keys `@awthaq/core` itself reads, tenant- and deployment-scoped. They belong to no
 * plugin (the domain services are not plugins), so the manifest cannot list
 * them: the CLI adds this list next to `manifest.config`.
 */
export const core: ReadonlyArray<Owned> = owned("core", [
  ConfigDescriptor.make(Sessions.SessionConfigScoped, {
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
  ConfigDescriptor.make(Accounts.AccountsPolicyScoped),
  ConfigDescriptor.make(RateLimits.RateLimitOverridesScoped),
  ConfigDescriptor.make(SessionCookie.SessionCookieConfigScoped, { audit: cookieAudit }),
  ConfigDescriptor.make(MailDispatch.MailDispatchConfigScoped),
]);

/**
 * Renders every descriptor's value as read from `built` (a default when the context never set it); `calling`, when
 * given, is the calling fiber's context, resolved by each key's scope.
 */
export const read = (
  built: Context.Context<never>,
  descriptors: ReadonlyArray<Owned>,
  calling?: Context.Context<never>,
): ReadonlyArray<Item> =>
  descriptors.map(({ owner, descriptor }) => ({ owner, ...descriptor.view(built, calling) }));

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
 * The same read from inside a running application: `built` is the context the application's layer was built in, the
 * calling fiber's context is the ambient one. Sensitive values are `<redacted>`; a caller exposing this over HTTP still
 * gates it (an admin permission), because the *shape* of configuration is operational detail.
 */
export const snapshot = (built: Context.Context<never>, descriptors: ReadonlyArray<Owned>) =>
  Effect.contextWith((calling: Context.Context<never>) =>
    Effect.succeed(read(built, descriptors, calling)),
  );

/**
 * EP-009: the descriptors a *running* application reports on. A plugin that serves an effective-config
 * view (`@awthaq/admin`'s `GET /admin/config`) reads this reference; the application provides
 * `EffectiveConfig.layer(auth.manifest)` next to its composition so the view lists every installed
 * plugin's descriptors, not only core's. Unprovided, it lists core's own.
 */
export const Catalog = Context.Reference<ReadonlyArray<Owned>>(
  "awthaq/core/EffectiveConfigCatalog",
  {
    defaultValue: () => core,
  },
);

/** Provides the composition's own descriptors (`auth.manifest.config`) plus core's to `Catalog`. */
export const layer = (manifest: {
  readonly config: ReadonlyArray<{
    readonly pluginId: string;
    readonly descriptor: ConfigDescriptor.ConfigDescriptor;
  }>;
}) =>
  Layer.succeed(Catalog, [
    ...core,
    ...manifest.config.map(({ pluginId, descriptor }): Owned => ({ owner: pluginId, descriptor })),
  ]);
