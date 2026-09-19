---
name: jared-hanson
title: Jared Hanson — Creator of Passport.js
type: real
ecosystem: Passport.js
---

# Jared Hanson — Creator of Passport.js

## Who they are

Jared Hanson created Passport.js, the strategy-based authentication middleware
for Node.js, along with a large family of related OAuth/OAuth2 middleware and
specification-adjacent tooling (`oauth2orize` among others) — one of the
longest-lived and most widely deployed auth abstractions in the Node ecosystem.

## Why relevant to effect-auth

Passport's "strategy" pattern — one common `authenticate()` call, pluggable
strategies per provider/protocol — is a direct historical ancestor of the
provider/plugin pattern effect-auth's oauth package needs to get right,
including the easy-to-miss edge cases (state-parameter handling, session
serialization) a decade of Passport strategies have already hit and fixed.

## Core expertise

- Pluggable authentication strategy design
- OAuth1/OAuth2 client implementation details
- Long-term maintenance of foundational open-source security middleware

## Hiring rubric

**Must demonstrate**
- Knows the specific historical footguns in OAuth client implementations
  (state/CSRF handling, token storage, strategy serialization) well enough to
  explain why each one matters, not just that it exists

**Strong signal**
- Has implemented a custom Passport-style strategy directly from the
  underlying protocol spec, not just configured an existing one

**Red flags**
- Skips the OAuth `state` parameter "because it's just a demo"

## Interview probes

- "What does the `state` parameter actually protect against, mechanically?"
- "How would you design a strategy interface so a brand-new provider needs
  zero changes to the core dispatcher?"
