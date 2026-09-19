# `.agents/` — 100 hiring profiles for effect-auth

This directory is a hiring/review reference for staffing effect-auth, not a
recruiting roster of contactable people. It has two kinds of files, both
marked in frontmatter (`type: real` / `type: archetype`):

- **`type: real` (22 files)** — verified, publicly documented figures from the
  Effect ecosystem and the wider authentication/identity/authorization
  industry (Effect core team, better-auth, Auth.js, Passport.js, Lucia, Ory,
  Auth0, OAuth2/OIDC standards work, WebAuthn spec editors, OPA/Casbin,
  TypeScript, Cucumber/BDD). Each profile is grounded in that person's actual
  public work and describes what to look for in an engineer who reasons the
  way they do — it is **not** an offer, a contact, or a claim that they are
  available for hire.
- **`type: archetype` (78 files)** — skill-based specialist personas (e.g.
  "WebAuthn/Passkeys Implementation Specialist," "Effect Layer/Context
  Architect") covering the technical surface area effect-auth actually needs:
  Effect internals, every OAuth2/OIDC and passwordless/MFA flow the plugin
  packages implement, session/token security, authorization patterns (RBAC/
  ABAC/ReBAC), applied cryptography, persistence, framework integration, and
  migration from comparable ecosystems (better-auth, Auth.js, Auth0, Firebase,
  Supabase, Clerk/WorkOS).

Every file follows the same shape: **Who they are / Role**, **Why relevant to
effect-auth**, **Core expertise**, a **Hiring rubric** (must-demonstrate /
strong-signal / red-flag bullets), and **Interview probes** — concrete
questions tied to this codebase's actual architecture (Effect v4, `Layer`/
`Context`, `Schema`, the plugin packages, the qadi authorization boundary,
the SQL repositories, the `features/` BDD suite).

## Real, publicly-documented figures (22)

| Profile | Ecosystem |
|---|---|
| [Michael Arnaldi](michael-arnaldi.md) — Creator of Effect | Effect |
| [Tim Smart](tim-smart.md) — Effect Platform & Infrastructure Maintainer | Effect |
| [Mattia Manzati](mattia-manzati.md) — Effect Developer Tooling | Effect |
| [Giulio Canti](giulio-canti.md) — Creator of fp-ts and io-ts | Effect |
| [Bereket Engida](bereket-engida.md) — Creator of better-auth | better-auth |
| [Iain Collins](iain-collins.md) — Creator of NextAuth.js | Auth.js |
| [Balázs Orbán](balazs-orban.md) — Lead Maintainer, Auth.js | Auth.js |
| [Jared Hanson](jared-hanson.md) — Creator of Passport.js | Passport.js |
| [pilcrow](pilcrow.md) — Creator of Lucia Auth | Lucia Auth |
| [Aeneas Rekkas](aeneas-rekkas.md) — Founder/CEO of Ory | Ory |
| [Eugenio Pace](eugenio-pace.md) — Co-founder/former CEO of Auth0 | Auth0 |
| [Matias Woloski](matias-woloski.md) — Co-founder/former CTO of Auth0 | Auth0 |
| [Vittorio Bertocci](vittorio-bertocci.md) — Token-Based Identity Protocol Expert | OAuth2 / OIDC |
| [Aaron Parecki](aaron-parecki.md) — IETF OAuth WG / Creator of IndieAuth | OAuth2 / OIDC |
| [Justin Richer](justin-richer.md) — Co-author, "OAuth 2 in Action" | OAuth2 / OIDC |
| [Philippe De Ryck](philippe-de-ryck.md) — Web Application Security Trainer | Web / App Security |
| [Tim Cappalli](tim-cappalli.md) — WebAuthn / Passkeys Standards Contributor | WebAuthn / Passkeys |
| [Christiaan Brand](christiaan-brand.md) — W3C WebAuthn Spec Co-editor | WebAuthn / Passkeys |
| [Torin Sandall](torin-sandall.md) — Co-creator of Open Policy Agent (OPA) | Authorization / Policy |
| [Yang Luo](yang-luo.md) — Creator of Casbin | Authorization / Policy |
| [Anders Hejlsberg](anders-hejlsberg.md) — Creator/Lead Architect of TypeScript | TypeScript |
| [Aslak Hellesøy](aslak-hellesoy.md) — Creator of Cucumber | BDD / Testing |

