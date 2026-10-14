---
"@awthaq/core": minor
"@awthaq/webhooks": minor
---
The ban note (`auth.admin.userBanned.reason`) and the organization suspension note (`auth.admin.organizationSuspended.reason`) are personal data: they are blanked in the audit trail when the person is erased and are no longer sent in webhook `data`.

Migration: a webhook receiver that read `data.reason` on `auth.admin.userBanned` or `auth.admin.organizationSuspended` must read the note through the admin API instead. ADR-EA-029, BEH-EA-277, BAM-005.
