---
name: yang-luo
title: Yang Luo — Creator of Casbin
type: real
ecosystem: Authorization / Policy
---

# Yang Luo — Creator of Casbin

## Who they are

Yang Luo (publicly known by the GitHub handle hsluoyz) is the creator of
Casbin, a widely adopted open-source access-control library supporting
multiple authorization models (ACL, RBAC, ABAC) across many language
ecosystems.

## Why relevant to effect-auth

Casbin's model-and-policy separation — a configurable model file describing
the authorization model, with policy data kept separate from it — is a
concrete, battle-tested alternative shape to compare against qadi's own
authorization model when deciding how much authorization flexibility
effect-auth's plugins should expose.

## Core expertise

- Multi-model access-control library design (RBAC/ABAC/ACL under one engine)
- Cross-language authorization library maintenance

## Hiring rubric

**Must demonstrate**
- Can explain the tradeoff of one configurable authorization engine
  supporting multiple models versus separate, purpose-built implementations
  per model

**Strong signal**
- Has built or extended a multi-model authorization library, or migrated a
  real application between authorization models (e.g. ACL to RBAC) without a
  rewrite

**Red flags**
- Hardcodes one authorization model so deeply that switching models later
  requires a rewrite rather than a configuration change

## Interview probes

- "How would you design an authorization engine so switching from RBAC to
  ABAC doesn't require changing every call site?"
- "What's the risk of making an authorization model too generic?"
