# ADR-EA-038: Sign-In Completion and Sign-Up Are Core Modules; a Session for a Proven Credential Is Minted Only From a Clearance

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-038 |
> | Revision | 1.1 |
> | Effective Date | 2026-10-13 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-10-13): Initial release (architecture plan 01) <br> 1.1 (2026-10-13): every sign-in and sign-up site is migrated and guarded; status Accepted — implemented |

---

## Context

Eight flows hand-wrote "look up the user, run the gate, run the `BeforeSignIn` veto, run the `BeforeSessionIssue` divert, mint the session, announce it", and six hand-wrote "run the `BeforeSignUp` veto, create, verify and link in a transaction, announce it". The copies drifted: SAML's divert lost its `amr`; a SAML sign-in completed by a second factor lost its Single Logout record, its role mapping and its tenant; only password announced a suspended refusal; a user erased between the credential proof and the session had five different answers (two of them a 500); SCIM skipped `BeforeSignUp` and `auth.user.created`, and its rollback called a delete that a legal-hold tap could veto, stranding a half-provisioned user; password's first session skipped the sign-in veto and divert altogether.

The suspension gate was deliberately a plain call and not a hook ([BEH-EA-046](../behaviors/06-domain-users-accounts.md)), because a tap can be left out of a composition. The same argument applies to the whole sequence: a rule that every flow must follow belongs in one function the compiler makes unavoidable, not in eight copies.

## Decision

**1. `SignIn` is the one implementation of sign-in completion.** `@awthaq/core`'s `SignIn.make` (resolved once inside a plugin's `make`, like `MailDispatch.make`, so no host wires a new layer) returns `clear(attempt)`, which does the lookup, the gate, the `BeforeSignIn` veto and the `BeforeSessionIssue` divert and returns a branded `Clearance`; `issue(clearance)`, which accepts nothing else and mints the session, runs the first factor's continuation, publishes `auth.user.signedIn` and runs `AfterSignIn`; `complete`, which is `clear` then `issue`; and `resume`, the divert owner's entry. The `Clearance` constructor is package-private (`internal/` is outside core's exports map), so a session for a proven credential cannot be minted without having passed the gate. The `amr` the divert sees is the `amr` the session records, and `SessionIssueContext.amr` is required.

**2. A divert carries a handoff.** The divert context gains `handoff { tenantId?, continuation? }`: the ambient tenant when the first factor cleared, and an optional typed *continuation* (work the first factor owes once its session exists: SAML's Single Logout record and role mapping). A divert owner that later completes the sign-in itself (`@awthaq/two-factor`) stores the handoff with its challenge and returns it to `SignIn.resume`, which re-runs the gate only, restores the tenant, and `issue` runs the continuation. Continuations are an aggregating registry (ADR-EA-012) carried by `Hooks.HooksLive`; `SignIn.continuation({ id, kind, payload, make })` is the typed front door.

**3. `SignUp` is the one implementation of user creation for every sign-up.** `SignUp.vet(application)` runs `BeforeSignUp` and returns a branded `Vetted`; `create`, `createWith` and `createSignedIn` accept nothing else. They own the transaction (create, verify and link are one unit, built on `Users.createWith` so a backend without transactions abandons the half-made user too), one `IdentityTaken` error, and the after-commit announcements (`auth.user.created`, `AfterSignUp`). A sign-up is any flow in which a person or a directory causes an account to exist: password, OAuth first login, SAML first login, magic link, email OTP and SCIM. Operator migrations (`UserImport.importUser`, `awthaq seed admin`) are not sign-ups and are exempt: a million-row import must not fire a million welcome mails or be vetoed by an application's sign-up policy.

**4. Uniform policies, decided once.** A user who vanished between proof and issue is a refusal (`SignIn/UserGone`) that each flow maps onto its own uniform answer, never a defect. A suspended refusal publishes `auth.user.signInFailed { reason: "suspended" }` for every strategy and for `resume`. A session minted at sign-up is a cleared sign-in (gate, veto, divert, `auth.user.signedIn`, `AfterSignIn`); password's reveal sign-up keeps "user and session in one transaction" ([BEH-EA-113](../behaviors/15-password.md)) through `createSignedIn`. A host's `BeforeSignUp` taps see SCIM provisioning under the strategy `scim:<organizationId>:<connectionId>`, and a veto answers 403. Neither module dies on `StoreUnavailable` (ADR-EA-028).

**5. A static test seals the seam.** `core/test/SignInSeams.test.ts` fails on `Sessions.issue`, `Users.create`/`createOrGet`, `SignIn.resume` and the sign-in/sign-up hook `run`s outside a counted allowlist, each entry carrying why.

## Consequences

**Positive**: one place to change or audit sign-in policy; the drift bugs above cannot recur structurally; a SAML session completed by a second factor keeps `fed`, its Single Logout record, its role mapping and its tenant; roughly 1,400 lines of per-plugin hook tests become cases at two interfaces plus one wiring probe per plugin.

**Negative**: plugins depend on two more core modules; magic-link, email OTP and SCIM now require the `SqlTransaction` port; password sign-up's contract gains `TwoFactorRequired`; a host's `BeforeSignUp` taps see SCIM provisioning, and its `BeforeSignIn` taps see password sign-ups.

## Alternatives considered

- **(a) A "finalisation" hook tap.** Rejected for the reason the gate is not a hook: a tap can be left out.
- **(b) Put the sequence inside `Sessions.issue`.** Rejected: `issue` also serves rotation and impersonation, neither of which is "a first factor just succeeded" (BCR-004).
- **(c) A `Context.Service` per module.** Rejected in favour of `make`, which needs no host wiring and matches `Channel.make` and `MailDispatch.make`.
- **(d) One `complete` only.** Rejected: device authorization must consume its grant between clearing and issuing.
- **(e) Move SAML role mapping before the divert.** Superseded by continuations, which also restore the Single Logout record and the tenant.

## Related

[ADR-EA-033](033-hook-registries-per-composition.md) (Decision 5 is made true by this ADR), [ADR-EA-028](028-infrastructure-error-policy.md) (no `orDie` on sign-in or sign-up), [ADR-EA-037](037-unit-of-work-releases-events-on-commit.md) (events follow the commit), [ADR-EA-031](031-erasure-registry-and-retention.md), [ADR-EA-012](012-slots-exclusive-registries-aggregate.md) (continuations aggregate).
