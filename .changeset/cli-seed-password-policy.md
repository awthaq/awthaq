---
"@awthaq/cli": minor
---

`awthaq seed admin` sets a password through the application's Password plugin (its exposed `PasswordCredential`, ADR-EA-048): the password must pass `Password.config`'s policy (minimum length, breach screening) before anything is written, and a refusal is a usage error (exit 2) carrying the policy's hints. A password over an account that already has one now replaces it instead of being silently dropped, and `auth.password.changed` is published when a password is set. The CLI's own 12-character minimum (`MIN_PASSWORD_LENGTH`) is removed.

Migration: an application without the Password plugin can still seed an account, but not with a password (`ApplicationUnavailable`, exit 9). An operator script that relied on a re-run leaving an existing password alone should omit the password. A seeded password now reaches the breach-check provider unless the application sets `Password.config({ breachCheck: false })`.
