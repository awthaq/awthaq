---
name: device-authorization-grant-specialist
title: Device Authorization Grant Specialist
type: archetype
ecosystem: OAuth2 / OIDC
---

# Device Authorization Grant Specialist

## Role

This specialist implements RFC 8628's device authorization grant for input-constrained clients like CLIs, TVs, and IoT devices: user-code generation, polling loop correctness, and the cross-device UX that ties a device session to a user's browser-based approval. Their daily work spans backend polling-state machines and the human-facing verification page.

## Why relevant to effect-auth

effect-auth ships `packages/cli`, which is exactly the input-constrained client the device flow targets; this specialist designs how the CLI requests a device code, displays the user-code/verification URL, and polls for completion using effect-auth's Effect-based scheduling primitives, ensuring the polling interval respects the `slow_down` response and that the resulting session is issued through the same principal-resolution pipeline as any other login method.

## Core expertise

- RFC 8628 device authorization grant flow and endpoint responsibilities
- Correct polling interval handling, including `slow_down` and `expired_token` responses
- User-code entropy/format design for typability and collision resistance
- Cross-device session correlation and approval UX (verification page, QR code option)
- Rate-limiting and abuse prevention for the device/token polling endpoint

## Hiring rubric

**Must demonstrate**
- Knows the exact polling backoff behavior required when the server returns `slow_down`
- Can explain why user codes need enough entropy to resist guessing within the polling window

**Strong signal**
- Has implemented a device flow end-to-end including the human verification page, not just the polling client
- Designed the CLI-side experience (clear instructions, QR code fallback) as a first-class concern

**Red flags**
- Polls at a fixed interval ignoring server-provided backoff signals
- Uses short, low-entropy user codes without rate-limiting the verification endpoint

## Interview probes

- Walk through the full device flow state machine, including what the CLI does on `authorization_pending`, `slow_down`, and `expired_token`.
- How would you build `packages/cli`'s device-flow polling as an Effect `Schedule` that correctly backs off on `slow_down`?
- What entropy and rate-limiting would you put on the user-code verification endpoint to prevent brute-forcing?
