---
ID: "BE-002"
Title: "OAuth token sets are discarded; the account model cannot carry provider tokens"
Level: high
Category: "api"
Status: resolved
Package: "oauth"
Source: "packages/oauth/src/OAuth.ts:188"
Auditor: "bereket-engida"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# BE-002 — OAuth token sets are discarded; the account model cannot carry provider tokens

`HIGH` · `api` · `oauth` · reported by **Bereket Engida — Creator of better-auth** (`bereket-engida`)

Status: **resolved**

## Summary

The exchanged TokenSet is used transiently (userinfo fetch, id-token verification) and then dropped. AccountRecord (packages/core/src/Accounts.ts:33-50) holds providerId/subject/issuer only — no accessToken, refreshToken, or expiry columns, unlike better-auth's account table which persists tokens and their lifetimes. OAuth can therefore only ever be sign-in; 'sign in with Google and then call Google's API on the user's behalf', offline refresh, and scope tracking are all impossible. This is the single largest domain-model parity gap.

## Evidence

Source: `packages/oauth/src/OAuth.ts:188`

```
  readonly accessToken: string;
  readonly idToken: string | undefined;
```

## Recommended fix

Persist tokens either as nullable account-model columns or as a plugin-owned, id-namespaced `oauth_token` table consistent with the plugin-table convention, and expose a token-refresh port so downstream apps never handle raw provider credentials.

## Context

