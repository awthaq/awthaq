---
name: effect-runtime-scheduler-specialist
title: Effect Runtime & Scheduler Specialist
type: archetype
ecosystem: Effect
---

# Effect Runtime & Scheduler Specialist

## Role

This specialist configures the low-level execution environment of an Effect application: custom Runtime construction, scheduling policies, retry/repeat schedules, and resource-safe shutdown sequencing. Day to day work includes tuning how the runtime executes fibers under load and ensuring long-running services shut down without dropping in-flight work.

## Why relevant to effect-auth

effect-auth runs as a long-lived server process (`packages/server`) that must shut down gracefully without dropping in-flight session verifications, OAuth token exchanges, or SQL repository transactions, and needs retry/backoff Schedules for transient failures like a flaky OAuth provider or a momentarily unavailable Postgres connection. This role owns custom Runtime configuration (e.g., tuning the fiber scheduler for latency-sensitive auth request paths versus background maintenance jobs like session-expiry sweeps) and designs the Scope-based shutdown sequence so a deploy or restart doesn't corrupt an in-progress credential rotation.

## Core expertise

- Custom Runtime construction and RuntimeFlags tuning for latency-sensitive vs background workloads
- Schedule design (exponential backoff, jitter, retry budgets) for transient OAuth/SQL failures
- Graceful shutdown sequencing via Scope so in-flight requests complete before resources close
- Distinguishing foreground request-serving fibers from background maintenance fibers (session sweeps)
- Tuning concurrency limits at the runtime level to protect downstream SQL connections
- Diagnosing runtime-level starvation or scheduling unfairness under load

## Hiring rubric

**Must demonstrate**
- Can explain how Effect's fiber scheduler differs from a thread pool and why that matters for tuning
- Has designed a graceful-shutdown path that waits for in-flight critical operations before exiting

**Strong signal**
- Has tuned retry Schedules with backoff/jitter for a real flaky external dependency (e.g., an OAuth provider)
- Distinguishes and isolates background maintenance workloads from foreground request-serving fibers

**Red flags**
- Uses fixed-delay retries with no jitter against an external provider, risking thundering-herd retries
- Kills the process on SIGTERM without draining in-flight requests or closing Scopes properly

## Interview probes

- "Design the shutdown sequence for effect-auth's server process so an in-flight API-key rotation isn't left half-committed when a deploy restarts the pod."
- "How would you set a retry Schedule for a transient OAuth provider 5xx versus a SQL connection timeout, and why would they differ?"
- "How do you keep a background session-expiry sweep from starving foreground login request fibers under load?"
