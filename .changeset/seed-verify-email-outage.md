---
"@awthaq/cli": patch
---

`seed admin`: a store outage while marking the seeded administrator's email verified is now the retryable usage error (exit 2, "the database is unavailable") like every other store failure of the command, instead of a defect (ADR-EA-028).
