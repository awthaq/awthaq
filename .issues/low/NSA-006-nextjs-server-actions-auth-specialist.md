---
ID: "NSA-006"
Title: "parseSetCookie percent-decodes values browsers would store verbatim, and NaN/Invalid Date options can reach the jar"
Level: low
Category: "correctness"
Status: resolved
Package: "next"
Source: "packages/next/src/WithNextCookies.ts:70"
Auditor: "nextjs-server-actions-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# NSA-006 — parseSetCookie percent-decodes values browsers would store verbatim, and NaN/Invalid Date options can reach the jar

`LOW` · `correctness` · `next` · reported by **Next.js Server Actions Auth Specialist** (`nextjs-server-actions-auth-specialist`)

Status: **resolved**

## Summary

Browsers store and re-send cookie values verbatim without percent-decoding, so decoding a Set-Cookie value here and writing the decoded string into Next's jar diverges from what the wire would have produced for any value containing a %-sequence. Harmless for today's tokens (session `id.secret` and the CSRF `token.hmac` are hex-plus-dot), but a latent round-trip asymmetry for any future cookie. Adjacent: Max-Age is converted with Number(raw) (line 83) and Expires with new Date(raw) (line 89) with no validity check, so NaN maxAge or an Invalid Date expires can be handed to jar.set.

## Evidence

Source: `packages/next/src/WithNextCookies.ts:70`

```
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
```

## Recommended fix

Write the raw value verbatim (or document the decode as load-bearing), and guard options translation: skip maxAge when Number.isNaN and expires when isNaN(date.getTime()).

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: Next.js integration
- Full dossier: [`nextjs-server-actions-auth-specialist`](../../.reports/nextjs-server-actions-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 22 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BO-004` — Framework-neutral adapter code lives in a Next-named package, stranding Astro/SvelteKit reuse](medium/BO-004-balazs-orban.md) `_(balazs-orban, medium)_`
- [`BO-010` — CookieJarLike does not structurally satisfy SvelteKit's Cookies.set (path required) — second-adapter fit untested](info/BO-010-balazs-orban.md) `_(balazs-orban, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `next-getsession-hardening`. Evidence at HEAD ec065a7: `packages/next/src/WithNextCookies.ts:69`. Fix: Pass the Set-Cookie value through verbatim and drop invalid numeric/date attributes. (effort S). Full dossier: `.plan/slices/11-frontend-next-react-client.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** WithNextCookies.parseSetCookie drops non-numeric/empty Max-Age and unparseable Expires; value decode kept and documented as the exact inverse of Next's encodeURIComponent write (verified against @edge-runtime/cookies semantics; next is not installed here so it is asserted via a re-encoding round-trip test). Tests added in WithNextCookies.test.ts.
