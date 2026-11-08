---
"@awthaq/admin": patch
---

Every admin gate (user, ban, deletion, credentials, tenant administration, impersonation, episodes) is one internal module that reads the configuration in force, publishes the denial and loads the target only after the gate (BEH-EA-221, BEH-EA-236). No behavior change.

Migration: none.
