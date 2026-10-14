---
"@awthaq/organization": patch
---

Every veto point in the organization plugin is named by its class (`HookPoint.aborted(OrganizationHooks.BeforeX)`) instead of a hand-typed string id, so a misspelt id cannot compile. `HookAborted.point` values are unchanged. The plugin's configuration, handlers, migrations and personal-data contributions moved to their own files (`OrganizationConfig`, `OrganizationHandlers`, `OrganizationMigrations`, `OrganizationPersonalData`, `OrganizationShape`) and the domain errors to `OrganizationErrors`; `OrganizationApi` and `Organization` re-export every name they exported before.

Migration: none.
