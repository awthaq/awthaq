---
name: data-residency-sharding-specialist
title: Data Residency & Sharding Specialist
type: archetype
ecosystem: Database & Persistence
---

# Data Residency & Sharding Specialist

## Role

This specialist designs data architectures that satisfy regulatory residency requirements (GDPR, data localization laws) by partitioning user data geographically, and manages the operational complexity of sharded lookups that result. Day to day work includes shard-key selection, cross-shard query design, and routing logic for multi-region deployments.

## Why relevant to effect-auth

effect-auth's plugin-package architecture (`packages/core`, `packages/organization`, `packages/sql`) centralizes user and session records behind repository interfaces that assume a single logical database today. A residency requirement — EU user data must live in an EU-region Postgres instance — forces this specialist to design a sharding key (likely tenant or organization ID, given `packages/organization` already models multi-tenancy) and to ensure session lookups, which happen on nearly every request, can resolve the correct shard without a slow global directory lookup on the hot path.

## Core expertise

- Shard-key design for identity data (tenant/org-based vs. user-based partitioning)
- Cross-shard query patterns and their latency/consistency costs, especially on hot paths like session verification
- Regulatory residency requirements (GDPR data localization, sector-specific rules) and how they map to infrastructure boundaries
- Directory/routing service design for resolving "which shard does this session belong to" cheaply
- Migration strategies for moving a tenant's data between shards/regions without downtime

## Hiring rubric

**Must demonstrate**
- Can propose a concrete shard key for effect-auth's data model and justify it against the organization/tenant structure already present in `packages/organization`
- Understands why a naive global lookup table for shard routing becomes a bottleneck on the session-verification hot path
- Knows the difference between data residency (where data is stored) and data sovereignty (which jurisdiction's law governs it)

**Strong signal**
- Has designed or operated a sharded identity system and can describe how cross-shard operations (e.g., a user moving between orgs in different regions) were handled
- Can explain how to keep session tokens self-describing enough (e.g., embedding a shard/region hint) to avoid a directory lookup on every request

**Red flags**
- Proposes sharding by hash of user ID with no regard for residency requirements, defeating the actual regulatory purpose
- Has no answer for how a session token would route to the correct regional shard without adding a global lookup on every authenticated request

## Interview probes

- "A customer requires that all EU user data, including sessions, stay in an EU region. How would you shape the session token and lookup path so verification doesn't require a global directory hit?"
- "An organization in `packages/organization` has members spanning two regions. How does that change your sharding strategy?"
- "How would you migrate a tenant's data from one regional shard to another without invalidating every active session mid-migration?"
