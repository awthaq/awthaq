# ADR-EA-043: Federated Identity Resolution Is a Core Module; a Lost Linking Race Resolves to the Anchor's User

> **Document Control**
>
> | Property | Value |
> |---|---|
> | Document ID | EFAUTH-ADR-043 |
> | Revision | 1.1 |
> | Effective Date | 2026-10-18 |
> | Status | Accepted — implemented |
> | Author | awthaq Engineering |
> | Classification | Architectural Decision |
> | Change History | 1.0 (2026-10-18): Initial release (architecture plan 14) <br> 1.1 (2026-10-18): OAuth and SAML are migrated and the seam is guarded (`SignInSeams.test.ts`); status Accepted — implemented |

---

## Context

A federated sign-in (an OAuth provider, an organization's OIDC connection, an organization's SAML connection) ends with one question: which local user is this external identity? `OAuth.callbackFlow` and `Saml.signIn` each answered it by hand with the same five steps: read the account anchored at `(providerId, subject, issuer)` ([INV-EA-015](../invariants.md#inv-ea-015-the-provider-subject-issuer-tuple-is-unique-per-account-and-the-oauth-state--pkce-verifier-is-single-use)), read the local holder of the asserted email, decide whether to link, create the user through `SignUp`, hand the user to `SignIn`.

Each step is a read followed by a write on another row, so each pair is a race, and neither copy owned it. Two requests that proved the same `(providerId, subject, issuer)` collided on a unique constraint and each plugin mapped the loss to whatever was nearest: SAML answered a 500 (`AccountAlreadyLinked` and `IdentityTaken{Account}` became defects) or `emailInUse`; OAuth answered `OAuthCallbackFailed` or `AccountExists{providers: ["acme"]}`, telling the person to sign in with the provider they had just used. Further drift: OAuth's explicit link of an identity already linked to another user reported success, linked nothing and overwrote that user's provider tokens; OAuth's returning sign-in died when the account was unlinked between its read and its token refresh; SAML never marked a created user verified while OAuth did (AOMS-007); SAML's email trust was not bounded to the connection's claimed domains; nothing announced a link.

[ADR-EA-038](038-sign-in-and-sign-up-are-core-modules.md)'s plan listed linking as a non-goal. That was a statement about `SignUp`'s scope and stands: linking is not a sign-up. What it did not consider is that the decision between linking and signing up is one policy, and splitting it across the seam is what left the race unowned: `SignUp` cannot recover from `IdentityTaken` because it does not know an anchor exists, and the plugin sees only a kind.

## Decision

**1. `FederatedIdentity.make` (`resolve`, `attach`) is the one implementation of "a proven external identity becomes a local user".** It sits above `SignUp` in the same stratum as `SignIn` and `SignUp`, and *uses* `SignUp` for one of its three outcomes (`Created`). Plugins pass data (an `ExternalIdentity`) and a verdict (`EmailTrust`) and receive a user id or a typed refusal. Nothing about accounts, holders, sign-ups or races crosses the seam.

**2. The trust rule is the module's; the verdict is the caller's.** Auto-link needs a trusted party, the address inside the trusted domains, the claim verified and the local address verified. Verify-on-create needs the first three. A party is trusted for any address it verifies (`trusted("any")`, a named OAuth provider) or for a list of domains (`trusted(domains)`, a connection's claimed domains, [BEH-EA-317](../behaviors/29-saml-sp.md); an empty list links nothing). Untrusted never links and never verifies.

**3. A lost race is resolved by one re-read of the anchor; a second loss is the typed `Contended` refusal.** Both requests proved the same identity, so the loser's own plan (create, auto-link) is moot once the anchor exists: it signs in as the anchor's user, exactly what the same request would have got a moment later. `Contended` is not an outage ([ADR-EA-028](028-infrastructure-error-policy.md)) and not a defect (ADR-EA-038 decision 4); each flow maps it to its uniform refusal.

**4. The explicit link refuses an identity linked to another user and is idempotent for the same user.** A vanished target user is `TargetGone`.

**5. A link the module makes is announced.** `auth.account.linked { userId, providerId, via }` (no subject, [ADR-EA-029](029-event-pii-posture.md)) is published for an auto-link and a new explicit link.

**6. A static test seals the seam.** No file under `oauth/src`, `saml/src` or `organization/src` reads an anchor, links an account or makes a `SignUp` (`SignInSeams.test.ts`).

## Alternatives considered

- **(a) Fix each plugin's catch in place.** Done for SAML as a hotfix (phase 0) and rejected as the end state: the divergences and any further trust source would stay.
- **(b) Widen `SignUp` with a `linkOrCreate`.** Rejected: linking is not a sign-up (ADR-EA-038 decision 3); the resolver uses `SignUp` instead.
- **(c) One serializable transaction around the whole resolution.** Rejected: it needs dialect-specific isolation, turns every federated sign-in into a retry loop on serialization failure, and the unique constraints plus one re-read already give the right answer.
- **(d) A `Context.Service`.** Rejected as in ADR-EA-038 (c): `make` needs no host wiring.
- **(e) Map the second loss to `StoreUnavailable`.** Rejected: it is not an outage (ADR-EA-028).

## Consequences

**Positive**: one place for the federated linking policy; the race class cannot recur per plugin; about 16 plugin tests become one suite over memory and SQL; organization OIDC connections can be trusted like SAML ones.

**Negative**: a create race runs `BeforeSignUp` twice (only the winner's unit commits and announces); a trusting SAML connection stops auto-linking addresses outside its claimed domains; a new event tag reaches webhook consumers.

## Related

[ADR-EA-038](038-sign-in-and-sign-up-are-core-modules.md) (extended), [ADR-EA-028](028-infrastructure-error-policy.md), [ADR-EA-029](029-event-pii-posture.md), [ADR-EA-041](041-domain-store-ports.md) (the atomic primitives `AccountStore.insertIfAbsent` and `UserStore.insertOrHolder` the re-read relies on), [BEH-EA-338](../behaviors/06-domain-users-accounts.md#beh-ea-338-a-federated-sign-in-resolves-its-identity-through-federatedidentity-and-a-lost-race-resolves-to-the-anchors-user), [BEH-EA-317](../behaviors/29-saml-sp.md).
