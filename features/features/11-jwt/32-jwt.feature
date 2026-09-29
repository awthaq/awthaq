# BDD-005 (bdd-gherkin-acceptance-testing-specialist): authored against the real, implemented
# `@awthaq/jwt` plugin, like 27-admin-impersonation.feature. Callers are real signed-in sessions;
# tokens are read the way a downstream service would read them (decoded, and verified against the
# served JWKS). A defective token is signed with the issuer's real key, so a rejection is about the
# defect and never about a signature that was wrong by accident.
# Behaviors-before-code prerequisites recorded for the packages that do not exist yet
# (magic-link, api-key, two-factor): their behavior files must precede their builds; nothing here
# waits on them.

@jwt @tokens
Feature: JWT

  # BEH-EA-263 — spec/behaviors/32-jwt.md; see also ADR-EA-017
  @BEH-EA-263
  Rule: A principal token is minted only for the authenticated caller, from nothing the caller supplies

    Scenario: A signed-in caller is minted a principal token naming them and their session
      Given a signed-in user "alice"
      When "alice" requests a token
      Then the response is 200
      And the token has the header "typ" set to "at+jwt"
      And the token has the header "alg" set to "EdDSA"
      And the token names the current signing key in its header
      And the token has the claim "iss" set to "https://issuer.test"
      And the token has the claim "aud" set to "https://issuer.test"
      And the token's "sub" claim is the user id of "alice"
      And the token's "sid" claim is the session id of "alice"
      And the token expires 15 minutes after it was issued

    Scenario: Every minted token carries its own unique id
      Given a signed-in user "alice"
      When "alice" requests a token
      And "alice" requests another token
      Then the tokens minted for "alice" carry different "jti" claims

    Scenario: Someone who is not signed in is refused
      When an anonymous caller requests a token
      Then the response is 401

    Scenario: Minting is a POST-only action
      Given a signed-in user "alice"
      When "alice" sends GET "/jwt/token"
      Then the response is 404

    Scenario: Nothing the caller supplies reaches the token's claims
      Given a signed-in user "alice"
      When "alice" requests a token with the body '{"sub":"someone-else","sid":"forged","iss":"https://evil.test"}'
      Then the response is 200
      And the token's "sub" claim is the user id of "alice"
      And the token's "sid" claim is the session id of "alice"
      And the token has the claim "iss" set to "https://issuer.test"

    Scenario: By default no token is attached to ordinary responses
      Given a signed-in user "alice"
      When "alice" requests a token
      Then the response carries no "x-jwt-token" header

  # BEH-EA-264 — spec/behaviors/32-jwt.md; see also ADR-EA-017
  @BEH-EA-264
  Rule: The JWKS is public, holds public keys only, and tells verifiers how long to cache it

    Scenario: Anyone can fetch the JWKS and it lists the current key
      When an anonymous caller fetches the JWKS
      Then the response is 200
      And the JWKS lists 1 keys
      And every JWKS key has a "kid" and the "alg" "EdDSA"

    Scenario: No JWKS key carries a private member
      When an anonymous caller fetches the JWKS
      Then no JWKS key carries a private member

    Scenario: The JWKS tells verifiers to cache it for ten minutes by default
      When an anonymous caller fetches the JWKS
      Then the response has the header "cache-control" set to "public, max-age=600"

    Scenario: The cache lifetime follows the configured value
      Given the JWKS may be cached for 60 seconds
      When an anonymous caller fetches the JWKS
      Then the response has the header "cache-control" set to "public, max-age=60"

  # BEH-EA-265 — spec/behaviors/32-jwt.md; see also RFC 8725
  @BEH-EA-265
  Rule: Verification is strict, and every way of failing it looks the same

    Scenario: A freshly minted token is accepted
      Given a signed-in user "alice"
      And "alice" has requested a token
      When "alice" introspects the token minted for "alice"
      Then the token is reported active

    Scenario: A token signed by the real key with no defect is accepted, so the rejections below are about the defect
      Given a signed-in user "alice"
      And a token signed by the issuer's key with the defect "none"
      When "alice" introspects the forged token
      Then the token is reported active

    Scenario Outline: A token signed by the real key but <defect> is not accepted
      Given a signed-in user "alice"
      And a token signed by the issuer's key with the defect "<defect>"
      When "alice" introspects the forged token
      Then the introspection answer is exactly '{"active":false}'

      Examples:
        | defect                    |
        | expired                   |
        | from another issuer       |
        | for another audience      |
        | of an unexpected class    |
        | not valid yet             |

    Scenario: A token whose payload was tampered with is not accepted
      Given a signed-in user "alice"
      And "alice" has requested a token
      And the token minted for "alice" has its payload claim "sub" replaced by "user-admin"
      When "alice" introspects the tampered token
      Then the introspection answer is exactly '{"active":false}'

    Scenario: A token whose signature was altered is not accepted
      Given a signed-in user "alice"
      And "alice" has requested a token
      And the token minted for "alice" has its signature altered
      When "alice" introspects the tampered token
      Then the introspection answer is exactly '{"active":false}'

    Scenario Outline: A token whose header claims the algorithm <alg> is not accepted
      Given a signed-in user "alice"
      And "alice" has requested a token
      And the token minted for "alice" has its header algorithm replaced by "<alg>"
      When "alice" introspects the tampered token
      Then the introspection answer is exactly '{"active":false}'

      Examples:
        | alg   |
        | none  |
        | HS256 |
        | RS256 |

    Scenario: A token signed by a key the issuer never published is not accepted
      Given a signed-in user "alice"
      And a token signed by a key the issuer never published
      When "alice" introspects the forged token
      Then the introspection answer is exactly '{"active":false}'

    Scenario: Something that is not a token at all gets the same answer
      Given a signed-in user "alice"
      When "alice" introspects the text "definitely.not.a-token"
      Then the introspection answer is exactly '{"active":false}'

  # BEH-EA-266 — spec/behaviors/32-jwt.md
  @BEH-EA-266
  Rule: Principal tokens and general-purpose tokens are different classes that cannot pass for one another

    Scenario: A general-purpose token is not accepted as a principal token
      Given a signed-in user "alice"
      And a general-purpose token is signed with the payload '{"sub":"user-alice"}'
      Then the principal verifier refuses the general-purpose token
      And the general-purpose verifier accepts the general-purpose token

    Scenario: A forged session id in a general-purpose payload does not make it a principal token
      Given a signed-in user "alice"
      And a general-purpose token is signed carrying the user id and the session id of "alice"
      Then the principal verifier refuses the general-purpose token
      And the live principal verifier refuses the general-purpose token

    Scenario: A principal token is not accepted by the general-purpose verifier
      Given a signed-in user "alice"
      And "alice" has requested a token
      Then the general-purpose verifier refuses the token minted for "alice"
      And the principal verifier accepts the token minted for "alice"

    Scenario: A general-purpose token needs no subject and may choose its audience
      Given a signed-in user "alice"
      And a general-purpose token is signed for the audience "inventory-service" with the payload '{"scope":"read"}'
      Then the general-purpose verifier accepts the general-purpose token for the audience "inventory-service"
      And the general-purpose verifier refuses the general-purpose token for the default audience

  # BEH-EA-267 — spec/behaviors/32-jwt.md
  @BEH-EA-267
  Rule: Introspection answers in the RFC 7662 shape, for callers who are themselves authenticated

    Scenario: Someone who is not signed in cannot introspect
      When an anonymous caller introspects the text "whatever"
      Then the response is 401

    Scenario: A live token is reported active with its claims
      Given a signed-in user "alice"
      And "alice" has requested a token
      When "alice" introspects the token minted for "alice"
      Then the token is reported active
      And the introspection claims name "alice" as the subject

    Scenario: A token is inactive once its session is revoked
      Given a signed-in user "alice"
      And "alice" has a second session "alice's laptop"
      And "alice's laptop" has requested a token
      When the session of "alice's laptop" is revoked
      And "alice" introspects the token minted for "alice's laptop"
      Then the introspection answer is exactly '{"active":false}'

    Scenario: A token whose id was denylisted is inactive
      Given a signed-in user "alice"
      And "alice" has requested a token
      And the id of the token minted for "alice" is denylisted
      When "alice" introspects the token minted for "alice"
      Then the introspection answer is exactly '{"active":false}'

    Scenario: A revoked session and a garbage token are indistinguishable
      Given a signed-in user "alice"
      And "alice" has a second session "alice's laptop"
      And "alice's laptop" has requested a token
      And the session of "alice's laptop" has been revoked
      When "alice" introspects the token minted for "alice's laptop"
      Then the response is 200
      And the introspection answer is exactly '{"active":false}'
      When "alice" introspects the text "garbage"
      Then the introspection answer is exactly '{"active":false}'

  # BEH-EA-268 — spec/behaviors/32-jwt.md; see also ADR-EA-017
  @BEH-EA-268
  Rule: Signing keys rotate without invalidating live tokens, and an emergency rotation invalidates them at once

    Scenario: Rotating the key keeps tokens signed by the old key verifying, and new tokens use the new key
      Given a signed-in user "alice"
      And "alice" has requested a token
      When the operator rotates the signing key
      Then the JWKS lists 2 keys
      When "alice" introspects the token minted for "alice"
      Then the token is reported active
      When "alice" requests another token
      Then the newest token is signed by a different key than the token minted for "alice"
      When "alice" introspects the newest token
      Then the token is reported active

    Scenario: An emergency rotation retires the old key at once
      Given a signed-in user "alice"
      And "alice" has requested a token
      When the operator rotates the signing key with no grace period
      Then the JWKS lists 1 keys
      When "alice" introspects the token minted for "alice"
      Then the introspection answer is exactly '{"active":false}'
      When "alice" requests another token
      And "alice" introspects the newest token
      Then the token is reported active

    Scenario: Revoking a key by its id stops it verifying at once
      Given a signed-in user "alice"
      And "alice" has requested a token
      When the operator revokes the key that signed the token minted for "alice"
      Then the JWKS does not list the key that signed the token minted for "alice"
      When "alice" introspects the token minted for "alice"
      Then the introspection answer is exactly '{"active":false}'

    Scenario: A key past its rotation interval is replaced on the next use
      Given keys rotate every 200 ms
      And a signed-in user "alice"
      And "alice" has requested a token
      When 300 ms pass
      And "alice" requests another token
      Then the newest token is signed by a different key than the token minted for "alice"
      And the JWKS lists 2 keys

    Scenario: A grace period shorter than the token lifetime is refused at configuration
      Given a configuration with a key grace period of 1 minutes
      Then the configuration is refused

  # BEH-EA-269 — spec/behaviors/32-jwt.md; see also ADR-EA-012
  @BEH-EA-269
  Rule: A minted token is not an origin credential unless the deployment opts in, and a downstream-only token never is

    Scenario: By default a minted token presented as a bearer credential is refused
      Given a signed-in user "alice"
      And "alice" has requested a token
      When "alice" calls the token endpoint with the token minted for "alice" as a bearer credential
      Then the response is 401

    Scenario: By default the opaque session token still authenticates as a bearer credential
      Given a signed-in user "alice"
      When "alice" calls the token endpoint with the opaque session token as a bearer credential
      Then the response is 200

    Scenario: When the deployment opts in, a minted token authenticates statelessly
      Given tokens are accepted as bearer credentials
      And a signed-in user "alice"
      And "alice" has requested a token
      When "alice" calls the token endpoint with the token minted for "alice" as a bearer credential
      Then the response is 200

    Scenario: With re-entry on, a revoked session's token keeps working until it expires
      Given tokens are accepted as bearer credentials
      And a signed-in user "alice"
      And "alice" has requested a token
      When the session of "alice" is revoked
      And someone calls the token endpoint with the token minted for "alice" as a bearer credential
      Then the response is 200

    Scenario: With re-entry on, a token made for another service still does not authenticate here
      Given tokens are accepted as bearer credentials
      And a signed-in user "alice"
      And a general-purpose token is signed for the audience "inventory-service" with the payload '{"sub":"user-alice"}'
      When someone calls the token endpoint with the general-purpose token as a bearer credential
      Then the response is 401

    Scenario: With re-entry on, a general-purpose token for this audience is still not a principal
      Given tokens are accepted as bearer credentials
      And a signed-in user "alice"
      And a general-purpose token is signed with the payload '{"sub":"user-alice"}'
      When someone calls the token endpoint with the general-purpose token as a bearer credential
      Then the response is 401

  # BEH-EA-270 — spec/behaviors/32-jwt.md; see also BEH-EA-265
  @BEH-EA-270
  Rule: A downstream service can verify tokens from the JWKS alone, and cannot check revocation

    Scenario: A downstream verifier accepts a minted token using only the JWKS
      Given a signed-in user "alice"
      And "alice" has requested a token
      And a downstream verifier for the audience "https://issuer.test"
      Then the downstream verifier accepts the token minted for "alice"

    Scenario: A downstream verifier for another audience refuses the token
      Given a signed-in user "alice"
      And "alice" has requested a token
      And a downstream verifier for the audience "https://another-api.test"
      Then the downstream verifier refuses the token minted for "alice"

    Scenario: A downstream verifier refuses a tampered token
      Given a signed-in user "alice"
      And "alice" has requested a token
      And the token minted for "alice" has its signature altered
      And a downstream verifier for the audience "https://issuer.test"
      Then the downstream verifier refuses the tampered token

    Scenario: The JWKS is fetched once and reused for later tokens
      Given a signed-in user "alice"
      And "alice" has requested a token
      And a downstream verifier for the audience "https://issuer.test"
      When the downstream verifier checks the token minted for "alice" 3 times
      Then the JWKS was fetched 1 times

    Scenario: Tokens naming an unknown key cannot turn into a fetch per request
      Given a signed-in user "alice"
      And a downstream verifier for the audience "https://issuer.test"
      When the downstream verifier checks 5 tokens signed by a key the issuer never published
      Then the JWKS was fetched at most 2 times

    Scenario: A downstream verifier cannot know that the session behind a token was revoked
      Given a signed-in user "alice"
      And "alice" has requested a token
      And a downstream verifier for the audience "https://issuer.test"
      When the session of "alice" is revoked
      Then the downstream verifier accepts the token minted for "alice"
