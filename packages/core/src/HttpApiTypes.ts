// @awthaq/core — HttpApiTypes
//
// spec/decisions/003-httpapi-as-contract.md (ADR-EA-003): a plugin's
// `contract` *is* an `HttpApi`/`HttpApiGroup` value, not a second
// awthaq-owned description of one — "one contract, no duplication." A
// wrapper alias here (`export interface HttpApi<...> { ... }` re-describing
// Effect's own class) would reintroduce exactly that duplication and
// silently violate the ADR.
//
// So this module *re-exports*, not wraps: each name below is the same
// class, same nominal identity, as Effect's own `effect/unstable/httpapi/*`
// — zero divergence risk. What it changes is only which **import path** a
// third-party plugin author's own source names. `effect/unstable/*` is
// Effect's own declared churn zone (v3->v4 already reorganized `platform`
// this way); a plugin author who writes
// `import { HttpApiGroup } from "@awthaq/core"` instead of
// `import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"`
// needs zero source changes when Effect 4.0 stable relocates that module —
// only this file's own re-export lines change, once, centrally, the same
// day `pnpm-workspace.yaml`'s `catalog.effect` pin is bumped off the rc
// line (MA-003, .issues/high).
//
// Scope: only the classes a plugin author's own `contract`/handler
// construction actually names (`AuthPlugin.Any["contract"]`,
// `Built<P>["api"]`, every shipped `*Api.ts` file) — `httpapi` is 56 of
// MA-003's 114 measured `effect/unstable` import sites and the only
// category that genuinely reaches a plugin author's own public types. The
// other 58 (sql/http/reactivity/schema) are internal implementation detail
// of `@awthaq/sql`/`@awthaq/server`/etc., never part of any package's own
// `index.ts` barrel, so they carry no third-party-breakage risk and get no
// re-export here.
export * as HttpApi from "effect/unstable/httpapi/HttpApi";
export * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
export * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
export * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
export * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
export * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";
