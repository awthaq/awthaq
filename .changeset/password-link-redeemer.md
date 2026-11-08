---
"@awthaq/password": minor
---

`POST /reset-password/confirm` is rate limited per source (`confirmResetByIp`, 30 per 15 minutes) before the token is decoded, so a flood of forged tokens no longer reaches the breach check (BEH-EA-117, APS-003). A reset, verify-email or change-email token whose row names no user is now spent rather than left live (BEH-EA-118).

Migration: `Password.confirmReset` takes an optional `ip`; a host calling it in-process passes the client address to keep the per-source budget meaningful. Tune with `RateLimits.tune(Password, { confirmResetByIp: { limit: 10 } })`.
