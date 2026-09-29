---
ID: "CTA-004"
Title: "Credential storage is an open question — no keychain integration, no fallback decision, no prohibition"
Level: medium
Category: "security"
Status: resolved
Package: "—"
Source: "spec/behaviors/09-authentication-middleware.md:55"
Auditor: "cli-tool-auth-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CTA-004 — Credential storage is an open question — no keychain integration, no fallback decision, no prohibition

`MEDIUM` · `security` · `—` · reported by **CLI Tool Auth Specialist** (`cli-tool-auth-specialist`)

Status: **resolved**

## Summary

No code under packages/ references keychain, keytar, libsecret, Credential Manager, or any encrypted-file store (repo-wide grep). Storage appears exactly twice, both as prose intention: here and in spec/behaviors/22-client-effect.md:137-141 ('attaching a token from a keychain' via transformClient). No decision record covers what happens on headless Linux or in containers, where no OS keychain exists — the exact environments a CLI targets. Nothing prevents the red-flag outcome of a raw long-lived bearer token in a world-readable dotfile once login lands.

## Evidence

Source: `spec/behaviors/09-authentication-middleware.md:55`

```
`archive/design/usage-examples-v4.md` §11.3 documents the native-client path this handler serves: a mobile or CLI client with no cookie jar reaches the same contract via `Auth.api(..., { csrf: false })` and a bearer token pulled from a keychain
```

## Recommended fix

Record a storage decision now, before implementation pressure exists: OS keychain via a thin native binding where available; an encrypted fallback file (0600, user-owned directory, machine-derived key at minimum) for headless environments; an explicit prohibition on plaintext token dotfiles; and document which choice applies to CI, where ephemeral filesystems argue for env-var-only credentials.

## Context

- Auditor verdict on this domain: **critical-gaps** (score 32/100), domain: CLI Authentication
- Full dossier: [`cli-tool-auth-specialist`](../../.reports/cli-tool-auth-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 19 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`MNA-009` — Docs promise a native bearer path the code does not finish](info/MNA-009-mobile-native-auth-specialist.md) `_(mobile-native-auth-specialist, info)_`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `cli-session-login-carveout`. Evidence at HEAD ec065a7: `spec/behaviors/09-authentication-middleware.md:55`. Fix: Record ticket 06's CredentialStore decision normatively (new behavior next to the session-command BEH) so the login implementation cannot default to a plaintext dotfile. (effort S). Full dossier: `.plan/slices/12-spec.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** BEH-EA-228 (CredentialStore: OS keychain first, 0600 file in a 0700 dir only as a warned fallback, AWTHAQ_TOKEN always wins and is never written, Redacted in memory) + cross-reference from 09-authentication-middleware.md. Implemented in packages/cli/src/CredentialStore.ts (macOS `security -i` / Linux `secret-tool` over an Exec port so the secret never rides argv), proven by packages/cli/test/CredentialStore.test.ts (fake security/secret-tool, real temp dir: mode 0600/0700 read off disk, single warning, env override never writes). Deferred: a Windows Credential Manager backend (Windows uses the warned file fallback; recorded in ADR-EA-027 and BEH-EA-228).
