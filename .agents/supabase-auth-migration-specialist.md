---
name: supabase-auth-migration-specialist
title: Supabase Auth Migration Specialist
type: archetype
ecosystem: Ecosystem Migration
---

# Supabase Auth Migration Specialist

## Role

This specialist migrates applications off Supabase's GoTrue-based authentication, which is unusual among incumbents in that its authorization model (Postgres Row Level Security policies keyed off `auth.uid()`) is deeply co-located with the database itself. Day to day work includes extracting users from Supabase's `auth.users` schema and translating RLS-policy-encoded authorization rules into an explicit, separate policy layer.

## Why relevant to effect-auth

Supabase Auth (GoTrue) stores users directly in a Postgres `auth` schema, which is architecturally convenient for a direct-to-Postgres migration into effect-auth's `@effect/sql-pg`-backed `packages/sql`, but its authorization model is the real migration challenge: Supabase apps typically encode nearly all authorization as Postgres RLS policies referencing `auth.uid()`/`auth.jwt()`, and effect-auth explicitly does not do this — it delegates all authorization to `qadi`. This specialist's core job is reading a Supabase project's RLS policies and re-modeling each one as an explicit `qadi` authorization rule, rather than trying to preserve RLS as the enforcement mechanism after migration.

## Core expertise

- Supabase's `auth.users`/`auth.identities` schema and GoTrue's password hash format (bcrypt, generally directly compatible)
- Reading and cataloging Postgres Row Level Security policies as an authorization specification, independent of their SQL implementation
- Translating RLS-policy semantics (`USING`/`WITH CHECK` expressions referencing `auth.uid()`) into equivalent `qadi` authorization rules
- Supabase Realtime and Storage authorization dependencies on the same RLS policies, which also need re-homing if those features are in scope
- Migrating Supabase's JWT-based session model (with custom claims from Postgres functions) to effect-auth's `packages/jwt`/session model

## Hiring rubric

**Must demonstrate**
- Understands that Supabase's real migration complexity isn't the user table (straightforward, often same Postgres instance) but the RLS-encoded authorization logic
- Can read a nontrivial RLS policy and restate its authorization semantics in plain language before proposing how to reproduce it in `qadi`
- Knows Supabase/GoTrue password hashes are typically bcrypt and can usually be verified directly without a lazy-rehash workaround (unlike Firebase)

**Strong signal**
- Has actually migrated a Supabase RLS-secured app off Supabase and can describe cataloging every policy before writing any new authorization code
- Can explain the risk of "temporarily" leaving RLS policies active alongside qadi checks post-migration (double enforcement masking bugs, or worse, silent gaps if RLS is dropped early)

**Red flags**
- Proposes simply keeping Postgres RLS active indefinitely as the authorization layer instead of migrating that logic into `qadi`, defeating the point of adopting effect-auth's architecture
- Treats the migration as just a `pg_dump`/`pg_restore` of the `auth` schema with no audit of RLS policies at all

## Interview probes

- "A Supabase app has an RLS policy: `USING (auth.uid() = user_id OR EXISTS (SELECT 1 FROM org_members WHERE org_id = orgs.id AND user_id = auth.uid() AND role = 'admin'))`. Restate this rule in plain English, then describe how you'd express it as a `qadi` policy."
- "Why can't you just leave the existing RLS policies in place after switching authentication to effect-auth, and what specifically breaks if you try?"
- "How do you verify a migrated Supabase user's existing bcrypt password hash against effect-auth's `packages/password`, and what's different here versus a Firebase migration?"
