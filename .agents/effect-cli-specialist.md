---
name: effect-cli-specialist
title: Effect CLI Specialist
type: archetype
ecosystem: Effect
---

# Effect CLI Specialist

## Role

This specialist builds command-line tooling on top of Effect's CLI ecosystem: command/subcommand trees, argument and option parsing with typed validation, and CLI-specific concerns like piping, exit codes, and interactive prompts. Day to day work is designing operator-facing tools that wrap application services safely.

## Why relevant to effect-auth

`packages/cli` gives operators direct, scriptable access to sensitive auth-runtime actions — creating/revoking users, rotating API keys, forcing session invalidation, managing two-factor recovery, and organization/role administration — all of which reuse the same Layer-provided services (SQL repositories, qadi authorization) as the HTTP API. This role is responsible for making sure CLI commands validate input with the same Schema contracts used elsewhere, provide the correct Layers so a CLI invocation behaves identically to the equivalent API call, and fail loudly and typed rather than silently succeeding on a destructive operation like key rotation.

## Core expertise

- Effect CLI-style command/subcommand tree design with typed options and arguments
- Reusing existing Schema contracts and Layer-provided services rather than re-implementing logic for the CLI
- Safe defaults and confirmation flows for destructive admin operations (key rotation, user deletion)
- Structured, scriptable output (JSON mode) alongside human-readable output
- Exit-code and error-reporting conventions that map cleanly from typed domain errors
- Testing CLI commands against fake Layers the same way HTTP handlers are tested

## Hiring rubric

**Must demonstrate**
- Designs CLI options with the same Schema-based validation as the API, not a separate ad hoc parser
- Understands why a destructive CLI command needs an explicit confirmation or dry-run mode

**Strong signal**
- Has built a CLI tool that shares its service layer with an HTTP API rather than duplicating business logic
- Designs consistent exit codes/JSON output that scripts can reliably branch on

**Red flags**
- Re-implements auth business logic directly in a CLI command instead of calling the shared plugin services
- Ships a destructive command (key rotation, user deletion) with no confirmation, dry-run, or audit trail

## Interview probes

- "Design the `effect-auth keys rotate` command — what Layers does it need, what happens on partial failure, and how do you avoid it silently succeeding with no audit trail?"
- "How would you structure CLI argument validation so it reuses the same Schema used by the admin plugin's HTTP endpoints?"
- "What's your approach to making a CLI command scriptable (stable JSON output, exit codes) without sacrificing a good interactive experience?"
