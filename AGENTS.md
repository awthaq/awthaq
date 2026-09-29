# AGENTS.md

## Agent skills

### Issue tracker

Issues and specs are tracked as local markdown files under `.scratch/` (no git remote is configured for this repo). See `docs/agents/issue-tracker.md`.

### Triage labels

The standard five-role vocabulary, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Plugin authoring

Conventions for writing a plugin (contract, config, migrations, hooks, ports) are in `docs/plugin-authoring.md`; the working, test-exercised template is `examples/plugin-template/`.

### Domain docs

Single-context, pointed at this repo's existing `spec/` directory (`spec/overview.md`, `spec/decisions/`, `spec/behaviors/`, `spec/traceability.md`) rather than a new `CONTEXT.md`/`docs/adr/`. See `docs/agents/domain.md`.
