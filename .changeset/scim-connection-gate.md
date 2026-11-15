---
"@awthaq/scim": minor
"@awthaq/organization": minor
"@awthaq/saml": patch
---

`ScimConnectionStore.create` now goes through `OrganizationConnectionLifecycle`: a SCIM connection can no longer be created for an organization that does not exist or is suspended (the two are refused alike with the new `InvalidScimConnection`, before a token is generated, storing nothing), and on SQL the create takes the organization lock and re-checks the organization, so an organization deletion that commits meanwhile cannot leave a connection that no cleanup would remove. SCIM claims no email domain; it only borrows the lifecycle's gate, lock and re-check (finding F-04-01). The shared domain normaliser (`OrganizationConnectionLifecycle.normalizeDomains`, used by the OIDC and SAML stores) now refuses more than 50 distinct domains ("at most 50 email domains"), a name longer than 253 characters and a label longer than 63, as the protocol's own refusal (finding F-04-02); the SAML HTTP schema keeps its early 50-domain refusal.

Migration: `ScimConnectionStore.create` can now fail with `InvalidScimConnection` (add it to error handling; seed an organization before creating its connection), `ScimConnections.layerStore` additionally requires `OrganizationConnectionLifecycle.OrganizationConnectionLifecycle` (provided by `Organization.Organization`, which `Scim` already depends on, so a host built with `Auth.make` changes nothing), and a direct caller of `OrganizationConnectionStore` or `SamlConnectionStore` that passes more than 50 domains or an over-long domain name now receives the protocol's refusal (`InvalidConnection`, `InvalidSamlConnection`).
