---
ID: "CSD-001"
Title: "Breach check never inspects the HTTP response status; fail-closed config is bypassed on 429/5xx"
Level: high
Category: "security"
Status: resolved
Package: "password"
Source: "packages/password/src/Password.ts:216"
Auditor: "credential-stuffing-defense-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# CSD-001 — Breach check never inspects the HTTP response status; fail-closed config is bypassed on 429/5xx

`HIGH` · `security` · `password` · reported by **Credential Stuffing Defense Specialist** (`credential-stuffing-defense-specialist`)

Status: **resolved**

## Summary

Effect's HttpClient resolves successfully for any status (the oauth plugin's own exchangeCode relies on this, checking body fields of possibly-erroring responses at OAuth.ts:211-217), so only a network/transport failure reaches the `Effect.catch` on line 218. A 429 or 503 from api.pwnedpasswords.com — the most common failure mode at deployment scale, since HIBP aggressively throttles — resolves normally, and its error body simply fails the suffix match, so `isBreached` returns false ('not breached'). The documented strict posture `breachCheck: { onUnavailable: "reject" }` therefore silently degrades to fail-open exactly when the breach API is struggling, i.e. often during large-scale automated traffic. The `onUnavailable` knob only governs transport errors, not HTTP-level errors.

## Evidence

Source: `packages/password/src/Password.ts:216`

```
const body = yield* response.text;
    return body.split("\n").some((line) => line.split(":")[0]?.trim().toUpperCase() === suffix);
  }).pipe(Effect.catch(() => Effect.succeed(onUnavailable === "reject")));
```

## Recommended fix

Check `response.status` inside the gen block and fail the effect (or route to the onUnavailable branch) for any non-200, e.g. pipe the request through a status filter so a 429/5xx lands in the same 'unavailable' path as a timeout; add a regression scenario pairing a 5xx response with `onUnavailable: "reject"` asserting sign-up is rejected.

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

**Validation (2026-09-19):** CONFIRMED — `packages/password/src/Password.ts:201-218`'s `isBreached` calls `httpClient.get` and reads `response.text` with no `response.status` check anywhere in the function; only the `Effect.catch` at line 218 (transport/parse failures) routes to `onUnavailable`. `packages/oauth/src/OAuth.ts:211` similarly reads `response.json` without a status check elsewhere in that file, corroborating that this codebase's `HttpClient` usage does not auto-reject on non-2xx. A 429/5xx body would simply fail the suffix match and resolve `isBreached` to `false`. Fix is a small, mechanical status check. Status → ready-for-agent.

**Resolved (2026-09-19):** Piped the HIBP response through `HttpClientResponse.filterStatusOk` (an existing `effect`/`unstable/http` primitive: succeeds only for a 2xx status, otherwise fails with `HttpClientError`) before reading `response.text` — any non-2xx now lands in the exact same catch-all `Effect.catch(() => Effect.succeed(onUnavailable === "reject"))` a transport error already routed through, rather than falling through to a body read that silently resolves "not breached."

TDD: added `httpClientReturningStatus` to `packages/password/test/Password.test.ts` and two new tests mirroring the file's existing `UnavailableHttpClient` pair exactly, substituting a 429/503 HTTP response for a transport failure — "a 429 from the breach check fails open by default" and "a 503 from the breach check fails closed when configured." Verified to genuinely fail: reverting the fix left the fail-closed (503) test green-turned-red — `signUp` silently succeeded instead of being rejected, exactly the bug this finding describes; the fail-open (429) test can't distinguish the bug from correct behavior by design (both resolve to "allow"), which is why the fail-closed case is the one that actually proves this. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (661 passed, 7 skipped).
