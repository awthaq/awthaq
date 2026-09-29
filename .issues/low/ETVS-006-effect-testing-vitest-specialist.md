---
ID: "ETVS-006"
Title: "Next-package tests share one ManagedRuntime and mutate TestClock across test cases"
Level: low
Category: "testing"
Status: ready-for-agent
Package: "next"
Source: "packages/next/test/GetSession.test.ts:102"
Auditor: "effect-testing-vitest-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ETVS-006 — Next-package tests share one ManagedRuntime and mutate TestClock across test cases

`LOW` · `testing` · `next` · reported by **Effect Testing & @effect/vitest Specialist** (`effect-testing-vitest-specialist`)

Status: **ready-for-agent**

## Summary

GetSession.test.ts builds one module-level ManagedRuntime (line 35) shared by five it() cases; the final case advances the shared TestClock by 31 days. The suite only passes because vitest runs cases in file order - reordering or adding a case after the expiry test silently inherits a shifted clock, and the runtime (its forked session Layer fibers) is never disposed. HasSessionCookie.test.ts instead builds a fresh runtime per test but also never disposes it, leaking fibers per run.

## Evidence

Source: `packages/next/test/GetSession.test.ts:102`

```
    // Default `SessionConfig` (`Sessions.ts`): 30-day absolute expiry.
    await runtime.runPromise(TestClock.adjust(Duration.days(31)));
```

## Recommended fix

Give each clock-advancing case its own ManagedRuntime (as HasSessionCookie does) and dispose it in a finally/afterAll, or reset time explicitly per case; keep one shared runtime only if all cases are read-only with respect to the clock.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 74/100), domain: Test architecture & determinism
- Full dossier: [`effect-testing-vitest-specialist`](../../.reports/effect-testing-vitest-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 44 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `next-getsession-hardening`. Evidence at HEAD ec065a7: `packages/next/test/GetSession.test.ts:40`. Fix: Per-case runtimes for clock-mutating cases and deterministic disposal everywhere. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
