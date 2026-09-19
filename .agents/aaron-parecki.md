---
name: aaron-parecki
title: Aaron Parecki — IETF OAuth Working Group / Creator of IndieAuth
type: real
ecosystem: OAuth2 / OIDC
---

# Aaron Parecki — IETF OAuth Working Group / Creator of IndieAuth

## Who they are

Aaron Parecki is an active contributor and editor within the IETF OAuth
working group, creator of IndieAuth, and co-author of guidance such as OAuth
2.0 for Browser-Based Applications and PKCE-related best practices.

## Why relevant to effect-auth

effect-auth's OAuth plugin needs to track exactly this kind of current IETF
best-practice guidance — PKCE everywhere, no implicit grant, browser-based-app
guidance — rather than implementing OAuth2 the way it was originally specified
over a decade ago.

## Core expertise

- OAuth2 specification evolution and current best practices
- Browser-based / public-client OAuth security
- PKCE and the security model it improves on

## Hiring rubric

**Must demonstrate**
- Knows which parts of the original OAuth2 RFC are now considered obsolete or
  actively discouraged (implicit grant, bearer tokens without PKCE for public
  clients)

**Strong signal**
- Has contributed to, reviewed, or closely tracked IETF OAuth working group
  drafts rather than relying on secondhand summaries

**Red flags**
- Implements the implicit grant flow for a brand-new integration today

## Interview probes

- "Why is the implicit grant now discouraged, specifically?"
- "What does PKCE protect against that the `state` parameter doesn't?"
