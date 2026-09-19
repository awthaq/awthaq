---
name: sms-otp-specialist
title: SMS OTP Specialist
type: archetype
ecosystem: Passwordless / MFA
---

# SMS OTP Specialist

## Role

This specialist implements SMS-delivered one-time codes as an authentication or MFA factor, focused on SIM-swap risk mitigation, carrier deliverability, and the operational realities of SMS as an insecure-by-default channel. Their daily work includes carrier/provider integration, cost/abuse controls, and designing safer alternatives or step-up requirements around SMS's known weaknesses.

## Why relevant to effect-auth

While no dedicated SMS package currently exists in effect-auth's plugin list, this specialist evaluates whether and how an SMS-OTP factor should sit alongside `packages/two-factor` and `packages/magic-link`, explicitly weighing SIM-swap and SS7-interception risk against user demand, and ensuring any such factor issues a principal through the same typed pipeline while being clearly documented (and to `qadi`) as a weaker factor than WebAuthn/TOTP for policy decisions.

## Core expertise

- SIM-swap attack mechanics and mitigation (carrier lookback, port-out alerts, step-up on suspicious swap)
- SMS deliverability across carriers/regions and provider failover (Twilio, etc.)
- Toll fraud and pumping (artificially inflated communications fraud) prevention
- Rate-limiting and cost-abuse controls for SMS send endpoints
- Positioning SMS OTP correctly relative to stronger factors in a layered MFA design

## Hiring rubric

**Must demonstrate**
- Can explain SIM-swap attacks and why SMS OTP is considered a weaker factor than TOTP/WebAuthn
- Knows concrete abuse patterns (SMS pumping/toll fraud) and how to rate-limit against them

**Strong signal**
- Has operated SMS delivery at scale and handled carrier failover/deliverability issues in production
- Designed a policy where SMS OTP triggers step-up scrutiny rather than being trusted equally to phishing-resistant factors

**Red flags**
- Recommends SMS OTP as the sole or strongest MFA factor with no caveats
- No rate-limiting on SMS-send endpoints, exposing the system to toll fraud

## Interview probes

- Explain how a SIM-swap attack defeats SMS OTP and what effect-auth could do to detect or mitigate it.
- How would you rate-limit an SMS-send endpoint to prevent it being used for toll fraud/pumping?
- If effect-auth added SMS OTP, how would you communicate its relative weakness to `qadi`'s policy layer so it's not weighted equally to a passkey?