- Auditor verdict on this domain: **needs-work** (score 63/100), domain: plugin architecture parity
- Full dossier: [`bereket-engida`](../../.reports/bereket-engida/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 31 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`AP-001` — Scheme-relative //host callbackURL bypasses the trusted-origin allowlist (open redirect)](high/AP-001-aaron-parecki.md) `_(aaron-parecki, high)_`
- [`AP-003` — id_token aud accepted only as an exact string; array-form audiences rejected](medium/AP-003-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-004` — Userinfo claims merged over id_token claims without the required sub equality check](medium/AP-004-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-006` — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored](medium/AP-006-aaron-parecki.md) `_(aaron-parecki, medium)_`
- [`AP-008` — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires](low/AP-008-aaron-parecki.md) `_(aaron-parecki, low)_`
- [`AH-002` — JWKS response cast wholesale with as unknown as and cached unvalidated](medium/AH-002-anders-hejlsberg.md) `_(anders-hejlsberg, medium)_`
- [`AGA-001` — OAuth callback rate limiting collapses to one global 20/min bucket behind any gateway or load balancer](high/AGA-001-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, high)_`
- [`AGA-005` — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL](low/AGA-005-api-gateway-auth-specialist.md) `_(api-gateway-auth-specialist, low)_`
- … 65 more findings touch `packages/oauth/src/OAuth.ts`

## Comments

_Triage notes and discussion append here._

**Decision (2026-09-19):** Resolved via [OAuth linked-account provider-token storage](../../.scratch/resolve-ready-for-human-findings/issues/31-oauth-linked-account-token-storage.md) — persistence/encryption for `accessToken`/`refreshToken` already exists at the SQL layer (unused); the fix wires `@awthaq/core`'s `Accounts` service to expose them via a `findCredentialHash`-style side channel, adds `accessTokenExpiresAt`/`refreshTokenExpiresAt`/`scope`/`tokenType` columns, has `@awthaq/oauth` persist tokens on both link and re-auth, and adds an `OAuthTokenAccess.withAccessToken` refresh port so raw tokens never leave a scoped callback. Status → ready-for-agent.

**Validation (2026-09-19):** CONFIRMED — `packages/oauth/src/OAuth.ts`'s `TokenSet` interface (lines 187-190) carries only `accessToken`/`idToken`, consumed transiently by `exchangeCode`/userinfo/id-token verification and never persisted; `packages/core/src/Accounts.ts`'s `AccountRecord` (lines 33-49) has only `id`/`userId`/`providerId`/`subject`/`issuer`/timestamps, no token columns. The recommended fix itself poses a genuine either/or architecture decision (nullable account columns vs. a separate plugin-owned `oauth_token` table, plus a token-refresh port design) with no existing precedent in the codebase to mechanically follow. Status → ready-for-human.

**Resolved (2026-09-20):** Implemented the full design from [OAuth linked-account provider-token storage](../../.scratch/resolve-ready-for-human-findings/issues/31-oauth-linked-account-token-storage.md) — all four pieces, exactly as decided:

- `packages/sql/src/Models.ts`'s `Account` model gains `accessTokenExpiresAt`/`refreshTokenExpiresAt`/`scope`/`tokenType` — nullable, constructor-defaulted to `null` (so every pre-existing insert/update call site, including `packages/sql/test/Repositories*.test.ts`'s own fixtures, kept compiling unchanged), included in both `insert` and `update` like `accessToken`/`refreshToken` already are. `packages/sql/src/CoreMigrations.ts` migration 17 adds all four columns, dialect-branched. `accessToken`/`refreshToken` themselves already had real, working AES-256-GCM encryption-at-rest (`AccountsRepositoryLive`) — untouched, since the new columns are metadata, not secrets, and pass through its existing spread-based `decryptRow` for free.
- `packages/core/src/Accounts.ts`: new `ProviderTokenSet` type; `AccountsShape.link` gains an optional `tokens?` input; new `findProviderTokens`/`updateProviderTokens` (mirroring `findCredentialHash`/`updateCredentialHash` exactly, in both `layerMemory` and `layerSql`); new `findById` (a small addition beyond the decision's own itemized list, needed so `OAuthTokenAccess` can recover an account's `providerId` from an `AccountId` alone — no existing method supported that lookup direction). `updateCredentialHash`'s own `layerSql` write extended to pass the 4 new token-metadata fields through unchanged (mirroring its existing `accessToken`/`refreshToken` passthrough), and `updateProviderTokens` passes `passwordHash` through in the same way — both directions verified by mutation (see below), since `Account.update` writes the full update-eligible column set, not a sparse patch.
- `packages/oauth/src/OAuth.ts`: `exchangeCode`'s parsed body and `TokenSet` gain `refresh_token`/`expires_in`/`scope`/`token_type`; new `toProviderTokenSet` helper. All three `accounts.link(...)` call sites (explicit link, trusted-email auto-link, brand-new sign-up) now pass `tokens: toProviderTokenSet(tokens, exchangedAt)`. The previously-silent re-authentication branch (`accountIfLinked`'s `onSome` — renamed from `userIdIfLinked`, which discarded the account down to just its `userId`) now calls `accounts.updateProviderTokens(account.id, ...)` on every successful sign-in against an already-linked account — the concrete "silently discarded on re-auth" bug this finding's own Summary named. `refreshTokenExpiresAt` is deliberately never populated from this module's own conversion (no standard OAuth2 field carries a refresh-token TTL) — the column exists for a provider-specific future, not guessed at today.
- New `packages/oauth/src/OAuthTokenAccess.ts`: `OAuthTokenAccess.withAccessToken(accountId, use)` — reads the stored token set, refreshes it first (a real `grant_type=refresh_token` exchange against the account's own resolved provider, reusing `exchangeCode`'s HTTP-call shape) when the access token is expired or within a 30s skew window and a refresh token is on record, persists the refreshed set via `updateProviderTokens`, then hands the (possibly-refreshed) raw token only into the scoped `use` callback — never returning it. Fails `OAuthTokenUnavailable` (no account/no stored tokens/expired-with-no-refresh-token) or `OAuthRefreshFailed` (the provider's own refresh call failed or returned no `access_token`). Handles RFC 6749 §6 correctly: a refresh response omitting `refresh_token` keeps the previously-stored one rather than treating the omission as "no longer refreshable." Exported from `packages/oauth/src/index.ts`; `OAuth.ts`'s own module header (which explicitly named "no token refresh operation" as a known gap) and the package barrel comment both updated.

TDD/mutation-verified throughout, not just asserted: `packages/core/test/Accounts.test.ts` gained 6 new dual-layer cases (12 tests) plus a `findById` case (2 tests) — mutation-confirmed the `updateCredentialHash`/`updateProviderTokens` cross-field passthrough is real by temporarily dropping each direction's passthrough in `packages/core/src/Accounts.ts` (both broke the corresponding new "leaves ... untouched" test with the right failure, reverted); also converted `Accounts.test.ts`'s own `layerSql` suite from a hand-rolled `CREATE TABLE accounts` fixture to `@awthaq/sql`'s real `CoreMigrations.coreMigrations` (the same BAM-002/BE-001 conversion), since a hand-rolled fixture has no way to pick up the new migration — this is exactly how the missing columns were first caught, as a genuine `SQLITE_ERROR: no such column` failure before the fixture was converted. `packages/oauth/test/OAuth.test.ts` gained 6 new cases covering new-sign-up, no-token-fields, re-authentication overwrite, explicit link, and trusted-email auto-link, all against a real fake `HttpClient` token endpoint (mirroring the file's own existing pattern) — mutation-confirmed by temporarily removing the re-auth branch's `updateProviderTokens` call and the new-sign-up `link` call's `tokens` field (each broke exactly the tests that depend on it, reverted). New `packages/oauth/test/OAuthTokenAccess.test.ts` (7 tests) covers a live token skipping refresh entirely, a within-skew-window token triggering a real refresh call whose result gets persisted, RFC 6749 §6's "keep the old refresh token" behavior, no-refresh-token/no-stored-tokens/unknown-account all failing `OAuthTokenUnavailable`, and a malformed refresh response failing `OAuthRefreshFailed` while leaving the stored tokens untouched — mutation-confirmed the skew-window expiry check and the RFC 6749 §6 refresh-token-passthrough logic are both real by temporarily breaking each in `packages/oauth/src/OAuthTokenAccess.ts` (4 and 1 tests failed respectively, correct reasons, reverted).

Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (770 passed, up from 744 at the start of this fix); `pnpm run test:bdd` unaffected (same 2 pre-existing, unrelated `15-password.steps.test.ts` failures — no `features/` file touched). `npx oxfmt` run on all 9 touched/new files; re-verified typecheck and the full test suite green after formatting.

Deliberately left open, named explicitly in this resolution rather than silently assumed: wiring a real production bootstrap caller for `@awthaq/core`'s own `Migrations.run` remains BE-001's own documented gap, unrelated to this finding; `OAuthTokenAccess` itself has no consumer yet in this codebase (no plugin or example server calls `withAccessToken`) — it is, like `LegacySessionBridge` (BAM-003), a capability a composition opts into providing when it needs to call a provider's API on a user's behalf, not a flow this fix wires into any existing HTTP handler.
