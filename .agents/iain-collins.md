---
name: iain-collins
title: Iain Collins — Creator of NextAuth.js
type: real
ecosystem: Auth.js
---

# Iain Collins — Creator of NextAuth.js

## Who they are

Iain Collins created NextAuth.js, the authentication library that became the
dominant drop-in auth solution for Next.js applications before evolving into
the framework-agnostic Auth.js project.

## Why relevant to effect-auth

NextAuth/Auth.js's provider abstraction — OAuth providers, credentials
providers, an email/magic-link provider, and adapters for different databases
— is one of the most widely deployed real-world templates for exactly the
provider/plugin surface effect-auth's oauth and magic-link packages need to
match feature-for-feature.

## Core expertise

- OAuth provider abstraction design
- Session strategy tradeoffs (JWT vs database-backed sessions)
- Database adapter patterns for auth state

## Hiring rubric

**Must demonstrate**
- Understands the tradeoffs between JWT-based and database-backed sessions
  well enough to pick correctly per deployment target (serverless vs
  long-running server)

**Strong signal**
- Has implemented a custom OAuth provider or database adapter against an
  existing auth framework's adapter interface

**Red flags**
- Assumes JWT sessions are strictly "better" without accounting for
  revocation requirements

## Interview probes

- "When would you choose a database-backed session over a JWT session, and
  what do you give up by doing so?"
- "How do you handle an OAuth provider that returns an unverified email
  address?"
