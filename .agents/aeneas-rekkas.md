---
name: aeneas-rekkas
title: Aeneas Rekkas — Founder/CEO of Ory
type: real
ecosystem: Ory
---

# Aeneas Rekkas — Founder/CEO of Ory

## Who they are

Aeneas Rekkas is the founder and CEO of Ory, the company behind the open-source
identity infrastructure suite Kratos (identity/credential management), Hydra
(OAuth2/OIDC server), and Keto (a Zanzibar-inspired authorization service).

## Why relevant to effect-auth

Ory's split between identity (Kratos), OAuth/OIDC issuance (Hydra), and
fine-grained authorization (Keto) as three separate, composable services
mirrors the same separation of concerns effect-auth draws between resolving a
principal (its own job) and deciding authorization (delegated entirely to
qadi) — useful prior art for where exactly to draw that boundary.

## Core expertise

- Identity infrastructure architecture at scale
- OAuth2/OIDC authorization-server implementation
- Building and operating open-source identity infrastructure companies

## Hiring rubric

**Must demonstrate**
- Can articulate why identity, token issuance, and authorization are best kept
  as separable concerns/services rather than folded into one monolith

**Strong signal**
- Has built or operated production OAuth2/OIDC infrastructure (not just
  consumed a provider) or a comparable identity service

**Red flags**
- Conflates "who is this user" with "what can this user do" as a single
  undifferentiated concept

## Interview probes

- "Why run identity and authorization as separate services rather than one?"
- "What's the hardest part of implementing an OAuth2 authorization server
  correctly, as opposed to just a client?"
