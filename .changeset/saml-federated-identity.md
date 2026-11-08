---
"@awthaq/saml": minor
---

A connection with `trustsEmail` now links only addresses in the domains it claims (`emailDomains`, BEH-EA-317), and the user it creates on a first sign-in has its address verified, as a trusted OAuth provider's does (BEH-EA-245, ADR-EA-043). The resolution moves to core's `FederatedIdentity`; two concurrent first sign-ins for one NameID sign in as one user, and a second lost race in a row is the uniform `SamlAssertionRejected`.

Migration: a `trustsEmail` connection whose users sign in with addresses outside its `emailDomains` stops auto-linking them (they get `SamlAssertionRejected`, reason `emailInUse`): add the domains to the connection, or link those accounts explicitly. Find them with `SELECT c.id, a.subject FROM saml_connection c JOIN accounts a ON a."providerId" = 'saml:' || c."organizationId" || ':' || c.id WHERE c."trustsEmail"` and compare each linked user's address domain with the connection's domains. ADR-EA-043, BEH-EA-245.
