---
ID: "SMS-003"
Title: "The mechanically-checked 'no Redacted reaches spans/events' guarantee does not exist"
Level: medium
Category: "testing"
Status: ready-for-agent
Package: "—"
Source: "spec/behaviors/25-testing-harness.md:145"
Auditor: "secrets-management-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# SMS-003 — The mechanically-checked 'no Redacted reaches spans/events' guarantee does not exist

`MEDIUM` · `testing` · `—` · reported by **Secrets Management Specialist** (`secrets-management-specialist`)

Status: **ready-for-agent**

## Summary

BEH-EA-199 requires runPluginContractTests to fail when a Redacted value reaches a span or an emitted event, and the glossary repeats that passwords, session secrets, and verification tokens 'are carried as Redacted throughout'. The spec itself concedes the interceptor was never built, and a grep confirms it: the only leak assertion in the repo is OAuth's narrow check that the client secret is absent from the authorize URL (packages/oauth/test/OAuth.test.ts:650). Across 21 packages, the redaction guarantee therefore rests entirely on the type system and manual review - exactly the situation the spec said must not be trusted.

## Evidence

Source: `spec/behaviors/25-testing-harness.md:145`

```
Asserting "no `Redacted` value reaches a span or event" requires instrumentation this project has not built
```

## Recommended fix

Build the promised test-time logger/tracer interceptor in @awthaq/test that deep-inspects span attributes and log/event payloads for Redacted instances (or serialized Redacted shapes) and fails runPluginContractTests; until it lands, add per-plugin spot assertions modeled on BEH-EA-126's.

## Context

- Auditor verdict on this domain: **needs-work** (score 64/100), domain: secrets management
- Full dossier: [`secrets-management-specialist`](../../.reports/secrets-management-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 38 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `redaction-guarantee-check`. Evidence at HEAD ec065a7: `spec/behaviors/25-testing-harness.md:145`. Fix: Build the BEH-EA-199 interceptor in @awthaq/test using canary secrets: run the plugin's flows with known canary passwords/tokens under a recording Tracer, Logger and AuthEvents/AuditLog subscriber, and fail if any canary string (or an unwrapped Redacted payload) appears in span attributes/events, log messages/annotations, or published events. (effort L). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.
