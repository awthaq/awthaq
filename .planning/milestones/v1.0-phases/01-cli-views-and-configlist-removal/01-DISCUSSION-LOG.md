# Phase 1: CLI views and ConfigList removal - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-14
**Phase:** 1-CLI views and ConfigList removal
**Areas discussed:** Output behaviour, ConfigList removal, Views module, Output seam, Tests, Gates

---

No question needed the user: the hard-to-reverse choices (format precedence, failure rendering, removed export) were fixed by REQUIREMENTS.md "Decisions taken" and the research, and every other question was a reversible internal choice.

## Decided autonomously

[auto] [Views module] — Q: "Where does the views module live?" → Selected: "new file PluginViews.ts" (reversible technical — decided autonomously: a new internal file is trivially moved or merged back)
[auto] [Views module] — Q: "One function per view or a table?" → Selected: "one descriptor per view and a single render" (reversible technical — decided autonomously: internal shape, no external contract)
[auto] [Views module] — Q: "Where is format resolved?" → Selected: "one private function mapping (--format, out.json) to text|json|dot" (reversible technical — decided autonomously: replaced by editing one function)
[auto] [Output seam] — Q: "How does the views module reach Output.report?" → Selected: "optional explicit-format override on report" (reversible technical — decided autonomously: additive optional parameter)
[auto] [Output seam] — Q: "Which of Migration.apply and Openapi move?" → Selected: "only call sites whose captured output stays identical" (reversible technical — decided autonomously: each call site revertible alone)
[auto] [ConfigList] — Q: "Where do the three lines land?" → Selected: "inline in the config list handler in Cli.ts" (reversible technical — decided autonomously: a local move)
[auto] [ConfigList] — Q: "Changeset bump level?" → Selected: "minor, per the test-app-removed precedent" (reversible technical — decided autonomously: one-line edit of a changeset file)
[auto] [Tests] — Q: "Where does the matrix live?" → Selected: "packages/cli/test/PluginViews.test.ts on Output.capture" (reversible technical — decided autonomously: test layout is local)
[auto] [Tests] — Q: "Doctor.test.ts use of ConfigList.show?" → Selected: "call the inlined entry point; assertion unchanged" (reversible technical — decided autonomously: mechanical import swap)
[auto] [Gates] — Q: "How is the knip baseline recorded?" → Selected: "committed 01-BASELINE.md with raw pnpm knip output" (reversible technical — decided autonomously: a documentation file)

## Claude's Discretion

Internal naming of the views module's exports, test-case table layout, wording of the changeset and spec Change History entries.

## Deferred Ideas

None.
