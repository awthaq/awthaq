---
"@awthaq/organization": minor
---

`OrganizationMemory` is removed from the package root. `Organization.records.memory` (the plugin's records bundle: the six stores `OrganizationMemory.layer` merged, plus `ConnectionRecords` and `DomainClaims`) replaces it. **Migration:** `OrganizationMemory.layer` becomes `Organization.records.memory`, or, over `TestAuth.layer(Auth.make([Organization]))`, nothing at all.
