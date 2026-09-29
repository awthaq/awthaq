---
ID: "ECS-008"
Title: "doctor's config-validation mandate conflicts with ADR-006 and the no-Layer boundary"
Level: medium
Category: "correctness"
Status: resolved
Package: "—"
Source: "spec/decisions/006-runtime-config-separate-from-installation.md:33"
Auditor: "effect-cli-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ECS-008 — doctor's config-validation mandate conflicts with ADR-006 and the no-Layer boundary

`MEDIUM` · `correctness` · `—` · reported by **Effect CLI Specialist** (`effect-cli-specialist`)

Status: **resolved**

## Summary

BEH-EA-201 requires doctor to validate 'every configuration value it can validate', but configuration lives in per-plugin Context.References overridden by Layer.provide at the composition root (ADR-006), options reach only Layers (BEH-EA-007), and REQ-EA-600 forbids evaluating any Layer. Which values doctor can validate, and from what source, is unspecifiable as written - and ADR-006 explicitly accepts having 'no config-validation-CLI story', directly contradicting BEH-EA-201.

## Evidence

Source: `spec/decisions/006-runtime-config-separate-from-installation.md:33`

```
**Negative**: There is no single artifact that lists "every configuration value this application has set," and this is a real operational gap, not a stylistic nit. Because each plugin's options live in its own `Context.Reference`, overridden by whatever `Layer.provide` calls an application's composition root happens to contain, an operator who wants to answer "what is `Password`'s `minLength` in production, and did someone override `Sessions`' idle timeout for this tenant" has to read the composition code itself — there is no `awthaq config list` or equivalent (nothing resembling it appears anywhere in file 26's CLI surface), no config-validation-CLI story that could catch a malformed override before deploy the way `Layer.launch`'s type-checking catches a missing port, and no runtime introspection endpoint that dumps effective configuration the way `plugin list --graph` (BEH-EA-202) dumps effective plugin topology. Every other structural fact about a composed application — its plugin graph, its hook chains, its routes — is introspectable per file 26; configuration, chosen specifically because it is *not* part of that statically-derived manifest (ADR-EA-005), is consequently the one axis of an application's behavior that CLI tooling in this specification has no answer for.
```

## Recommended fix

Reconcile the two: either enumerate the statically declared config surface doctor reads (plugin-class Config descriptors plus environment) and amend ADR-006's negative consequences, or scope BEH-EA-201 to declared-default/insecure-combination validation and drop the 'every configuration value' universality.

## Context

- Auditor verdict on this domain: **needs-work** (score 56/100), domain: Operator CLI tooling
- Full dossier: [`effect-cli-specialist`](../../.reports/effect-cli-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 15 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`EP-009` — No operational artifact of effective configuration — an ADR-acknowledged multi-tenant blind spot](low/EP-009-eugenio-pace.md) `_(eugenio-pace, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-doctor-hardening`. Evidence at HEAD ec065a7: `spec/decisions/006-runtime-config-separate-from-installation.md:33`. Fix: Resolve the contradiction toward the richer option: introduce an effective-configuration descriptor that plugins declare statically (Schema + default + sensitivity), that `doctor` validates and a guarded operator view can dump, and amend ADR-006's Negative consequence accordingly. EP-009's per-tenant effective-config dump is folded in. (effort L). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Resolved toward the richer option: plugins (and core/server) declare configuration descriptors (ConfigDescriptor.make(reference, { sensitive, audit, project })); Auth.make exposes them as manifest.config, derived without evaluating any Layer; EffectiveConfig.read/audit/snapshot read them against a Context (a configuration Layer built on its own) or the ambient one; awthaq config list and doctor use them; GET /admin/config (fail-closed canManageUsers gate, secrets redacted, reads the configuration the layer was built under) is the runtime view; ADR-EA-006 revised to 1.2, BEH-EA-201 and new BEH-EA-229 aligned. Populated for Password, Passkey, Organization, Admin (+ AuditChain key), Roles, ApiKey, core Sessions/SessionCookie/MailDispatch and server BodyLimit. Tests: core/test/EffectiveConfig.test.ts, cli/test/Doctor.test.ts, admin/test/AdminConfig.test.ts (+ AuthHttp.test.ts 403 without the gate). Deviations: a descriptor carries an optional `audit` function and `sensitive` keys instead of a Schema (the reference's own type already validates shape; audits encode the insecure-default rules); config that is a Context.Service rather than a Reference (CSRF secret, JwtConfig) has no descriptor, covered by doctor --build reporting a build failure. Manifest tests in other packages gained the manifest plugin `groups` field.
