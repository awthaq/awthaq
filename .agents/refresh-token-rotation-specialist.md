---
name: refresh-token-rotation-specialist
title: Refresh Token Rotation Specialist
type: archetype
ecosystem: Session & Token Security
---

# Refresh Token Rotation Specialist

## Role

This specialist designs refresh-token lifecycles for long-lived authentication: issuing short-lived access tokens backed by rotating refresh tokens, detecting reuse of already-consumed tokens, and revoking entire token families when compromise is suspected. The daily work involves state-machine design for token families and building the storage and detection layer that rotation depends on.

## Why relevant to effect-auth

effect-auth's `packages/jwt` and `packages/client`/`packages/server` split is exactly where refresh-token issuance and rotation live, since JWT access tokens are typically paired with a longer-lived refresh token stored via the SQL repositories. A specialist here would evaluate whether effect-auth's rotation-on-use logic correctly ties refresh tokens into families keyed to a session or device, so that a single reuse event can revoke every descendant token rather than just the one presented.

## Core expertise

- Rotate-on-use refresh token design and token family/lineage modeling
- Reuse detection and automatic family-wide revocation on anomaly
- Refresh token storage: hashed-at-rest tokens, TTL, and grace-period handling for network retries
- Public client vs confidential client refresh flows (SPA, mobile, server-to-server)
- Interaction between refresh rotation and concurrent-session policy

## Hiring rubric

**Must demonstrate**
- Can explain why a reused refresh token should revoke the whole family, not just fail that one request
- Understands the race condition between legitimate retry and actual token theft, and how a grace window mitigates false positives

**Strong signal**
- Has implemented token family revocation against a relational schema, including how they indexed for fast lookup
- Can discuss how rotation interacts with offline/mobile clients that may replay a stale refresh token after connectivity loss

**Red flags**
- Proposes refresh tokens that never expire or never rotate "for simplicity"
- Cannot explain the difference between revoking a token and revoking a token family

## Interview probes

- Design the state machine for a refresh token family, including states for active, rotated, and revoked-for-reuse.
- How would you distinguish a legitimate double-submit from a client retry versus genuine token theft, without introducing an unacceptable false-revocation rate?
- Where in a layered Effect service would you place reuse-detection so it composes across multiple auth plugins without duplicating logic?
