---
"@awthaq/sql": minor
---

Remove the legacy-AAD read from `SealedColumn`. Values are sealed under the canonical AAD `<table>:<rowKey>:<column>` only (ADR-EA-019 revision 1.2).

- Removed: the `legacyAad` option of `SealedColumn.column` and of `SealedColumn.reveal`, the `legacyAad` field of `Column`/`Sweepable`, `Revealed.legacy` and `SweepReport.legacy` (so the `legacy` field of `ColumnSweep` and of the `sweepAll` Info line), and the legacy-AAD read logs. The plugin declarations in `@awthaq/webhooks`, `@awthaq/organization`, `@awthaq/saml` and `@awthaq/two-factor` drop their `legacyAad`, and `TestAuth.runSealedColumnTests` no longer has a legacy-AAD case.
- Kept: `SealedColumn.sweepAll` and `sweep` for key rotation (`{ table, column, scanned, resealed, unreadable }`), and `adoptPlaintext` as an explicit opt-in for core PII.
- A value that does not open is still the typed `SealedColumn/Unreadable`; the `SealedColumn.option` warning now hints that it may be sealed under a retired legacy AAD (restore from backup or re-enter the secret).

Migration: none for installs that never ran a pre-release build. If you did, before upgrading run SealedColumn.sweepAll on a build containing the sweep and confirm unreadable: 0; rows still sealed under the old AADs (webhooks-endpoint:, organization-oauth-connection:, saml-sp-key:, and two_factor_secret:<id> without the field suffix) stop opening after this release: webhook secrets and headers silently drop, OAuth client secrets are dropped, SAML signing and TOTP fail closed. Nothing is deleted; rolling back or restoring a backup and re-running the sweep recovers every row.
