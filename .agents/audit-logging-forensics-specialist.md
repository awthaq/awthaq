---
name: audit-logging-forensics-specialist
title: Audit Logging & Forensics Specialist
type: archetype
ecosystem: Security & Cryptography
---

# Audit Logging & Forensics Specialist

## Role

This specialist designs audit trails for security-sensitive events that remain trustworthy under adversarial conditions — tamper-evident, complete, and detailed enough to reconstruct an incident after the fact. The work includes deciding what events must be logged, how logs are protected from modification (including by privileged insiders), and validating that a real incident could actually be reconstructed from what's captured.

## Why relevant to effect-auth

`packages/core`'s AuthEvents mechanism is effect-auth's existing hook for exactly this: a specialist would review whether AuthEvents captures the full set of security-relevant transitions (login success/failure, session creation/revocation, role changes, impersonation start/end from `packages/admin`, credential changes across every plugin) with enough context (actor, target, timestamp, source IP, prior state) to reconstruct an incident, and whether the event stream itself is protected from tampering or deletion, including by an admin who might be the subject of an investigation.

## Core expertise

- Security-event taxonomy design: what must always be logged versus what's merely useful telemetry
- Tamper-evident log design (append-only storage, hash chaining, write-once destinations)
- Incident reconstruction methodology: working backward from a suspected compromise to a timeline
- Ensuring privileged actions (like admin impersonation) generate audit entries a privileged actor cannot themselves suppress or edit
- Log retention policy design balanced against storage cost and compliance requirements

## Hiring rubric

**Must demonstrate**
- Can name the minimum event set a security audit log for an auth system must capture
- Understands why an audit log must be protected even from the administrators who generate the events it records

**Strong signal**
- Has designed or reviewed a tamper-evident logging mechanism (append-only, hash-chained, or externally shipped) rather than a plain mutable table
- Has actually reconstructed an incident timeline from logs and can describe what was missing that made it harder

**Red flags**
- Treats application debug logs as equivalent to a security audit trail
- Has no answer for how the audit log itself is protected from modification by a compromised admin account

## Interview probes

- Design the AuthEvents payload for an impersonation session in `packages/admin` such that a full incident timeline could be reconstructed later, including what a privileged actor should never be able to alter about it.
- What's the minimum viable tamper-evidence mechanism you'd add to an audit log stored in the same SQL database as the application's normal tables?
- Walk through how you'd reconstruct a timeline of a suspected account takeover using only the audit events this system currently seems to capture — where are the likely gaps?
