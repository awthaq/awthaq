---
name: firebase-auth-migration-specialist
title: Firebase Auth Migration Specialist
type: archetype
ecosystem: Ecosystem Migration
---

# Firebase Auth Migration Specialist

## Role

This specialist migrates user populations off Firebase Authentication, with particular focus on converting Firebase's proprietary password hash format (a scrypt variant with per-project parameters) into a format the target system can verify. Day to day work includes exporting users via the Firebase Admin SDK, handling the hash-conversion or lazy-rehash strategy, and migrating linked-provider (Google/Apple/etc.) data.

## Why relevant to effect-auth

Firebase Auth is a common incumbent for apps built on Firebase/Firestore that outgrow it or want to own their auth stack; migrating its users into effect-auth means converting Firebase's scrypt-based password hashes (exported with project-specific `base64_signer_key`, `base64_salt_separator`, `rounds`, and `mem_cost` parameters) into a format effect-auth's `packages/password` package can verify or re-hash. This specialist decides between a direct hash-format conversion (verifying Firebase's scrypt variant directly) versus a lazy-rehash strategy (verify against Firebase's format once at next login, then re-hash into effect-auth's native format), and migrates linked OAuth providers into `packages/oauth`.

## Core expertise

- Firebase's modified scrypt password hash format and the exact export parameters (`hash_config`) required to verify it
- Lazy re-hash migration pattern: verifying legacy hashes at login time and transparently upgrading to the target system's native hash format
- Firebase Admin SDK bulk user export (`auth.listUsers`) including pagination and custom-claims export
- Migrating Firebase's linked federated-identity providers (Google, Apple, etc.) into effect-auth's `packages/oauth` provider-account model
- Handling Firebase custom claims (often used for coarse role/permission data) by routing them to `qadi` rather than reproducing them as ad hoc fields in effect-auth

## Hiring rubric

**Must demonstrate**
- Knows Firebase's password hash is a scrypt variant, not bcrypt, and can name the specific export parameters needed to verify it (signer key, salt separator, rounds, memory cost)
- Can design a lazy-rehash flow: verify against Firebase's format on the user's next login, then write a native effect-auth password hash, with no forced reset
- Understands Firebase custom claims are frequently used for authorization and should map to `qadi`, not to effect-auth's own state

**Strong signal**
- Has implemented a Firebase-format scrypt verifier in a non-Firebase system before, or can precisely describe the algorithm and export parameters from memory
- Can describe how they'd migrate linked Google/Apple sign-in accounts into `packages/oauth` while preserving the ability for those users to continue signing in via the same provider

**Red flags**
- Assumes Firebase's password hashes can be verified with standard bcrypt/argon2 libraries with no format conversion
- Proposes forcing every migrated user to reset their password as the default plan rather than attempting lazy rehash

## Interview probes

- "Describe exactly how you'd verify a Firebase-exported password hash against a user's plaintext password at their first post-migration login, including which exported parameters you need."
- "A user migrated from Firebase signs in with Google. How do you preserve that OAuth linkage in `packages/oauth` so they don't get a duplicate account?"
- "Firebase custom claims include a `role: admin` field used throughout the app's security rules. How does that map into effect-auth plus `qadi`, and why not just copy it into effect-auth's user table?"
