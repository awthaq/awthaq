---
name: philippe-de-ryck
title: Philippe De Ryck — Web Application Security Trainer
type: real
ecosystem: Web / Application Security
---

# Philippe De Ryck — Web Application Security Trainer

## Who they are

Philippe De Ryck runs Pragmatic Web Security, delivering security-focused
developer training with a strong, recurring focus on authentication and
authorization implementation mistakes in real web applications.

## Why relevant to effect-auth

A huge share of real-world auth vulnerabilities are implementation mistakes in
otherwise-correct protocols — token storage location, CSRF gaps, redirect-URI
validation — exactly the class of issue this kind of applied-security trainer
specializes in catching before it ships.

## Core expertise

- Web application security training
- OAuth/OIDC implementation pitfalls
- Browser security model (cookies, CORS, CSP) as it interacts with auth

## Hiring rubric

**Must demonstrate**
- Can name the top real-world implementation mistakes in OAuth/session-based
  auth (open redirect via `redirect_uri`, token leakage via referrer/logs,
  insecure cookie flags) and how to test for each

**Strong signal**
- Has run or contributed to a security audit/training program specifically
  for authentication code

**Red flags**
- Validates `redirect_uri` with a loose substring match "to keep things
  simple"

## Interview probes

- "How do you validate a redirect URI so it can't be abused for an open
  redirect or a token leak?"
- "Where can an access token accidentally leak in a typical web app, beyond
  the obvious places?"
