---
ID: "PV-016"
Title: "Session cookie is SameSite=Strict but set on a redirect chain the provider started cross-site — first landing request after OAuth sign-in may look signed out"
Level: low
Category: "security"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-016 — Session cookie is SameSite=Strict but set on a redirect chain the provider started cross-site — first landing request after OAuth sign-in may look signed out

`LOW` · `security` · `oauth` · found during the 2026-09-29 plan validation (not in the original audit)

Status: **resolved**

## Summary

Session cookie is SameSite=Strict but set on a redirect chain the provider started cross-site — first landing request after OAuth sign-in may look signed out. Discovered by a slice validator while checking the audit's evidence against HEAD `ec065a7`; see `.plan/README.md` §4 (defect N16).

## Evidence

Source: `packages/oauth/src/OAuth.ts` — full write-up in the host issue's dossier under `.plan/slices/`.

## Recommended fix

Planned under: P02 / IC-007 cookie decision.

## Comments

_Triage notes and discussion append here._

**Plan note (2026-09-29):** investigated under P02 (recorded in BEH-EA-122 and packages/oauth/README.md, not fixed). The IC-007 `SessionCookieConfig` now offers the `Lax`-capable modes; switching the OAuth callback's session cookie to a Lax mode or a same-site bounce page remains a product choice. Left open.

**Resolved (2026-09-29):** Implemented the least-surprising opt-in, default unchanged: SessionCookie.HostLax (packages/core/src/SessionCookie.ts), a typed SessionCookieConfig mode rendering __Host-session with SameSite=Lax, no Domain, no Partitioned; expire uses the same attributes; the CSRF double-submit cookie stays Strict. Every issuance site already renders through SessionCookie, so the OAuth callback picks it up with SessionCookie.config({ mode: SessionCookie.HostLax }). config audit flags it as cookie-samesite-relaxed like the other relaxed modes. Red first: packages/core/test/SessionCookie.test.ts, EffectiveConfig.test.ts and packages/oauth/test/AuthHttp.test.ts (callback under HostLax sets a __Host- SameSite=Lax session cookie). Docs: spec BEH-EA-055 list (07-sessions.md), BEH-EA-122 known-limitation paragraph (16-oauth.md), packages/oauth/README.md. Not built: the interstitial same-site bounce page (needs a change to the callback's declared success type; belongs with the native return leg, ticket 17). @awthaq/next still renders under the default config only (already documented). Gates: typecheck, core/oauth/server/next suites (930), spec:verify:strict, check:readmes.
