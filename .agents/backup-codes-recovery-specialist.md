---
name: backup-codes-recovery-specialist
title: Backup Codes & Account Recovery Specialist
type: archetype
ecosystem: Passwordless / MFA
---

# Backup Codes & Account Recovery Specialist

## Role

This specialist designs one-time backup/recovery codes used when a user's primary MFA factor (authenticator app, passkey) is unavailable. Their daily work includes generation and hashed storage of code sets, safe one-time display, and the regeneration UX that invalidates old codes without locking users out mid-transition.

## Why relevant to effect-auth

`packages/two-factor` needs a recovery path for when a TOTP device is lost, and this specialist owns backup-code generation, storage (hashed, never plaintext, consistent with effect-auth's forbidding of type assertions and its schema-first DTO approach), single-use consumption tracking, and the regeneration flow that must atomically invalidate the old set while showing the new set exactly once — all wired through the same SQL repositories and Effect service boundaries as the rest of `packages/two-factor`.

## Core expertise

- Generating backup code sets with sufficient per-code entropy and a reasonable set size
- Hashed-at-rest storage of codes (never plaintext), with per-code single-use consumption tracking
- Safe one-time display UX (show once, force explicit "I've saved these" acknowledgment)
- Atomic regeneration: invalidating the old set only after the new set is durably persisted
- Low-remaining-codes warnings and re-enrollment nudges

## Hiring rubric

**Must demonstrate**
- Stores backup codes hashed, not in plaintext, and can explain the threat model that requires this
- Designs single-use consumption as atomic/race-safe, same as any other single-use token

**Strong signal**
- Has built the "show once" UX correctly, including handling a user who navigates away before acknowledging
- Designed regeneration so a failure mid-flow can't leave a user with zero valid codes

**Red flags**
- Stores backup codes as plaintext or reversibly encrypted "for support purposes"
- Regenerates codes by deleting the old set before confirming the new set was persisted

## Interview probes

- Walk through your exact storage schema for backup codes in `packages/two-factor` — what's hashed, what's queryable, and why.
- What happens if a user's browser crashes right after backup codes are generated but before they've saved them?
- How do you make code regeneration atomic so a mid-flow failure never leaves zero valid recovery codes?
