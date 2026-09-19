---
name: compliance-soc2-gdpr-specialist
title: Compliance (SOC2/GDPR) Specialist
type: archetype
ecosystem: Security & Cryptography
---

# Compliance (SOC2/GDPR) Specialist

## Role

This specialist translates compliance frameworks like SOC 2 and GDPR into concrete engineering requirements for an authentication system: access-logging controls, data retention and deletion schedules, and the structural tension between "keep an audit trail" and "honor a right-to-erasure request." The work is cross-functional, bridging legal/compliance requirements and actual schema and retention-policy design.

## Why relevant to effect-auth

Authentication data is squarely in scope for both SOC 2 (access controls, audit logging, change management) and GDPR (personal data minimization, right to erasure) — and effect-auth's AuthEvents, session records, and organization membership data in `packages/core`/`packages/organization` are exactly the kind of records a deletion request would target while an audit trail simultaneously needs to retain evidence of what happened. A specialist would design how effect-auth reconciles a GDPR erasure request against its own audit-logging needs (e.g., pseudonymizing rather than deleting the audit record, while genuinely deleting the underlying PII).

## Core expertise

- SOC 2 control mapping for authentication systems (access control, logging, change management, availability)
- GDPR data-subject rights implementation: right to erasure, data portability, and their limits against legal-basis retention needs
- Data retention schedule design for auth records (sessions, login history, audit events) with defensible durations
- Reconciling "must keep an audit trail" against "must honor an erasure request" via pseudonymization or minimization rather than blanket exemption
- Data residency and cross-border transfer considerations for auth data in multi-region deployments

## Hiring rubric

**Must demonstrate**
- Can explain concretely how a right-to-erasure request is reconciled with a legal or security need to retain some audit trail, rather than treating them as flatly incompatible
- Knows the difference between what SOC 2 requires operationally versus what GDPR requires legally, and doesn't conflate the two frameworks

**Strong signal**
- Has implemented pseudonymization of a deleted user's audit trail (retaining the event, stripping the identifying PII) rather than either full deletion or full retention
- Can define a defensible, framework-aligned retention schedule for session and login-history data, not an arbitrary number

**Red flags**
- Treats "we keep everything forever for audit purposes" as an adequate answer to a GDPR erasure request
- Cannot distinguish SOC 2's operational-control focus from GDPR's data-subject-rights focus

## Interview probes

- A user submits a GDPR erasure request, but effect-auth's AuthEvents log contains their login history needed for a security audit trail. How do you reconcile these two requirements concretely, at the schema level?
- What retention schedule would you set for session records and login-history events in `packages/core`, and what specifically justifies that duration under SOC 2 versus GDPR?
- How would data residency requirements change your recommendation for where session or audit data is stored in a multi-region deployment?
