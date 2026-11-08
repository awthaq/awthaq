---
"@awthaq/admin": patch
---

The impersonation audit ledger never reports a break that is only a write in flight (plan 25, ALF-005, BEH-EA-215). `ImpersonationRecords.layerMemory` writes an episode row and its ledger link as one uninterruptible critical section (`create`, `endEpisode`, `closeExpired`), and `verifyChain` reads rows and ledger under the same lock, so a `verifyChain` racing a write no longer answers `row-unledgered`, and an interrupted write leaves both or neither. `layerSql`'s `verifyChain` now reads both tables in one transaction under the chain lock, so a writer committing between its two reads is no longer reported as `row-unledgered` or `row-missing`.
