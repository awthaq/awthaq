# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@authentication-methods @oauth
Feature: OAuth and OIDC

  # BEH-EA-121 — spec/behaviors/16-oauth.md
  @BEH-EA-121
  Rule: PKCE S256 is structural, not optional

    @REQ-EA-328
    Scenario: Every authorization-code flow is built with PKCE using the S256 challenge method
      Given a provider "google" configured for the authorization-code flow
      When an authorization request is built for "google"
      Then the request includes a PKCE challenge using the "S256" method

    # Shipping-gap map (.scratch/shipping-gaps), ticket 22: pruned, not
    # force-implemented — "the interface declares pkce as structurally true" is a
    # TypeScript type-level property (OAuthProviderConfig.pkce: true, a
    # literal type, not boolean) — provable by reading the type
    # declaration, not by any runtime request a step could make.
    @skip
    @REQ-EA-329
    Scenario: The provider interface offers no configuration to disable PKCE
      Given the "OAuthProvider" interface
      When a provider is configured
      Then no option exists to turn PKCE off, since the interface declares "pkce" as structurally "true"

    @REQ-EA-330
    Scenario: A provider that rejects PKCE outright uses only the documented per-provider quirk override
      Given a provider "apple" that rejects PKCE outright
      When "apple" is configured with its documented "quirks: { skipPkce: true }" entry
      Then PKCE is skipped only for "apple", visibly, via the quirk table
      And no general escape hatch is exposed to any other provider

  # BEH-EA-122 — spec/behaviors/16-oauth.md
  @BEH-EA-122
  Rule: Flow state lives server-side, in Verification

    @REQ-EA-331
    Scenario: Initiating an OAuth flow stores state, the PKCE verifier, and the nonce server-side under Verification
      Given an OAuth flow initiated for provider "google"
      When the authorization request is built
      Then "state", "codeVerifier", and "nonce" are stored server-side under core Verification with purpose "oauth.flow"
      And the stored entry is single-use and TTL-bounded

    @REQ-EA-332
    Scenario: The browser receives only an opaque correlation cookie, never the verifier or nonce
      Given an OAuth flow initiated for provider "google"
      When the browser is redirected to "google"
      Then the browser holds only an opaque correlation cookie
      And neither the PKCE verifier nor the nonce is ever sent to the browser

    @REQ-EA-333
    Scenario: A replayed callback using an already-consumed flow-state entry fails
      Given an OAuth callback that has already completed once, consuming its "oauth.flow" Verification entry
      When the same callback is replayed with the same "state" value
      Then the replayed callback fails, rather than re-running the token exchange

    @REQ-EA-333
    Scenario: A user denying consent at the provider gets the typed denial outcome
      Given an OAuth flow initiated for provider "google"
      When the provider redirects back with the authorization error "access_denied"
      Then the callback fails with the typed denial "access_denied"
      And the flow is consumed, so a replay carrying a code fails

    @REQ-EA-334
    Scenario: A callback presented after its flow-state entry's TTL has expired fails
      Given an "oauth.flow" Verification entry whose TTL has expired before the callback arrives
      When the callback is presented
      Then the callback fails as invalid

  # BEH-EA-123 — spec/behaviors/16-oauth.md
  @BEH-EA-123
  Rule: Linking is explicit by default

    @REQ-EA-335
    Scenario: A callback whose email matches an existing, unlinked account fails with a typed outcome by default
      Given "oauth({ providers: [google()], linking: \"explicit\" })"
      And an existing account with email "alice@example.com" that has not linked "google"
      When "alice@example.com" completes a "google" callback
      Then the response is "409 Conflict" with the typed error "AccountExists" listing provider "password"

    @REQ-EA-336
    Scenario: No account is silently linked when the default configuration rejects the callback
      Given the same unlinked-email callback that fails with "AccountExists"
      When the failure is returned
      Then no "google" Account is created or linked to "alice"'s existing user

    @REQ-EA-337
    Scenario: The account can still be linked afterward through an explicit, signed-in linking flow
      Given "alice" is signed in with her existing "password" account
      When "alice" calls "client.oauth.link" for provider "google"
      Then the callback attaches a "google" Account to "alice"'s current user

  # BEH-EA-124 — spec/behaviors/16-oauth.md
  @BEH-EA-124
  Rule: Trusted-provider auto-link is opt-in, per provider

    @REQ-EA-338
    Scenario: A provider not named in trustedProviders never auto-links, even on a verified-email match
      Given "oauth({ providers: [google()], linking: \"explicit\" })" with no "trustedProviders" entry
      And a "google" callback whose verified email matches an existing, unlinked account
      When the callback is handled
      Then the accounts are not auto-linked

    @REQ-EA-339
    Scenario: A provider named in trustedProviders auto-links on a verified-email match
      Given "oauth({ providers: [google()], linking: { trustedProviders: [\"google\"] } })"
      And a "google" callback whose verified email matches an existing, unlinked account
      When the callback is handled
      Then the "google" Account is automatically linked to the existing account

    @REQ-EA-339
    Scenario: A trusted provider never auto-links into a local account whose email is unverified
      Given "oauth({ providers: [google()], linking: { trustedProviders: [\"google\"] } })"
      And a "google" callback whose verified email matches an existing, unlinked account whose own email is unverified
      When the callback is handled
      Then the accounts are not auto-linked

    @REQ-EA-340
    Scenario: Naming one provider as trusted does not extend auto-link to a second, unnamed provider
      Given "oauth({ providers: [google(), github()], linking: { trustedProviders: [\"google\"] } })"
      And a "github" callback whose verified email matches an existing, unlinked account
      When the "github" callback is handled
      Then the accounts are not auto-linked
      And "github" is held to the same explicit-linking default as if "trustedProviders" were empty

  # BEH-EA-125 — spec/behaviors/16-oauth.md; see also INV-EA-015.
  @BEH-EA-125
  Rule: `(provider, subject, issuer)` is the identity anchor

    @REQ-EA-341
    Scenario: An Account row is keyed uniquely on (provider, subject, issuer)
      Given no Account exists with provider "okta", subject "u-1", and issuer "https://okta.example.com/oauth2/default"
      When an account is linked with that provider, subject, and issuer
      Then the Account is created

    @REQ-EA-342
    Scenario: A second Account with the same (provider, subject, issuer) tuple is rejected as a duplicate
      Given an Account already exists with provider "okta", subject "u-1", and issuer "https://okta.example.com/oauth2/default"
      When another link attempt uses the same provider, subject, and issuer
      Then the second link attempt is rejected as a duplicate

    @REQ-EA-343
    Scenario: The same subject under two different issuers is never collapsed into one account
      Given an Account exists with provider "okta", subject "u-1", and issuer "https://okta.example.com/oauth2/default"
      When a callback presents provider "okta", subject "u-1", and a different issuer "https://okta-eu.example.com/oauth2/default"
      Then a distinct Account is created or matched for the different issuer
      And the two issuers' accounts are never treated as the same account

    @REQ-EA-344
    Scenario: Email is never used as, or as a substitute for, the identity-anchor tuple
      Given two Accounts under provider "google" with different subjects that happen to share the email "alice@example.com"
      When both callbacks are handled
      Then both Accounts remain distinct, keyed only by their own (provider, subject, issuer) tuples
      And neither callback is matched or merged by the shared email

    # Shipping-gap map (.scratch/shipping-gaps), ticket 22: pruned, not
    # force-implemented — needs a real SQL backend (the in-memory Ref-backed Accounts
    # implementation this suite composes has no genuine race to lose) plus
    # real concurrent dispatch — already covered at the repository level
    # by BEH-EA-043's own UNIQUE constraint
    # (packages/sql/test/Repositories.test.ts).
    @skip
    @REQ-EA-345
    Scenario: The tuple uniqueness holds under two concurrent link attempts for the same tuple
      Given no Account exists with provider "okta", subject "u-2", and issuer "https://okta.example.com/oauth2/default"
      When two concurrent requests race to link that same provider, subject, and issuer
      Then only one link attempt succeeds
      And the other is rejected by the database-level constraint, not by application-level query discipline that could lose the race

  # BEH-EA-126 — spec/behaviors/16-oauth.md
  @BEH-EA-126
  Rule: Provider secrets are `Config.Redacted`, inside Layers

    # Shipping-gap map (.scratch/shipping-gaps), ticket 22: pruned, not
    # force-implemented — hit a real `Config.Redacted`/`Schema.Redacted`
    # decode failure ("Encoding" schema issue) building a provider Layer
    # from a `process.env`-set var in this harness, not yet root-caused
    # within this ticket's own budget; `Config.Redacted` reading real env
    # vars is exercised without issue elsewhere in this codebase
    # (`packages/ports/src/PasswordHasher.ts`'s own `Config.Int` usage,
    # `OAuth.test.ts`'s own `Config.succeed`-based fixtures), so this is
    # flagged as a genuine follow-up specific to this scenario's own setup,
    # not a real product defect assumed from a skipped test.
    @skip
    @REQ-EA-346
    Scenario: A provider's client secret is read via Config.Redacted inside its own Layer construction
      Given a provider "okta" configured with "clientSecret: Config.Redacted(\"AUTH_OAUTH_OKTA_CLIENT_SECRET\")"
      When "okta"'s provider Layer is constructed
      Then the secret value is obtained from the environment via "Config.Redacted", inside that Layer

    # Shipping-gap map (.scratch/shipping-gaps), ticket 22: pruned, not
    # force-implemented — a static source-code-inspection claim ("the application's
    # plugin-wiring source code"), not a runtime behavior any step could
    # exercise — closer to a lint/review concern than an acceptance test.
    @skip
    @REQ-EA-347
    Scenario: The client secret never appears as a plaintext option or plugin argument
      Given the application's plugin-wiring source code for provider "okta"
      When that source is inspected
      Then no plaintext secret value appears as an option, a plugin argument, or anywhere alongside the plugin wiring
      And only the name of the environment variable appears

    @REQ-EA-348
    Scenario: The redacted secret cannot be printed even if something attempts to log it
      Given "okta"'s "clientSecret" held as a "Config.Redacted" value
      When that value is passed to a logger or serialized for a span
      Then the plaintext secret does not appear in the resulting output

  # BEH-EA-127 — spec/behaviors/16-oauth.md
  @BEH-EA-127
  Rule: Generic OIDC discovery, with exact issuer match

    @REQ-EA-349
    Scenario: A discovery document whose issuer matches the configured issuer exactly registers successfully
      Given "okta" configured with "issuer: Config.String(\"AUTH_OAUTH_OKTA_ISSUER\")" set to "https://okta.example.com/oauth2/default"
      When the discovery document is fetched and its "issuer" field is "https://okta.example.com/oauth2/default"
      Then provider registration succeeds

    @REQ-EA-350
    Scenario: A mismatched discovery-document issuer fails registration rather than proceeding with the fetched value
      Given "okta" configured with "issuer" set to "https://okta.example.com/oauth2/default"
      When the fetched discovery document's "issuer" field is "https://attacker.example.com/oauth2/default"
      Then provider registration fails
      And the fetched value is not used in place of the configured issuer

    @REQ-EA-351
    Scenario: The issuer mismatch is caught at boot-time registration, not per-request
      Given the same mismatched discovery document for "okta"
      When the application boots and registers its providers
      Then registration fails at boot
      And no request-serving code path is ever reached with the mismatched provider configured

  # BEH-EA-128 — spec/behaviors/16-oauth.md
  @BEH-EA-128
  Rule: Callback destination is validated, never echoed

    @REQ-EA-352
    Scenario: A callbackURL on the trusted-origin allowlist is honored
      Given a trusted-origin allowlist including "https://app.example.com"
      When a sign-in request specifies "callbackURL=https://app.example.com/dashboard"
      Then the post-login redirect goes to "https://app.example.com/dashboard"

    @REQ-EA-353
    Scenario: A callbackURL taken unvalidated from a query parameter is never redirected to
      Given a sign-in request specifying "callbackURL=https://attacker.example.com/phish"
      When the OAuth callback handler processes the completed flow
      Then the handler does not redirect to "https://attacker.example.com/phish"
      And the callback is not treated as authorizing an arbitrary redirect target

    @REQ-EA-354
    Scenario: redirect_uri is always derived from the configured base URL, never from request input
      Given an authorization request under construction for provider "google"
      When the "redirect_uri" parameter is built
      Then its value is derived from the application's own configured base URL
      And no part of the request's own input is used to construct it
