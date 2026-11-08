---
"@awthaq/core": minor
---

`Auth.make` validates and documents the composed contract's session lifecycle (ADR-EA-045): it refuses an endpoint declaring two `SessionLifecycle` kinds, and annotates `api`, `publicApi` and `adminApi` with `SessionLifecycle.openApi(SessionLifecycle.inventory(api))`, so the OpenAPI document carries `x-awthaq-session` and the `Cache-Control: no-store`, `set-auth-token` and `x-awthaq-session-ended` headers for exactly the declared operations.

Migration: an application that sets its own api-level `OpenApi.Transform` replaces this one; call `SessionLifecycle.openApi(SessionLifecycle.inventory(api))` inside its own to keep both. BEH-EA-343.
