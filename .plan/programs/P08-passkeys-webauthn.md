# P08 — Passkeys / WebAuthn

Phase 2 · 25 open issues to fix (16 medium, 8 low, 1 info) · 17 closed by validation · ~58h summed per-issue estimate (upper bound) · 2 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `passkey-ceremony-policy` — Ceremony policy: origins, cross-origin, UV, timeouts

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~8h · depends on workstreams: `passkey-challenge-store-hardening`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CB-003](../slices/10-passkey-admin.md) | medium | security | PARTIAL | S | — | Reject cross-origin ceremonies in the plugin pre-check for all three ceremonies unless an explicit embedded-origin policy is configured. |
| [MNA-007](../slices/10-passkey-admin.md) | medium | correctness | PARTIAL | S | — | Treat configured platform (android:apk-key-hash:) origins as exact-match origins exempt from the web rpId-suffix check, consistently across all ceremonies. |
| [TC-003](../slices/10-passkey-admin.md) | medium | api | CONFIRMED | M | — | Expose ceremony timeout (≤ challenge TTL), hints and extension passthrough on the port and PasskeyConfig; set them explicitly in every options generator. |
| [CB-009](../slices/10-passkey-admin.md) | low | security | PARTIAL | S | WPS-003 | Make the conditional exemption policy-driven: conditional create is unavailable when the RP requires UV. |
| [HSK-007](../slices/10-passkey-admin.md) | low | dx | CONFIRMED | S | — | Document the discoverable-credential (CTAP2.1+ / platform) requirement of the conditional ceremony. |

Closed by validation in this workstream: BPAS-005 (ALREADY-FIXED), TC-005 (ALREADY-FIXED)

## `passkey-enumeration-safety` — Enumeration safety of the anonymous authenticate ceremony

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~5h · depends on workstreams: `passkey-challenge-store-hardening`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [TC-001](../slices/10-passkey-admin.md) | medium | security | CONFIRMED | M | — | Keep username-first but make its response indistinguishable for unknown emails via deterministic decoy descriptors, and rate-limit the endpoint. |
| [TSS-004](../slices/10-passkey-admin.md) | medium | security | CONFIRMED | S | — | Equalize cost on the unknown-credential path with a decoy verification, mirroring Password's dummyHash. |

Closed by validation in this workstream: CB-006 (DUPLICATE → TC-001), WPS-007 (DUPLICATE → TC-001)

## `passkey-challenge-store-hardening` — ChallengeStore correctness and hygiene

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [WPS-003](../slices/10-passkey-admin.md) | medium | correctness | CONFIRMED | S | — | Stop probing both registration scopes: the verify payload names its ceremony, and only that scope is consumed. |
| [WPS-005](../slices/10-passkey-admin.md) | medium | performance | CONFIRMED | S | — | Reclaim expired challenges opportunistically on issue, expose an explicit sweep, and throttle the anonymous options endpoint. |
| [BPAS-008](../slices/10-passkey-admin.md) | low | security | CONFIRMED | S | — | Route the memory/SQL final comparison through the module's constantTimeEqual over decoded bytes. |
| [WPS-009](../slices/10-passkey-admin.md) | low | correctness | CONFIRMED | S | — | State per-backend guarantees in the type and prove them with a cross-backend conformance suite. |

Closed by validation in this workstream: CB-007 (DUPLICATE → BPAS-008), WPS-008 (DUPLICATE → BPAS-008), HSK-010 (DUPLICATE → BPAS-008)

## `passkey-counter-anomaly-policy` — Counter anomaly: make the decided 'log + step-up' policy real

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~8h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CB-004](../slices/10-passkey-admin.md) | medium | correctness | CONFIRMED | M | — | Move counter-regression detection out of the library into the plugin so the decided 'log + step-up' policy actually runs, with an optional strict mode. |
| [WPS-006](../slices/10-passkey-admin.md) | medium | security | PARTIAL | M | CB-004 | Persist anomaly state on the credential and let policy act on it; raise PasskeyCounterAnomaly under the strict policy (CB-004). |