## Specialist archetypes (78)

### Effect ecosystem (12)

| Profile |
|---|
| [Effect Schema Specialist](effect-schema-specialist.md) |
| [Effect Layer/Context Architect](effect-layer-context-architect.md) |
| [Effect HTTP API Specialist](effect-http-api-specialist.md) |
| [Effect SQL Repository Specialist](effect-sql-repository-specialist.md) |
| [Effect Concurrency & Fiber Specialist](effect-concurrency-fiber-specialist.md) |
| [Effect Stream Specialist](effect-stream-specialist.md) |
| [Effect Testing & @effect/vitest Specialist](effect-testing-vitest-specialist.md) |
| [Effect Atom/React Reactivity Specialist](effect-atom-react-specialist.md) |
| [Effect CLI Specialist](effect-cli-specialist.md) |
| [Effect Observability & Tracing Specialist](effect-observability-tracing-specialist.md) |
| [Effect Typed Error Management Specialist](effect-error-management-specialist.md) |
| [Effect Runtime & Scheduler Specialist](effect-runtime-scheduler-specialist.md) |

### OAuth2 / OIDC (8)

| Profile |
|---|
| [OAuth2 Authorization Code + PKCE Specialist](oauth2-authorization-code-pkce-specialist.md) |
| [OIDC ID Token Specialist](oidc-id-token-specialist.md) |
| [OAuth2 Client Credentials / M2M Specialist](oauth2-client-credentials-m2m-specialist.md) |
| [SAML Federation Specialist](saml-federation-specialist.md) |
| [SCIM Provisioning Specialist](scim-provisioning-specialist.md) |
| [Token Introspection & Revocation Specialist](token-introspection-revocation-specialist.md) |
| [JWT/JWK Specialist](jwt-jwk-specialist.md) |
| [Device Authorization Grant Specialist](device-authorization-grant-specialist.md) |

### Passwordless / MFA (10)

| Profile |
|---|
| [WebAuthn/Passkeys Implementation Specialist](webauthn-passkeys-specialist.md) |
| [TOTP/HOTP MFA Specialist](totp-hotp-mfa-specialist.md) |
| [Magic Link / Email OTP Specialist](magic-link-email-otp-specialist.md) |
| [SMS OTP Specialist](sms-otp-specialist.md) |
| [Backup Codes & Account Recovery Specialist](backup-codes-recovery-specialist.md) |
| [Password Hashing Specialist](password-hashing-specialist.md) |
| [Credential Stuffing Defense Specialist](credential-stuffing-defense-specialist.md) |
| [Biometric / Platform Authenticator Specialist](biometric-platform-authenticator-specialist.md) |
| [Hardware Security Key (FIDO U2F/CTAP) Specialist](hardware-security-key-specialist.md) |
| [Account Recovery Flow Specialist](account-recovery-flow-specialist.md) |

### Session & token security (6)

| Profile |
|---|
| [Session Management Specialist](session-management-specialist.md) |
| [Refresh Token Rotation Specialist](refresh-token-rotation-specialist.md) |
| [Token Revocation & Blacklist Specialist](token-revocation-blacklist-specialist.md) |
| [Cookie Security Specialist](cookie-security-specialist.md) |
| [CSRF Defense Specialist](csrf-defense-specialist.md) |
| [Rate Limiting & Brute-Force Defense Specialist](rate-limiting-brute-force-specialist.md) |

### Authorization (8)

| Profile |
|---|
| [RBAC Role Modeling Specialist](rbac-role-modeling-specialist.md) |
| [ABAC Attribute-Based Policy Specialist](abac-attribute-policy-specialist.md) |
| [ReBAC / Zanzibar-style Specialist](rebac-zanzibar-specialist.md) |
| [Policy Engine / Rego Specialist](policy-engine-rego-specialist.md) |
| [Multi-Tenant Isolation Specialist](multi-tenant-isolation-specialist.md) |
| [Permission Caching Specialist](permission-caching-specialist.md) |
| [Organization Hierarchy Specialist](organization-hierarchy-specialist.md) |
| [Impersonation & Delegation Specialist](impersonation-delegation-specialist.md) |

