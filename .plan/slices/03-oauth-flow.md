# Slice 03 — oauth-flow: validation & fix plan

- **Slice:** `03-oauth-flow` (manifest `.plan/_manifests/03-oauth-flow.tsv`, 66 issues)
- **Validated at:** `ec065a7` on 2026-09-29
- **Scope:** `packages/oauth/src/{OAuth,OAuthApi,Jwt,OAuthProvider,OAuthTokenAccess}.ts` + tests

## Counts (verdict × level)

| verdict | critical | high | medium | low | info | total |
|---|---|---|---|---|---|---|
| CONFIRMED | 0 | 6 | 12 | 6 | 1 | 25 |
| PARTIAL | 0 | 0 | 7 | 2 | 0 | 9 |
| ALREADY-FIXED | 0 | 0 | 8 | 3 | 0 | 11 |
| INVALID | 0 | 0 | 0 | 0 | 0 | 0 |
| DUPLICATE | 0 | 1 | 9 | 8 | 1 | 19 |
| WONTFIX-CANDIDATE | 0 | 0 | 0 | 1 | 1 | 2 |
| **total** | 0 | 7 | 36 | 20 | 3 | 66 |

## Summary

Much of the audit's OAuth surface was closed by commits after it: the open redirect (9b3e42c), the JWKS schema decode (e364411), JWKS kid-miss refetch plus TTL (fd8e5e9), header/payload schema (e3059f2), trusted-proxy client IP (a3b7255), `__Host-` cookie path (8c40afe) and provider-token persistence plus refresh (e773cf1). Those commits retire 11 findings outright and most of the 19 duplicates' JWKS halves. What is really still wrong clusters in five places. (1) **OIDC claim integrity** in `verifyIdToken`/`callback`: userinfo overrides the signed id_token with no `sub` check (OIT-001, high); aud is strict-string and azp is never read (OIT-003 plus 6 dups); there is no clock leeway and no iat/nbf; ambient `Date.now()` is used three times; the nonce is optional in the verifier; and every failure reason is erased. (2) **Provider-response casts** are still present for the token endpoint (now duplicated into `OAuthTokenAccess.ts`) and userinfo. The discovery cast is slice 04's ESS-002. (3) **Outbound resilience**: no timeout, no retry, no 503 channel, and a boot-time die on unreachable discovery. (4) **Linking trust**: auto-link ignores the local account's `emailVerified` (pre-account-takeover), JIT users never inherit trusted-IdP verification, and `AccountExists` hardcodes `"password"`. (5) **Callback HTTP hygiene**: non-constant-time state compare, a state cookie that is never expired, no Referrer-Policy, an unthrottled authorize endpoint, and RFC 6749 error redirects that die as schema-decode errors. The three high architecture items (native return leg, per-org connections, client_credentials) already have recorded decisions and are planned per those tickets.

## Workstreams

### 1. `oauth-provider-response-decoding` — Schema-decode every provider response in packages/oauth

- **IDs:** ESS-003, ACS-004, JJS-005, OAP-004, OIT-005, JR-010, AP-008, MA-006, AH-002, KRS-005, VB-004, AOMS-010, OAP-007
- **Why grouped:** All of these are 'provider JSON crosses the trust boundary by assertion'. The JWKS cast and TTL halves were already fixed (e364411, fd8e5e9). What remains is the token-endpoint body (OAuth.ts:250, copied into OAuthTokenAccess.ts:93), the userinfo body (OAuth.ts:712) and structural RSA-JWK selection (Jwt.ts:152). The discovery cast is ESS-002 in slice 04 and should land in the same PR.
- **Effort:** S · **Depends on workstreams:** —
- **Ordered steps:**
  1. Add packages/oauth/src/ProviderResponses.ts with TokenResponseSchema and UserinfoSchema (ESS-003).
  2. Switch exchangeCode, OAuthTokenAccess.refresh and userinfo to HttpIncomingMessage.schemaBodyJson, deleting three casts.
  3. Tighten Jwt.findKey with RsaJwkSchema and drop kty-less entries (ACS-004).
  4. Coordinate with slice 04: land ESS-002's DiscoveryDocumentSchema together, since AP-006 needs its token_endpoint_auth_methods_supported field.
- **Test plan:** Red-first tests: a numeric id_token, a string expires_in, an array userinfo body, a kty-less JWK, and a non-string refresh access_token. Each must fail typed, never die.
- **Acceptance:** No `as` on provider-response data remains in packages/oauth/src (the MNA-003 flow payload is covered by OIT-006).

### 2. `oauth-oidc-claims-integrity` — OIDC id_token and userinfo claim validation

- **IDs:** OIT-001, AP-004, APS-008, OIT-003, AOMS-004, AP-003, JJS-006, JR-008, OAP-006, VB-006, MA-002, OIT-004, OIT-006, OIT-008, OIT-007, OIT-009, SFS-005
- **Why grouped:** Every item edits verifyIdToken or the id_token/userinfo merge in callback: sub cross-check and identity-claim precedence, aud/azp, Clock-based exp with leeway and iat/nbf, mandatory nonce, reason-tagged failures, and the docs and tests for what stays unvalidated.
- **Effort:** M · **Depends on workstreams:** oauth-provider-response-decoding
- **Ordered steps:**
  1. MA-002: read the Clock once per verification and replace all three Date.now() calls.
  2. OIT-008: introduce CallbackFailureReason and the `callbackFailed(reason)` helper first, so every later check tags its reason.
  3. OIT-004: add clockSkew and maxIdTokenAge config, plus exp/nbf/iat checks.
  4. OIT-003: add audienceAccepted (string or array aud, azp rules).
  5. OIT-006: replace isFlowPayload with FlowPayloadSchema (no casts) and make the nonce mandatory for oidc.
  6. OIT-001: add the userinfo sub cross-check and let the id_token win sub/email/email_verified (closes AP-004 and APS-008).
  7. OIT-009: add the alg HS256/none pins.
  8. OIT-007: document the at_hash, auth_time and max_age deferral.
- **Test plan:** All in packages/oauth/test/OAuth.test.ts's 'OIDC id_token' block. Give oktaDiscovery a userinfo variant. Drive time with TestClock. About 14 new red-first cases (listed per issue).
- **Acceptance:** An id_token is accepted only with: a valid RS256 signature from a typed RSA JWK, exact iss, aud/azp per OIDC Core 3.1.3.7, exp/nbf/iat within skew by the Effect Clock, and a present, matching nonce. userinfo is used only when its sub matches.

### 3. `oauth-outbound-resilience` — Deadlines, retries and a 503 channel for provider calls

- **IDs:** ECF-001, ERS-003, EEM-004, NAM-004
- **Why grouped:** All four are the same missing policy layer around outbound HTTP. Timeouts produce a new failure class that EEM-004 must type, retries must fit inside the timeout budget, and NAM-004's boot behavior depends on both.
- **Effort:** M · **Depends on workstreams:** oauth-provider-response-decoding
- **Ordered steps:**
  1. EEM-004: add ProviderUnavailable (503) and a transport/protocol failure classifier.
  2. ECF-001: add httpTimeouts config and wrap every call (exchange, JWKS, userinfo, refresh, discovery) in Effect.timeout, with TimeoutError mapped to ProviderUnavailable.
  3. ERS-003: use an HttpClient.retryTransient client for idempotent GETs only. The code exchange is never retried.
  4. NAM-004: extract a shared OAuthProviders registry (removing the duplicate boot resolution in OAuthTokenAccess), plus the chosen discovery mode.
- **Test plan:** Fake HttpClient routes returning Effect.never, a 503-then-200 sequence, and 400 invalid_grant, all driven with TestClock. Assert call counts for retry/no-retry.
- **Acceptance:** No provider call outlives its deadline. Transient GET failures are absorbed. Provider outages answer 503, not 400.

### 4. `oauth-token-endpoint-client-auth` — client_secret_basic support and discovery-driven auth method

- **IDs:** AP-006
- **Why grouped:** A standalone interop fix touching the exchange and refresh paths. It needs the schema-decoded discovery document (ESS-002, slice 04).
- **Effort:** M · **Depends on workstreams:** oauth-provider-response-decoding
- **Ordered steps:**
  1. Add tokenEndpointAuthMethod to the config and to ResolvedProvider.
  2. Read token_endpoint_auth_methods_supported and validate it at boot.
  3. Share authenticateTokenRequest between exchangeCode and OAuthTokenAccess.refresh.
- **Test plan:** A fake client records headers: basic has an Authorization header and no secret in the body; post has no header; a mismatch dies at boot.
- **Acceptance:** Basic-only IdPs work, and misconfiguration fails at boot.

### 5. `oauth-callback-error-contract` — RFC 6749 §4.1.2.1 error responses at the callback

- **IDs:** AP-005, JR-003, OAP-003
- **Why grouped:** Three reports of the same CallbackQuery schema gap.
- **Effort:** S · **Depends on workstreams:** oauth-oidc-claims-integrity
- **Ordered steps:**
  1. Decide option A, B or C (see Decisions).
  2. Make CallbackQuery's code optional and add error fields.
  3. Consume the flow on the error path after state/cookie validation, then fail typed.
- **Test plan:** AuthHttp tests for a denial with a valid state, a denial with a bad state, and replay after a denial. Plus a BDD scenario.
- **Acceptance:** A consent denial never yields a framework decode 400.

### 6. `oauth-callback-http-hardening` — Callback/authorize HTTP-level hardening

- **IDs:** TSS-003, CSS-006, PDR-004, OAP-008, CSS-004, RBS-008
- **Why grouped:** All are HTTP-surface properties of the two OAuth handlers: constant-time state compare, state-cookie expiry, Referrer-Policy, an authorize rate limit, and cookie-attribute wire tests. RBS-008 is already fixed and listed for completeness. CSS-006 and PDR-004 share one appendPreResponseHandler.
- **Effort:** M · **Depends on workstreams:** shared-constant-time-compare
- **Ordered steps:**
  1. TSS-003: consume the shared constantTimeEqual (cross-slice workstream) in callback.
  2. CSS-006 and PDR-004: register one pre-response handler in both handlers that expires __Host-oauth-state (callback) and sets Referrer-Policy: no-referrer (both).
  3. OAP-008: add an authorize rate-limit rule and wire ClientAddress into authorize.
  4. CSS-004: add @awthaq/test CookieAssertions and assert every OAuth Set-Cookie.
  5. PDR-004 (server half): add the opt-in SecurityHeaders.layer and a deployment checklist.
- **Test plan:** packages/oauth/test/AuthHttp.test.ts: getSetCookie() on the success and failure callbacks, a Referrer-Policy assertion, and the authorize throttle at 31 requests.
- **Acceptance:** Every OAuth response sends Referrer-Policy. The callback always expires the state cookie. authorize answers 429 under flood.

### 7. `oauth-account-linking-policy` — Account-linking trust decisions and AccountExists accuracy

- **IDs:** TMS-007, AOMS-007, NAM-006, EEM-007, NAM-005, FAMS-006, BAM-011
- **Why grouped:** All concern what the callback does when an email already exists or a new user is JIT-created. TMS-007 must land before AOMS-007: marking OAuth-created users verified is only safe once auto-link also requires a verified local account.
- **Effort:** S · **Depends on workstreams:** oauth-oidc-claims-integrity
- **Ordered steps:**
  1. TMS-007: require a verified local account for auto-link. Update the BEH-EA-124 spec and BDD.
  2. AOMS-007: trusted provider plus email_verified at JIT create leads to users.verifyEmail in the same transaction.
  3. NAM-006: AccountExists.providers per the decision.
  4. NAM-005 and FAMS-006: README migration and import recipes (with the oauth docs rewrite).
- **Test plan:** packages/oauth/test/OAuth.test.ts BEH-EA-123/124 block: an unverified local account is not auto-linked; trusted vs untrusted JIT verification; AccountExists lists real providers.
- **Acceptance:** No auto-link into an unproven local account. The stored emailVerified reflects trusted-IdP verification. AccountExists never asserts 'password' falsely.

### 8. `oauth-config-safety` — Required baseUrl and operational docs

- **IDs:** PDR-005, AGA-005
- **Why grouped:** Both are about baseUrl being defaulted silently and undocumented.
- **Effort:** S · **Depends on workstreams:** —
- **Ordered steps:**
  1. Convert OAuthConfig to a required-baseUrl Context.Service (JwtConfig precedent) and update all callers.
  2. Validate at boot and log redirect_uris.
  3. Rewrite packages/oauth/README.md (stale 'planned package' stub) with the deployment, linking-migration, import-recipe and OIDC-scope sections used by AGA-005, NAM-005, FAMS-006 and OIT-007.
- **Test plan:** A boot failure on a malformed baseUrl, a warning on plain-http non-localhost, and a type-level test that config({}) is rejected.
- **Acceptance:** OAuth cannot be composed without an explicit, well-formed baseUrl.

### 9. `provider-token-storage` — Remaining provider-token persistence gap (id_token)

- **IDs:** BAM-008, NAM-008, RRS-007
- **Why grouped:** BE-002 (e773cf1) closed refresh and expiry. Only the id_token column is left.
- **Effort:** M · **Depends on workstreams:** —
- **Ordered steps:**
  1. Add idToken to ProviderTokenSet, the Account model and a migration, encrypted at rest.
  2. Persist it from callback and preserve it on refresh.
- **Test plan:** Dual-layer Accounts tests plus an OAuth sign-up test plus a ciphertext-at-rest test.
- **Acceptance:** The id_token is persisted, encrypted, and survives refresh.

### 10. `native-session-bootstrap` — Native/mobile OAuth return leg (decision ticket 17)

- **IDs:** MNA-003, MNA-004
- **Why grouped:** The native return leg (exchange code plus token endpoint) and the deep-link callback allowlist are only useful together. Shares ticket 17 and the bearer-delivery DTO with MNA-001 (slice 07).
- **Effort:** L · **Depends on workstreams:** oauth-oidc-claims-integrity, oauth-callback-http-hardening
- **Ordered steps:**
  1. Carry the native flag in FlowPayloadSchema (after OIT-006).
  2. MNA-004: nativeRedirectURLs allowlist plus a fallback warning log.
  3. MNA-003: exchange code via Verification (purpose oauth.exchange, 60s, encrypted payload) and POST /oauth/token.
  4. Share the SessionTokenResponse DTO with MNA-001 (slice 07).
  5. Add the spec BEH and BDD scenario.
- **Test plan:** AuthHttp tests: native callback yields a code and no cookie; redeem once; second redemption fails; 60s expiry under TestClock; deep-link allowlist accept/fallback.
- **Acceptance:** A native app completes OAuth and obtains a bearer token with no token in any URL. Browser flows are unchanged.

### 11. `multi-tenant-oauth-connections` — Per-organization OAuth connections (decision ticket 18)

- **IDs:** EP-004, CWM-001
- **Why grouped:** One decision covers both. Cross-slice with EP-001 and DRS-001 (slice 05, tenant key) and packages/organization (slice 08).
- **Effort:** XL · **Depends on workstreams:** oauth-outbound-resilience
- **Ordered steps:**
  1. Add the organization_oauth_connection table and repository.
  2. Add the OrganizationConnections LayerMap service.
  3. Add the OAuthConfigShape.connections resolver hook, consulted after the static registry.
  4. Add home-realm discovery hints (organization, email domain).
  5. Update the spec.
- **Test plan:** Resolver cache tests. A full callback through an org connection. Static precedence. Secret encrypted at rest.
- **Acceptance:** A runtime-added org connection signs users in without a redeploy.

### 12. `m2m-client-credentials` — client_credentials in packages/api-key (decision ticket 10)

- **IDs:** OCM-001
- **Why grouped:** Owned by the api-key slice (09). Recorded here only because the audit anchored it to OAuth.ts. packages/oauth does not change.
- **Effort:** XL · **Depends on workstreams:** shared-constant-time-compare
- **Ordered steps:**
  1. Follow ticket 10: registerClient/revokeClient, POST /apiKey/token, a JWT mint, and a ServicePrincipal.
- **Test plan:** packages/api-key tests.
- **Acceptance:** RFC 6749 §4.4 is available to service callers.

### 13. `persistence-colocation-invariant` — Document the users/accounts transaction-domain invariant

- **IDs:** DRS-006
- **Why grouped:** A spec-only fix, linked to the residency findings in slice 05.
- **Effort:** S · **Depends on workstreams:** —
- **Ordered steps:**
  1. Add a new INV in spec/invariants.md, a BEH-EA-035 pointer, and a layerNoop doc note.
- **Test plan:** spec:verify:strict.
- **Acceptance:** The invariant exists and is cross-referenced.

### —. `oauth-callback-url-policy` — callbackURL open-redirect (closed)

- **IDs:** APS-002, TMS-003, PDR-006
- **Why grouped:** All closed by 9b3e42c. The remaining deep-link work lives in native-session-bootstrap.
- **Effort:** S · **Depends on workstreams:** —
- **Ordered steps:**
  1. None. Closed.
- **Test plan:** Existing tests at OAuth.test.ts:802/834.
- **Acceptance:** Already met.

### —. `api-path-param-conventions` — Path-parameter naming rule (cross-slice, AVS-006 canonical)

- **IDs:** AVS-010
- **Why grouped:** A duplicate of slice 10's AVS-006. No oauth change is needed under the proposed rule.
- **Effort:** S · **Depends on workstreams:** —
- **Ordered steps:**
  1. None in this slice.
- **Test plan:** n/a
- **Acceptance:** n/a

**External workstream referenced:** `shared-constant-time-compare`: Cross-slice: one exported constantTimeEqual in @awthaq/core, replacing the private copies (slices 01, 03, 06, 10).

## Decisions needed

### NAM-004 — Provider discovery resolved once at boot and dies the process on failure

- A: keep fail-fast, but retry discovery with jittered backoff before dying (ERS-003). Minimal, spec-neutral.
- B: A plus an opt-in per-provider `discovery: 'lazy'` mode. The provider resolves on first use, answers 503 ProviderUnavailable until resolved, is refreshed on a TTL, and is permanently disabled with a logged defect if the fetched issuer mismatches (BEH-EA-127 still holds per provider).
- C: make all discovery lazy by default.

