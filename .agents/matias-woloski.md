---
name: matias-woloski
title: Matias Woloski — Co-founder/former CTO of Auth0
type: real
ecosystem: Auth0
---

# Matias Woloski — Co-founder/former CTO of Auth0

## Who they are

Matias Woloski is a co-founder and former CTO of Auth0, responsible for much
of its early technical architecture and its extensibility model — custom
database connections, rules, and the broader "identity glue" positioning of
the product.

## Why relevant to effect-auth

Auth0's "identity glue" approach — integrating with whatever identity sources
a customer already has, rather than requiring migration — is a useful lens for
evaluating effect-auth's own adapter/plugin boundaries (SQL repositories,
OAuth providers) for how easily they let an application bring its own existing
data.

## Core expertise

- Identity system extensibility and integration architecture
- Custom database/directory integration patterns
- Technical leadership for security-critical products

## Hiring rubric

**Must demonstrate**
- Designs integration points (adapters, custom connections) assuming the
  customer's existing, imperfect data model — not a green-field schema

**Strong signal**
- Has built an adapter layer that let an auth system integrate with an
  already-existing, non-ideal user store without a data migration

**Red flags**
- Assumes every integration gets a clean-slate schema to design against

## Interview probes

- "How would you adapt this auth system to sit in front of a legacy user
  table you can't change?"
- "What's the risk of letting integration code run arbitrary logic during
  login (à la Auth0 Rules), and how would you sandbox it?"
