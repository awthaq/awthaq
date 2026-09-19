---
name: effect-layer-context-architect
title: Effect Layer/Context Architect
type: archetype
ecosystem: Effect
---

# Effect Layer/Context Architect

## Role

This specialist designs the dependency-injection graph of an Effect application: which services are exposed as Context.Tag boundaries, how Layers compose and merge, and how lifecycle (acquire/release) is threaded through a system built from independently deployable modules. The daily work is drawing and pruning Layer graphs, not writing business logic.

## Why relevant to effect-auth

effect-auth is explicitly a plugin-package architecture (core, password, oauth, passkey, magic-link, api-key, two-factor, admin, organization, roles, jwt, sql, api, server) where each package contributes Layers that must compose into a single runtime without circular dependencies or duplicated service instances. This role owns the boundary between a plugin's own Context.Tag services and the services it consumes from core or from qadi (the sibling authorization library), and is responsible for making sure Layer.provide/Layer.merge graphs stay legible as new plugins are added.

## Core expertise

- Context.Tag/Context.GenericTag design and service boundary placement
- Layer.merge/Layer.provide graph composition and diagnosing circular Layer dependencies
- Scoped resource lifecycle management (acquireRelease) across plugin boundaries
- Layer memoization semantics and when a service should be shared vs re-instantiated
- Structuring a plugin package's public Layer so consumers can override individual dependencies
- Delegating authorization concerns to qadi's Layers rather than reimplementing policy logic in effect-auth

## Hiring rubric

**Must demonstrate**
- Can explain why two independently-required Layers of the same service don't create duplicate instances
- Has designed a plugin/extension system using Layers rather than ad hoc singletons or DI containers

**Strong signal**
- Has debugged and resolved a real circular Layer dependency in a multi-package system
- Designs Context.Tag boundaries narrow enough to be independently testable with mock Layers

**Red flags**
- Reaches for module-level mutable singletons instead of Context/Layer when a new service is needed
- Treats Layer composition order as unimportant, or can't explain Layer.provide vs Layer.merge semantics

## Interview probes

- "A new plugin package needs to depend on both core's session service and qadi's authorization service — how do you structure its Layer so it doesn't force a specific provisioning order on consumers?"
- "Describe a circular Layer dependency you've hit and how you broke the cycle without collapsing two services into one."
- "How do you decide whether a plugin's internal cache service should be a Layer.scoped resource or a plain Layer.succeed value?"
