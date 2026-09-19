---
name: rate-limiting-brute-force-specialist
title: Rate Limiting & Brute-Force Defense Specialist
type: archetype
ecosystem: Session & Token Security
---

# Rate Limiting & Brute-Force Defense Specialist

## Role

This specialist designs throttling for authentication-adjacent endpoints — login, OTP verification, password reset, magic-link request — balancing attacker cost against legitimate user friction. The work includes choosing rate-limit keys (IP, account, device fingerprint), picking distributed state backends, and avoiding lockout policies that themselves become a denial-of-service vector against legitimate users.

## Why relevant to effect-auth

effect-auth's plugin surface includes `packages/password`, `packages/two-factor`, and `packages/magic-link`, each exposing an endpoint (password login, OTP submission, magic-link request) that is a natural brute-force or enumeration target. A specialist would evaluate whether rate limiting is applied per-account as well as per-IP (since IP-only limiting is trivially bypassed and account-only limiting enables attacker-triggered lockout of a victim), and whether limiter state is centralized appropriately given the SQL-backed, potentially multi-instance deployment model.

## Core expertise

- Per-IP, per-account, and per-device rate-limit keying strategies and their respective bypass risks
- Distributed rate-limit state (Redis, SQL-backed counters, sliding window vs fixed window)
- Exponential backoff and CAPTCHA escalation design for repeated failures
- Avoiding attacker-triggered account lockout as a denial-of-service vector against legitimate users
- OTP- and magic-link-specific throttling (short-lived codes, single-use enforcement, resend cooldowns)

## Hiring rubric

**Must demonstrate**
- Can explain why IP-only rate limiting fails against distributed credential stuffing
- Knows the difference between throttling that slows an attacker and lockout that a third party can weaponize against a victim account

**Strong signal**
- Has designed a rate limiter with both per-account and per-IP dimensions plus a global anomaly threshold
- Can discuss how to rate-limit an OTP or magic-link endpoint without adding attacker-usable timing signal about whether the account exists

**Red flags**
- Proposes locking an account after N failed attempts with no path back for the legitimate owner other than support
- Rate-limits only login but not password-reset or OTP-resend endpoints

## Interview probes

- How would you rate-limit a login endpoint so that an attacker cannot lock out a legitimate user by intentionally failing their password?
- Design throttling for an OTP verification endpoint that resists both brute force of the code and enumeration of valid phone numbers/emails.
- What distributed state backend would you choose for rate-limit counters given a multi-instance deployment, and how do you handle a backend outage — fail open or fail closed?
