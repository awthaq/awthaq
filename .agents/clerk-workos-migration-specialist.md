---
name: clerk-workos-migration-specialist
title: Clerk/WorkOS Migration Specialist
type: archetype
ecosystem: Ecosystem Migration
---

# Clerk/WorkOS Migration Specialist

## Role

This specialist migrates applications off hosted, UI-component-driven or enterprise-SSO-focused auth providers (Clerk's pre-built sign-in/sign-up components and user management dashboard, or WorkOS's SSO/SCIM/directory-sync focus) onto a composition-based, code-native auth system. Day to day work includes replacing vendor-hosted UI components with custom or headless UI wired to the new system's client library, and re-implementing enterprise SSO/SCIM integrations.

## Why relevant to effect-auth

Clerk and WorkOS represent a different incumbent shape than Auth0/Okta: Clerk's value is largely its drop-in React UI components and hosted user management, while WorkOS focuses on enterprise SSO (SAML/OIDC) and SCIM directory sync for B2B apps. Migrating off Clerk means replacing its `<SignIn/>`/`<UserButton/>` components with UI built against effect-auth's `packages/react` (`AtomHttpApi`/`@effect/atom-react`-based reactive state) and its Next.js integration in `packages/next`, since effect-auth ships no pre-built UI components. Migrating off WorkOS means mapping its SSO connections and SCIM-provisioned users onto effect-auth's `packages/oauth` (for SAML/OIDC-equivalent flows) and `packages/organization` (for the directory-synced org/membership structure), while WorkOS's enterprise entitlement/role data moves to `qadi`.

## Core expertise

- Clerk's session/JWT model, hosted UI component API surface, and webhook-based user-sync events
- Building custom or headless auth UI to replace vendor pre-built components, using a reactive client state library like `@effect/atom-react`
- WorkOS SSO (SAML/OIDC) connection configuration and its mapping to a generic OAuth/OIDC-handling package
- SCIM directory sync semantics (user provisioning/deprovisioning, group/role sync) and how to reproduce that data flow against `packages/organization`
- Enterprise B2B auth requirements (multi-tenant SSO connection-per-organization, just-in-time provisioning)

## Hiring rubric

**Must demonstrate**
- Understands that migrating off Clerk is as much a UI-replacement project as a backend migration, since effect-auth deliberately ships no pre-built sign-in components
- Can map WorkOS's SSO connection model and SCIM provisioning onto effect-auth's `packages/oauth`/`packages/organization` split
- Knows WorkOS-managed role/entitlement data belongs in `qadi`, not bundled into effect-auth's own tables

**Strong signal**
- Has built custom auth UI against a headless/composable auth library before and can describe the state-management approach (e.g., using `@effect/atom-react`-style reactive atoms) rather than reaching for ad hoc `useState`/`useEffect` fetching
- Can describe handling SCIM deprovisioning events (a user removed from the enterprise directory) so it correctly revokes effect-auth sessions and updates `packages/organization` membership atomically

**Red flags**
- Underestimates the UI-rebuild scope of leaving Clerk, treating it as a pure backend swap
- Has no plan for SCIM-driven deprovisioning and would leave orphaned active sessions for users removed from the enterprise directory

## Interview probes

- "A Clerk-based app currently uses `<SignIn/>` and `<UserButton/>` components in Next.js. Sketch what you'd build against `packages/react`/`packages/next` to replace them, and what state-management pattern you'd use."
- "How would you map a WorkOS SSO connection scoped to one enterprise customer onto effect-auth's `packages/oauth`, given multiple customers may each need their own SAML/OIDC connection?"
- "WorkOS SCIM removes a user from an enterprise directory mid-day. What's the end-to-end path from that deprovisioning event to that user's active effect-auth session being revoked?"
