# P16 — Native, bearer & machine identity

Phase 3 · 16 open issues to fix (8 high, 7 medium, 1 info) · 12 closed by validation · ~120h summed per-issue estimate (upper bound) · 2 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `apikey-machine-identity` — @awthaq/api-key: API keys + client_credentials service identity (decision 10)

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~24h · depends on workstreams: `tsconfig-paths-drift`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MAPS-003](../slices/09-ports-apikey-cli.md) | high | architecture | CONFIRMED | L | OCM-002 | Give ServicePrincipal a construction path: client_credentials M2M clients in @awthaq/api-key minting short-lived JWTs via @awthaq/jwt, verified back into ServicePrincipal. |
| [OCM-002](../slices/09-ports-apikey-cli.md) | high | security | CONFIRMED | L | — | Implement the long-lived API-key credential kind of @awthaq/api-key exactly as decision 10 specifies, and make it a third Authentication scheme. |

Closed by validation in this workstream: SCP-002 (DUPLICATE → OCM-002), AR-006 (DUPLICATE → MAPS-003), SMS-008-secrets-management-specialist (DUPLICATE → OCM-002), TRBS-009 (DUPLICATE → OCM-002)

## `bearer-credential-extensibility` — Bearer credential seam: JWT re-entry (decision 33) + multi-contributor registry

Slices: [06-server-api](../slices/06-server-api.md) · ~16h · depends on workstreams: `m2m-identity (MAPS-003, slice 09) for the api-key contributor`, `per-request-session-cache`, `session-rotation-delivery`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MAPS-001](../slices/06-server-api.md) | high | architecture | CONFIRMED | L | TS-003-tim-smart, PIL-005 | Implement decision 33 (stateless JWT-as-bearer): an optional `BearerCredentialResolver` seam in Authentication, opted into by @awthaq/jwt via JwtConfig.acceptAsBearer, with audience scoping for downstream-only tokens. |
| [MAPS-004](../slices/06-server-api.md) | medium | architecture | CONFIRMED ⚖️ decision | M | MAPS-001, MAPS-003 | Generalize decision 33's single BearerCredentialResolver into an ordered, plugin-contributed registry of bearer resolvers, so jwt and api-key (and later SCIM) can each claim bearer credentials without editing @awthaq/api or @awthaq/server. |

Closed by validation in this workstream: JR-004 (DUPLICATE → MAPS-001), AGA-003 (DUPLICATE → MAPS-001), VB-008 (DUPLICATE → MAPS-001)

## `native-session-bootstrap` — Native/mobile OAuth return leg (decision ticket 17)

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~16h · depends on workstreams: `oauth-callback-http-hardening`, `oauth-oidc-claims-integrity`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MNA-003](../slices/03-oauth-flow.md) | high | architecture | CONFIRMED | L | — | Implement decision ticket 17: native-mode authorize, an exchange code minted at callback, and a JSON redemption endpoint returning the session token. |
| [MNA-004](../slices/03-oauth-flow.md) | high | dx | CONFIRMED | M | MNA-003 | Add an explicit native-redirect allowlist matched on the full serialized scheme+authority(+path prefix) for non-http(s) URLs, and log when a requested callbackURL is discarded. |

## `jwt-stateless-bearer-reentry` — Stateless JWT-as-bearer strategy (wayfinder 33)

Slices: [04-oauth-provider-jwt](../slices/04-oauth-provider-jwt.md) · ~12h · depends on workstreams: `jwt-claims-codec-hardening`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [NAM-001](../slices/04-oauth-provider-jwt.md) | high | architecture | CONFIRMED | L | VB-005 | Implement .scratch/resolve-ready-for-human-findings/issues/33-stateless-jwt-session-strategy.md verbatim: a `BearerCredentialResolver` slot on `Authentication`, a default-off `JwtConfig.acceptAsBearer`, `signJWT({ audience })`, and a README stateless recipe. |

Closed by validation in this workstream: IC-008 (DUPLICATE → NAM-001)

