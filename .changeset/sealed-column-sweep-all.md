---
"@awthaq/sql": minor
---

Legacy-AAD sunset preparation (plan 05 phase 14, additive; no `legacyAad` entry and no `adoptPlaintext` is removed).

- `SealedColumn.SweepReport` gains `legacy`: of the values re-sealed, those that opened only under a legacy AAD. `SealedColumn.Revealed` gains `legacy: boolean` for the same fact on a single read. Code that builds a `SweepReport` or `Revealed` by hand must add the field.
- New `SealedColumn.sweepAll(columns, { batch? })`: sweeps each column in order, answers one `{ table, column, scanned, resealed, legacy, unreadable }` per column and logs one Info line per column (ids and counts only).
- A read that opens under a legacy AAD is now logged (ids only): debug when it re-seals, a warning when `resealOnRead` is off.
- `SealedColumn.sweep`, `sqlSwap` and `aadOf` accept any column declaration regardless of its value type (the new `SealedColumn.Sweepable`).
- Operator runbook in `docs/plugin-authoring.md`: run `sweepAll`, then `sweepAll` again; every column must report `legacy: 0` before a later release may delete the legacy read.
