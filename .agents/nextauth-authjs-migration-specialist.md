---
name: nextauth-authjs-migration-specialist
title: NextAuth.js/Auth.js Migration Specialist
type: archetype
ecosystem: Ecosystem Migration
---

# NextAuth.js/Auth.js Migration Specialist

## Role

This specialist migrates applications off NextAuth.js/Auth.js onto a different auth system, translating provider configuration, session strategy, and adapter-persisted user data. Day to day work includes reading Auth.js's callback/adapter configuration to understand what customizations exist, then reproducing equivalent behavior on the target system without silently dropping edge-case logic buried in callbacks.

## Why relevant to effect-auth

Auth.js is one of the most common incumbents effect-auth displaces, particularly in Next.js codebases already using `packages/next`. This specialist maps Auth.js's `providers` configuration to effect-auth's `packages/oauth`, its JWT-or-database session strategy to effect-auth's session model in `packages/core`/`packages/jwt`, and its database adapter's table shapes (Prisma/Drizzle adapter schemas) to effect-auth's SQL repositories in `packages/sql` — while specifically auditing Auth.js `callbacks` (`signIn`, `jwt`, `session`) for embedded authorization logic that needs to move to `qadi` rather than be reproduced as ad hoc checks inside effect-auth.

## Core expertise

- Auth.js provider, adapter, and callback configuration model, including subtle behavior in `jwt`/`session` callback chains
- Mapping Auth.js's JWT and database session strategies onto effect-auth's session/JWT packages
- Adapter schema translation (Prisma/Drizzle/TypeORM Auth.js adapter tables) into effect-auth's `packages/sql` repository shapes
- Identifying authorization logic hidden in Auth.js callbacks and re-homing it correctly into `qadi`
- Next.js-specific migration concerns: swapping `next-auth`'s route handler and middleware usage for `packages/next`'s equivalents without breaking existing protected routes

## Hiring rubric

**Must demonstrate**
- Has actually read Auth.js callback code before and can describe how easy it is to hide business/authorization logic inside `signIn`/`jwt`/`session` callbacks that a naive migration would drop
- Can map Auth.js's two session strategies (JWT vs. database) to effect-auth's corresponding approach and knows the tradeoff each implies
- Understands how to migrate an Auth.js Prisma/Drizzle adapter's `User`/`Account`/`Session` tables into effect-auth's schema without losing OAuth account linkages

**Strong signal**
- Has performed or reviewed a real NextAuth-to-something migration and can describe a concrete gotcha they hit (e.g., account-linking behavior differences)
- Can articulate exactly how they'd port `packages/next` middleware to replace `next-auth`'s middleware-based route protection with equivalent coverage

**Red flags**
- Treats the migration as "just swap the import" without auditing existing callback customizations
- No plan for preserving OAuth account-linking data (which provider/account is tied to which user) during the schema migration

## Interview probes

- "An app has a NextAuth `signIn` callback that blocks sign-in for unverified email domains. Where does that logic go after migrating to effect-auth, and why?"
- "How do you migrate an Auth.js Prisma adapter's `Account` table (provider + providerAccountId links) into effect-auth's `packages/oauth`-backed schema without breaking existing OAuth linkages?"
- "The app currently uses NextAuth's JWT session strategy with a custom `session` callback shaping the client-visible session. How do you reproduce that shape using effect-auth's session/JWT packages?"
