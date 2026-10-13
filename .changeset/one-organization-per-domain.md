---
"@awthaq/organization": minor
"@awthaq/saml": minor
---

An email domain belongs to one organization across protocols.

- `@awthaq/organization`: new `DomainClaims` record store (`organization_domain_owner`, whose primary key makes a first claim atomic, and `organization_domain_claim`), part of `Organization.records`. `OrganizationConnectionStore` claims a connection's `emailDomains` through it in the connection's own transaction and fails `ConnectionDomainTaken` for a domain another organization owns over any protocol; `connectionsOnOrganizationDelete` releases the organization's claims. `OrganizationConnections.layerStore` now requires `DomainClaims` and `SqlTransaction`.
- `@awthaq/saml`: `SamlConnectionStore` claims through the same store and fails `SamlDomainTaken`; creating, updating domains of, and deleting a connection (and deleting its organization) keep the claim in step. `Saml.layer` requires `DomainClaims`, provided by `Organization.records`.
- BEH-EA-317, ADR-EA-023 Decision 4. The organization that owns a domain may still route it over both protocols (`Sso.preferred` picks).

Migration: two migrations are added: organization's `create_organization_domain_claim` (creates the two tables and claims the stored OIDC domains) and Saml's `claim_saml_connection_domains`, which claims the stored SAML domains and FAILS, naming the domains, when one organization holds a domain over OIDC that another holds over SAML. Before upgrading, list such clashes (`SELECT d.domain FROM saml_connection_domain d JOIN saml_connection c ON c.id = d."connectionId" JOIN organization_oauth_connection_domain o ON o.domain = d.domain WHERE o."organizationId" <> c."organizationId"`) and delete the connection (or its domains) of the organization that does not own the domain. `Auth.make` numbers every plugin's migrations in one list, so the new organization migration shifts the ids of the plugins composed after it: on a database that is already migrated, `awthaq migration status` refuses it (ECS-009); re-baseline the plugin ledger or migrate a fresh database. A host composing `OrganizationConnections.layerStore` or a hand-built `Saml.layer` by hand provides `DomainClaims.layerMemory`/`layerSql` and `SqlTransaction`.
