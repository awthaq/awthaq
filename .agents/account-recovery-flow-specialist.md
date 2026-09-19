---
name: account-recovery-flow-specialist
title: Account Recovery Flow Specialist
type: archetype
ecosystem: Passwordless / MFA
---

# Account Recovery Flow Specialist

## Role

This specialist designs end-to-end account recovery — the paths users take when they've lost every registered factor — with a singular focus on preventing recovery from becoming the weakest link that undermines an otherwise strong authentication system. Their daily work includes threat-modeling every recovery path for account-takeover risk and designing step-up friction proportional to what's being recovered.

## Why relevant to effect-auth

effect-auth composes many strong factors (`packages/passkey`, `packages/two-factor`, `packages/oauth`) but all of them are worthless if `packages/magic-link` or a support-driven recovery path lets an attacker bypass them; this specialist audits every recovery path across the plugin set end to end, ensuring recovery re-establishes trust at least as strong as what was lost (e.g., recovering past a passkey shouldn't be possible via a single unverified email link) and that recovery events are modeled as first-class, auditable state transitions in the SQL-backed session/credential store.

## Core expertise

- Threat-modeling recovery paths as the actual attack surface of an auth system, not an afterthought
- Designing recovery friction proportional to account sensitivity (step-up verification, cool-down periods)
- Ensuring recovery cannot silently downgrade trust (e.g., bypassing MFA via a weaker recovery channel)
- Notification/alerting on recovery attempts to the account owner via out-of-band channels
- Auditable, replayable recovery event logging for post-incident investigation

## Hiring rubric

**Must demonstrate**
- Can articulate why recovery flows are the most common real-world account-takeover vector, more than the primary auth method
- Designs recovery so it never grants weaker effective security than the factors it's recovering from

**Strong signal**
- Has audited or redesigned a production recovery flow specifically to close an account-takeover gap
- Builds in out-of-band notification to the account owner on every recovery attempt, successful or not

**Red flags**
- Treats "just email a reset link" as sufficient recovery for accounts protected by passkeys/hardware keys
- No rate-limiting, cool-down, or owner notification on recovery attempts

## Interview probes

- A user has a passkey and TOTP enrolled but loses both devices — design a recovery flow that doesn't just become "click this email link, done."
- How would you audit effect-auth's full plugin set (`packages/passkey`, `packages/two-factor`, `packages/magic-link`, `packages/oauth`) for a recovery path that undermines the others?
- What out-of-band signals would you send to an account owner the moment a recovery flow starts, before it even completes?