**Recommendation:** B. Default behavior stays fail-fast (with A's retries), so BEH-EA-127's boot guarantee is unchanged for everyone who does not opt in, and deployments that need Auth.js-style availability can opt in per provider. This is the richer option at a bounded cost. Also dedupe the second boot resolution in OAuthTokenAccess.layer by sharing one resolved-provider registry service (`OAuthProviders`) between OAuth.layer and OAuthTokenAccess.layer.

### NAM-006 — AccountExists always reports the conflicting provider as 'password'

- A: drop the field (AccountExists becomes field-less, like the other uniform errors).
- B: `providers: ReadonlyArray<string>`, the real providerIds from `accounts.listByUser(existing.id)`, always populated.
- C: B, but populated only when the callback's own profile.emailVerified === true (the caller proved control of that mailbox at the provider). Otherwise an empty array.

**Recommendation:** C. BEH-EA-123's stated purpose for the typed error is to drive a 'sign in with X, then link' UI, which needs the real method list (a richer contract). Gating on the provider-verified email avoids handing a sign-in-method map to someone holding an unverified provider identity for the victim's address. Existence is already disclosed by BEH-EA-123 itself, so this adds only the method list. Update BEH-EA-123's sketch (`AccountExists { provider: "password" }`).

### AP-005 — RFC 6749 4.1.2.1 authorization error responses are unparseable by the callback contract

- A: any `error` param (after state+cookie validation and flow consumption) becomes the same field-less OAuthCallbackFailed (400). Strictly uniform (JR-003/OAP-003).
- B: a new typed `OAuthAuthorizationDenied { error: Literals(['access_denied','invalid_request','unauthorized_client','unsupported_response_type','invalid_scope','server_error','temporarily_unavailable']) }` (400), raised only after the state+cookie check passes. error_description and error_uri are never echoed (provider-controlled free text). An unknown error code maps to OAuthCallbackFailed.
- C: B, plus redirect to flow.callbackURL with `?error=<code>` instead of JSON.

**Recommendation:** B. The `error` code is already visible to the user in the redirect URL, so echoing the enumerated code after state validation reveals nothing to an attacker (they cannot forge a valid state+cookie pair for the victim). It lets apps render 'you cancelled' vs 'something went wrong', the most common non-attack callback outcome. Keep JSON, not a redirect (C), consistent with OAuthApi.ts's documented typed-error convention.

## Per-issue dossiers

### Workstream `oauth-provider-response-decoding`

#### ACS-004 — JWKS response cast unvalidated before becoming key material

`medium` · `security` · `oauth` · [.issues/medium/ACS-004-applied-cryptography-specialist.md](../../.issues/medium/ACS-004-applied-cryptography-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

The cast half was fixed by e364411. The other half of the recommended fix is still open: require kty === 'RSA' and validate RSA JWK members before key import.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — The cast is gone (e364411).
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/Jwt.ts:152` — Still true: a `kty`-less entry is an RSA candidate, and entries are untyped Record<string, unknown> (n/e never validated).
  ```ts
    const candidates = jwks.keys.filter((key) => key.kty === "RSA" || key.kty === undefined);
    const matched = kid === undefined ? candidates[0] : candidates.find((key) => key.kid === kid);
  ```

**Fix plan** (S): Tighten key selection. Decode RSA JWKs structurally and stop admitting kty-less entries.

1. packages/oauth/src/Jwt.ts: add `RsaJwkSchema = Schema.Struct({ kty: Schema.Literal('RSA'), n: Schema.String, e: Schema.String, kid: Schema.optional(Schema.String), alg: Schema.optional(Schema.String), use: Schema.optional(Schema.String) })`. In `findKey`, filter `jwks.keys` through `Schema.decodeUnknownOption(RsaJwkSchema)` (drop non-conforming entries) instead of `kty === 'RSA' || kty === undefined`.
2. Skip entries whose `use` is present and not 'sig', or whose `alg` is present and not 'RS256'.
3. `verifyRs256` then receives a typed RSA JWK. Keep passing it to `importKey` unchanged.
4. Coordinate with slice 04's AOMS-005 (multi-alg) so the schema becomes a per-alg union there.

- **Files:** `packages/oauth/src/Jwt.ts`
- **Tests (write first):**
  - packages/oauth/test/Jwt.test.ts: 'findKey ignores a kty-less entry' (red first), 'findKey ignores use=enc keys', 'findKey ignores an RSA entry missing n'
- **Acceptance:**
  - A kty-less or malformed JWKS entry is never selected.
- **Spec refs:** BEH-EA-127
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### ESS-003 — Token-exchange response cast; id_token type never validated

`medium` · `correctness` · `oauth` · [.issues/medium/ESS-003-effect-schema-specialist.md](../../.issues/medium/ESS-003-effect-schema-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for JJS-005, OAP-004, OIT-005

Confirmed and widened. The token-response cast now exists twice (OAuth.ts:250 and OAuthTokenAccess.ts:93), and userinfo is cast at 712. Canonical for the remaining 'provider JSON cast' reports whose JWKS half was fixed by e364411 (JJS-005, OAP-004, OIT-005). The discovery-document half of those reports belongs to ESS-002 (slice 04).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:250` — The token-endpoint body is still a type assertion (it grew to 6 fields with BE-002).
  ```ts
      const body = (yield* response.json) as {
        readonly access_token?: string;
        readonly id_token?: string;
        readonly refresh_token?: string;
        readonly expires_in?: number;
        readonly scope?: string;
        readonly token_type?: string;
      };
  ```
- `packages/oauth/src/OAuthTokenAccess.ts:93` — e773cf1 copied the same cast into the refresh path after the audit.
  ```ts
      const body = (yield* response.json) as {
        readonly access_token?: string;
        readonly refresh_token?: string;
        readonly expires_in?: number;
        readonly scope?: string;
        readonly token_type?: string;
      };
  ```
- `packages/oauth/src/OAuth.ts:706` — The userinfo body is also asserted.
  ```ts
            ? yield* httpClient
                .get(provider.userinfoEndpoint.value, {
                  headers: { authorization: `Bearer ${tokens.accessToken}` },
                })
                .pipe(
                  Effect.flatMap((response) => response.json),
                  Effect.map((body) => body as Record<string, unknown>),
                  Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```

**Fix plan** (S): Decode token-endpoint and userinfo responses with Schema at the boundary, shared by OAuth.ts and OAuthTokenAccess.ts, and delete the casts.

1. New module packages/oauth/src/ProviderResponses.ts: `TokenResponseSchema = Schema.Struct({ access_token: Schema.String, id_token: Schema.optional(Schema.String), refresh_token: Schema.optional(Schema.String), expires_in: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])), scope: Schema.optional(Schema.String), token_type: Schema.optional(Schema.String) })` (NumberFromString tolerates providers that send "3600"), plus `UserinfoSchema = Schema.Record(Schema.String, Schema.Unknown)`.
2. OAuth.ts exchangeCode: `response` → `HttpIncomingMessage.schemaBodyJson(TokenResponseSchema)`. Drop the manual `typeof body.access_token` check and the `as {...}` cast. A decode failure maps to OAuthCallbackFailed (reason 'token-exchange').
3. OAuthTokenAccess.ts refresh: the same schema, with a decode failure mapped to OAuthRefreshFailed.
4. OAuth.ts userinfo: `schemaBodyJson(UserinfoSchema)`, removing `body as Record<string, unknown>`.
5. Do not touch OAuthProvider.ts:142 here. The discovery cast is ESS-002 (slice 04), and implementers should land both in the same PR if convenient.

- **Files:** `packages/oauth/src/ProviderResponses.ts`, `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthTokenAccess.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'a token response whose id_token is a number fails typed as OAuthCallbackFailed' (red: today it reaches Jwt.decode)
  - 'a token response with expires_in as a numeric string persists the right expiry'
  - 'a userinfo body that is a JSON array fails typed, not as a defect'
  - packages/oauth/test/OAuthTokenAccess.test.ts: 'a refresh response with a non-string access_token fails OAuthRefreshFailed'
- **Acceptance:**
  - `grep -nE ' as [{A-Z]' packages/oauth/src/OAuth.ts packages/oauth/src/OAuthTokenAccess.ts` finds no response casts.
  - Every malformed-provider-response test fails with a typed error. None die.
- **Spec refs:** BEH-EA-122, BEH-EA-127
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### AH-002 — JWKS response cast wholesale with as unknown as and cached unvalidated

`medium` · `security` · `oauth` · [.issues/medium/AH-002-anders-hejlsberg.md](../../.issues/medium/AH-002-anders-hejlsberg.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `e364411`

The `as unknown as Jwt.Jwks` cast was replaced by a Schema decode in e364411 (ESS-001/GC-001/SFS-002/TTE-001), with the regression test 'a malformed JWKS document fails typed' at OAuth.test.ts:973.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — JWKS decoded via HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema); a decode failure yields OAuthCallbackFailed.
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/Jwt.ts:31` — Schema added by e364411.
  ```ts
  export const JwksDocumentSchema = Schema.Struct({
    keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  });
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### JJS-005 — Untrusted JWKS, discovery, and token-exchange JSON flows through unvalidated type casts

`medium` · `security` · `oauth` · [.issues/medium/JJS-005-jwt-jwk-specialist.md](../../.issues/medium/JJS-005-jwt-jwk-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ESS-003**

Its four casts: JWKS fixed by e364411, id_token header/payload fixed by e3059f2 (AH-001/ESS-004), token-exchange body is ESS-003, discovery is ESS-002 (slice 04).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — The JWKS cast is gone (e364411).
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/OAuth.ts:250` — The remaining cast is ESS-003.
  ```ts
      const body = (yield* response.json) as {
        readonly access_token?: string;
        readonly id_token?: string;
        readonly refresh_token?: string;
        readonly expires_in?: number;
        readonly scope?: string;
        readonly token_type?: string;
      };
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### KRS-005 — Provider JWKS response type-cast without any schema validation

`medium` · `security` · `oauth` · [.issues/medium/KRS-005-key-rotation-specialist.md](../../.issues/medium/KRS-005-key-rotation-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `e364411`

The `as unknown as Jwt.Jwks` cast was replaced by a Schema decode in e364411 (ESS-001/GC-001/SFS-002/TTE-001), with the regression test 'a malformed JWKS document fails typed' at OAuth.test.ts:973.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — JWKS decoded via HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema); a decode failure yields OAuthCallbackFailed.
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/Jwt.ts:31` — Schema added by e364411.
  ```ts
  export const JwksDocumentSchema = Schema.Struct({
    keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  });
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### MA-006 — Type assertions cross trust boundaries: unvalidated JWKS cast contradicts the repo's own no-as rule

`medium` · `api` · `oauth` · [.issues/medium/MA-006-michael-arnaldi.md](../../.issues/medium/MA-006-michael-arnaldi.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ESS-005**

Two-part finding. The JWKS cast is ALREADY-FIXED (e364411). The Password.ts `(input as { readonly email: string }).email` casts are exactly ESS-005 in slice 07. Nothing remains in this slice.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — The JWKS half was fixed by e364411.
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/password/src/Password.ts:571` — The Password.ts rate-limit casts half still exists (also at 583 and 599). It is owned by ESS-005 (slice 07).
  ```ts
                key: (input) => `password:signup:${(input as { readonly email: string }).email}`,
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### OAP-004 — JWKS/token/userinfo responses consumed via unchecked casts; malformed JWKS crashes callback as a defect

`medium` · `security` · `oauth` · [.issues/medium/OAP-004-oauth2-authorization-code-pkce-specialist.md](../../.issues/medium/OAP-004-oauth2-authorization-code-pkce-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ESS-003**

JWKS half fixed by e364411 (a malformed keys field now fails typed). Token and userinfo casts remain, which is ESS-003.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — The JWKS cast is gone (e364411).
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/OAuth.ts:250` — The remaining cast is ESS-003.
  ```ts
      const body = (yield* response.json) as {
        readonly access_token?: string;
        readonly id_token?: string;
        readonly refresh_token?: string;
        readonly expires_in?: number;
        readonly scope?: string;
        readonly token_type?: string;
      };
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### OIT-005 — Provider-controlled JSON cast without validation turns malformed responses into defects

`medium` · `correctness` · `oauth` · [.issues/medium/OIT-005-oidc-id-token-specialist.md](../../.issues/medium/OIT-005-oidc-id-token-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ESS-003**

JWKS half fixed by e364411. Token and userinfo casts are ESS-003. The discovery cast and the resulting request-time `new URL()` throw in buildAuthorizeUrl are ESS-002 (slice 04).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — The JWKS cast is gone (e364411).
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/OAuth.ts:250` — The remaining cast is ESS-003.
  ```ts
      const body = (yield* response.json) as {
        readonly access_token?: string;
        readonly id_token?: string;
        readonly refresh_token?: string;
        readonly expires_in?: number;
        readonly scope?: string;
        readonly token_type?: string;
      };
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### VB-004 — Provider JWKS response trusted via unvalidated cast

`medium` · `security` · `oauth` · [.issues/medium/VB-004-vittorio-bertocci.md](../../.issues/medium/VB-004-vittorio-bertocci.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `e364411`

The `as unknown as Jwt.Jwks` cast was replaced by a Schema decode in e364411 (ESS-001/GC-001/SFS-002/TTE-001), with the regression test 'a malformed JWKS document fails typed' at OAuth.test.ts:973.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — JWKS decoded via HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema); a decode failure yields OAuthCallbackFailed.
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/Jwt.ts:31` — Schema added by e364411.
  ```ts
  export const JwksDocumentSchema = Schema.Struct({
    keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  });
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### AOMS-010 — JWKS cache never expires: stale keys trusted for process lifetime

`low` · `security` · `oauth` · [.issues/low/AOMS-010-auth0-okta-migration-specialist.md](../../.issues/low/AOMS-010-auth0-okta-migration-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `fd8e5e9`

fd8e5e9 (JJS-001/KRS-004/OIT-002) added a 15-minute JWKS cache TTL and made the kid-miss refetch reachable. Revoked or removed keys now converge within 15 minutes, not at restart. (OAP-007's optional 'manual invalidation' knob was not added. It is not needed now that a TTL exists. The Date.now() reads here are tracked by MA-002.)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:95` — TTL constant added by fd8e5e9.
  ```ts
  const JWKS_CACHE_TTL = Duration.minutes(15);
  ```
- `packages/oauth/src/OAuth.ts:335` — A TTL'd-out entry is treated as a cache miss and refetched.
  ```ts
      const cachedEntry = HashMap.get(yield* Ref.get(jwksCache), provider.id);
      const jwks =
        Option.isSome(cachedEntry) &&
        Date.now() - cachedEntry.value.fetchedAt < Duration.toMillis(JWKS_CACHE_TTL)
          ? cachedEntry.value.jwks
          : yield* fetchAndCacheJwks;
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### AP-008 — Provider-controlled discovery and JWKS documents consumed via unchecked casts; JWKS cache never expires

`low` · `correctness` · `oauth` · [.issues/low/AP-008-aaron-parecki.md](../../.issues/low/AP-008-aaron-parecki.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ESS-002**

The JWKS cast was fixed by e364411 and the missing JWKS TTL by fd8e5e9 (15 min). The discovery cast remains, which is ESS-002 (slice 04).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — The JWKS is schema-decoded (e364411).
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/OAuthProvider.ts:140` — The discovery cast is still present. It is owned by ESS-002 in slice 04.
  ```ts
        const document = yield* httpClient.get(discoveryUrl).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as DiscoveryDocument),
          Effect.orDie,
        );
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### JR-010 — Discovery and JWKS wire documents consumed via unvalidated type assertions

`low` · `security` · `oauth` · [.issues/low/JR-010-justin-richer.md](../../.issues/low/JR-010-justin-richer.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **ESS-002**

The JWKS half was fixed by e364411. The discovery half (OAuthProvider.ts:142) is ESS-002 (slice 04, high).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — The JWKS is schema-decoded (e364411).
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/OAuthProvider.ts:140` — The discovery cast is still present. It is owned by ESS-002 in slice 04.
  ```ts
        const document = yield* httpClient.get(discoveryUrl).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as DiscoveryDocument),
          Effect.orDie,
        );
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### OAP-007 — JWKS cache is a process-lifetime Ref with no TTL; revoked provider keys stay accepted until restart or kid change

`low` · `security` · `oauth` · [.issues/low/OAP-007-oauth2-authorization-code-pkce-specialist.md](../../.issues/low/OAP-007-oauth2-authorization-code-pkce-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `fd8e5e9`

fd8e5e9 (JJS-001/KRS-004/OIT-002) added a 15-minute JWKS cache TTL and made the kid-miss refetch reachable. Revoked or removed keys now converge within 15 minutes, not at restart. (OAP-007's optional 'manual invalidation' knob was not added. It is not needed now that a TTL exists. The Date.now() reads here are tracked by MA-002.)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:95` — TTL constant added by fd8e5e9.
  ```ts
  const JWKS_CACHE_TTL = Duration.minutes(15);
  ```
- `packages/oauth/src/OAuth.ts:335` — A TTL'd-out entry is treated as a cache miss and refetched.
  ```ts
      const cachedEntry = HashMap.get(yield* Ref.get(jwksCache), provider.id);
      const jwks =
        Option.isSome(cachedEntry) &&
        Date.now() - cachedEntry.value.fetchedAt < Duration.toMillis(JWKS_CACHE_TTL)
          ? cachedEntry.value.jwks
          : yield* fetchAndCacheJwks;
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

### Workstream `oauth-oidc-claims-integrity`

#### OIT-001 — Userinfo claims override the signed id_token with no sub cross-check

`high` · `security` · `oauth` · [.issues/high/OIT-001-oidc-id-token-specialist.md](../../.issues/high/OIT-001-oidc-id-token-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) · canonical for AP-004, APS-008

Confirmed verbatim at HEAD. OIDC Core 5.3.2 requires userinfo.sub === id_token.sub. Canonical for AP-004 (the same sub check) and APS-008 (email_verified for auto-link sourced from the weaker userinfo). The fix below covers both.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:717` — userinfo is spread last and wins every overlap, including `sub`, `email` and `email_verified`.
  ```ts
          const profile = provider.mapProfile({ ...idClaims, ...userinfoClaims });
  ```
- `packages/oauth/src/OAuth.ts:706` — userinfo is cast, and its `sub` is never compared to the verified id_token's.
  ```ts
            ? yield* httpClient
                .get(provider.userinfoEndpoint.value, {
                  headers: { authorization: `Bearer ${tokens.accessToken}` },
                })
                .pipe(
                  Effect.flatMap((response) => response.json),
                  Effect.map((body) => body as Record<string, unknown>),
                  Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/OAuth.ts:719` — profile.subject from the merged object keys the account lookup.
  ```ts
          const accountIfLinked = yield* accounts.findByProviderSubject(
            providerId,
            profile.subject,
            Option.getOrUndefined(provider.issuer),
          );
  ```

**Fix plan** (M): For oidc providers, fail when userinfo.sub differs from the verified id_token sub, and let the signed id_token win for identity-bearing claims (sub, email, email_verified). userinfo only enriches the profile.

1. packages/oauth/src/OAuth.ts callback: decode the userinfo body with a Schema (`UserinfoSchema = Schema.Record(Schema.String, Schema.Unknown)` via `HttpIncomingMessage.schemaBodyJson`, delivered by ESS-003), removing the `body as Record<string, unknown>` cast.
2. When `idClaims !== undefined && userinfoClaims !== undefined`: require `typeof userinfoClaims.sub === 'string' && userinfoClaims.sub === idClaims.sub`, else fail `OAuthCallbackFailed` (internal reason 'userinfo-sub-mismatch' via OIT-008's reason channel).
3. Replace the merge with `{ ...idClaims, ...userinfoClaims, ...pickPresent(idClaims, ['sub', 'email', 'email_verified']) }`. `pickPresent` is a small typed helper that copies only keys present in the verified id_token, with no casts. id_token then wins identity claims and userinfo still refreshes name/picture.
4. Plain `oauth2` providers (no id_token) keep today's behavior: userinfo is the only source.
5. Update the comment at OAuth.ts:698-702 to state the new precedence rule and cite OIDC Core 5.3.2.

- **Files:** `packages/oauth/src/OAuth.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts OIDC block: add `userinfo_endpoint` to a variant of `oktaDiscovery`. Then 'a userinfo response whose sub differs from the id_token sub is rejected' (red first).
  - same block: 'id_token email_verified wins over userinfo for the trusted auto-link decision' (userinfo says true, id_token says false: no auto-link, AccountExists).
  - same block: 'userinfo still enriches name when subs match'.
  - features/features/05-authentication-methods/16-oauth.feature: optional new BEH-EA-125 scenario 'A userinfo response for a different subject is never used'.
- **Acceptance:**
  - A mismatched userinfo sub yields OAuthCallbackFailed. No account is created or linked.
  - For oidc providers, profile.subject, email and emailVerified always come from the verified id_token when present there.
  - Existing oauth2 (GitHub-style) tests stay green.
- **Spec refs:** BEH-EA-125, BEH-EA-124, BEH-EA-127
- **Depends on:** ESS-003

**Recommended status:** `ready-for-agent`

#### MA-002 — Ambient Date.now() inside an Effect bypasses the Clock, breaking TestClock determinism

`medium` · `correctness` · `oauth` · [.issues/medium/MA-002-michael-arnaldi.md](../../.issues/medium/MA-002-michael-arnaldi.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Confirmed, and worse than reported: three Date.now() sites in verifyIdToken now (327, 338, 360). callback already uses `DateTime.now` at line 689, so the idiom is right next door.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:356` — exp is checked against ambient Date.now().
  ```ts
      if (
        claims["iss"] !== expectedIssuer ||
        claims["aud"] !== provider.clientId ||
        exp === undefined ||
        Date.now() >= exp * 1000 ||
        (nonce !== undefined && claims["nonce"] !== nonce)
      ) {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
  ```
- `packages/oauth/src/OAuth.ts:335` — The JWKS TTL added by fd8e5e9 introduced two more ambient Date.now() reads (plus line 327's fetchedAt).
  ```ts
      const cachedEntry = HashMap.get(yield* Ref.get(jwksCache), provider.id);
      const jwks =
        Option.isSome(cachedEntry) &&
        Date.now() - cachedEntry.value.fetchedAt < Duration.toMillis(JWKS_CACHE_TTL)
          ? cachedEntry.value.jwks
          : yield* fetchAndCacheJwks;
  ```

**Fix plan** (S): Read time once per verification from the Effect Clock and use it for exp/iat/nbf and the JWKS cache age.

1. packages/oauth/src/OAuth.ts verifyIdToken: `const nowMs = yield* Clock.currentTimeMillis` (import `effect/Clock`) at the top, or `DateTime.now` plus `DateTime.toEpochMillis`.
2. Replace `Date.now()` at lines 327, 338 and 360 with `nowMs` (the fetchedAt write inside `fetchAndCacheJwks` must read the Clock inside its own Effect).
3. Pass `nowMs` into the claim checks introduced by OIT-004.

- **Files:** `packages/oauth/src/OAuth.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'an id_token becomes expired when TestClock advances past exp' (it.effect with TestClock.adjust; red first against Date.now)
  - 'the JWKS cache refetches after TestClock advances past JWKS_CACHE_TTL'
- **Acceptance:**
  - `grep -n 'Date.now' packages/oauth/src` returns nothing.
  - Both TestClock-driven tests pass.
- **Spec refs:** BEH-EA-127
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### OIT-003 — azp never validated and array-valued aud rejected outright

`medium` · `compliance` · `oauth` · [.issues/medium/OIT-003-oidc-id-token-specialist.md](../../.issues/medium/OIT-003-oidc-id-token-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for AOMS-004, AP-003, JJS-006, JR-008, OAP-006, VB-006

Canonical for the aud/azp cluster (7 reports). Chosen over the equally-medium AOMS-004/AP-003 because it is the only report that also covers the 'azp present but different' case (OIDC Core 3.1.3.7 SHOULD). Fails closed, so this is an interop issue, not a forgery vector.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:356` — `claims["aud"] !== provider.clientId`: an array aud always fails, and `azp` is never read (0 grep hits for azp in packages/oauth).
  ```ts
      if (
        claims["iss"] !== expectedIssuer ||
        claims["aud"] !== provider.clientId ||
        exp === undefined ||
        Date.now() >= exp * 1000 ||
        (nonce !== undefined && claims["nonce"] !== nonce)
      ) {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
  ```

**Fix plan** (S): Accept aud as a string or an array containing clientId. Require azp === clientId when aud has more than one value, and whenever azp is present.

1. packages/oauth/src/OAuth.ts: add `const audienceAccepted = (claims: Record<string, unknown>, clientId: string): boolean`. `aud` must be a string equal to clientId, or an array of strings (narrow with `Array.isArray` and `every(isString)`, no casts) that includes clientId. If the array length is > 1, `azp` must be a string equal to clientId. If `azp` is present at all, it must equal clientId.
2. Replace `claims["aud"] !== provider.clientId` in verifyIdToken with `!audienceAccepted(claims, provider.clientId)`. Tag the failure reason 'aud' or 'azp' (OIT-008).
3. Out of scope here: packages/jwt/src/JwtCodec.ts:242 (JR-008's second site) verifies first-party tokens whose aud is always the configured string. Leave it to slice 04's VB-005/JJS-008 audience work.

- **Files:** `packages/oauth/src/OAuth.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts OIDC block: 'an array aud containing the client id is accepted' (red first)
  - 'a multi-value aud without azp is rejected'
  - 'an azp naming another client is rejected even when aud matches'
  - 'a single-element array aud is accepted'
- **Acceptance:**
  - All four cases behave as specified. The existing string-aud tests stay green.
- **Spec refs:** BEH-EA-127
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### OIT-004 — Expiry check has zero clock-skew leeway and iat/nbf are never validated

`medium` · `correctness` · `oauth` · [.issues/medium/OIT-004-oidc-id-token-specialist.md](../../.issues/medium/OIT-004-oidc-id-token-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:356` — Zero leeway on exp. iat and nbf are never read (0 grep hits).
  ```ts
      if (
        claims["iss"] !== expectedIssuer ||
        claims["aud"] !== provider.clientId ||
        exp === undefined ||
        Date.now() >= exp * 1000 ||
        (nonce !== undefined && claims["nonce"] !== nonce)
      ) {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
  ```

**Fix plan** (S): Add a configurable clock-skew leeway and validate iat/nbf.

1. packages/oauth/src/OAuth.ts `OAuthConfigShape`: add `readonly clockSkew: Duration.Duration` (default 60 seconds) and `readonly maxIdTokenAge: Option<Duration>` (default none, for defense in depth).
2. verifyIdToken: fail when `nowMs >= exp*1000 + skew`; when `nbf` is present it must be a number with `nowMs + skew >= nbf*1000`; `iat` must be a number with `iat*1000 <= nowMs + skew`; if maxIdTokenAge is set, `nowMs - iat*1000 <= maxAge`.
3. Non-number iat/nbf present in the claims means reject.

- **Files:** `packages/oauth/src/OAuth.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'an id_token expired by less than the skew is accepted'; 'an id_token with iat in the future beyond skew is rejected'; 'an id_token with nbf in the future is rejected'; 'maxIdTokenAge rejects an old iat' (TestClock-driven)
- **Acceptance:**
  - All four cases pass with the default 60s skew. The existing 'an expired id_token is rejected' test stays green.
- **Spec refs:** BEH-EA-127
- **Depends on:** MA-002

**Recommended status:** `ready-for-agent`

#### AOMS-004 — aud claim compared by string equality: multi-audience id_tokens always fail federation

`medium` · `correctness` · `oauth` · [.issues/medium/AOMS-004-auth0-okta-migration-specialist.md](../../.issues/medium/AOMS-004-auth0-okta-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **OIT-003**

Array aud plus missing azp, same line.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:356` — `claims["aud"] !== provider.clientId`: an array aud always fails, and `azp` is never read (0 grep hits for azp in packages/oauth).
  ```ts
      if (
        claims["iss"] !== expectedIssuer ||
        claims["aud"] !== provider.clientId ||
        exp === undefined ||
        Date.now() >= exp * 1000 ||
        (nonce !== undefined && claims["nonce"] !== nonce)
      ) {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### AP-003 — id_token aud accepted only as an exact string; array-form audiences rejected

`medium` · `compliance` · `oauth` · [.issues/medium/AP-003-aaron-parecki.md](../../.issues/medium/AP-003-aaron-parecki.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **OIT-003**

Array aud plus azp for multi-audience, same line.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:356` — `claims["aud"] !== provider.clientId`: an array aud always fails, and `azp` is never read (0 grep hits for azp in packages/oauth).
  ```ts
      if (
        claims["iss"] !== expectedIssuer ||
        claims["aud"] !== provider.clientId ||
        exp === undefined ||
        Date.now() >= exp * 1000 ||
        (nonce !== undefined && claims["nonce"] !== nonce)
      ) {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### AP-004 — Userinfo claims merged over id_token claims without the required sub equality check

`medium` · `compliance` · `oauth` · [.issues/medium/AP-004-aaron-parecki.md](../../.issues/medium/AP-004-aaron-parecki.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **OIT-001**

Identical finding (the OIDC Core 5.3.2 sub check). Its 'merge userinfo only for non-identity claims' suggestion is folded into OIT-001's fix.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:717` — Same line and root cause as OIT-001.
  ```ts
          const profile = provider.mapProfile({ ...idClaims, ...userinfoClaims });
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### OIT-006 — Nonce check is conditional on the flow having a nonce; verifier does not enforce presence for oidc

`low` · `security` · `oauth` · [.issues/low/OIT-006-oidc-id-token-specialist.md](../../.issues/low/OIT-006-oidc-id-token-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Unreachable in the wired flow today (authorize always mints a nonce for oidc), exactly as reported. It is still a latent fail-open, and the guard beside it (isFlowPayload) is itself built on `as` casts.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:356` — The nonce is compared only when the flow carries one.
  ```ts
      if (
        claims["iss"] !== expectedIssuer ||
        claims["aud"] !== provider.clientId ||
        exp === undefined ||
        Date.now() >= exp * 1000 ||
        (nonce !== undefined && claims["nonce"] !== nonce)
      ) {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
  ```
- `packages/oauth/src/OAuth.ts:663` — flow.nonce undefined leads to verifyIdToken(nonce=undefined).
  ```ts
          const nonce =
            flow.nonce === undefined
              ? undefined
              : yield* encryption.decrypt(flow.nonce, identifier).pipe(
  ```
- `packages/oauth/src/OAuth.ts:141` — isFlowPayload never validates `nonce`, and uses `as` casts (a no-type-assertion violation).
  ```ts
  const isFlowPayload = (value: unknown): value is FlowPayload =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["providerId"] === "string" &&
    typeof (value as Record<string, unknown>)["codeVerifier"] === "string" &&
    typeof (value as Record<string, unknown>)["callbackURL"] === "string";
  ```

**Fix plan** (S): Make the nonce mandatory for oidc verification, and schema-decode the flow payload instead of the cast-based guard.

1. packages/oauth/src/OAuth.ts: replace `isFlowPayload` with `const FlowPayloadSchema = Schema.Struct({ providerId: Schema.String, codeVerifier: Schema.String, nonce: Schema.optional(Schema.String), callbackURL: Schema.String, link: Schema.optional(Schema.Struct({ userId: Schema.String })) })`, decoded with `Schema.decodeUnknownOption`. Remove the three `as Record<string, unknown>` casts. This also carries the MNA-003 `native` flag later.
2. verifyIdToken: change the parameter to `nonce: string` (required).
3. callback: when `provider.kind === 'oidc'` and the decrypted nonce is undefined, fail `OAuthCallbackFailed` (reason 'missing-nonce') before calling verifyIdToken.

- **Files:** `packages/oauth/src/OAuth.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'an oidc flow whose persisted payload lacks a nonce fails closed' (issue a Verification entry by hand with no nonce; red first)
  - 'an id_token without a nonce claim is rejected'
- **Acceptance:**
  - verifyIdToken's type no longer admits an undefined nonce.
  - `grep -n ' as ' packages/oauth/src/OAuth.ts` no longer matches isFlowPayload.
- **Spec refs:** BEH-EA-122, BEH-EA-127, INV-EA-015
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### OIT-008 — All id_token failure reasons collapse into one reason-free error, discarding JwtVerificationError's typed reason

`low` · `dx` · `oauth` · [.issues/low/OIT-008-oidc-id-token-specialist.md](../../.issues/low/OIT-008-oidc-id-token-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:348` — JwtVerificationError's reason is erased.
  ```ts
        Effect.flatMap((jwk) => Jwt.verifyRs256(jwk, decoded.signingInput, decoded.signature)),
        Effect.mapError(() => new OAuthApi.OAuthCallbackFailed()),
  ```
- `packages/oauth/src/OAuthApi.ts:41` — Field-less on the wire. That is intentional (anti-oracle) and stays.
  ```ts
  export class OAuthCallbackFailed extends Schema.TaggedError<OAuthCallbackFailed>()(
    "OAuthCallbackFailed",
    {},
    { httpApiStatus: 400 },
  ) {}
  ```

**Fix plan** (S): Keep the wire error opaque, and carry a discriminated internal reason for logs and spans.

1. packages/oauth/src/OAuth.ts: define `type CallbackFailureReason = 'state-malformed' | 'state-cookie-mismatch' | 'flow-consumed' | 'flow-provider-mismatch' | 'decrypt' | 'iss-mismatch' | 'token-exchange' | 'id-token-missing' | 'jwt-malformed' | 'alg' | 'jwks' | 'kid' | 'signature' | 'iss' | 'aud' | 'azp' | 'exp' | 'nbf' | 'iat' | 'nonce' | 'missing-nonce' | 'userinfo' | 'userinfo-sub-mismatch'`.
2. Add `const callbackFailed = (reason: CallbackFailureReason, cause?: unknown) => Effect.logWarning('oauth callback failed').pipe(Effect.annotateLogs({ reason }), Effect.andThen(Effect.annotateCurrentSpan('oauth.failure_reason', reason)), Effect.andThen(Effect.fail(new OAuthApi.OAuthCallbackFailed())))`. Replace every `Effect.fail(new OAuthApi.OAuthCallbackFailed())` and `mapError(() => new OAuthCallbackFailed())` with it, passing the Jwt.ts `reason` through where one exists.
3. Do NOT add fields to OAuthCallbackFailed. The wire stays uniform (BEH-EA-086/122).

- **Files:** `packages/oauth/src/OAuth.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'a wrong-nonce failure logs reason=nonce while the error stays field-less' (capture logs with a test Logger layer; red first)
- **Acceptance:**
  - Every OAuthCallbackFailed site emits a reason-tagged log and span annotation.
  - The HTTP response body is unchanged.
- **Spec refs:** BEH-EA-122, BEH-EA-086
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### OIT-009 — id_token test suite omits alg confusion, kid rotation, azp/array-aud, and userinfo sub mismatch

`low` · `testing` · `oauth` · [.issues/low/OIT-009-oidc-id-token-specialist.md](../../.issues/low/OIT-009-oidc-id-token-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

The kid-rotation part is fixed (fd8e5e9 added the unregistered-kid and rotation-refetch tests). alg confusion (HS256/none), array aud/azp, and userinfo sub-mismatch are still untested.

**Evidence at HEAD:**

- `packages/oauth/test/OAuth.test.ts:1056` — kid rotation is now pinned (added by fd8e5e9).
  ```ts
      it.effect(
        "JJS-001/JR-002/KRS-004/OIT-002: a rotated signing key is picked up via the kid-miss refetch, not stuck on the stale cache",
  ```
- `packages/oauth/test/OAuth.test.ts:220` — oktaDiscovery still has no userinfo_endpoint. No array aud, azp or HS256/none tests exist (grep: 0 hits).
  ```ts
  const oktaDiscovery = {
    issuer: "https://okta.example.com/oauth2/default",
    authorization_endpoint: "https://okta.example.com/authorize",
    token_endpoint: "https://okta.example.com/token",
    jwks_uri: "https://okta.example.com/jwks",
  };
  ```

**Fix plan** (S): Add the remaining negative scenarios. Most arrive as the red-first tests of OIT-001 and OIT-003, and alg confusion is added standalone.

1. packages/oauth/test/OAuth.test.ts OIDC block: 'an id_token with alg HS256 (signed with the RSA modulus as HMAC key) is rejected' and 'an alg:none id_token is rejected'. Both fail at the RS256 equality gate today, so they are pins, not red tests.
2. Userinfo sub mismatch comes from OIT-001's test. Array aud and azp come from OIT-003's tests.

- **Files:** `packages/oauth/test/OAuth.test.ts`
- **Tests (write first):**
  - as listed in steps
- **Acceptance:**
  - The id_token describe block covers alg confusion, kid rotation, array aud, azp mismatch and userinfo sub mismatch.
- **Spec refs:** BEH-EA-127
- **Depends on:** OIT-001, OIT-003

**Recommended status:** `ready-for-agent`

#### APS-008 — Userinfo claims override the signed id_token for the auto-link trust decision

`low` · `security` · `oauth` · [.issues/low/APS-008-auth-pentest-specialist.md](../../.issues/low/APS-008-auth-pentest-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **OIT-001**

Same root cause as OIT-001 (spread order lets userinfo override the signed id_token). OIT-001's fix explicitly makes the id_token win `email`/`email_verified`, which closes this finding.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:717` — userinfo overrides the signed email_verified.
  ```ts
          const profile = provider.mapProfile({ ...idClaims, ...userinfoClaims });
  ```
- `packages/oauth/src/OAuth.ts:762` — The merged profile.emailVerified gates auto-link.
  ```ts
                if (Option.isSome(existing)) {
                  const autoLink =
                    trustedProviders.includes(providerId) && profile.emailVerified === true;
                  if (!autoLink) {
                    return yield* Effect.fail(
                      new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
                    );
                  }
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### JJS-006 — id_token aud validated as exact string only; azp never checked and array aud fails login

`low` · `correctness` · `oauth` · [.issues/low/JJS-006-jwt-jwk-specialist.md](../../.issues/low/JJS-006-jwt-jwk-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **OIT-003**

Same aud/azp gap.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:356` — `claims["aud"] !== provider.clientId`: an array aud always fails, and `azp` is never read (0 grep hits for azp in packages/oauth).
  ```ts
      if (
        claims["iss"] !== expectedIssuer ||
        claims["aud"] !== provider.clientId ||
        exp === undefined ||
        Date.now() >= exp * 1000 ||
        (nonce !== undefined && claims["nonce"] !== nonce)
      ) {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### JR-008 — aud claim validated by strict string equality in both verifiers; array audiences rejected, azp never checked

`low` · `compliance` · `oauth` · [.issues/low/JR-008-justin-richer.md](../../.issues/low/JR-008-justin-richer.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **OIT-003**

Same gap. Its JwtCodec.ts:242 second site verifies first-party single-string aud tokens and is tracked by slice 04's audience work (VB-005).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:356` — `claims["aud"] !== provider.clientId`: an array aud always fails, and `azp` is never read (0 grep hits for azp in packages/oauth).
  ```ts
      if (
        claims["iss"] !== expectedIssuer ||
        claims["aud"] !== provider.clientId ||
        exp === undefined ||
        Date.now() >= exp * 1000 ||
        (nonce !== undefined && claims["nonce"] !== nonce)
      ) {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### OAP-006 — id_token aud compared as exact string; array-form aud (OIDC-legal) always fails validation

`low` · `correctness` · `oauth` · [.issues/low/OAP-006-oauth2-authorization-code-pkce-specialist.md](../../.issues/low/OAP-006-oauth2-authorization-code-pkce-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **OIT-003**

Same aud/azp gap.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:356` — `claims["aud"] !== provider.clientId`: an array aud always fails, and `azp` is never read (0 grep hits for azp in packages/oauth).
  ```ts
      if (
        claims["iss"] !== expectedIssuer ||
        claims["aud"] !== provider.clientId ||
        exp === undefined ||
        Date.now() >= exp * 1000 ||
        (nonce !== undefined && claims["nonce"] !== nonce)
      ) {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### SFS-005 — Single-algorithm RS256 equality gate is the only algorithm-policy precedent

`low` · `security` · `oauth` · [.issues/low/SFS-005-saml-federation-specialist.md](../../.issues/low/SFS-005-saml-federation-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence high)

Forward-looking design guidance for a SamlSigner port that does not exist (SAML is Planned-Phase3, wayfinder ticket 08). Nothing is actionable in packages/oauth today. The 'algorithm allow-list as data' shape should be applied when slice 04's AOMS-005 (RS256-only id_token verification) adds ES256/EdDSA. Cross-reference it there rather than keep this open.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:313` — The single-value RS256 gate, as described.
  ```ts
      if (decoded.header.alg !== "RS256") {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
      }
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `wontfix`

#### VB-006 — id_token validation omits azp, at_hash, and iat/nbf bounds; array-form aud unsupported

`low` · `security` · `oauth` · [.issues/low/VB-006-vittorio-bertocci.md](../../.issues/low/VB-006-vittorio-bertocci.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **OIT-003**

The aud/azp half is OIT-003. Its iat/nbf half is OIT-004 and its at_hash half is OIT-007, both in this workstream.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:356` — `claims["aud"] !== provider.clientId`: an array aud always fails, and `azp` is never read (0 grep hits for azp in packages/oauth).
  ```ts
      if (
        claims["iss"] !== expectedIssuer ||
        claims["aud"] !== provider.clientId ||
        exp === undefined ||
        Date.now() >= exp * 1000 ||
        (nonce !== undefined && claims["nonce"] !== nonce)
      ) {
        return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### OIT-007 — at_hash unimplemented; auth_time/max_age absent — acceptable for the code-only flow but undocumented

`info` · `compliance` · `oauth` · [.issues/info/OIT-007-oidc-id-token-specialist.md](../../.issues/info/OIT-007-oidc-id-token-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Compliant today, as the finding says. The documentation gap is real.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:198` — response_type is always 'code', so at_hash is OPTIONAL per OIDC Core 3.1.3.7.
  ```ts
    url.searchParams.set("response_type", "code");
  ```
- `packages/oauth/src/Jwt.ts:7` — The header documents the RS256/rotation deferrals but not at_hash, auth_time or max_age. `grep -rn 'at_hash\|auth_time\|max_age' packages/oauth` returns 0 hits.
  ```ts
  // deliberately: RS256 only (the OIDC-mandated, near-universal default —
  // Google, Okta, Auth0, Entra ID all sign with RS256 by default), signature
  // verification via the platform `crypto.subtle` (Node's WebCrypto, no
  // dependency), and no JWKS-rotation refresh policy beyond "refetch once on
  // a `kid` cache miss." ES256/EdDSA and a real rotation policy are not
  // implemented — a real gap, documented here rather than silently assumed
  ```

**Fix plan** (S): Document the at_hash/auth_time/max_age deferral next to the existing RS256 deferral, and pin response_type=code structurally.

1. packages/oauth/src/Jwt.ts header: add a paragraph saying at_hash is not validated because only response_type=code exists (OIDC Core 3.1.3.7 optional), that at_hash becomes REQUIRED if a hybrid/implicit response_type is ever added, and that auth_time/max_age (freshness, step-up) are unsupported and belong to wayfinder ticket 15 (step-up).
2. packages/oauth/src/OAuth.ts `buildAuthorizeUrl`: extract the literal to `const RESPONSE_TYPE = "code" as const` with a comment pointing at the Jwt.ts note. The `as const` is a literal-widening annotation, not a type assertion.
3. packages/oauth/README.md: an 'OIDC validation scope' table listing what is and is not validated (see the oauth-docs step in this workstream).

- **Files:** `packages/oauth/src/Jwt.ts`, `packages/oauth/src/OAuth.ts`, `packages/oauth/README.md`
- **Tests (write first):**
  - None (docs only).
- **Acceptance:**
  - The Jwt.ts header and README both name at_hash, auth_time and max_age as deliberately unsupported, with the trigger condition for at_hash.
- **Spec refs:** BEH-EA-127
- **Depends on:** —

**Recommended status:** `ready-for-agent`

### Workstream `oauth-outbound-resilience`

#### ECF-001 — No deadline on any outbound HTTP call: five third-party calls can pin auth request fibers

`high` · `correctness` · `oauth` · [.issues/high/ECF-001-effect-concurrency-fiber-specialist.md](../../.issues/high/ECF-001-effect-concurrency-fiber-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

Confirmed and wider than reported. `grep -rn 'Effect.timeout' packages/*/src` returns 0 hits, and the outbound sites are now OAuth.ts:247 (token), :323 (JWKS), :706 (userinfo), OAuthProvider.ts:140 (discovery), OAuthTokenAccess.ts:90 (refresh, new since the audit), jwt/src/verify.ts:83 (JWKS) and password/src/Password.ts:317 (HIBP).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:244` — Token exchange, no deadline.
  ```ts
      if (Option.isSome(provider.clientSecret)) {
        form["client_secret"] = Redacted.value(provider.clientSecret.value);
      }
      const response = yield* httpClient.post(provider.tokenEndpoint, {
        body: HttpBody.urlParams(form),
      });
  ```
- `packages/oauth/src/OAuth.ts:323` — JWKS fetch, no deadline.
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```
- `packages/oauth/src/OAuthProvider.ts:140` — Discovery at boot, no deadline.
  ```ts
        const document = yield* httpClient.get(discoveryUrl).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as DiscoveryDocument),
          Effect.orDie,
        );
  ```
- `packages/password/src/Password.ts:317` — HIBP, no deadline (slice 07's file, same root cause).
  ```ts
        .get(`https://api.pwnedpasswords.com/range/${prefix}`)
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  ```

**Fix plan** (M): Give every outbound provider call a policy deadline, configurable per call class, and map a timeout into the typed failure channel.

1. packages/oauth/src/OAuth.ts `OAuthConfigShape`: add `readonly httpTimeouts: { readonly tokenExchange: Duration.Duration; readonly jwks: Duration.Duration; readonly userinfo: Duration.Duration; readonly discovery: Duration.Duration }` (defaults 10s/5s/5s/10s). Per-call-class values follow the flexibility-over-complexity preference.
2. Wrap the whole call in `Effect.timeout(config_.httpTimeouts.X)`, covering request plus body decode, not just the request. Sites: exchangeCode, fetchAndCacheJwks, userinfo, and OAuthTokenAccess.refresh (tokenExchange budget).
3. OAuthProvider.resolve: accept a `timeout` argument from the caller and apply it to the discovery GET. A timeout still dies at boot (BEH-EA-127) unless NAM-004's decision changes that.
4. Map `TimeoutError` to `ProviderUnavailable` (EEM-004) rather than OAuthCallbackFailed.
5. Cross-slice, same root cause, owned by those slices' plans: jwt/src/verify.ts:83 (slice 04) and Password.ts:317 HIBP (slice 07; breach check fails open on timeout). Name ECF-001 in their commits.

- **Files:** `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthProvider.ts`, `packages/oauth/src/OAuthTokenAccess.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'a token endpoint that never answers fails within the configured deadline' (fake HttpClient returning Effect.never, run under TestClock.adjust; red first)
  - same for JWKS and userinfo
  - packages/oauth/test/OAuthTokenAccess.test.ts: 'a hung refresh call fails OAuthRefreshFailed after the deadline'
- **Acceptance:**
  - No outbound call in packages/oauth/src can outlive its configured deadline.
  - The hung-endpoint tests complete under TestClock with no real waiting.
- **Spec refs:** BEH-EA-122, BEH-EA-127
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### EEM-004 — OAuth provider transport failures collapse into the same 400 OAuthCallbackFailed as caller errors

`medium` · `api` · `oauth` · [.issues/medium/EEM-004-effect-error-management-specialist.md](../../.issues/medium/EEM-004-effect-error-management-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Confirmed. Distinguishing a transport failure leaks nothing to an attacker: it can only be reached after state+cookie+PKCE validation of a flow the caller initiated.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:269` — Every exchange failure, transport included, becomes a 400.
  ```ts
    }).pipe(Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())));
  ```
- `packages/oauth/src/OAuthApi.ts:103` — No 503-class member in the callback contract.
  ```ts
        error: [
          ProviderNotFound,
          OAuthCallbackFailed,
          AccountExists,
          Api.RateLimited,
          Hooks.TwoFactorRequired,
        ],
  ```

**Fix plan** (S): Add ProviderUnavailable (503) for transport, timeout and 5xx failures of the token/JWKS/userinfo endpoints. Keep OAuthCallbackFailed (400) for protocol rejections.

1. packages/oauth/src/OAuthApi.ts: `export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()('ProviderUnavailable', {}, { httpApiStatus: 503 }) {}`. Add it to the callback endpoint's error list. Update the OAuthCallbackFailed doc comment, which lists 'a token-exchange failure': transport failures are now split out.
2. packages/oauth/src/OAuth.ts: in exchangeCode, fetchAndCacheJwks and userinfo, replace the blanket `Effect.catch` with a classifier: `HttpClientError` with reason Transport/Timeout, `Cause.TimeoutError` (ECF-001), or response status >= 500 becomes ProviderUnavailable. Status 4xx, a schema decode error (ESS-003) or a missing access_token becomes OAuthCallbackFailed. Read the status explicitly, because HttpClient resolves for any status.
3. OAuthShape.callback's error union: add ProviderUnavailable.
4. OAuthTokenAccess: optionally split OAuthRefreshFailed the same way (`OAuthProviderUnavailable`), for symmetry.

- **Files:** `packages/oauth/src/OAuthApi.ts`, `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthTokenAccess.ts`, `spec/behaviors/16-oauth.md`
- **Tests (write first):**
  - packages/oauth/test/AuthHttp.test.ts: 'a token endpoint answering 503 yields HTTP 503 ProviderUnavailable' (red first)
  - 'a token endpoint answering 400 invalid_grant still yields 400 OAuthCallbackFailed'
- **Acceptance:**
  - Transport/5xx/timeout failures give a 503. Protocol failures give a 400. The body of each stays field-less.
- **Spec refs:** BEH-EA-122, BEH-EA-086, BEH-EA-088
- **Depends on:** ECF-001

**Recommended status:** `ready-for-agent`

#### ERS-003 — Zero retry/backoff Schedules: one transient provider error fails OAuth callback permanently

`medium` · `architecture` · `oauth` · [.issues/medium/ERS-003-effect-runtime-scheduler-specialist.md](../../.issues/medium/ERS-003-effect-runtime-scheduler-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:323` — A single attempt. Any failure becomes OAuthCallbackFailed. `grep -rn 'Effect.retry\|Schedule\.' packages/*/src` returns 0 hits.
  ```ts
      const fetchAndCacheJwks = httpClient.get(jwksUri).pipe(
        Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Jwt.JwksDocumentSchema)),
        Effect.tap((jwks) =>
          Ref.update(jwksCache, (cache) =>
            HashMap.set(cache, provider.id, { jwks, fetchedAt: Date.now() }),
          ),
        ),
        Effect.catch(() => Effect.fail(new OAuthApi.OAuthCallbackFailed())),
  ```

**Fix plan** (S): Retry only idempotent GETs (JWKS, discovery, userinfo) with jittered exponential backoff inside the deadline. Never retry the single-use code exchange.

1. packages/oauth/src/OAuth.ts make: derive `const idempotentClient = httpClient.pipe(HttpClient.retryTransient({ retryOn: 'errors-and-responses', times: 2, schedule: Schedule.exponential('50 millis').pipe(Schedule.jittered) }))` (Effect v4 `HttpClient.retryTransient`, verified at ../effect/packages/effect/src/unstable/http/HttpClient.ts:912). Use it for fetchAndCacheJwks and userinfo. Keep `httpClient` for exchangeCode and add a comment there explaining why (the authorization code is single-use, RFC 6749 §4.1.2).
2. OAuthProvider.resolve: use the same retrying client for the discovery GET (boot).
3. Make `retry: { times, base }` part of OAuthConfigShape with the defaults above.
4. The total time budget still comes from ECF-001's Effect.timeout wrapping the retried call.

- **Files:** `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthProvider.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'a JWKS endpoint that 503s once then succeeds still verifies the id_token' (red first)
  - 'a token endpoint that 503s is NOT retried' (count calls on the fake client == 1)
- **Acceptance:**
  - One transient JWKS/userinfo/discovery failure no longer fails the flow.
  - The token exchange is called exactly once per callback.
- **Spec refs:** BEH-EA-127
- **Depends on:** ECF-001

**Recommended status:** `ready-for-agent`

#### NAM-004 — Provider discovery resolved once at boot and dies the process on failure

`medium` · `correctness` · `oauth` · [.issues/medium/NAM-004-nextauth-authjs-migration-specialist.md](../../.issues/medium/NAM-004-nextauth-authjs-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Confirmed. BEH-EA-127 mandates boot failure only for an issuer mismatch. Dying on 'temporarily unreachable' is an implementation choice, so how far to relax it is a real product call.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:547` — Any unreachable discovery document dies the whole composition at boot.
  ```ts
        // BEH-EA-127: resolved once, at boot — a mismatched or unfetchable
        // discovery document dies here, before any request is ever served.
        const resolved = yield* Effect.all(
          config_.providers.map((provider) => OAuthProvider.resolve(httpClient, provider)),
        );
        const registry = new Map(resolved.map((provider) => [provider.id, provider] as const));
  ```
- `packages/oauth/src/OAuthProvider.ts:140` — `Effect.orDie` with no retry. OAuthTokenAccess.layer repeats the same boot resolution (a second discovery fetch per provider).
  ```ts
        const document = yield* httpClient.get(discoveryUrl).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as DiscoveryDocument),
          Effect.orDie,
        );
  ```

**Fix plan** (M): Split 'misconfigured' (boot die) from 'unreachable' (retry, then optionally lazy), and share one provider registry.

1. Land ERS-003's retrying discovery client (option A).
2. Extract a `OAuthProviders` Context.Service (resolved registry) built once, consumed by OAuth.layer and OAuthTokenAccess.layer, removing the duplicate `Effect.all(config_.providers.map(resolve))` at OAuthTokenAccess.ts:158.
3. If B is chosen: `OAuthProviderConfig.discovery?: { mode: 'boot' | 'lazy'; refresh?: Duration }`. For lazy, the registry holds an `Effect.cachedWithTTL` resolver per provider. authorize/callback yield it and map failure to ProviderUnavailable (EEM-004). An issuer mismatch dies that provider's resolver, logs `Effect.logError`, and marks it permanently unavailable.
4. Spec: add a note to BEH-EA-127 that lazy mode moves the mismatch failure from boot to first use, still failing closed.

- **Files:** `packages/oauth/src/OAuthProvider.ts`, `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthTokenAccess.ts`, `spec/behaviors/16-oauth.md`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'a discovery endpoint that fails once at boot still registers the provider' (red first)
  - (B) 'a lazy provider whose discovery is down answers 503 and recovers once discovery is reachable'
  - (B) 'a lazy provider whose fetched issuer mismatches never serves a request'
- **Acceptance:**
  - A single transient discovery failure no longer prevents boot.
  - (B) An unreachable lazy provider does not block the rest of the auth runtime.
- **Spec refs:** BEH-EA-127
- **Depends on:** ERS-003
- **Needs decision:** yes. See *Decisions needed*.

**Recommended status:** `ready-for-human`

### Workstream `oauth-token-endpoint-client-auth`

#### AP-006 — Token endpoint auth hardwired to client_secret_post; basic unsupported and discovery metadata ignored

`medium` · `api` · `oauth` · [.issues/medium/AP-006-aaron-parecki.md](../../.issues/medium/AP-006-aaron-parecki.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:244` — client_secret_post only.
  ```ts
      if (Option.isSome(provider.clientSecret)) {
        form["client_secret"] = Redacted.value(provider.clientSecret.value);
      }
      const response = yield* httpClient.post(provider.tokenEndpoint, {
        body: HttpBody.urlParams(form),
      });
  ```
- `packages/oauth/src/OAuthProvider.ts:100` — token_endpoint_auth_methods_supported is never read.
  ```ts
  interface DiscoveryDocument {
    readonly issuer?: string;
    readonly authorization_endpoint?: string;
    readonly token_endpoint?: string;
    readonly jwks_uri?: string;
    readonly userinfo_endpoint?: string;
  }
  ```
- `packages/oauth/src/OAuthTokenAccess.ts:87` — The refresh path (added after the audit) is also post-only.
  ```ts
      if (Option.isSome(provider.clientSecret)) {
        form["client_secret"] = Redacted.value(provider.clientSecret.value);
      }
      const response = yield* httpClient.post(provider.tokenEndpoint, {
        body: HttpBody.urlParams(form),
      });
  ```

**Fix plan** (M): Support client_secret_basic (the RFC 6749 §2.3.1 default) and client_secret_post, selected from config or discovery, validated at boot.

1. packages/oauth/src/OAuthProvider.ts: add `OAuthProviderConfig.tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'none'` and `ResolvedProvider.tokenEndpointAuthMethod`. Read `token_endpoint_auth_methods_supported` from the (schema-decoded, ESS-002) discovery document. Resolution order: explicit config, else 'client_secret_basic' if advertised or if the list is absent, else 'client_secret_post' if advertised, else die at boot with a clear message. 'none' when no clientSecret.
2. Die at boot if an explicitly configured method is not in an advertised list.
3. New helper `authenticateTokenRequest(provider, form)` in packages/oauth/src/ProviderResponses.ts (or a TokenEndpoint.ts), returning the request. For basic, set `Authorization: Basic base64(formUrlEncode(clientId) + ':' + formUrlEncode(secret))` per RFC 6749 §2.3.1 (the credentials MUST be form-urlencoded first, so do not use HttpClientRequest.basicAuth blindly) and omit client_secret from the body. For post, keep today's form fields.
4. Use the helper in both OAuth.ts exchangeCode and OAuthTokenAccess.ts refresh.

- **Files:** `packages/oauth/src/OAuthProvider.ts`, `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthTokenAccess.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'a provider advertising only client_secret_basic receives an Authorization: Basic header and no client_secret in the body' (red first; the fake client records request headers)
  - 'a configured method the discovery document does not advertise fails at boot'
  - 'client ids containing reserved characters are form-urlencoded before base64'
- **Acceptance:**
  - Both methods work for the exchange and refresh paths.
  - A mismatch surfaces at boot, not at the first sign-in.
- **Spec refs:** BEH-EA-126, BEH-EA-127
- **Depends on:** ESS-002

**Recommended status:** `ready-for-agent`

### Workstream `oauth-callback-error-contract`

#### AP-005 — RFC 6749 4.1.2.1 authorization error responses are unparseable by the callback contract

`medium` · `compliance` · `oauth` · [.issues/medium/AP-005-aaron-parecki.md](../../.issues/medium/AP-005-aaron-parecki.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for JR-003, OAP-003

Confirmed. Canonical for JR-003 and OAP-003 (same schema, same fix shape). The three reports disagree on the outcome's shape (uniform OAuthCallbackFailed vs a typed provider-error outcome), so that choice is recorded as an open decision.

**Evidence at HEAD:**

- `packages/oauth/src/OAuthApi.ts:74` — `code` is required and no `error` field exists, so an RFC 6749 §4.1.2.1 denial redirect fails query decoding before the handler runs.
  ```ts
  export const CallbackQuery = Schema.Struct({
    code: Schema.String,
    state: Schema.String,
    /** RFC 9207 mix-up countermeasure — validated when the provider sends it. */
    iss: Schema.optional(Schema.String),
  });
  ```

**Fix plan** (S): Model RFC 6749 §4.1.2.1 error responses in the callback contract and fold them into the handler's own validated failure path.

1. packages/oauth/src/OAuthApi.ts CallbackQuery: `code: Schema.optional(Schema.String)`, plus `error: Schema.optional(Schema.String)`, `error_description: Schema.optional(Schema.String)` and `error_uri: Schema.optional(Schema.String)`.
2. packages/oauth/src/OAuth.ts OAuthShape.callback input: `code: string | undefined` and `error: string | undefined`.
3. callback: keep the rate limit, provider lookup, state/cookie check and `verification.consume` first (consuming the flow makes the denied flow single-use). Then, if `error !== undefined` or `code === undefined`, fail per the decision (B: OAuthAuthorizationDenied with the enumerated code, else OAuthCallbackFailed). Never call exchangeCode.
4. (B) OAuthApi.ts: add the OAuthAuthorizationDenied TaggedError (400) to the callback error list.
5. Handler: pass `query.error` through. Do not log error_description at more than debug level.

- **Files:** `packages/oauth/src/OAuthApi.ts`, `packages/oauth/src/OAuth.ts`, `features/features/05-authentication-methods/16-oauth.feature`, `spec/behaviors/16-oauth.md`
- **Tests (write first):**
  - packages/oauth/test/AuthHttp.test.ts: 'a provider redirect with error=access_denied and a valid state answers the typed denial, not a decode error' (red first)
  - 'error=access_denied with a mismatched state answers 400 OAuthCallbackFailed'
  - 'the flow is consumed by a denial, so a replay with a code fails'
  - BDD: new BEH-EA-122 scenario 'A user denying consent at the provider gets the typed denial outcome'
- **Acceptance:**
  - A denial redirect never yields a framework decode error.
  - State is validated on the error path too (RFC 6749 §4.1.2.1).
- **Spec refs:** BEH-EA-122, BEH-EA-086
- **Depends on:** —
- **Needs decision:** yes. See *Decisions needed*.

**Recommended status:** `ready-for-human`

#### JR-003 — RFC 6749 §4.1.2.1 authorization-error responses are unmodelable: required code param means a user-denial redirect never reaches the uniform typed failure

`medium` · `compliance` · `oauth` · [.issues/medium/JR-003-justin-richer.md](../../.issues/medium/JR-003-justin-richer.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **AP-005**

Same root cause and the same recommended schema change as AP-005 (the canonical ID). Its preference for a uniform OAuthCallbackFailed is option A in AP-005's decision.

**Evidence at HEAD:**

- `packages/oauth/src/OAuthApi.ts:74` — Same schema, same gap.
  ```ts
  export const CallbackQuery = Schema.Struct({
    code: Schema.String,
    state: Schema.String,
    /** RFC 9207 mix-up countermeasure — validated when the provider sends it. */
    iss: Schema.optional(Schema.String),
  });
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### OAP-003 — RFC 6749 error responses (error=access_denied, no code) are unmodeled and die as schema-decode failures

`medium` · `compliance` · `oauth` · [.issues/medium/OAP-003-oauth2-authorization-code-pkce-specialist.md](../../.issues/medium/OAP-003-oauth2-authorization-code-pkce-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **AP-005**

Same root cause and the same recommended schema change as AP-005 (the canonical ID). Its preference for a uniform OAuthCallbackFailed is option A in AP-005's decision.

**Evidence at HEAD:**

- `packages/oauth/src/OAuthApi.ts:74` — Same schema, same gap.
  ```ts
  export const CallbackQuery = Schema.Struct({
    code: Schema.String,
    state: Schema.String,
    /** RFC 9207 mix-up countermeasure — validated when the provider sends it. */
    iss: Schema.optional(Schema.String),
  });
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

### Workstream `oauth-callback-http-hardening`

#### CSS-004 — Wire tests assert cookie names only and discard attributes — the class of bug in CSS-001 is invisible to the suite

`medium` · `testing` · `oauth` · [.issues/medium/CSS-004-cookie-security-specialist.md](../../.issues/medium/CSS-004-cookie-security-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

8c40afe (CSS-001) added attribute assertions for __Host-oauth-state. The session cookie emitted by the OAuth callback, plus HttpOnly/SameSite on the state cookie, are still unasserted at wire level. The same `split(';')[0]` helpers exist in password/admin/passkey tests (other slices).

**Evidence at HEAD:**

- `packages/oauth/test/AuthHttp.test.ts:183` — Fixed in part by 8c40afe: Path=/, Secure and no Domain are now asserted for the state cookie (HttpOnly/SameSite are not).
  ```ts
          const cookie = response.headers.get("set-cookie");
          assert.isString(cookie);
          assert.match(cookie ?? "", /^__Host-oauth-state=/);
          // CSS-001: the `__Host-` prefix requires Secure, no Domain, and
          // Path=/ exactly — a narrower path silently voids the prefix and
          // real browsers drop the cookie.
          assert.match(cookie ?? "", /;\s*Path=\/(;|$)/i);
          assert.match(cookie ?? "", /;\s*Secure/i);
  ```
- `packages/oauth/test/AuthHttp.test.ts:220` — Still open: the session cookie set by the OAuth callback is asserted by name only.
  ```ts
          const sessionCookie = callbackResponse.headers.get("set-cookie");
          assert.isString(sessionCookie);
          assert.match(sessionCookie ?? "", /^__Host-session=/);
  ```

**Fix plan** (S): Add a shared Set-Cookie attribute assertion helper and apply it to every OAuth-emitted cookie.

1. packages/test/src/CookieAssertions.ts (new, exported from @awthaq/test): `parseSetCookie(raw)` and `assertHostPrefixedCookie(raw, name, { httpOnly, sameSite })`, which assert `__Host-` rules (Secure, Path=/, no Domain) plus the requested HttpOnly and SameSite values.
2. packages/oauth/test/AuthHttp.test.ts: use it for the state cookie (HttpOnly, SameSite=Lax) and the callback's session cookie (HttpOnly, SameSite per BEH-EA-055). Iterate `headers.getSetCookie()` once CSS-006 adds a second cookie.
3. Cross-slice: password/admin/passkey/csrf wire suites should adopt the helper (note for slices 06, 07 and 10).

- **Files:** `packages/test/src/CookieAssertions.ts`, `packages/oauth/test/AuthHttp.test.ts`
- **Tests (write first):**
  - The new assertions themselves. Mutation-check by temporarily dropping `httpOnly` in OAuth.ts and confirming red.
- **Acceptance:**
  - A cookie-attribute regression on either OAuth cookie fails packages/oauth's wire suite.
- **Spec refs:** BEH-EA-055, BEH-EA-122
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### PDR-004 — No security headers anywhere: no Referrer-Policy on auth redirects, no HSTS, no CSP, no X-Content-Type-Options

`medium` · `security` · `oauth` · [.issues/medium/PDR-004-philippe-de-ryck.md](../../.issues/medium/PDR-004-philippe-de-ryck.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Confirmed. The OAuth redirect responses are the part the library owns end to end. The global security-headers middleware is an opt-in server concern (slice 06's package), planned here because no other manifest carries it.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:431` — The post-auth 302 carries no Referrer-Policy. `grep -rni 'referrer-policy\|strict-transport\|content-security-policy\|x-content-type' packages/*/src` returns 0 hits.
  ```ts
          if (outcome.session !== undefined) {
            const response = HttpServerResponse.redirect(outcome.callbackURL);
            return yield* HttpServerResponse.setCookie(
              response,
              Sessions.SESSION_COOKIE_NAME,
              Redacted.value(outcome.session.token),
              Sessions.SESSION_COOKIE_ATTRIBUTES,
            ).pipe(Effect.orDie);
  ```

**Fix plan** (M): Set `Referrer-Policy: no-referrer` on the OAuth authorize and callback responses, and ship an opt-in security-headers middleware plus a deployment checklist.

1. packages/oauth/src/OAuth.ts: in both handlers, add the header via the same `HttpEffect.appendPreResponseHandler` used by CSS-006 (`HttpServerResponse.setHeader(res, 'referrer-policy', 'no-referrer')`). This covers success and error bodies. `no-referrer` prevents the provider's code/state landing URL from leaking to subresources.
2. packages/server/src/SecurityHeaders.ts (new, opt-in): `SecurityHeaders.layer(options)`, an HttpRouter middleware setting `Strict-Transport-Security` (default max-age=31536000; includeSubDomains, opt-out), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `X-Frame-Options: DENY`/CSP `frame-ancestors 'none'` for auth routes, each overridable. Export it from @awthaq/server.
3. Add a 'Deployment checklist' section to packages/server/README.md covering HSTS at the edge, and when to use SecurityHeaders.layer.

- **Files:** `packages/oauth/src/OAuth.ts`, `packages/server/src/SecurityHeaders.ts`, `packages/server/src/index.ts`, `packages/server/README.md`
- **Tests (write first):**
  - packages/oauth/test/AuthHttp.test.ts: 'authorize and callback 302s carry Referrer-Policy: no-referrer' (red first)
  - packages/server/test/SecurityHeaders.test.ts: default and override cases
- **Acceptance:**
  - Both OAuth endpoints always send Referrer-Policy.
  - The opt-in middleware exists and is documented.
- **Spec refs:** BEH-EA-128
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### TSS-003 — OAuth callback compares state correlation secret with non-constant-time string !==

`medium` · `security` · `oauth` · [.issues/medium/TSS-003-timing-side-channel-specialist.md](../../.issues/medium/TSS-003-timing-side-channel-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

Confirmed. The practical exploitability is low (network jitter, plus the value must then still pass Verification.consume's hashed check), but it is inconsistent with BEH-EA-056 and Csrf.ts. Four private constant-time helpers exist (Sessions.ts:50, ChallengeStore.ts:230, Csrf.ts:38, PasswordHasher.ts:73), and none is shared.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:632` — `!==` on the secret-bearing state value.
  ```ts
          const decoded = decodeState(input.state);
          if (Option.isNone(decoded) || input.cookieState !== input.state) {
            return yield* Effect.fail(new OAuthApi.OAuthCallbackFailed());
          }
  ```

**Fix plan** (S): Compare cookieState and state in constant time over fixed-length digests, using a shared helper.

1. Cross-slice shared helper (workstream `shared-constant-time-compare`, also serving slice 01's ACS-002/MLO-004/TSS-005 and slice 10's BPAS-008/CB-007/WPS-008): export `constantTimeEqual(a: Uint8Array, b: Uint8Array)` and `constantTimeEqualString` from a new `packages/core/src/ConstantTime.ts` (re-exported from @awthaq/core), and delete the private copies.
2. OAuth.ts callback: `const matches = cookieState !== undefined && constantTimeEqual(sha256(cookieState), sha256(input.state))` via `crypto.digest('SHA-256', ...)`. Hashing first removes the length side channel. Keep `Option.isNone(decoded)` as a separate structural check.

- **Files:** `packages/core/src/ConstantTime.ts`, `packages/core/src/index.ts`, `packages/oauth/src/OAuth.ts`
- **Tests (write first):**
  - packages/core/test/ConstantTime.test.ts: equal, different, and different-length inputs
  - packages/oauth/test/OAuth.test.ts: the existing mismatched-cookie test stays green (behavioral pin)
- **Acceptance:**
  - No `!==` comparison on secret material remains in OAuth.ts.
  - One shared helper serves every package.
- **Spec refs:** BEH-EA-056, BEH-EA-122
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### RBS-008 — OAuth callback IP keying uses the raw socket address with no trusted-proxy handling — shared bucket behind any reverse proxy

`medium` · `security` · `oauth` · [.issues/medium/RBS-008-rate-limiting-brute-force-specialist.md](../../.issues/medium/RBS-008-rate-limiting-brute-force-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `a3b7255`

Fixed by a3b7255 (AGA-001/NHS-003), which added @awthaq/ports/ClientAddress (layerDirect default plus opt-in layerTrustedProxy). The OAuth callback no longer reads request.remoteAddress. The 'per-provider cap' idea was not adopted. It is not needed to close the finding.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:423` — The IP now comes from the ClientAddress port (layerTrustedProxy walks X-Forwarded-For/Forwarded past configured hops or CIDRs).
  ```ts
          const resolvedAddress = yield* clientAddress.resolve(request);
          const outcome = yield* oauth.callback(params.provider, {
            code: query.code,
            state: query.state,
            iss: query.iss,
            cookieState,
            ...(Option.isSome(resolvedAddress) ? { ip: resolvedAddress.value } : {}),
          });
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### CSS-006 — Consumed __Host-oauth-state cookie is never expired at the callback

`low` · `security` · `oauth` · [.issues/low/CSS-006-cookie-security-specialist.md](../../.issues/low/CSS-006-cookie-security-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:431` — The success path sets only the session cookie.
  ```ts
          if (outcome.session !== undefined) {
            const response = HttpServerResponse.redirect(outcome.callbackURL);
            return yield* HttpServerResponse.setCookie(
              response,
              Sessions.SESSION_COOKIE_NAME,
              Redacted.value(outcome.session.token),
              Sessions.SESSION_COOKIE_ATTRIBUTES,
            ).pipe(Effect.orDie);
  ```
- `packages/oauth/src/OAuth.ts:440` — The link path sets nothing. Typed failures are rendered by the framework with no Set-Cookie.
  ```ts
          return HttpServerResponse.redirect(outcome.callbackURL);
  ```

**Fix plan** (S): Expire __Host-oauth-state on every callback response: success, link, and typed failure.

1. packages/oauth/src/OAuth.ts callback handler: before calling `oauth.callback`, register `HttpEffect.appendPreResponseHandler((_req, res) => HttpServerResponse.expireCookie(res, OAUTH_STATE_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' }))` (both APIs exist in Effect v4: HttpEffect.ts:243, HttpServerResponse.ts:657). This covers the framework-encoded error responses too.
2. Make sure the expiry does not clobber the session Set-Cookie. Both are separate cookies, but assert the header list contains both.

- **Files:** `packages/oauth/src/OAuth.ts`
- **Tests (write first):**
  - packages/oauth/test/AuthHttp.test.ts: 'a successful callback expires __Host-oauth-state (Max-Age=0) alongside the session cookie' (use `response.headers.getSetCookie()`; red first)
  - 'a failed callback (400) also expires __Host-oauth-state'
- **Acceptance:**
  - Every callback response carries `__Host-oauth-state=; Max-Age=0; Path=/; Secure`.
- **Spec refs:** BEH-EA-122
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### OAP-008 — authorize endpoint is unthrottled while callback is rate-limited: unauthenticated Verification-row and crypto amplification

`low` · `security` · `oauth` · [.issues/low/OAP-008-oauth2-authorization-code-pkce-specialist.md](../../.issues/low/OAP-008-oauth2-authorization-code-pkce-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:537` — Only a callback rule is registered.
  ```ts
        const registerCallbackRule: Effect.Effect<void, RateLimits.RateLimitScopeViolation> =
          rateLimitsRegistry.register(OAuth, {
            group: "oauth",
            endpoint: "callback",
            key: "ip",
            limit: CALLBACK_RATE_LIMIT.limit,
            window: CALLBACK_RATE_LIMIT.window,
          });
  ```
- `packages/oauth/src/OAuth.ts:557` — authorize consumes no limiter, yet mints PKCE material, two encryptions and a Verification row.
  ```ts
        const authorize: OAuthShape["authorize"] = Effect.fnUntraced(function* (providerId, input) {
          const provider = registry.get(providerId);
          if (provider === undefined) {
            return yield* Effect.fail(new OAuthApi.ProviderNotFound({ providerId }));
  ```
- `packages/oauth/src/OAuthApi.ts:92` — No Api.RateLimited in the authorize contract.
  ```ts
        error: [ProviderNotFound, Api.Unauthenticated],
  ```

**Fix plan** (S): Register and enforce a looser per-IP rule on authorize.

1. packages/oauth/src/OAuth.ts: `AUTHORIZE_RATE_LIMIT = { limit: 30, window: Duration.minutes(1) }`, registered via `rateLimitsRegistry.register(OAuth, { group: 'oauth', endpoint: 'authorize', key: 'ip', ... })` next to the callback rule. The key is `oauth:authorize:${ip ?? 'unknown'}`.
2. OAuthShape.authorize input: add `ip?: string`. The handler resolves it via `clientAddress.resolve(request)` (it needs `request` in the handler signature, as callback has). Consume it at the top of `authorize`, mapping RateLimited to Api.RateLimited.
3. OAuthApi.ts authorize: add Api.RateLimited to the error list.
4. Make both rules' limits configurable via `OAuthConfigShape.rateLimits?: { authorize, callback }` (flexibility preference).

- **Files:** `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthApi.ts`, `spec/behaviors/14-rate-limiting.md`
- **Tests (write first):**
  - packages/oauth/test/AuthHttp.test.ts: 'authorize is throttled after its own rule's limit' (mirror the existing callback throttle test; red first)
- **Acceptance:**
  - The 31st authorize from one IP within a minute answers 429.
  - The rule is visible in the RateLimits registry.
- **Spec refs:** BEH-EA-110, BEH-EA-107, BEH-EA-108
- **Depends on:** —

**Recommended status:** `ready-for-agent`

### Workstream `oauth-account-linking-policy`

#### AOMS-007 — Federated users are created with emailVerified=false even when the IdP verified the email

`medium` · `correctness` · `oauth` · [.issues/medium/AOMS-007-auth0-okta-migration-specialist.md](../../.issues/medium/AOMS-007-auth0-okta-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:798` — The JIT user is created with the default emailVerified=false. verifyEmail is never called.
  ```ts
                      const user = yield* users
                        .create({ email: profile.email ?? `${providerId}:${profile.subject}`, name })
                        .pipe(
                          Effect.catchTag(
                            "EmailAlreadyExists",
                            () =>
                              new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
                          ),
  ```
- `packages/core/src/Users.ts:81` — verifyEmail is the sanctioned transition.
  ```ts
   * BEH-EA-041/042: no operation below accepts `emailVerified` as input —
   * `create` always starts it `false` (supplier-authority default), and
   * `verifyEmail` is the only transition, one-directional and idempotent.
  ```
- `packages/migrate-auth0/src/ImportAuth0User.ts:51` — Precedent: the Auth0 importer already calls verifyEmail when the source verified it.
  ```ts
      const user = input.emailVerified
        ? yield* users.verifyEmail(created.id).pipe(Effect.orDie)
        : created;
  ```

**Fix plan** (S): When a trusted provider asserts email_verified at first (JIT) creation, mark the new local user verified inside the same transaction.

1. packages/oauth/src/OAuth.ts create branch: inside the `sqlTransaction.withTransaction` block, after `users.create`, if `profile.email !== undefined && profile.emailVerified === true && trustedProviders.includes(providerId)`, call `users.verifyEmail(user.id)` (`Effect.orDie` on UserNotFound, which is impossible in the same transaction).
2. Gate it on trustedProviders, not any provider. An untrusted provider's claim must not flip local state that TMS-007's auto-link gate then relies on (otherwise a weak provider could mint a 'verified' squat account).
3. Do NOT call verifyEmail on the auto-link or explicit-link paths. The local account's verification state is its own (TMS-007).
4. Spec: add a note to BEH-EA-042 that the OAuth plugin, with a trusted provider asserting email_verified at JIT creation, is a sanctioned caller of verifyEmail. It is not a client-settable generic write.

- **Files:** `packages/oauth/src/OAuth.ts`, `spec/behaviors/06-domain-users-accounts.md`, `spec/behaviors/16-oauth.md`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'a trusted provider with email_verified=true creates a verified user' (red first)
  - 'an untrusted provider with email_verified=true creates an unverified user'
- **Acceptance:**
  - The stored emailVerified reflects a trusted provider's verification at creation.
  - Untrusted providers never flip it.
- **Spec refs:** BEH-EA-042, BEH-EA-124
- **Depends on:** TMS-007

**Recommended status:** `ready-for-agent`

#### FAMS-006 — Provider-subject mismatches in imported links silently JIT-duplicate accounts

`medium` · `correctness` · `oauth` · [.issues/medium/FAMS-006-firebase-auth-migration-specialist.md](../../.issues/medium/FAMS-006-firebase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

The runtime fall-through is by design (BEH-EA-125's identity anchor) and correct. What is missing is the import recipe and a dry-run tool. No Firebase importer exists (packages/migrate-* covers auth0 and better-auth sessions only), so the dry-run belongs with the planned `awthaq import` CLI (BEH-EA-207, slice 09).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:719` — The lookup is keyed on (providerId, subject, issuer). A mismatched import falls through to auto-link or JIT, as described.
  ```ts
          const accountIfLinked = yield* accounts.findByProviderSubject(
            providerId,
            profile.subject,
            Option.getOrUndefined(provider.issuer),
          );
  ```
- `packages/oauth/src/OAuth.ts:798` — JIT create with the synthetic `${providerId}:${subject}` email when the profile has no email.
  ```ts
                      const user = yield* users
                        .create({ email: profile.email ?? `${providerId}:${profile.subject}`, name })
                        .pipe(
                          Effect.catchTag(
                            "EmailAlreadyExists",
                            () =>
                              new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
                          ),
  ```

**Fix plan** (S): Document the exact federated-identity import recipe now. Defer the dry-run tool to the CLI import work.

1. packages/oauth/README.md: an 'Importing federated identities' section. providerId must equal the awthaq provider `id`, subject must be the IdP's `sub` (Firebase `providerUserInfo[].rawId`, NOT the Firebase uid), and issuer must equal the provider's configured issuer (`Option.getOrUndefined(provider.issuer)`, empty for oauth2). Include a table for Google/Apple/GitHub.
2. Export a small pure helper `OAuth.accountAnchorFor(providerConfig, subject)` returning `{ providerId, subject, issuer }` so importers cannot drift (optional, cheap).
3. File a follow-up with the CLI import workstream (slice 09): `awthaq import --dry-run` replays findByProviderSubject for every federated row and reports the rows that would fall through.

- **Files:** `packages/oauth/README.md`, `packages/oauth/src/OAuth.ts`
- **Tests (write first):**
  - If the helper is added: packages/oauth/test/OAuth.test.ts 'accountAnchorFor matches what callback looks up'
- **Acceptance:**
  - The recipe is documented. The dry-run is tracked in the CLI import plan.
- **Spec refs:** BEH-EA-125, BEH-EA-207
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### NAM-005 — Auto-linking is stricter than Auth.js — silent behavior change for migrated users

`medium` · `security` · `oauth` · [.issues/medium/NAM-005-nextauth-authjs-migration-specialist.md](../../.issues/medium/NAM-005-nextauth-authjs-migration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

The behavioral difference is real and intended by BEH-EA-123/124, so it will not change (TMS-007 makes it stricter still). Only the missing documentation of the Auth.js-to-trustedProviders mapping is actionable. The 'report the owning provider' half is NAM-006.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:762` — The stricter-than-Auth.js gate is intentional (BEH-EA-123/124).
  ```ts
                if (Option.isSome(existing)) {
                  const autoLink =
                    trustedProviders.includes(providerId) && profile.emailVerified === true;
                  if (!autoLink) {
                    return yield* Effect.fail(
                      new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
                    );
                  }
  ```
- `packages/oauth/README.md:1` — No migration mapping documented. The README is still a 'planned package' stub.
  ```
  # @awthaq/oauth
  
  > **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
  ```

**Fix plan** (S): Document the Auth.js to awthaq linking mapping.

1. packages/oauth/README.md (rewrite the stale 'planned package' stub, see oauth-docs in this workstream): a 'Migrating from Auth.js' section mapping `allowDangerousEmailAccountLinking: true` on provider X to `linking: { trustedProviders: ['x'] }`. It must state that awthaq additionally requires provider email_verified and (after TMS-007) a verified local email, and that affected users will see AccountExists and must sign in then link.

- **Files:** `packages/oauth/README.md`
- **Tests (write first):**
  - None (docs).
- **Acceptance:**
  - The README contains the mapping table and the behavior-change warning.
- **Spec refs:** BEH-EA-123, BEH-EA-124
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### TMS-007 — Trusted-provider auto-link ignores the local account's emailVerified — email-squatting account pre-takeover

`medium` · `security` · `oauth` · [.issues/medium/TMS-007-threat-modeling-specialist.md](../../.issues/medium/TMS-007-threat-modeling-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

The core claim holds: a trusted-provider sign-in silently links into a local account whose email was never proven. The finding overstates one part: the attacker's password is not immediately usable, because Password.ts:841 gates sign-in on emailVerified. It becomes usable the moment anything verifies that address (the victim clicking the signup mail, or AOMS-007's fix if done naively). The fix is needed as specified.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:762` — Only the provider-side email_verified is consulted. existing.value.emailVerified is ignored.
  ```ts
                if (Option.isSome(existing)) {
                  const autoLink =
                    trustedProviders.includes(providerId) && profile.emailVerified === true;
                  if (!autoLink) {
                    return yield* Effect.fail(
                      new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
                    );
                  }
  ```
- `packages/password/src/Password.ts:841` — Mitigation: the squatter cannot sign in by password while the account is unverified.
  ```ts
          if (!user.emailVerified) {
            yield* events.publish({
              _tag: "auth.user.signInFailed",
              strategy: "password",
              reason: "emailNotVerified",
            });
            return yield* Effect.fail(new PasswordApi.EmailNotVerified());
  ```

**Fix plan** (S): Auto-link only into a local account whose email is already verified. Otherwise answer AccountExists, as the explicit path does.

1. packages/oauth/src/OAuth.ts: `const autoLink = trustedProviders.includes(providerId) && profile.emailVerified === true && existing.value.emailVerified`.
2. Update the BEH-EA-124 requirement text so a verified-email match requires BOTH sides verified, and add the rationale (pre-account-takeover via email squatting).
3. BDD: extend the 16-oauth.feature BEH-EA-124 rule with 'A trusted provider never auto-links into a local account whose email is unverified'.

- **Files:** `packages/oauth/src/OAuth.ts`, `spec/behaviors/16-oauth.md`, `features/features/05-authentication-methods/16-oauth.feature`, `features/step-definitions/OAuthSteps.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts BEH-EA-123/124 block: 'a trusted provider does not auto-link into an unverified local account' (red first)
  - the existing auto-link test must first verify the local user (users.verifyEmail) to stay green
- **Acceptance:**
  - An unverified local account yields AccountExists and no account row is linked.
  - A verified local account plus a trusted provider still auto-links.
- **Spec refs:** BEH-EA-124
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### NAM-006 — AccountExists always reports the conflicting provider as 'password'

`low` · `correctness` · `oauth` · [.issues/low/NAM-006-nextauth-authjs-migration-specialist.md](../../.issues/low/NAM-006-nextauth-authjs-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) · canonical for EEM-007

Confirmed at both raise sites. Canonical over EEM-007 (the same two lines). The payload asserts a fact the code never checked (the user may be passkey-only or another-OAuth-only).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:762` — Hardcoded PASSWORD_PROVIDER_ID on the auto-link rejection.
  ```ts
                if (Option.isSome(existing)) {
                  const autoLink =
                    trustedProviders.includes(providerId) && profile.emailVerified === true;
                  if (!autoLink) {
                    return yield* Effect.fail(
                      new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
                    );
                  }
  ```
- `packages/oauth/src/OAuth.ts:798` — Hardcoded again on the EmailAlreadyExists translation.
  ```ts
                      const user = yield* users
                        .create({ email: profile.email ?? `${providerId}:${profile.subject}`, name })
                        .pipe(
                          Effect.catchTag(
                            "EmailAlreadyExists",
                            () =>
                              new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
                          ),
  ```

**Fix plan** (S): Report the actually-linked providers (or nothing), never a hardcoded 'password'.

1. packages/oauth/src/OAuthApi.ts AccountExists: replace `provider: Schema.String` with `providers: Schema.Array(Schema.String)` (per decision C, or remove it for A).
2. packages/oauth/src/OAuth.ts: in the auto-link rejection, `const linked = yield* accounts.listByUser(existing.value.id)` and fail `AccountExists({ providers: profile.emailVerified === true ? linked.map((a) => a.providerId) : [] })`.
3. EmailAlreadyExists translation in the create branch: look up `users.findByEmail(email)` then listByUser, applying the same gating. This path is a race (a concurrent create), so an empty array is acceptable if the lookup misses.
4. Update spec/behaviors/16-oauth.md BEH-EA-123's ts sketch, features/16-oauth.feature's 'fails with a typed outcome' scenario, and packages/client if it pattern-matches `provider`.

- **Files:** `packages/oauth/src/OAuthApi.ts`, `packages/oauth/src/OAuth.ts`, `spec/behaviors/16-oauth.md`, `features/features/05-authentication-methods/16-oauth.feature`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'AccountExists lists the passkey provider for a passkey-only user' (seed an account row with providerId 'passkey'; red first)
  - 'AccountExists lists nothing when the provider email is unverified'
- **Acceptance:**
  - The payload never names a provider the user has no account row for.
- **Spec refs:** BEH-EA-123, BEH-EA-086
- **Depends on:** —
- **Needs decision:** yes. See *Decisions needed*.

**Recommended status:** `ready-for-human`

#### EEM-007 — AccountExists wire error hardcodes provider 'password' regardless of the conflicting account's actual strategy

`low` · `api` · `oauth` · [.issues/low/EEM-007-effect-error-management-specialist.md](../../.issues/low/EEM-007-effect-error-management-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **NAM-006**

Same two raise sites and the same fix options as NAM-006 (canonical).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:798` — The same hardcoded provider as NAM-006.
  ```ts
                      const user = yield* users
                        .create({ email: profile.email ?? `${providerId}:${profile.subject}`, name })
                        .pipe(
                          Effect.catchTag(
                            "EmailAlreadyExists",
                            () =>
                              new OAuthApi.AccountExists({ provider: Accounts.PASSWORD_PROVIDER_ID }),
                          ),
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### BAM-011 — Account linking is at parity and the identity anchor is stricter than better-auth's

`info` · `architecture` · `oauth` · [.issues/info/BAM-011-better-auth-migration-specialist.md](../../.issues/info/BAM-011-better-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence high)

Informational parity note ('strongest parity area found') with no defect and 'No action for parity' as its own recommendation. Still accurate at HEAD. Its template suggestion belongs to the CLI import work (BEH-EA-207), not to this package.

**Evidence at HEAD:**

- `packages/sql/src/CoreMigrations.ts:93` — The DB-level identity-anchor uniqueness the finding praises is present.
  ```ts
            UNIQUE ("providerId", subject, issuer)
  ```
- `packages/oauth/src/OAuth.ts:59` — Explicit linking by default, trusted list opt-in.
  ```ts
    readonly linking: "explicit" | { readonly trustedProviders: ReadonlyArray<string> };
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `wontfix`

### Workstream `oauth-config-safety`

#### AGA-005 — redirect_uri is config-derived only: spoof-proof against gateway Host headers, but silently breaks when baseUrl lags the public URL

`low` · `correctness` · `oauth` · [.issues/low/AGA-005-api-gateway-auth-specialist.md](../../.issues/low/AGA-005-api-gateway-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:600` — redirect_uri comes only from config (secure), and nothing documents the behind-gateway requirement.
  ```ts
          const redirectUri = `${config_.baseUrl}/oauth/${providerId}/callback`;
  ```
- `packages/oauth/README.md:1` — No operational docs.
  ```
  # @awthaq/oauth
  
  > **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
  ```

**Fix plan** (S): Document that baseUrl must be the public scheme+host. The boot validation arrives with PDR-005.

1. packages/oauth/README.md 'Deploying behind a proxy/gateway': baseUrl MUST equal the public origin the provider redirects to (TLS terminates at the proxy). redirect_uri is `${baseUrl}/oauth/<id>/callback` and must be registered verbatim at the provider. Host/X-Forwarded-Host are never consulted, by design (BEH-EA-128). ClientAddress.layerTrustedProxy is the separate knob for client IPs.
2. examples/memory-server README (if present): a note that the example binds plain http on :3001 and why baseUrl must be set.
3. Boot warning: covered by PDR-005's http-non-localhost warning. Also log once at boot, at info level, the effective redirect_uri per provider, so operators can diff it against the provider console.

- **Files:** `packages/oauth/README.md`, `packages/oauth/src/OAuth.ts`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'boot logs the effective redirect_uri for each provider' (test Logger)
- **Acceptance:**
  - The README documents the requirement.
  - The boot log shows each redirect_uri.
- **Spec refs:** BEH-EA-128
- **Depends on:** PDR-005

**Recommended status:** `ready-for-agent`

#### PDR-005 — Insecure-by-default OAuth/passkey origins: localhost baseUrl and empty trustedOrigins ship as defaults

`low` · `security` · `oauth` · [.issues/low/PDR-005-philippe-de-ryck.md](../../.issues/low/PDR-005-philippe-de-ryck.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

The 'insecure-by-default' framing is overstated for OAuth. An empty trustedOrigins is the most restrictive allowlist (relative paths only), and a localhost redirect_uri fails closed at the provider. The real residual is silent misconfiguration, which is actionable. The passkey half (rpId/origins defaults) is slice 10's.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:67` — The localhost baseUrl default ships.
  ```ts
  const defaultOAuthConfig: OAuthConfigShape = {
    providers: [],
    linking: "explicit",
    trustedOrigins: [],
    baseUrl: "http://localhost:3000",
    defaultCallbackURL: "/",
  };
  ```
- `packages/jwt/src/JwtConfig.ts:10` — The repo already records a stricter precedent that names OAuthConfig.baseUrl.
  ```ts
  // every other `Context.Reference`-with-default config this codebase uses
  // elsewhere (`AdminConfig`, `RolesConfig`, `OAuthConfig`), `JwtConfig` is a
  // plain `Context.Service` with no default value at all, so an application
  // that installs `Jwt` without calling `config(...)` fails to compose at
  // all, rather than silently shipping an unconfigured `iss` claim — the
  // spec's own stricter-than-`OAuthConfig.baseUrl` decision.
  ```

**Fix plan** (S): Make baseUrl required (JwtConfig's precedent) and validate it at boot.

1. packages/oauth/src/OAuth.ts: convert `OAuthConfig` from a Context.Reference-with-default to a `Context.Service`, as JwtConfig did. `config(options: { readonly baseUrl: string } & Partial<Omit<OAuthConfigShape, 'baseUrl'>>)`. Composing OAuth without `config({ baseUrl })` then fails to type-check or compose.
2. Boot validation in `make`: `URL.parse(baseUrl)` must succeed with no path/query/fragment beyond '/'. Die with a descriptive message otherwise. If the protocol is `http:` and the host is not localhost/127.0.0.1/[::1], emit `Effect.logWarning` (the redirect_uri will be refused by most providers).
3. Update every caller of OAuth.config and the implicit default: packages/test/src/TestAuth.ts, features/step-definitions/OAuthWorld.ts, examples/*, and OAuthTokenAccess.ts (reads OAuthConfig).
4. Spec: note in ADR-EA-011 or BEH-EA-128 that baseUrl is required config (the redirect_uri derivation input).

- **Files:** `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthTokenAccess.ts`, `packages/test/src/TestAuth.ts`, `features/step-definitions/OAuthWorld.ts`, `spec/behaviors/16-oauth.md`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts: 'a baseUrl with a path component fails at boot' (red first)
  - 'a plain-http non-localhost baseUrl logs a warning'
  - type-level: a `// @ts-expect-error` on `OAuth.config({})` in a *.test-d.ts or vitest typecheck test
- **Acceptance:**
  - OAuth cannot be composed without an explicit baseUrl.
  - A malformed baseUrl dies at boot with a clear message.
- **Spec refs:** BEH-EA-128, BEH-EA-127
- **Depends on:** —

**Recommended status:** `ready-for-agent`

### Workstream `provider-token-storage`

#### BAM-008 — OAuth token lifecycle is thinner: no refresh, no idToken/expiry/scope columns

`medium` · `api` · `oauth` · [.issues/medium/BAM-008-better-auth-migration-specialist.md](../../.issues/medium/BAM-008-better-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

e773cf1 (BE-002) fixed the refresh operation and the expiry/scope columns. The idToken column is still missing, and so is the better-auth importer mapping for it: better-auth's Account carries idToken, and BEH-EA-207 says a source field must not be silently dropped.

**Evidence at HEAD:**

- `packages/core/src/Accounts.ts:85` — Refresh, expiry and scope are fixed by e773cf1. There is still no idToken field, so the id_token is used transiently and then dropped.
  ```ts
  export interface ProviderTokenSet {
    readonly accessToken: Redacted.Redacted<string>;
    readonly refreshToken: Option.Option<Redacted.Redacted<string>>;
    readonly accessTokenExpiresAt: Option.Option<DateTime.Utc>;
    readonly refreshTokenExpiresAt: Option.Option<DateTime.Utc>;
    readonly scope: Option.Option<string>;
    readonly tokenType: Option.Option<string>;
  }
  ```
- `packages/oauth/src/OAuth.ts:272` — tokens.idToken is never mapped onto the persisted set.
  ```ts
  const toProviderTokenSet = (tokens: TokenSet, now: DateTime.Utc): Accounts.ProviderTokenSet => ({
    accessToken: Redacted.make(tokens.accessToken),
    refreshToken:
      tokens.refreshToken === undefined
        ? Option.none()
        : Option.some(Redacted.make(tokens.refreshToken)),
  ```

**Fix plan** (M): Persist the provider's id_token (encrypted at rest, like access/refresh tokens) as part of ProviderTokenSet so better-auth account imports have a destination and a future RP-initiated logout can send id_token_hint.

1. packages/core/src/Accounts.ts: add `readonly idToken: Option.Option<Redacted.Redacted<string>>` to `ProviderTokenSet`; thread it through `layerMemory` and `layerSql` (`link`, `findProviderTokens`, `updateProviderTokens`).
2. packages/sql/src/Models.ts: add a nullable `idToken` column to the `Account` model. Encrypt it in `AccountsRepositoryLive` exactly like `accessToken`/`refreshToken` (same kid envelope, row+column AAD).
3. packages/sql/src/CoreMigrations.ts: add a new forward-only migration (next number after 17) that adds a nullable `idToken` TEXT column, dialect-branched like migration 17.
4. packages/oauth/src/OAuth.ts `toProviderTokenSet`: map `tokens.idToken` to `Option.some(Redacted.make(...))`.
5. packages/oauth/src/OAuthTokenAccess.ts `refresh`: preserve the stored idToken when the refresh response has no id_token; replace it when one is present.
6. The GDPR erasure cascade already deletes account rows. Confirm that no separate PII store is introduced.

- **Files:** `packages/core/src/Accounts.ts`, `packages/sql/src/Models.ts`, `packages/sql/src/CoreMigrations.ts`, `packages/sql/src/Repositories.ts`, `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthTokenAccess.ts`
- **Tests (write first):**
  - packages/core/test/Accounts.test.ts: 'link persists and findProviderTokens returns the idToken' (dual layer, red first)
  - packages/oauth/test/OAuth.test.ts (BE-002 block): 'an oidc sign-up persists the id_token alongside the access token'
  - packages/sql/test/Repositories.test.ts: 'idToken is ciphertext at rest'
- **Acceptance:**
  - An oidc callback persists the id_token, readable only through Accounts.findProviderTokens.
  - The raw DB column holds ciphertext, not the JWT.
  - A refresh response without id_token keeps the previously stored one.
- **Spec refs:** BEH-EA-125, BEH-EA-207
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### NAM-008 — No OAuth token refresh: refresh tokens persisted but never used

`medium` · `dx` · `oauth` · [.issues/medium/NAM-008-nextauth-authjs-migration-specialist.md](../../.issues/medium/NAM-008-nextauth-authjs-migration-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `e773cf1`

Commit e773cf1 (BE-002) persists the full token set, adds accessTokenExpiresAt/scope/tokenType, and ships OAuthTokenAccess.withAccessToken, which refreshes via grant_type=refresh_token. Both halves of the finding (refresh operation plus expiry/scope columns) are closed.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:16` — The quoted 'no token refresh operation' header text is gone; BE-002 replaced it.
  ```ts
  // BE-002 (.issues/high): the exchanged access/refresh token pair is now
  // persisted (`@awthaq/core`'s `Accounts.ProviderTokenSet`, via `link`/
  // `updateProviderTokens` in this file's own `callback` handler) rather
  // than discarded after the transient userinfo/id-token use, and
  // `OAuthTokenAccess.ts` exposes a scoped refresh port so application code
  // calling the provider's API on the user's behalf never handles a raw
  // token directly.
  ```
- `packages/oauth/src/OAuth.ts:731` — Fresh tokens are persisted on every re-auth, not only at link time.
  ```ts
            onSome: (account) =>
              accounts
                .updateProviderTokens(account.id, toProviderTokenSet(tokens, exchangedAt))
                .pipe(Effect.as(account.userId), Effect.orDie),
  ```
- `packages/core/src/Accounts.ts:85` — expiry/scope/tokenType columns now exist (migration 17).
  ```ts
  export interface ProviderTokenSet {
    readonly accessToken: Redacted.Redacted<string>;
    readonly refreshToken: Option.Option<Redacted.Redacted<string>>;
    readonly accessTokenExpiresAt: Option.Option<DateTime.Utc>;
    readonly refreshTokenExpiresAt: Option.Option<DateTime.Utc>;
    readonly scope: Option.Option<string>;
    readonly tokenType: Option.Option<string>;
  }
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### RRS-007 — OAuth refresh tokens never captured, never stored, never refreshed — encrypted columns are dead plumbing

`medium` · `architecture` · `oauth` · [.issues/medium/RRS-007-refresh-token-rotation-specialist.md](../../.issues/medium/RRS-007-refresh-token-rotation-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `e773cf1`

Refresh tokens are captured, persisted in the already-encrypted columns, and refreshed by OAuthTokenAccess.withAccessToken, which keeps the old refresh token when the response omits a new one (RFC 6749 §6). The 'dead plumbing' claim no longer holds. The remaining cast on the token response belongs to ESS-003.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:250` — refresh_token/expires_in/scope/token_type are now read from the token response. The cast itself is still open under ESS-003.
  ```ts
      const body = (yield* response.json) as {
        readonly access_token?: string;
        readonly id_token?: string;
        readonly refresh_token?: string;
        readonly expires_in?: number;
        readonly scope?: string;
        readonly token_type?: string;
      };
  ```
- `packages/oauth/src/OAuth.ts:731` — Tokens are persisted via updateProviderTokens; link() receives `tokens` at all three call sites.
  ```ts
            onSome: (account) =>
              accounts
                .updateProviderTokens(account.id, toProviderTokenSet(tokens, exchangedAt))
                .pipe(Effect.as(account.userId), Effect.orDie),
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

### Workstream `native-session-bootstrap`

#### MNA-003 — OAuth callback hands the session to the client only via Set-Cookie on a 302 - unreachable from a native app

`high` · `architecture` · `oauth` · [.issues/high/MNA-003-mobile-native-auth-specialist.md](../../.issues/high/MNA-003-mobile-native-auth-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

Confirmed. Decision recorded in .scratch/resolve-ready-for-human-findings/issues/17-native-mobile-session-bootstrap.md: a one-time exchange code in the deep-link redirect, redeemed at a new token endpoint, with the same bearer-delivery shape as MNA-001 (slice 07). Implementation note (not a re-litigation): the ticket names 'the existing KeyValueStore port', but no such port exists in @awthaq/ports (only Effect's unstable/persistence/KeyValueStore, whose get-then-remove is not atomic). Core Verification already provides the atomic single-use, TTL-bound, hashed-at-rest semantics the decision requires, so use it (purpose `oauth.exchange`). If the implementer insists on KeyValueStore, they must add an atomic take.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:431` — The only credential delivery is Set-Cookie on a 302. There is no native mode, exchange code or /oauth/token endpoint (grep: 0 hits).
  ```ts
          if (outcome.session !== undefined) {
            const response = HttpServerResponse.redirect(outcome.callbackURL);
            return yield* HttpServerResponse.setCookie(
              response,
              Sessions.SESSION_COOKIE_NAME,
              Redacted.value(outcome.session.token),
              Sessions.SESSION_COOKIE_ATTRIBUTES,
            ).pipe(Effect.orDie);
  ```

**Fix plan** (L): Implement decision ticket 17: native-mode authorize, an exchange code minted at callback, and a JSON redemption endpoint returning the session token.

1. OAuthApi.ts AuthorizeQuery: add `mode: Schema.optional(Schema.Literal('native'))`. FlowPayload (schema from OIT-006): add `native: Schema.optional(Schema.Boolean)`.
2. OAuth.ts authorize: persist `native: true` in the flow. Allow custom-scheme callbackURLs only in native mode (MNA-004).
3. OAuth.ts callback (native): after `sessions.issue`, do not set a cookie. Mint an exchange code: `verification.issue({ identifier: 'oauth.exchange:' + uuidv7, ttl: Duration.seconds(60), payload: { sessionToken: <encryption.encrypt(token, identifier)> } })`, then encode `identifier.value` like `encodeState`. Redirect to `flow.callbackURL` with `?code=<exchange>` appended via URL/searchParams. Never put the session token itself in the URL.
4. OAuthApi.ts: a new endpoint `HttpApiEndpoint.post('token', '/oauth/token', { payload: Schema.Struct({ code: Schema.String }), success: <shared bearer SessionTokenResponse from MNA-001>, error: [OAuthCallbackFailed, Api.RateLimited] })`. OAuth.ts handler: decode, `verification.consume` (atomic single-use), decrypt, return `{ token, session }`. Rate-limit per IP (reuse the ClientAddress pattern).
5. Share the response DTO with slice 07's MNA-001 bearer-delivery work (`X-Awthaq-Token-Delivery: bearer`) so password, passkey and OAuth return one token shape. Coordinate: whichever lands first defines it in @awthaq/api.
6. Browser mode stays byte-for-byte unchanged.
7. Spec: new BEH-EA-### under 16-oauth.md, 'Native clients receive a one-time exchange code, never a token in the URL'. Add a traceability.md row.

- **Files:** `packages/oauth/src/OAuthApi.ts`, `packages/oauth/src/OAuth.ts`, `packages/api/src/Session.ts`, `spec/behaviors/16-oauth.md`, `spec/traceability.md`, `features/features/05-authentication-methods/16-oauth.feature`
- **Tests (write first):**
  - packages/oauth/test/AuthHttp.test.ts: 'a native-mode callback redirects with an exchange code and sets no session cookie' (red first)
  - 'POST /oauth/token redeems the code once for a working bearer token'
  - 'a second redemption of the same code fails'
  - 'a code older than 60s fails' (TestClock)
  - BDD: a new scenario for the native return leg
- **Acceptance:**
  - A native app can complete OAuth with ASWebAuthenticationSession/Custom Tabs and obtain a bearer token.
  - No live token ever appears in a URL.
  - Browser flows are unchanged.
- **Spec refs:** BEH-EA-122, BEH-EA-128, BEH-EA-055
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### MNA-004 — Callback URL allowlist cannot admit custom-scheme deep links and fails silently

`high` · `dx` · `oauth` · [.issues/high/MNA-004-mobile-native-auth-specialist.md](../../.issues/high/MNA-004-mobile-native-auth-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

Confirmed at HEAD: the only acceptance paths are a same-origin relative path or a WHATWG origin match. Also note that even an admitted deep link would receive only a Set-Cookie on a 302, so this fix is only useful together with MNA-003's native return leg (decision ticket 17).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:180` — A custom-scheme URL (myapp://cb) parses with origin 'null', so it can never match an https allowlist entry and silently falls back, with no log.
  ```ts
    if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
    const parsed = Option.fromNullOr(URL.parse(raw));
    return parsed.pipe(
      Option.filter((url) => trustedOrigins.includes(url.origin)),
      Option.match({ onNone: () => fallback, onSome: () => raw }),
    );
  ```

**Fix plan** (M): Add an explicit native-redirect allowlist matched on the full serialized scheme+authority(+path prefix) for non-http(s) URLs, and log when a requested callbackURL is discarded.

1. packages/oauth/src/OAuth.ts `OAuthConfigShape`: add `readonly nativeRedirectURLs: ReadonlyArray<string>` (default `[]`), with entries like `myapp://oauth/callback` or `com.example.app:/cb` (RFC 8252 §7.1 private-use schemes).
2. `resolveCallbackURL`: after the relative-path branch, if `url.protocol` is not `http:`/`https:`, accept only when `raw` equals, or starts with, an entry of `nativeRedirectURLs`, compared on the `URL.parse`-normalized `href`. Never compare `.origin` for non-special schemes.
3. Turn `resolveCallbackURL` into an Effect (or return a tagged result) so the authorize handler can `Effect.logWarning` with an annotation `{ requested, reason: 'untrusted-origin' | 'untrusted-native-scheme' | 'unparseable' }` whenever it falls back. REQ-EA-353's no-error posture is kept.
4. Deep-link callbackURLs are honored only when the flow is in native mode (MNA-003). In browser mode a custom-scheme callbackURL falls back, because a Set-Cookie on a 302 to myapp:// is useless.
5. Document the RFC 8252 guidance in packages/oauth/README.md: prefer claimed https universal/app links, and use private-use schemes only with the exchange-code leg.

- **Files:** `packages/oauth/src/OAuth.ts`, `packages/oauth/README.md`, `spec/behaviors/16-oauth.md`
- **Tests (write first):**
  - packages/oauth/test/OAuth.test.ts BEH-EA-128 block: 'a native-mode flow honors an allowlisted myapp:// callbackURL' (red first)
  - same block: 'a non-allowlisted custom scheme falls back to defaultCallbackURL and logs a warning' (capture with a test Logger)
  - same block: 'javascript:alert(1) falls back' (the class pin PDR-006 suggested)
- **Acceptance:**
  - An allowlisted `myapp://oauth/callback` survives authorize → callback in native mode.
  - A non-allowlisted scheme falls back to defaultCallbackURL, and exactly one warning log is emitted.
  - Browser-mode behavior for http(s) callbackURLs is unchanged.
- **Spec refs:** BEH-EA-128
- **Depends on:** MNA-003

**Recommended status:** `ready-for-agent`

### Workstream `multi-tenant-oauth-connections`

#### EP-004 — Connection model absent: OAuth providers are a static per-composition array

`high` · `architecture` · `oauth` · [.issues/high/EP-004-eugenio-pace.md](../../.issues/high/EP-004-eugenio-pace.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) · canonical for CWM-001

Confirmed and not started. Decision ticket 18 (resolved): per-organization OAuth connections as data, in an `organization_oauth_connection` table owned by packages/organization, resolved through a `LayerMap.Service`-backed `OrganizationConnections` port, additive to the static Map. Canonical over CWM-001 (same decision, same evidence).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:56` — Static compose-time provider array.
  ```ts
  export interface OAuthConfigShape {
    readonly providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>;
  ```
- `packages/oauth/src/OAuth.ts:547` — Resolved once into an immutable Map. There is no organization_oauth_connection or OrganizationConnections anywhere (grep: 0 hits).
  ```ts
        // BEH-EA-127: resolved once, at boot — a mismatched or unfetchable
        // discovery document dies here, before any request is ever served.
        const resolved = yield* Effect.all(
          config_.providers.map((provider) => OAuthProvider.resolve(httpClient, provider)),
        );
        const registry = new Map(resolved.map((provider) => [provider.id, provider] as const));
  ```
- `spec/models/09-sso.md:65` — The spec still records no connection model.
  ```
  No design beyond this row exists yet. There is no `SsoApi` contract, no connection model, no per-tenant resolution mechanism, and no decision on whether SSO wraps SAML and OIDC-based enterprise connections under one plugin or dispatches to the separate `Saml`/`OAuth` plugins underneath.
  ```

**Fix plan** (XL): Implement ticket 18's connection model: an org-owned connection table plus a LayerMap-backed resolver, consulted after the static registry.

1. packages/organization: new table `organization_oauth_connection` (id, organizationId, kind oidc|oauth2 with saml reserved, issuer, discoveryUrl/endpoints, clientId, clientSecret encrypted via the Encryption/KeyProvider ports, emailDomains[]) with a migration under the plugin's own prefix (BEH-EA-040), plus a records repository.
2. packages/organization: `OrganizationConnections` as a `LayerMap.Service` keyed by organizationId (Effect v4 ../effect/packages/effect/src/LayerMap.ts). `lookup(orgId)` builds `OAuthProvider.OAuthProviderConfig` values from the stored rows and resolves them with the same `OAuthProvider.resolve` (reused).
3. packages/oauth: an optional dependency. `OAuthConfigShape.connections?: { resolve: (hint: { providerId: string; organizationId?: string; emailDomain?: string }) => Effect<Option<ResolvedProvider>> }` (a port-shaped callback, so oauth does not import organization, per the stratum rules). authorize/callback try `registry.get(providerId)` first, then `connections.resolve`. The provider id for a connection is namespaced (`org:<orgId>:<connectionId>`) so flow payloads stay unambiguous.
4. Home-realm discovery: an `authorize` query param `organization` or `login_hint` email domain feeds the resolver hint (the WorkOS/CWM-001 email-domain routing).
5. Admin CRUD for connections belongs to ticket 19's admin surface. Stage it after the resolver.
6. Dependencies: DRS-001's tenant_id/TenantContext (slice 05) and EP-001 are siblings in ticket 18. Land TenantContext first if the resolver should read it ambiently.
7. Spec: update spec/models/09-sso.md (connection model now exists for OIDC/OAuth2). Add BEH-EA entries for connection resolution.

- **Files:** `packages/organization/src/*`, `packages/oauth/src/OAuth.ts`, `packages/oauth/src/OAuthProvider.ts`, `spec/models/09-sso.md`, `spec/behaviors/16-oauth.md`
- **Tests (write first):**
  - packages/organization/test/OrganizationConnections.test.ts: 'a stored connection resolves to a provider and is cached per org'
  - packages/oauth/test/OAuth.test.ts: 'an org connection id not in the static registry completes a full callback' (red first)
  - 'a static provider id still wins over a connection with the same id'
  - 'a connection's client secret is ciphertext at rest'
- **Acceptance:**
  - An organization can add an OIDC connection at runtime, with no redeploy, and its users can sign in through it.
  - Static providers are unaffected.
- **Spec refs:** BEH-EA-121, BEH-EA-125, BEH-EA-126, BEH-EA-127, BEH-EA-040
- **Depends on:** —

**Recommended status:** `ready-for-agent`

#### CWM-001 — OAuth providers are a static compose-time array — a WorkOS connection-per-organization model is unrepresentable without a redeploy

`high` · `architecture` · `oauth` · [.issues/high/CWM-001-clerk-workos-migration-specialist.md](../../.issues/high/CWM-001-clerk-workos-migration-specialist.md) · current status `ready-for-agent`

**Verdict:** DUPLICATE (confidence high) · duplicate of **EP-004**

Same root cause and the same resolving decision (ticket 18) as EP-004 (canonical). Its email-domain routing and qadi-owned role mapping requirements are folded into EP-004's plan.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:56` — The same static array as EP-004.
  ```ts
  export interface OAuthConfigShape {
    readonly providers: ReadonlyArray<OAuthProvider.OAuthProviderConfig>;
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

### Workstream `m2m-client-credentials`

#### OCM-001 — No client-credentials grant or token-issuing authorization server exists for machine callers

`high` · `architecture` · `oauth` · [.issues/high/OCM-001-oauth2-client-credentials-m2m-specialist.md](../../.issues/high/OCM-001-oauth2-client-credentials-m2m-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

Confirmed. Decision ticket 10: client_credentials ships in packages/api-key as `POST auth/apiKey/token`, minting short-lived JWTs via packages/jwt's signer, and packages/oauth stays a pure client. So no code change lands in packages/oauth. The work is owned by the api-key slice (09); related slice 04 findings OCM-006/OCM-007.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:238` — The only grant type in the repo. `grep -rn client_credentials packages/*/src` returns 0 hits.
  ```ts
        grant_type: "authorization_code",
  ```
- `packages/api-key/src/index.ts:1` — The decided owner package is still an empty placeholder.
  ```ts
  // @awthaq/api-key — Plugin (M7)
  //
  // Long-lived API keys resolving to service principals.
  //
  // Planned first module: not yet specified — see spec/roadmap.md M7
  // See spec/overview.md for the full package map.
  //
  // Empty placeholder — awthaq is pre-implementation. No exported symbols yet.
  ```

**Fix plan** (XL): Implement ticket 10's M2M half in packages/api-key. Nothing changes in packages/oauth.

1. packages/api-key: `registerClient(name, scopes)` returns `{ clientId, clientSecret: Redacted }` (SHA-256 at rest, constant-time compare via the shared helper from TSS-003's workstream), plus `revokeClient`.
2. ApiKeyApi: `POST /apiKey/token` accepting `grant_type=client_credentials` (client_secret_post and client_secret_basic, reusing AP-006's credential parsing rules), with scope = requested ∩ registered.
3. Mint via packages/jwt's signer with `sub: 'service:<clientId>'`, `scope`, and `exp` from `ApiKeyConfig.tokenTtl` (default 15m). Resolve to `ServicePrincipal` via the Bearer strategy.
4. Spec: spec/models/07-api-keys.md plus new BEH entries. Record in roadmap.md that this pulls a Phase-3 slice into M7 (the ticket's own flag).

- **Files:** `packages/api-key/src/*`, `packages/jwt/src/*`, `spec/models/07-api-keys.md`, `spec/roadmap.md`
- **Tests (write first):**
  - packages/api-key/test/ClientCredentials.test.ts: 'a registered client obtains a scoped JWT'; 'requested scopes beyond the registered set are dropped'; 'a revoked client cannot mint'
- **Acceptance:**
  - A service can obtain a short-lived scoped token over RFC 6749 §4.4.
  - packages/oauth is unchanged.
- **Spec refs:** —
- **Depends on:** —

**Recommended status:** `ready-for-agent`

### Workstream `persistence-colocation-invariant`

#### DRS-006 — Cross-table transactions assume one logical database; the SqlTransaction default can silently mean no transaction

`medium` · `correctness` · `oauth` · [.issues/medium/DRS-006-data-residency-sharding-specialist.md](../../.issues/medium/DRS-006-data-residency-sharding-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

The claim that 'the SqlTransaction default can silently mean no transaction' is overstated: there is no default, and a SQL composition must choose layerSql. The substantive part holds: the users+accounts colocation assumption the OAuth JIT path relies on is not written down anywhere in spec/ (grep for colocation/shard in spec/behaviors/05, decisions/014 and invariants returns nothing).

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:795` — users.create and accounts.link share one withTransaction.
  ```ts
                const created = yield* sqlTransaction
                  .withTransaction(
                    Effect.gen(function* () {
  ```
- `packages/ports/src/SqlTransaction.ts:36` — layerNoop is an explicit, documented choice, not a 'default'. SqlTransaction is a plain Context.Service with no default value, and only TestAuth wires layerNoop.
  ```ts
  /** For an in-memory composition — every write already lands atomically in its own `Ref.modify`, so there is nothing this port needs to wrap. */
  export const layerNoop: Layer.Layer<SqlTransaction> = Layer.succeed(
    SqlTransaction,
    SqlTransaction.of({ withTransaction: (effect) => effect }),
  );
  ```

**Fix plan** (S): Write the colocation invariant into the spec. No runtime assertion (that would be speculative infra).

1. spec/invariants.md: a new INV-EA-0xx, 'Core identity tables (users, accounts, sessions, verification_*) share one transaction domain; any partitioning scheme must co-shard a user with its accounts', citing OAuth's JIT create+link and Password.confirmReset (BEH-EA-058) as the transactions that depend on it.
2. spec/behaviors/05-persistence-stratum.md BEH-EA-035 rationale: one sentence pointing at the invariant.
3. packages/ports/src/SqlTransaction.ts: extend the layerNoop doc comment. Its atomicity holds per Ref only, so a memory composition can still orphan a user if accounts.link dies. Acceptable for dev/test only.
4. Cross-slice: link this invariant from DRS-001 (slice 05, tenant key) and DRS-004/DRS-005 so any shard-key design respects it.

- **Files:** `spec/invariants.md`, `spec/behaviors/05-persistence-stratum.md`, `packages/ports/src/SqlTransaction.ts`, `spec/traceability.md`
- **Tests (write first):**
  - `pnpm run spec:verify:strict` passes with the new invariant id.
- **Acceptance:**
  - The invariant exists and is referenced from BEH-EA-035.
- **Spec refs:** BEH-EA-035, BEH-EA-058
- **Depends on:** —

**Recommended status:** `ready-for-agent`

### Workstream `oauth-callback-url-policy`

#### APS-002 — Protocol-relative callbackURL bypasses the trustedOrigins allowlist

`medium` · `security` · `oauth` · [.issues/medium/APS-002-auth-pentest-specialist.md](../../.issues/medium/APS-002-auth-pentest-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `9b3e42c`

Fixed by 9b3e42c (OAP-001/AP-001/PDR-001): the protocol-relative and backslash variants no longer count as relative paths.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:180` — The `//` and `/\` prefixes now fall through to the origin allowlist.
  ```ts
    if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
    const parsed = Option.fromNullOr(URL.parse(raw));
    return parsed.pipe(
      Option.filter((url) => trustedOrigins.includes(url.origin)),
      Option.match({ onNone: () => fallback, onSome: () => raw }),
    );
  ```
- `packages/oauth/test/OAuth.test.ts:802` — Regression test added by 9b3e42c.
  ```ts
      it.effect("OAP-001/AP-001: a scheme-relative //host callbackURL is never redirected to", () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: "//evil.example.com/phish",
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### TMS-003 — Open redirect: resolveCallbackURL accepts any '/'-prefixed value before the origin allowlist, including protocol-relative URLs

`medium` · `security` · `oauth` · [.issues/medium/TMS-003-threat-modeling-specialist.md](../../.issues/medium/TMS-003-threat-modeling-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `9b3e42c`

Same root cause and same fix as APS-002, closed by 9b3e42c.

**Evidence at HEAD:**

- `packages/oauth/src/OAuth.ts:180` — Same fix as APS-002.
  ```ts
    if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
    const parsed = Option.fromNullOr(URL.parse(raw));
    return parsed.pipe(
      Option.filter((url) => trustedOrigins.includes(url.origin)),
      Option.match({ onNone: () => fallback, onSome: () => raw }),
    );
  ```
- `packages/oauth/test/OAuth.test.ts:834` — The backslash variant is covered too.
  ```ts
      it.effect(
        "OAP-001/AP-001: a backslash-variant /\\host callbackURL is never redirected to",
        () =>
          Effect.gen(function* () {
            const oauth = yield* OAuth.OAuth;
            const { state } = yield* oauth.authorize("acme", {
              callbackURL: "/\\evil.example.com/phish",
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

#### PDR-006 — CallbackURL validation tests never exercise protocol-relative or backslash variants

`low` · `testing` · `oauth` · [.issues/low/PDR-006-philippe-de-ryck.md](../../.issues/low/PDR-006-philippe-de-ryck.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) · fixed by `9b3e42c`

9b3e42c added exactly the two regression cases this finding asks for. The optional `javascript:` case is not pinned. It is already rejected by the origin check (its origin is 'null'), so adding it is a nice-to-have in the MNA-004 test work, not a reopen.

**Evidence at HEAD:**

- `packages/oauth/test/OAuth.test.ts:802` — // case pinned.
  ```ts
      it.effect("OAP-001/AP-001: a scheme-relative //host callbackURL is never redirected to", () =>
        Effect.gen(function* () {
          const oauth = yield* OAuth.OAuth;
          const { state } = yield* oauth.authorize("acme", {
            callbackURL: "//evil.example.com/phish",
  ```
- `packages/oauth/test/OAuth.test.ts:834` — /\ case pinned.
  ```ts
      it.effect(
        "OAP-001/AP-001: a backslash-variant /\\host callbackURL is never redirected to",
        () =>
          Effect.gen(function* () {
            const oauth = yield* OAuth.OAuth;
            const { state } = yield* oauth.authorize("acme", {
              callbackURL: "/\\evil.example.com/phish",
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

### Workstream `api-path-param-conventions`

#### AVS-010 — Path-parameter naming follows two competing conventions

`info` · `api` · `oauth` · [.issues/info/AVS-010-api-design-versioning-specialist.md](../../.issues/info/AVS-010-api-design-versioning-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) · duplicate of **AVS-006**

Same root cause as AVS-006 (slice 10: no written path-parameter and id naming rule across contracts), and the finding itself says 'normalize in the same pre-publish sweep as AVS-006'. For oauth, the proposed rule (natural keys bare, surrogate keys `:singularId`) requires no change.

**Evidence at HEAD:**

- `packages/oauth/src/OAuthApi.ts:84` — `:provider` is a natural-key bare noun. Under the finding's own proposed rule it stays as is.
  ```ts
      HttpApiEndpoint.get("authorize", "/oauth/:provider/authorize", {
  ```

**Fix plan:** none (see verdict rationale).

**Recommended status:** `resolved`

## Closed without work

| ID | level | verdict | reason | evidence |
|---|---|---|---|---|
| NAM-008 | medium | ALREADY-FIXED | fixed by `e773cf1` | `packages/oauth/src/OAuth.ts:16` |
| APS-002 | medium | ALREADY-FIXED | fixed by `9b3e42c` | `packages/oauth/src/OAuth.ts:180` |
| TMS-003 | medium | ALREADY-FIXED | fixed by `9b3e42c` | `packages/oauth/src/OAuth.ts:180` |
| RRS-007 | medium | ALREADY-FIXED | fixed by `e773cf1` | `packages/oauth/src/OAuth.ts:250` |
| SFS-005 | low | WONTFIX-CANDIDATE | no actionable defect | `packages/oauth/src/OAuth.ts:313` |
| MA-006 | medium | DUPLICATE | duplicate of ESS-005 | `packages/oauth/src/OAuth.ts:323` |
| AH-002 | medium | ALREADY-FIXED | fixed by `e364411` | `packages/oauth/src/OAuth.ts:323` |
| JJS-005 | medium | DUPLICATE | duplicate of ESS-003 | `packages/oauth/src/OAuth.ts:323` |
| KRS-005 | medium | ALREADY-FIXED | fixed by `e364411` | `packages/oauth/src/OAuth.ts:323` |
| OAP-004 | medium | DUPLICATE | duplicate of ESS-003 | `packages/oauth/src/OAuth.ts:323` |
| OIT-005 | medium | DUPLICATE | duplicate of ESS-003 | `packages/oauth/src/OAuth.ts:323` |
| VB-004 | medium | ALREADY-FIXED | fixed by `e364411` | `packages/oauth/src/OAuth.ts:323` |
| AP-008 | low | DUPLICATE | duplicate of ESS-002 | `packages/oauth/src/OAuth.ts:323` |
| JR-010 | low | DUPLICATE | duplicate of ESS-002 | `packages/oauth/src/OAuth.ts:323` |
| AOMS-010 | low | ALREADY-FIXED | fixed by `fd8e5e9` | `packages/oauth/src/OAuth.ts:95` |
| OAP-007 | low | ALREADY-FIXED | fixed by `fd8e5e9` | `packages/oauth/src/OAuth.ts:95` |
| AOMS-004 | medium | DUPLICATE | duplicate of OIT-003 | `packages/oauth/src/OAuth.ts:356` |
| AP-003 | medium | DUPLICATE | duplicate of OIT-003 | `packages/oauth/src/OAuth.ts:356` |
| JJS-006 | low | DUPLICATE | duplicate of OIT-003 | `packages/oauth/src/OAuth.ts:356` |
| JR-008 | low | DUPLICATE | duplicate of OIT-003 | `packages/oauth/src/OAuth.ts:356` |
| OAP-006 | low | DUPLICATE | duplicate of OIT-003 | `packages/oauth/src/OAuth.ts:356` |
| VB-006 | low | DUPLICATE | duplicate of OIT-003 | `packages/oauth/src/OAuth.ts:356` |
| CWM-001 | high | DUPLICATE | duplicate of EP-004 | `packages/oauth/src/OAuth.ts:56` |
| BAM-011 | info | WONTFIX-CANDIDATE | no actionable defect | `packages/sql/src/CoreMigrations.ts:93` |
| RBS-008 | medium | ALREADY-FIXED | fixed by `a3b7255` | `packages/oauth/src/OAuth.ts:423` |
| AP-004 | medium | DUPLICATE | duplicate of OIT-001 | `packages/oauth/src/OAuth.ts:717` |
| APS-008 | low | DUPLICATE | duplicate of OIT-001 | `packages/oauth/src/OAuth.ts:717` |
| EEM-007 | low | DUPLICATE | duplicate of NAM-006 | `packages/oauth/src/OAuth.ts:798` |
| JR-003 | medium | DUPLICATE | duplicate of AP-005 | `packages/oauth/src/OAuthApi.ts:74` |
| OAP-003 | medium | DUPLICATE | duplicate of AP-005 | `packages/oauth/src/OAuthApi.ts:74` |
| AVS-010 | info | DUPLICATE | duplicate of AVS-006 | `packages/oauth/src/OAuthApi.ts:84` |
| PDR-006 | low | ALREADY-FIXED | fixed by `9b3e42c` | `packages/oauth/test/OAuth.test.ts:802` |

## Out-of-manifest observations (not filed; for the orchestrator)

- **SameSite=Strict session cookie on the OAuth landing redirect.** `packages/core/src/Sessions.ts:153` sets `sameSite: "strict"`, and the OAuth callback sets it on a 302 that belongs to a redirect chain started cross-site by the provider. Chromium treats that chain as cross-site for Strict cookies, so the first request to `callbackURL` may arrive **without** the session cookie (the user looks signed out until a same-site navigation). Worth a spec check against BEH-EA-055 and a real-browser BDD. Possible fix: land on a same-origin interstitial, or a meta-refresh 200, before the final redirect.
- **`isFlowPayload` uses `as Record<string, unknown>` casts** (OAuth.ts:144-146), a no-type-assertion violation not filed by any auditor. Folded into OIT-006's FlowPayloadSchema step.
- **`OAuthTokenAccess.layer` resolves every provider's discovery a second time at boot** (OAuthTokenAccess.ts:158). Folded into NAM-004's shared `OAuthProviders` registry step.
- **`packages/oauth/README.md` still says 'planned package… no line of source has shipped'.** It is the target for the AGA-005, NAM-005, FAMS-006 and OIT-007 docs and should be rewritten wholesale.
- **Callback failures render as JSON to a browser top-level navigation.** This is the documented convention (OAuthApi.ts header), but UX-hostile. It relates to AP-005 option C and is not re-litigated here.

## Cross-slice duplicates / links

- JR-010, AP-008 → **ESS-002** (slice 04, discovery cast). MA-006 → **ESS-005** (slice 07, Password.ts rate-limit casts). AVS-010 → **AVS-006** (slice 10).
- ECF-001 also covers `packages/jwt/src/verify.ts:83` (slice 04) and `packages/password/src/Password.ts:317` HIBP (slice 07).
- TSS-003 shares the `shared-constant-time-compare` helper with ACS-002/MLO-004/TSS-005 (slice 01) and BPAS-008/CB-007/WPS-008/HSK-010 (slice 10).
- MNA-003 shares decision ticket 17 and the bearer DTO with MNA-001 (slice 07). EP-004 shares ticket 18 with EP-001 and DRS-001 (slice 05). OCM-001's implementation lives in api-key (slice 09) with OCM-006/OCM-007 (slice 04).
- ACS-004's residual (Jwt.findKey kty) should coordinate with slice 04's AOMS-005 (multi-alg) and the Jwt.ts kid-fallback items (AP-002/VB-003/ESS-007/ACS-003, which fd8e5e9 already fixed).
- DRS-006's invariant should be referenced by DRS-001/DRS-004/DRS-005.
