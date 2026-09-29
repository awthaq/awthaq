// @awthaq/oauth — OAuthConnections
//
// EP-004/CWM-001 (wayfinder ticket 18, ADR-EA-018): the port through which
// `OAuthProviders` consults per-organization OAuth *connections* after its
// static registry. This plugin never imports the organization plugin (plugins
// do not depend on one another's stratum): the resolver is a port-shaped
// callback, and `@awthaq/organization` provides one backed by its
// `organization_oauth_connection` table (BEH-EA-235).
//
// A `Context.Reference` with a default (ADR-EA-011): nothing has to provide it,
// an unprovided read is "no connections", and the static providers behave
// exactly as before.
//
// What is resolved is a *config*, not a resolved provider: discovery (its
// deadline, its retries, its issuer-mismatch defect) stays this plugin's
// business, so a connection gets the very same treatment a static provider
// does. `revision` lets the resolver say "this connection changed" (a rotated
// secret, an edited endpoint) so a cached discovery result is dropped.

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as OAuthProvider from "./OAuthProvider.ts";

export interface OAuthConnection {
  /** The provider descriptor; its `id` is the namespaced connection id (`org:<organizationId>:<connectionId>`), never a static provider's. */
  readonly config: OAuthProvider.OAuthProviderConfig;
  /** Changes whenever the stored connection does; a cached discovery is reused only for an equal revision. */
  readonly revision: string;
}

export interface OAuthConnectionResolverShape {
  /** The connection `providerId` names, or `None` when it names none (the provider is then unknown). */
  readonly find: (providerId: string) => Effect.Effect<Option.Option<OAuthConnection>>;
}

/** The installed connection resolver, if any — `Option.none()` unless the application provides one. */
export const OAuthConnectionResolver = Context.Reference<
  Option.Option<OAuthConnectionResolverShape>
>("awthaq/oauth/ConnectionResolver", { defaultValue: () => Option.none() });

/** Installs `resolver`; `Organization.oauthConnections` builds one over the organization plugin's connections. */
export const layer = (resolver: OAuthConnectionResolverShape) =>
  Layer.succeed(OAuthConnectionResolver, Option.some(resolver));
