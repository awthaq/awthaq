---
name: api-design-versioning-specialist
title: API Design & Versioning Specialist
type: archetype
ecosystem: Developer Experience
---

# API Design & Versioning Specialist

## Role

This specialist designs stable, evolvable public APIs: the surface a downstream consumer or plugin author depends on, backward-compatible change strategy, and deprecation lifecycle. Day to day work is reviewing proposed API changes for the blast radius they create for existing consumers.

## Why relevant to effect-auth

Every plugin package (password, oauth, passkey, magic-link, api-key, two-factor, admin, organization, roles, jwt) exposes a public Layer/Context surface and Schema-defined DTOs that other packages and, eventually, third-party plugin authors depend on — and effect-auth is pinned to Effect v4's still-moving rc line, so this role must design effect-auth's own public API to be more stable than its underlying dependency. This role owns deciding how a plugin can add a new capability (e.g., a new two-factor method or a new OAuth provider) without breaking existing consumers' Layer wiring or Schema-decoded persisted data, and defines the deprecation path when an API must change incompatibly.

## Core expertise

- Designing plugin-facing public APIs (Layers, Schema contracts) with a stable surface distinct from internals
- Backward-compatible Schema evolution strategy for DTOs already persisted or already consumed by clients
- Semantic-versioning discipline and deprecation windows for a pre-1.0, fast-moving library
- Additive-vs-breaking change classification across a plugin-package architecture
- Designing extension points (new OAuth providers, new two-factor methods) without widening the public surface unnecessarily
- Communicating breaking changes clearly via changelogs/migration notes tied to `spec/decisions/`

## Hiring rubric

**Must demonstrate**
- Can classify a proposed change as additive, backward-compatible-breaking, or hard-breaking, and justify it
- Designs new plugin capabilities as extensions of existing contracts rather than parallel, inconsistent APIs

**Strong signal**
- Has shipped a deprecation path (old API kept functional, warned, then removed on a schedule) for a real breaking change
- Anticipates how a public API change ripples through consumers before it ships, not after a complaint

**Red flags**
- Treats "it's pre-1.0" as license to make breaking changes without a migration path or communication
- Designs a new plugin's public API inconsistently with existing plugins' established conventions

## Interview probes

- "You need to add a new required field to the OAuth account DTO that's already persisted and already consumed by `packages/client`. What's your rollout plan?"
- "How do you decide when a change to a plugin's public Layer signature is additive versus breaking?"
- "Design the extension point for adding a new two-factor method (e.g., WebAuthn-based) without every existing consumer needing to change their Layer wiring."
