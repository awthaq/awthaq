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
// class, same nominal identity, as Effect's own `effect/http-api/*`
// — zero divergence risk. What it changes is only which **import path** a
// third-party plugin author's own source names. These modules are Effect's
// own declared churn zone: the rc line kept them under `effect/unstable/*`,
// effect 4.1 moved them to `effect/http-api/*` and still tags them
// `@stability unstable`. A plugin author who writes
// `import { HttpApiGroup } from "@awthaq/core"` instead of
// `import * as HttpApiGroup from "effect/http-api/HttpApiGroup"`
// needed zero source changes for that move, and will need none for the
// next — only this file's own re-export lines change, once, centrally
// (MA-003, .issues/high).
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
export * as HttpApi from "effect/http-api/HttpApi";
export * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
export * as HttpApiGroup from "effect/http-api/HttpApiGroup";
export * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
export * as HttpApiSchema from "effect/http-api/HttpApiSchema";
export * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
