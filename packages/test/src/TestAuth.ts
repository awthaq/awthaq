// @awthaq/test — TestAuth
//
// spec/behaviors/25-testing-harness.md, BEH-EA-193 through BEH-EA-200.
//
// **What is deliberately not built here, and why:**
// - BEH-EA-193's "permissive `RateLimiter`" is wired in below
//   (`RateLimiter.layerPermissive`, `@awthaq/ports`'s own BEH-EA-112
//   default; `rateLimiter: "enforcing"` swaps in the real in-memory limiter).
//   `RateLimits.layer` (`@awthaq/core`'s per-plugin rule
//   *registry* half) is provided too: every plugin that declares rate-limit
//   rules opens a `RateLimits.budget` in its layer, and core's own `account`
//   handlers do the same, so building any of them (and, by extension,
//   `TestAuth.layer(built)`) genuinely needs a `RateLimitsRegistry` instance
//   to register into.
// - BEH-EA-194 (`TestClock`) and BEH-EA-195 (`Layer.mock`) are `effect`'s own
//   exports, not awthaq's — nothing to wrap; a test simply imports them
//   directly (`effect/testing/TestClock`, `effect/Layer`).
// - BEH-EA-196 (`qadiTestLayer`, `subjectWith`) is `@qadi/testing`'s own
//   package, already published and real — again nothing to wrap. Its
//   illustrative `subjectWith` does not exist under that name in the real,
//   installed `@qadi/testing`/`@qadi/core`; the real equivalent is
//   `@qadi/core`'s own `makeSubject`/`fromRoles`, and `@qadi/testing`'s
//   `Fixtures.ts` ready-made subjects — a test imports those directly.
// - BEH-EA-200 (hook veto/observe isolation): `runPluginContractTests`' opt-in `hooks`
//   option (PV-260) exercises each tap the plugin *declares* (`AuthPlugin.layer`'s
//   `taps`, whose handlers `plugin.taps` exposes) against a stub input on a fresh point
//   of the tap's own kind. Taps an application adds itself are not declared on a plugin;
//   a test taps a point by passing the tap in `TestAuth.layer`'s `taps` option — it
//   requires its point, which the base provides (every core point's own layer,
//   `Hooks.HooksLive`) or a composed plugin declares (`AuthPlugin.Service`'s `hookPoints`,
//   provided once beneath the taps). The mechanism itself is covered by
//   `packages/core/test/HookPoint.test.ts`.
// - BEH-EA-199's "no `Redacted` value reaches a span or event" check is
//   mechanical (EOTS-002): `RedactionGuard` installs a recording tracer and
//   logger (and an `AuthEvents` inspector) into `TestAuth.layer`, and
//   `runPluginContractTests`' opt-in `redaction` option drives a plugin's flows
//   against it with canary secrets.
//
// **`TestAuth.signInAs` targets `HttpRouter.toWebHandler`'s raw
// `(Request) => Promise<Response>` shape, not `HttpApiTest.groups`'s
// in-memory client.** BEH-EA-197's own illustrative code calls
// `client.admin.stats()` with no visible session plumbing after
// `signInAs`, implying some ambient mechanism thread a session into later
// calls automatically — but `HttpApiTest.groups` builds its own internal
// `HttpClient` with no seam for injecting a cookie header into it, and
// exposes no such seam itself. Every wire-level test already built in this
// repository (`password`'s, `oauth`'s, `qadi`'s, `server`'s own
// `AuthHttp.test.ts` files) instead threads a `Set-Cookie`/`cookie` header
// by hand between `HttpRouter.toWebHandler`'s real `Request`/`Response`
// objects — a proven, already-exercised pattern with a real extension seam.
// `signInAs` returns the ready-to-use cookie header string for exactly that
// pattern, rather than reimplementing (or fighting) `HttpApiTest.groups`'s
// internals for an ambient-session mechanism this codebase does not
// otherwise use anywhere.
//
// **`signInAs`'s `roles` is a caller-supplied callback, not a `{roles: [...]}`
// list.** `@awthaq/test` sits in the same stratum as `@awthaq/roles`
// (both are downstream of `core`/`server`/`qadi`/`sql`/`ports`/`api`, per
// `spec/overview.md`'s own package map) — it does not depend on `roles` (or
// any other plugin package), so it has no way to assign a role itself. A
// caller that has installed `Roles` passes `onSignedUp: (userId) =>
// roles.assign(userId, "member")`; `signInAs` runs it, if given, right after
// issuing the user and before minting the session.
// ELC-004: `memoryFoundation`, what every memory layer needs beneath it (defined in `internal/foundation.ts`,
// shared with `RecordsContract`).
export { memoryFoundation } from "./internal/foundation.ts";
export type { FoundationServices, RetentionRegistryService } from "./internal/foundation.ts";

export {
  TestCsrfConfig,
  encryption,
  httpClient,
  layer,
  recordModes,
} from "./internal/composition.ts";
export type { CommonOptions, MemoryMode, SqlMode } from "./internal/composition.ts";

export {
  csrfSetCookie,
  csrfToken,
  sessionSetCookie,
  signInAs,
  withRequest,
  withoutRequest,
} from "./internal/session.ts";
export type { SignedInSession } from "./internal/session.ts";

export { buildContext, lazyApp, listen, openApps, serve, withApp } from "./internal/appHarness.ts";
export type {
  AgentOptions,
  App,
  AppNeeds,
  LazyApp,
  ListeningApp,
  RequestInit,
  ServeOptions,
  SignInOptions,
  SignedInAgent,
} from "./internal/appHarness.ts";

export type { TestFramework } from "./TestFramework.ts";

export {
  migratedSchema,
  runPluginContractTests,
  throwingFramework,
} from "./internal/contractRunner.ts";
export type { ContractTestOptions, RecordsOption } from "./internal/contractRunner.ts";

// Plan 05: the plugin-table conformance suites, beside `runPluginContractTests` so a third-party
// plugin runs them the same way (`TestAuth.runTenantIsolationTests`, `TestAuth.runSealedColumnTests`).
export { runSealedColumnTests } from "./SealedConformance.ts";
export type { SealedColumnConfig } from "./SealedConformance.ts";
export { runTenantIsolationTests } from "./TenantConformance.ts";
export type {
  KeyedProbe,
  MethodClass,
  Probe,
  TableCase,
  TenantIsolationConfig,
} from "./TenantConformance.ts";
