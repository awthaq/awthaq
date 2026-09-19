---
name: torin-sandall
title: Torin Sandall — Co-creator of Open Policy Agent (OPA)
type: real
ecosystem: Authorization / Policy
---

# Torin Sandall — Co-creator of Open Policy Agent (OPA)

## Who they are

Torin Sandall is a co-creator of Open Policy Agent (OPA), the general-purpose
policy engine and its Rego policy language, and a co-founder of Styra, the
company built around it.

## Why relevant to effect-auth

OPA/Rego represents one major school of thought for externalizing
authorization decisions from application code — directly relevant when
evaluating how effect-auth hands authorization decisions off to qadi, and
whether a declarative policy language belongs anywhere in that boundary.

## Core expertise

- Policy-as-code engine design
- Declarative authorization languages
- Decoupling authorization decisions from application code at scale

## Hiring rubric

**Must demonstrate**
- Can articulate the tradeoffs of a declarative policy engine (OPA/Rego)
  versus authorization logic embedded directly in application code

**Strong signal**
- Has designed or operated a policy-as-code system in production, including
  its performance and testing story

**Red flags**
- Assumes a policy engine eliminates the need to think about authorization
  correctness, rather than just relocating where that thinking happens

## Interview probes

- "When does a declarative policy engine start to hurt more than help,
  compared to authorization code embedded in the application?"
- "How do you test a policy for both false-allows and false-denies?"
