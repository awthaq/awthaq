---
ID: "CSD-003"
Title: "Sessions never capture IP/userAgent at issuance — forensics and device-aware detection have no data"
Level: medium
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:559"
Auditor: "credential-stuffing-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSD-003 — Sessions never capture IP/userAgent at issuance — forensics and device-aware detection have no data

`MEDIUM` · `security` · `password` · reported by **Credential Stuffing Defense Specialist** (`credential-stuffing-defense-specialist`)

Status: **resolved**

## Summary

The Sessions port is ready for request context — `issue` accepts `request?: { ip?: string; userAgent?: string }` (core Sessions.ts:139) and persists both (Sessions.ts:253-254), and SessionDto exposes userAgent — but every production call site omits it: password signIn (this line and signUp line 494), OAuth (OAuth.ts:729), and passkey (Passkey.ts:599) all issue with `{ userId }` alone, so ipAddress/userAgent are always null. Downstream stuffing response — 'list the victim's sessions and revoke unfamiliar devices' — and any future IP-velocity or impossible-travel signal have nothing to work with, and the admin session list renders null user agents.

## Evidence

Source: `packages/password/src/Password.ts:559`

```
const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
```

## Recommended fix

Thread HttpServerRequest.remoteAddress and the user-agent header into sessions.issue at the HTTP handler layer (or via a request-context capability) for every session-issuing plugin, matching the flow-state capture OAuth already performs at OAuth.ts:332.

## Context

- Auditor verdict on this domain: **needs-work** (score 55/100), domain: credential stuffing defense
- Full dossier: [`credential-stuffing-defense-specialist`](../../.reports/credential-stuffing-defense-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 16 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`ARF-001` — confirmReset violates the spec's single-transaction invariant: consume, password change, and revocation commit independently](high/ARF-001-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, high)_`
- [`ARF-002` — WeakPassword is checked after the reset token is consumed — a policy mistake burns the single-use token](medium/ARF-002-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-003` — requestReset/resendVerification send mail inline, leaking account existence through response latency](medium/ARF-003-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-004` — requestReset issues tokens for accounts with no password credential; confirmReset then dies with a 500](medium/ARF-004-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, medium)_`
- [`ARF-007` — confirmReset slices the token identifier without validating its prefix, turning a valid verify-email token into a 500](low/ARF-007-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-008` — Reset works for unverified accounts (good) but completing a reset neither confers nor requires verification, leaving the account still locked](low/ARF-008-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-009` — Mailed reset token embeds the internal userId, leaking a UUIDv7 (creation timestamp) inside a recovery artifact](low/ARF-009-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- [`ARF-010` — Reset-request rate limit is keyed solely on the attacker-chosen email — unlimited spray across addresses](low/ARF-010-account-recovery-flow-specialist.md) `_(account-recovery-flow-specialist, low)_`
- … 41 more findings touch `packages/password/src/Password.ts`

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** CONFIRMED (confidence high); workstream `session-issuance-context`. Evidence at HEAD ec065a7: `packages/password/src/Password.ts:866`. Fix: Thread {ip, userAgent} from every session-minting handler into sessions.issue. (effort M). Full dossier: `.plan/slices/07-password-mfa.md`. Status → ready-for-agent.

**Resolved (2026-09-29):** Every production session-minting path now passes {ip, userAgent} to Sessions.issue: password signUp/signIn/changePassword (PasswordShape inputs gain userAgent, changePassword also ip; handlers read the User-Agent header and the ClientAddress-resolved ip), OAuth callback (OAuthShape.callback input gains userAgent; issue gets callback ip+UA), passkey authenticateVerify (new optional context arg; the handler now needs ClientAddress like Password/OAuth, so Passkey.layer requires it: passkey tests and features/PasskeyWorld provide ClientAddress.layerDirect). Sessions.issue caps the persisted userAgent at MAX_USER_AGENT_LENGTH=512 in both layers. Tests: password/test/Password.test.ts (domain: ip+UA recorded for signUp, signIn, changePassword), password/test/AuthHttp.test.ts (wire: sign-up records User-Agent, capped at 512), oauth/test/OAuth.test.ts, passkey/test/Passkey.test.ts. Spec: BEH-EA-054 paragraph. Touches password/oauth/passkey sources and their test compositions outside my packages (conflict hint). Not covered: the passkey registration/sign-up path (no session is minted there) and admin impersonation (issues its own actingAs session).
