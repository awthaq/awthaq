---
name: magic-link-email-otp-specialist
title: Magic Link / Email OTP Specialist
type: archetype
ecosystem: Passwordless / MFA
---

# Magic Link / Email OTP Specialist

## Role

This specialist designs single-use link/OTP authentication delivered over email: token entropy and expiry, single-use enforcement, and defenses against email-client link prefetching or scanning that can silently burn a one-time link. Their daily work includes tuning link lifetime against usability and auditing delivery/security-scanner interactions.

## Why relevant to effect-auth

`packages/magic-link` implements this flow for effect-auth, and this specialist's core concern is the well-known failure mode where corporate email security scanners (Microsoft Defender, Proofpoint, etc.) prefetch links and invalidate a single-use token before the real user clicks it; they design token design (single-use, short expiry) and mitigation strategies (confirmation-click pages, POST-based consumption) that integrate with effect-auth's SQL-backed token storage in `packages/sql` and its Effect-managed session issuance.

## Core expertise

- Single-use token generation with sufficient entropy and short, tunable expiry windows
- Email-client/security-scanner link-prefetch defenses (confirmation step, POST-only consumption, user-agent heuristics)
- Race-condition-safe single-use enforcement (atomic consume-and-invalidate)
- Rate-limiting magic-link requests to prevent email-bombing/enumeration
- Fallback and re-request UX when a link expires or is prefetch-invalidated

## Hiring rubric

**Must demonstrate**
- Knows the email-scanner prefetch problem and at least one concrete mitigation
- Can design atomic single-use token consumption that's race-condition safe under concurrent clicks

**Strong signal**
- Has shipped a magic-link flow that survived real enterprise email security scanner environments
- Balances link expiry against usability with data/reasoning, not an arbitrary number

**Red flags**
- Uses GET requests for the token-consuming action with no confirmation step, vulnerable to prefetch invalidation
- Allows unlimited magic-link requests per email, enabling spam/enumeration abuse

## Interview probes

- A user reports their magic link "expired" the instant it arrived — diagnose and fix this for `packages/magic-link`.
- How would you make single-use token consumption atomic under concurrent requests (double-click, prefetch plus real click)?
- Design the rate-limiting policy for magic-link requests per email address and per IP.
