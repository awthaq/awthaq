---
"@awthaq/admin": minor
---

`Admin.AdminConfig` (the `Context.Reference`) is no longer exported: the admin plugins read it only per operation, through their gate (ADR-EA-018 Decision 8, rev 1.5).

Migration: provide configuration with `Admin.config({ … })` (build time: `Layer.provide`; per tenant: a `TenantConfig` lookup; per request: `Effect.provide(Admin.config({ … }))`), and read the effective configuration with `GET /admin/config` / `EffectiveConfig` (BEH-EA-229). `Admin.AdminConfigShape` and the gate input types are unchanged.
