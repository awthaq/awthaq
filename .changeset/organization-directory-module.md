---
"@awthaq/organization": minor
"@awthaq/admin": minor
"@awthaq/saml": patch
"@awthaq/scim": patch
"@awthaq/qadi": patch
---

The organization row is a system module, `OrganizationDirectory` (`find`, `findActive`, `requireActive`, `isSlugAvailable`, `listForUser`, `listPage`, `create`, `update`, `delete`, `suspend`, `reinstate`), exposed by `Organization.layer` (ADR-EA-040). `create` writes the organization and its creator's membership in one transaction (a failed creation leaves neither) and the creator's membership now fires `AfterAddMember`. `suspend` and `reinstate` take a `PlatformAdminActor`, run the new `BeforeSuspendOrganization` / `AfterSuspendOrganization` and `BeforeReinstateOrganization` / `AfterReinstateOrganization` hook points, and still publish `auth.admin.organizationSuspended` / `organizationUnsuspended`. `AdminTenants` suspends, reinstates and lists through the Directory instead of writing `OrganizationRecords`, so a platform suspension is observable and `@awthaq/qadi`'s `DecisionCacheInvalidationLive` now clears a long-lived decision cache on suspension, reinstatement, a team move and a team-role change. The SAML and SCIM token and connection gates read `OrganizationDirectory.findActive` / `find`. `OrganizationQadi.relationships` reads the Directory.

Migration: `AdminTenantsShape["suspendOrganization"]` and `["unsuspendOrganization"]` (and the `/admin/organizations/:id/suspend` and `/unsuspend` endpoints) can now answer `HookAborted` (`403`) when a `BeforeSuspendOrganization` / `BeforeReinstateOrganization` tap vetoes. `AdminTenants`, `SamlConnections.layerStore`, `Saml.layer` and `ScimAuthenticationLive` require the exposed `OrganizationDirectory` instead of `OrganizationRecords`. A host that installs `DecisionCacheInvalidationLive` must provide `OrganizationHooksLive` (as before) which now includes the four new points. `OrganizationLive` compositions are unchanged. The tenant middleware still reads `OrganizationRecords` directly (a raw read of a suspended organization is deliberate).
