---
ID: "ERAS-003"
Title: "No edge/worker export conditions or edge deployment guidance anywhere"
Level: low
Category: "docs"
Status: ready-for-agent
Package: "client"
Source: "packages/client/package.json:17"
Auditor: "edge-runtime-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# ERAS-003 — No edge/worker export conditions or edge deployment guidance anywhere

`LOW` · `docs` · `client` · reported by **Edge Runtime Auth Specialist** (`edge-runtime-auth-specialist`)

Status: **ready-for-agent**

## Summary

All 21 packages share the same four-condition export map (types/bun/import/default); none declares edge-light, worker, or browser conditions. Since the internals are WebCrypto-pure this is not a runtime blocker, but bundlers resolving @awthaq/next inside a Vercel Edge middleware or a Cloudflare Worker get no signal about which entry points are edge-safe, and no spec file, ADR, or README documents an edge deployment story or the edge/origin split (grep of spec/ and package READMEs finds no Workers/Vercel Edge mention). The codebase is edge-ready and refuses to say so.

## Evidence

Source: `packages/client/package.json:17`

```
      "bun": "./src/index.ts",
      "import": "./lib/index.js",
      "default": "./lib/index.js"
```

## Recommended fix

Add edge-light/worker conditions (they can map to the same ./src/*.ts for now) to client, api, next, and jwt, and add a short deployment ADR: cookie-presence at the edge, signature verification tier (once ERAS-001 lands), sessions/hashing/SQL on origin.

## Context

- Auditor verdict on this domain: **pass-with-concerns** (score 72/100), domain: Edge Runtime Compat
- Full dossier: [`edge-runtime-auth-specialist`](../../.reports/edge-runtime-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 34 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** PARTIAL (confidence medium); workstream `next-edge-stateless-tier`. Evidence at HEAD ec065a7: `packages/client/package.json:14`. Fix: Documentation only: an edge deployment section; no new export conditions. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.
