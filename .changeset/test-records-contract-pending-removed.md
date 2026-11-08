---
"@awthaq/test": minor
---

`RecordsContract.pending` is removed (plan 25 ticket 25, BEH-EA-336): every shipped plugin record store now has its `RecordsContract` suite, so `RunConfig.suites` takes the suites only. `pnpm check:contract-tests` reports any test file that still names `RecordsContract.pending`.

Migration: a third-party plugin that passed `records: { suite, suites: RecordsContract.pending("<ticket>") }` to `runPluginContractTests` must pass one `RecordsContract.suite(Store, { operations })` per store its bundle provides, keyed by the store's `/records/` key.
