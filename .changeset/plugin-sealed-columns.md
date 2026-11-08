---
"@awthaq/core": minor
"@awthaq/webhooks": minor
"@awthaq/organization": minor
"@awthaq/saml": minor
"@awthaq/jwt": minor
"@awthaq/two-factor": minor
---

`AuthPlugin.Service` takes an optional `sealedColumns` (the `SealedColumn.column` declarations of the plugin's own tables), `Auth.make` refuses a column on a table the plugin does not own or declared twice (`Auth/SealedColumnDeclarationInvalid`), and `auth.sealedColumns` lists every one, so a rotation sweep cannot forget the TOTP secret or a signing key: `SealedColumn.sweepDeployed({ also: auth.sealedColumns })`. The webhooks, organization, saml, jwt and two-factor plugins declare their seven columns (ADR-EA-019 rev 1.3, BEH-EA-339).

Migration: none (the field is optional). A plugin that seals a column should declare it.
