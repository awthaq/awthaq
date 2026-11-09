---
"@awthaq/organization": patch
---

The system `OrganizationInvitations.cancel` refuses a suspended organization's invitation with `InvitationNotFound` (checked before its status) and writes, vetoes and announces nothing, as the `cancelInvitation` endpoint already did (BEH-EA-237). A host, SCIM or administrative caller that cancelled such an invitation directly now gets the not-found answer; reinstate the organization first.
