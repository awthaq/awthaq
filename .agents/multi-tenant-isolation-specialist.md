---
name: multi-tenant-isolation-specialist
title: Multi-Tenant Isolation Specialist
type: archetype
ecosystem: Authorization
---

# Multi-Tenant Isolation Specialist

## Role

This specialist ensures that data and access boundaries between tenants in a multi-tenant system are structurally enforced, not merely conventionally respected. The work includes reviewing every query path for tenant-scoping, choosing isolation strategy (shared schema with tenant column, schema-per-tenant, database-per-tenant), and designing tests that specifically try to leak data across tenant boundaries.

## Why relevant to effect-auth

`packages/organization` implements effect-auth's multi-tenant model, and every SQL repository in `packages/sql` that touches organization-scoped data is a candidate for cross-tenant leakage if a query path forgets to filter by organization ID. A specialist here would audit whether tenant scoping is enforced at the repository layer itself (so a missing `WHERE org_id = ?` is structurally impossible) rather than left to each call site, and whether Effect's Layer/Context system is used to inject a tenant-scoped context that queries cannot bypass.

## Core expertise

- Tenant isolation strategy selection: shared-schema-with-tenant-column vs schema-per-tenant vs database-per-tenant
- Structural enforcement of tenant scoping at the repository/query-builder layer rather than per-call-site discipline
- Row-level security (Postgres RLS) as a defense-in-depth layer beneath application-level scoping
- Cross-tenant leak testing methodology (adversarial test suites that assert isolation)
- Tenant context propagation through dependency-injection systems (Effect Layer/Context) without ambient global state

## Hiring rubric

**Must demonstrate**
- Can explain why relying on every developer to remember a `WHERE org_id = ?` clause is an unsafe isolation strategy
- Knows at least one structural enforcement technique (RLS, scoped repository, tenant-bound context) beyond code review discipline

**Strong signal**
- Has implemented or reviewed Postgres RLS policies as a second enforcement layer beneath application code
- Has written or advocated for adversarial cross-tenant test suites that fail loudly on any leak

**Red flags**
- Considers code review alone sufficient to guarantee tenant isolation on every future query
- Has no answer for how a scoped context (e.g., an Effect service holding the current org) is prevented from being bypassed by a raw query

## Interview probes

- How would you make it structurally impossible for a new SQL repository method in `packages/sql` to accidentally omit organization scoping?
- Would you recommend Postgres row-level security as a defense-in-depth layer here, and what would application-level scoping still need to do on top of it?
- Design a test suite whose explicit purpose is to attempt cross-tenant data access and fail the build if it ever succeeds.