## `m2m-client-credentials` — client_credentials in packages/api-key (decision ticket 10)

Slices: [03-oauth-flow](../slices/03-oauth-flow.md) · ~32h · depends on workstreams: `shared-constant-time-compare`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [OCM-001](../slices/03-oauth-flow.md) | high | architecture | CONFIRMED | XL | — | Implement ticket 10's M2M half in packages/api-key. Nothing changes in packages/oauth. |

## `native-token-delivery` — Opt-in bearer token delivery for native clients (ticket 17)

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MNA-001](../slices/07-password-mfa.md) | high | api | CONFIRMED | M | — | Implement ticket 17's opt-in bearer delivery for every session-minting response. |

## `device-authorization-design` — Device-authorization security parameters and scenarios

Slices: [12-spec](../slices/12-spec.md) · ~2h · depends on workstreams: `cli-session-login-carveout`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DAG-004](../slices/12-spec.md) | medium | security | CONFIRMED | S | CTA-002 | Now that decision 06 makes the device plugin the CLI's login backend, write its security parameters into the model doc (and later BEHs): user-code alphabet/length/entropy, TTL, normalization, constant-time lookup, RateLimiter rules on /device/code, /device/token and the approval endpoint. |
| [DAG-007](../slices/12-spec.md) | medium | testing | CONFIRMED | S | DAG-004 | Author the device-authorization feature file (scenarios before code) and its traceability, registered as @skip @unwired until the plugin exists. |

Closed by validation in this workstream: DAG-006 (WONTFIX-CANDIDATE)

## `client-native-bearer-mode` — Client bearer/native mode (token store + delivery header)

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MNA-006](../slices/11-frontend-next-react-client.md) | medium | dx | CONFIRMED | M | MNA-001 | Ship a client-side bearer mode: a pluggable token-store service, a transformClient that attaches it, and the request header that opts into ticket 17's body token delivery; document the React Native recipe. |

## `device-authorization-grant` — Normative RFC 8628 spec before Phase 3

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DAG-005](../slices/13-repo-features-tooling.md) | medium | architecture | CONFIRMED | M | — | Graduate the better-auth §A.1–A.6 polling state machine into awthaq's own spec/models/13-device-authorization.md as a 'Design constraints' section (normative intent for Phase 3), adding RFC 8628 §3.5's client slow_down +5 s duty and the BEH-EA-208/CLI-login linkage; allocate a BEH-EA range when the plugin enters a roadmap milestone. |

Closed by validation in this workstream: DAG-001 (DUPLICATE → DAG-005)

## `m2m-client-secret-lifecycle` — API-key / client-secret rotation and transport ADR

Slices: [12-spec](../slices/12-spec.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [OCM-005](../slices/12-spec.md) | medium | compliance | CONFIRMED ⚖️ decision | S | OCM-002 (cross-slice: api-key build) | Decide and record (ADR-EA-022) API-key and client-secret rotation with a bounded dual-validity grace window and the transport header, then carry it into the api-key build (OCM-002, cross-slice). |

## `session-delivery` — Shared session delivery (cookie vs bearer)

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [WPS-004](../slices/10-passkey-admin.md) | medium | compliance | CONFIRMED | M | MNA-001 | Introduce one shared session-delivery helper (owned by @awthaq/api/server, implementing ticket 17's cookie-or-bearer choice) and route every session-minting handler through it; amend BEH-EA-131 accordingly. |

## `native-bearer-bootstrap` — Native/mobile bearer path: document what exists now, finish issuance under MNA-001

Slices: [12-spec](../slices/12-spec.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MNA-009](../slices/12-spec.md) | info | docs | PARTIAL | S | — | Doc-side only here: amend BEH-EA-066's native-client paragraph to state what exists (bearer resolution + `set-auth-token` rotation header) and what doesn't (token issuance → MNA-001 per decision ticket 17; `{ csrf: false }` variant → BEH-EA-171; magic-link unimplemented). Rewrite it again as a positive statement when MNA-001 lands. |