### Security & cryptography (8)

| Profile |
|---|
| [Applied Cryptography Specialist](applied-cryptography-specialist.md) |
| [Threat Modeling Specialist](threat-modeling-specialist.md) |
| [Authentication Penetration Testing Specialist](auth-pentest-specialist.md) |
| [Secrets Management Specialist](secrets-management-specialist.md) |
| [Key Rotation Specialist](key-rotation-specialist.md) |
| [Timing / Side-Channel Specialist](timing-side-channel-specialist.md) |
| [Audit Logging & Forensics Specialist](audit-logging-forensics-specialist.md) |
| [Compliance (SOC2/GDPR) Specialist](compliance-soc2-gdpr-specialist.md) |

### Database & persistence (6)

| Profile |
|---|
| [SQL Schema Migration Specialist](sql-schema-migration-specialist.md) |
| [Postgres Performance Specialist](postgres-performance-specialist.md) |
| [SQLite Embedded Auth Specialist](sqlite-embedded-auth-specialist.md) |
| [Read Replica Consistency Specialist](read-replica-consistency-specialist.md) |
| [Data Residency & Sharding Specialist](data-residency-sharding-specialist.md) |
| [Event Sourcing & Audit Trail Specialist](event-sourcing-audit-trail-specialist.md) |

### Framework integration (8)

| Profile |
|---|
| [Next.js Server Actions Auth Specialist](nextjs-server-actions-auth-specialist.md) |
| [React Server Components Auth Specialist](react-server-components-auth-specialist.md) |
| [Node HTTP Server Integration Specialist](node-http-server-integration-specialist.md) |
| [Edge Runtime Auth Specialist](edge-runtime-auth-specialist.md) |
| [Mobile/Native Auth Specialist](mobile-native-auth-specialist.md) |
| [CLI Tool Auth Specialist](cli-tool-auth-specialist.md) |
| [Microservices Auth Propagation Specialist](microservices-auth-propagation-specialist.md) |
| [API Gateway Auth Specialist](api-gateway-auth-specialist.md) |

### Ecosystem migration (6)

| Profile |
|---|
| [better-auth Migration Specialist](better-auth-migration-specialist.md) |
| [NextAuth.js/Auth.js Migration Specialist](nextauth-authjs-migration-specialist.md) |
| [Auth0/Okta Migration Specialist](auth0-okta-migration-specialist.md) |
| [Firebase Auth Migration Specialist](firebase-auth-migration-specialist.md) |
| [Supabase Auth Migration Specialist](supabase-auth-migration-specialist.md) |
| [Clerk/WorkOS Migration Specialist](clerk-workos-migration-specialist.md) |

### Developer experience & tooling (6)

| Profile |
|---|
| [TypeScript Type-Level Engineer](typescript-type-level-engineer.md) |
| [Monorepo Tooling Specialist](monorepo-tooling-specialist.md) |
| [BDD/Gherkin Acceptance Testing Specialist](bdd-gherkin-acceptance-testing-specialist.md) |
| [API Design & Versioning Specialist](api-design-versioning-specialist.md) |
| [Documentation & Technical Writing Specialist](documentation-technical-writing-specialist.md) |
| [Developer Experience / SDK Specialist](developer-experience-sdk-specialist.md) |

## How to use this

1. Pick the profile(s) closest to the role you're hiring or the PR you're
   reviewing.
2. Use the **Hiring rubric** as an interview scorecard, not a checklist to
   read aloud — the "must demonstrate" bullets are the bar, "strong signal"
   is what separates a good hire from a great one, and "red flags" are
   specific enough to probe for directly.
3. Use the **Interview probes** as starting questions, then follow up on the
   reasoning, not just the answer.
4. For a PR review, ask "would the [X] specialist sign off on this?" for
   whichever domain the PR touches — it's a faster way to load the right
   mental model than re-deriving it from scratch.
