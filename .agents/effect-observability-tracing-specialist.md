---
name: effect-observability-tracing-specialist
title: Effect Observability & Tracing Specialist
type: archetype
ecosystem: Effect
---

# Effect Observability & Tracing Specialist

## Role

This specialist instruments Effect applications for production visibility: OpenTelemetry span propagation, structured logging, and metrics. Day to day work includes deciding what gets a span, what gets logged at what level, and ensuring traces stay coherent across asynchronous, multi-fiber execution.

## Why relevant to effect-auth

Authentication is a security-sensitive, latency-sensitive surface where operators need to trace a single login/OAuth/passkey flow across Layer boundaries — from HttpApi middleware, through a plugin's business logic, into a SQL repository call and out to qadi for an authorization decision — without losing span context across fiber forks (as introduced by the session-verify memoization work). This role is responsible for structured logging of security-relevant events (failed login attempts, token issuance, key rotation) in a way that's auditable but never logs secrets, and for wiring OpenTelemetry spans so a slow auth request can be root-caused to a specific plugin or repository call.

## Core expertise

- Effect's built-in tracing integration with OpenTelemetry span creation and propagation
- Structured logging (Effect.log* with annotations) with consistent field naming across plugins
- Ensuring span context survives fiber forking/joining (e.g., across memoized concurrent effects)
- Metrics design (counters/histograms) for auth-specific signals: login failure rate, token issuance latency
- Redaction discipline: never logging secrets, tokens, or credentials in spans or structured logs
- Correlating a single logical auth request across HttpApi middleware, plugin logic, and SQL repositories

## Hiring rubric

**Must demonstrate**
- Can explain how Effect propagates trace/span context across Layer and fiber boundaries
- Has a concrete discipline for redacting secrets from logs and spans by default, not by review

**Strong signal**
- Has instrumented a real multi-service trace that let them root-cause a specific slow dependency
- Designs log/metric field naming conventions that stay consistent across independently authored plugins

**Red flags**
- Logs raw request/response bodies or tokens "temporarily for debugging" without redaction
- Adds spans indiscriminately everywhere, producing noisy traces that don't help root-cause anything

## Interview probes

- "How do you ensure a trace span survives correctly when a request triggers the session-verify memoization path and gets deduplicated across concurrent callers?"
- "What's your policy for what fields are safe to log on a failed login attempt, and how do you enforce it across plugins written by different teams?"
- "Design the span structure for an OAuth login: what gets its own span, and what stays inside a parent span as an event?"
