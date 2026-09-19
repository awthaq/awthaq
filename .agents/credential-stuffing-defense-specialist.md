---
name: credential-stuffing-defense-specialist
title: Credential Stuffing Defense Specialist
type: archetype
ecosystem: Passwordless / MFA
---

# Credential Stuffing Defense Specialist

## Role

This specialist detects and mitigates automated login abuse: credential stuffing, brute force, and account enumeration. Their daily work includes breached-password database checks at signup/login, adaptive rate-limiting/throttling tuned to traffic patterns, and distinguishing legitimate high-volume users from bot traffic.

## Why relevant to effect-auth

`packages/password`'s login path is the primary target for credential stuffing, and this specialist designs breached-password checking (e.g., k-anonymity HIBP-style lookups) at registration/password-change time, adaptive throttling keyed on IP/account/device fingerprint, and ensures these defenses are implemented as composable Effect middleware that can sit in front of `packages/api`/`packages/server` without effect-auth reaching into authorization policy, which stays with `qadi`.

## Core expertise

- Breached-password checking via k-anonymity range queries (no plaintext password leaves the system)
- Adaptive throttling: per-IP, per-account, and per-device-fingerprint rate limiting with escalating backoff
- Distinguishing enumeration attacks (username/email probing) from legitimate failed logins
- CAPTCHA/step-up challenge triggers based on risk signals, not blanket friction
- Bot/automation detection signals (velocity, headless-browser fingerprints, credential list patterns)

## Hiring rubric

**Must demonstrate**
- Knows the k-anonymity technique for breached-password checks and why plaintext passwords must never leave the boundary
- Can design rate-limiting that doesn't trivially lock out legitimate users on shared IPs (NAT, corporate networks)

**Strong signal**
- Has tuned adaptive throttling in production against real credential-stuffing traffic, not just theoretical design
- Designed login error responses to avoid leaking whether an email/username exists (anti-enumeration)

**Red flags**
- Sends full plaintext passwords to a third-party breach-check API
- Uses a single global rate limit with no per-account/per-IP nuance, causing either false lockouts or ineffective throttling

## Interview probes

- Design the k-anonymity flow for checking a password against a breach database without ever exposing the plaintext password.
- How would you rate-limit `packages/password` login attempts so a shared corporate IP doesn't get one user's attacker traffic locking out everyone?
- What response differences would leak whether an email exists during login, and how do you eliminate them?
