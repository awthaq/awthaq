---
name: monorepo-tooling-specialist
title: Monorepo Tooling Specialist
type: archetype
ecosystem: Developer Experience
---

# Monorepo Tooling Specialist

## Role

This specialist owns the build and dependency infrastructure of a multi-package repository: workspace configuration, version pinning strategy, and incremental build orchestration. Day to day work includes keeping cross-package builds fast and correct as new packages are added and dependencies shift.

## Why relevant to effect-auth

effect-auth is a pnpm workspace with roughly two dozen packages (core, each plugin, admin, organization, roles, jwt, sql, api, server, client, react, next, cli, qadi) that must build in dependency order via TypeScript project references (`tsc -b`), and it exact-pins Effect v4's rc line via a pnpm workspace catalog because the API surface is still moving pre-1.0. This role is responsible for keeping `pnpm-workspace.yaml` and the catalog entries consistent across all `package.json` files, ensuring project-reference graphs match actual import dependencies so incremental builds stay correct, and managing the churn of a pre-1.0 dependency bump across every consuming package in one coordinated change.

## Core expertise

- pnpm workspace and catalog configuration for consistent, exact-pinned versions across packages
- TypeScript project references (`tsc -b`) graph design matching real inter-package dependencies
- Coordinating exact-pin version bumps of a fast-moving pre-1.0 dependency across many packages atomically
- Diagnosing incremental build cache invalidation issues and stale `.tsbuildinfo` problems
- Publish/versioning strategy for internal packages that aren't yet independently released
- Keeping lockfile (`pnpm-lock.yaml`) changes minimal and reviewable during dependency bumps

## Hiring rubric

**Must demonstrate**
- Understands why exact-pinning (not `^`/`~`) matters for a pre-1.0 dependency like Effect v4's rc line
- Can diagnose a `tsc -b` project-reference graph that doesn't match actual import dependencies

**Strong signal**
- Has executed a coordinated exact-pin bump of a core dependency across 20+ packages without breaking the catalog
- Has fixed a stale incremental-build cache issue that was silently hiding a type error

**Red flags**
- Mixes range-based and exact-pinned versions inconsistently across packages, defeating the pinning strategy
- Adds a new package without updating its project-reference edges, causing silent stale builds

## Interview probes

- "Effect v4 ships a new rc — walk through your process for bumping the pnpm catalog entry and verifying all 20+ consuming packages still build and pass the BDD suite."
- "A package builds fine standalone but a dependent package sees stale types — how do you diagnose whether it's a project-reference graph issue or a build-cache issue?"
- "Why exact-pin a pre-1.0 dependency via a catalog rather than letting each package specify its own range?"
