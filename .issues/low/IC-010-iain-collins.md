---
ID: "IC-010"
Title: "First real run requires hand-generating a base64 32-byte key; no dev auto-generation"
Level: low
Category: "dx"
Status: ready-for-agent
Package: "—"
Source: "README.md:171"
Auditor: "iain-collins"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# IC-010 — First real run requires hand-generating a base64 32-byte key; no dev auto-generation

`LOW` · `dx` · `—` · reported by **Iain Collins — Creator of NextAuth.js** (`iain-collins`)

Status: **ready-for-agent**

## Summary

KeyProvider.layerEnv hard-requires AWTHAQ_ENCRYPTION_KEY (base64, exactly 32 bytes, Config.Redacted) with good error messages (packages/ports/src/KeyProvider.ts:80-95), and the quickstart duly makes the reader paste a node -e incantation to boot. Auth.js generates AUTH_SECRET automatically in dev and via `npx auth add` for production, which removes a whole class of first-run failures. The explicit-key requirement is defensible for a crypto-at-rest system and the memory example needs no key (examples/memory-server/README.md:9), but the gap between 'clone and run' and 'quickstart runs' is self-inflicted friction.

## Evidence

Source: `README.md:171`

```
export AWTHAQ_ENCRYPTION_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
```

## Recommended fix

Provide a dev-only KeyProvider layer that generates and warns (or persists to .env.local) when the env var is absent, keeping the strict env layer as the production default.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: Next.js integration DX
- Full dossier: [`iain-collins`](../../.reports/iain-collins/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 26 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`CWM-007` — README shipping-status claims next remains a stub package, contradicting the implemented four-module adapter](low/CWM-007-clerk-workos-migration-specialist.md) `_(clerk-workos-migration-specialist, low)_`
- [`CSS-005` — README quickstart shows the session cookie as SameSite=Lax; every code path and the BDD suite enforce Strict](low/CSS-005-cookie-security-specialist.md) `_(cookie-security-specialist, low)_`
- [`DESS-008` — Quickstart offers no zero-database path and does not mention the runnable example](low/DESS-008-developer-experience-sdk-specialist.md) `_(developer-experience-sdk-specialist, low)_`
- [`DTWS-003` — Root README lists @awthaq/next as a stub package; it has a real implementation](medium/DTWS-003-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`DTWS-004` — Implemented @awthaq/roles plugin is absent from the root README's repo map, plugin table, and composition comment](medium/DTWS-004-documentation-technical-writing-specialist.md) `_(documentation-technical-writing-specialist, medium)_`
- [`IC-005` — Quickstart copy-paste output shows SameSite=Lax where the code sets Strict](low/IC-005-iain-collins.md) `_(iain-collins, low)_`
- [`NHS-009` — OpenAPI/Scalar docs served unauthenticated in the canonical composition](low/NHS-009-node-http-server-integration-specialist.md) `_(node-http-server-integration-specialist, low)_`
- [`SMS-006` — README quickstart loads DATABASE_URL via non-null assertion instead of Effect Config](low/SMS-006-secrets-management-specialist.md) `_(secrets-management-specialist, low)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `readme-docs-accuracy`. Evidence at HEAD ec065a7: `README.md:171`. Fix: Add an explicit, opt-in `KeyProvider.layerEphemeral` (random 32-byte key generated at layer build, loud warning that ciphertext won't survive a restart) for dev/examples; keep layerEnv as the production path. Do not silently auto-fallback from layerEnv (that would lose encrypted data in a misconfigured prod). (effort S). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Plan note (2026-09-29):** Not done in P19 (docs-only program): KeyProvider.layerEphemeral is a source change in packages/ports (plus a test and an example wiring), outside spec/README/docs. The README already documents the production path (AWTHAQ_ENCRYPTION_KEYS, key generation one-liner); add the 'layerEphemeral (dev only)' cell to the Configuration table when the layer exists.
