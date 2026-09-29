---
ID: "NHS-004"
Title: "No request-body size limit anywhere on the serving path"
Level: medium
Category: "security"
Status: resolved
Package: "—"
Source: "node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/dist/unstable/http/HttpIncomingMessage.js:57"
Auditor: "node-http-server-integration-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NHS-004 — No request-body size limit anywhere on the serving path

`MEDIUM` · `security` · `—` · reported by **Node HTTP Server Integration Specialist** (`node-http-server-integration-specialist`)

Status: **resolved**

## Summary

The platform's MaxBodySize fiber reference defaults to undefined (unlimited), and a grep for MaxBodySize across packages/ and examples/ returns zero matches: no middleware, no composition layer, no endpoint sets a cap. Every JSON endpoint (/password/sign-up, /session/revoke, DELETE /user, ...) buffers the entire request body into memory before schema decoding, so a single connection sending a multi-gigabyte body per request is a trivial memory-exhaustion DoS against the auth server, and a 413 response is not reachable at all in the shipped wiring.

## Evidence

Source: `node_modules/.pnpm/effect@4.0.0-rc.116/node_modules/effect/dist/unstable/http/HttpIncomingMessage.js:57`

```
export const MaxBodySize = /*#__PURE__*/Context.Reference("effect/http/HttpIncomingMessage/MaxBodySize", {
  defaultValue: () => undefined
});
```

## Recommended fix

Set MaxBodySize (a few hundred KB is generous for these payloads) in @awthaq/server's composition surface — e.g. a small middleware or documented Layer that applies the reference to all served routes — so the limit exists by default instead of depending on each application remembering it.

## Context

- Auditor verdict on this domain: **needs-work** (score 66/100), domain: HTTP server integration
- Full dossier: [`node-http-server-integration-specialist`](../../.reports/node-http-server-integration-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `server-request-limits`. Evidence at HEAD ec065a7: `../effect/packages/effect/src/unstable/http/HttpIncomingMessage.ts:133`. Fix: Ship a default request-body cap in @awthaq/server: a global HttpRouter middleware layer that provides `HttpIncomingMessage.MaxBodySize` (configurable, default ~256 KiB) and maps the resulting parse failure to a typed 413, and wire it into the canonical composition. (effort M). Full dossier: `.plan/slices/13-repo-features-tooling.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** New packages/server/src/BodyLimit.ts (exported from index): BodyLimitConfig Context.Reference (default 256 KiB) + config(); layer = global HttpRouter middleware that provides HttpIncomingMessage.MaxBodySize (Node body reader cuts off chunked oversize bodies; Effect destroys the socket so the client sees a dropped connection, not a 413) and answers 413 {_tag:'PayloadTooLarge'} before the handler when declared content-length exceeds the cap (this is the bound on toWebHandler, where the runtime does not read MaxBodySize). Wired into README quickstart and examples/memory-server. Tests packages/server/test/BodyLimit.test.ts (6: real Node server 413/no handler, normal, chunked cut-off, configurable; toWebHandler 413/normal; red first: module absent). Spec: BEH-EA-085 addendum (no new BEH id, avoids traceability renumbering) + traceability row. Decisions/deviations: 413 body is a middleware-level response, not a typed error in @awthaq/api (the dossier's alternative), since a typed error would have to join every endpoint's error union; chunked oversize on web path is left to host limits (documented). Header-size limits are Node server options (maxHeaderSize), not touched. Gates: typecheck (pre-existing react TS2883 only), test 849, bdd 104, spec:verify 19/19.
