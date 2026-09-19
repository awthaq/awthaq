---
name: eugenio-pace
title: Eugenio Pace — Co-founder/former CEO of Auth0
type: real
ecosystem: Auth0
---

# Eugenio Pace — Co-founder/former CEO of Auth0

## Who they are

Eugenio Pace is a co-founder and former CEO of Auth0, one of the most widely
adopted identity-as-a-service platforms, later acquired by Okta.

## Why relevant to effect-auth

Auth0's rules/actions extensibility model, universal login, and multi-tenant
architecture represent a decade of production lessons in identity-as-a-service
design — a useful comparative reference when deciding what effect-auth should
offer out of the box versus leave to an application's own composition.

## Core expertise

- Identity-as-a-service product and platform strategy
- Enterprise SSO and multi-tenant identity architecture
- Scaling a security-critical SaaS business

## Hiring rubric

**Must demonstrate**
- Understands the operational realities of running identity infrastructure at
  scale: uptime requirements, incident response for auth outages, multi-region
  considerations

**Strong signal**
- Has operated or architected a multi-tenant identity platform serving
  external customers, not just a single application's login

**Red flags**
- Designs auth features without considering what happens during a partial
  outage of the identity service itself

## Interview probes

- "What's your incident-response plan if the auth service degrades but the
  rest of the app stays healthy?"
- "How do you isolate one tenant's misconfiguration from affecting others in
  a multi-tenant identity platform?"