Closed by validation in this workstream: HSK-004 (DUPLICATE → WPS-006), BPAS-009 (DUPLICATE → WPS-006)

## `webauthn-attestation-policy` — Attestation conveyance that means something

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~5h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [HSK-002](../slices/09-ports-apikey-cli.md) | medium | security | CONFIRMED ⚖️ decision | M | — | (Recommended option B) Surface attestation format and add an optional AAGUID/format trust policy; warn when conveyance is requested without a policy. |
| [HSK-006](../slices/09-ports-apikey-cli.md) | info | api | CONFIRMED | S | HSK-002 | Add 'indirect' to AttestationConveyance. |

Closed by validation in this workstream: TC-006 (DUPLICATE → HSK-002), CB-008 (DUPLICATE → HSK-002)

## `webauthn-user-presence` — Enforce UP on ordinary passkey registrations

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CB-002](../slices/09-ports-apikey-cli.md) | medium | security | PARTIAL | M | — | Enforce UP on ordinary registrations by letting the plugin choose requireUserPresence per ceremony; surface userPresent. |

Closed by validation in this workstream: BPAS-004 (DUPLICATE → CB-002)

## `passkey-wire-contract` — Passkey wire contract fidelity

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~11h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AVS-003](../slices/10-passkey-admin.md) | medium | api | CONFIRMED | M | — | Model the WebAuthn options dictionaries as Schemas in the contract and use them as success types. |
| [HSK-003](../slices/10-passkey-admin.md) | medium | dx | CONFIRMED | S | — | Carry browser-reported transports end-to-end and surface transports/aaguid in the credential DTO. |
| [AVS-006](../slices/10-passkey-admin.md) | low | api | CONFIRMED | S | — | Use HttpApiEndpoint.delete and a resource-action id for the passkey credential delete. |
| [HSK-008](../slices/10-passkey-admin.md) | low | testing | CONFIRMED | M | HSK-003 | Add real-shaped fixtures (packed self-attestation, non-zero AAGUID, transports) and end-to-end plugin tests over the real port. |
| [WPS-010](../slices/10-passkey-admin.md) | low | correctness | CONFIRMED | S | — | Make create collision-aware and identical across layers with a typed error. |

## `passkey-user-handle` — Stable per-user WebAuthn user handle and Signals

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~8h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BPAS-003](../slices/10-passkey-admin.md) | medium | correctness | CONFIRMED | M | — | Mint one random WebAuthn user handle per user, persist it in a plugin table, send it in every registration ceremony, store exactly it on the credential, and cross-check assertion userHandle. |
| [BPAS-006](../slices/10-passkey-admin.md) | medium | dx | CONFIRMED | M | BPAS-003 | Add WebAuthn L3 Signals to the client, fed by an enumeration-safe server surface keyed on the (now stable) user handle. |

Closed by validation in this workstream: HSK-001 (DUPLICATE → BPAS-003), TC-002 (DUPLICATE → BPAS-003), WPS-002 (DUPLICATE → BPAS-003), CB-005 (DUPLICATE → BPAS-003)

## `passkey-browser-signals` — WebAuthn Signals API in @awthaq/client

Slices: [13-repo-features-tooling](../slices/13-repo-features-tooling.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [TC-004](../slices/13-repo-features-tooling.md) | medium | dx | PARTIAL ⚖️ decision | M | — | Add a typed, fire-and-forget Signals layer to @awthaq/client's passkeyClient: signalAllAcceptedCredentials after delete and after every successful authenticate, signalCurrentUserDetails after a profile-name change; expose signal capabilities in getClientCapabilities. Server supplies the needed rpId/userHandle/credential-id list. |

## `passkey-docs` — Passkey documentation truthfulness

Slices: [10-passkey-admin](../slices/10-passkey-admin.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [TC-007](../slices/10-passkey-admin.md) | low | docs | CONFIRMED | S | DTWS-002, DTWS-001 | Rewrite the passkey README and passkey spec status text from the shipped code, including a Recovery section. |

Closed by validation in this workstream: WPS-012 (ALREADY-FIXED)

