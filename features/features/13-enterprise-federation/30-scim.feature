# BDD-005/P20a: authored against the shipped `@awthaq/scim` (ADR-EA-023), like
# 27-admin-impersonation.feature and 31-organization.feature. Every scenario drives the plugin's
# `/scim/v2` group over real HTTP the way a directory service (Okta, Entra ID) would: as the
# holder of a connection's bearer token. Where a scenario is about what the directory did to an
# account (its status, its sessions, its membership) the step reads the services the handler ran
# on. The safety Rules (BEH-EA-246/247/249) are adversarial by construction: a token for one
# connection aims at another connection's users, and at accounts nobody provisioned.

@enterprise-federation @scim
Feature: SCIM Provisioning

  # BEH-EA-246 — spec/behaviors/30-scim.md; see also ADR-EA-023, BEH-EA-237
  @BEH-EA-246
  Rule: A SCIM connection authenticates by a hashed, revocable bearer token and scopes everything it reads

    @REQ-EA-911
    Scenario: A request carrying the connection's bearer token is served
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" lists users
      Then the response is 200

    @REQ-EA-912
    Scenario Outline: An absent, malformed or unknown token is refused with the same 401
      Given an organization "Acme" with the SCIM connection "Okta"
      When a request presents <credential>
      Then the response is 401
      And the response is indistinguishable from an unauthenticated request's

      Examples:
        | credential                                        |
        | "no credential"                                   |
        | "a token without the scim_ prefix"                |
        | "a well-formed scim_ token no connection holds"   |
        | "an empty bearer token"                           |

    @REQ-EA-913
    Scenario: A revoked connection's token is refused with the same 401
      Given an organization "Acme" with the SCIM connection "Okta"
      And the connection "Okta" is revoked
      When "Okta" lists users
      Then the response is 401
      And the response is indistinguishable from an unauthenticated request's

    @REQ-EA-914
    Scenario: The token of a connection whose organization is suspended is refused with the same 401, and works again once reinstated
      Given an organization "Acme" with the SCIM connection "Okta"
      And the organization of "Okta" is suspended
      When "Okta" lists users
      Then the response is 401
      And the response is indistinguishable from an unauthenticated request's
      When the organization of "Okta" is reinstated
      And "Okta" lists users
      Then the response is 200

    @REQ-EA-915
    Scenario: The token is returned once, as scim_ followed by 256 random bits
      Given an organization "Acme" with the SCIM connection "Okta"
      And an organization "Acme" with the SCIM connection "Entra"
      Then the token of "Okta" is "scim_" followed by 64 hexadecimal characters
      And the tokens of "Okta" and "Entra" differ

    @REQ-EA-916
    Scenario: Only the SHA-256 of the token is stored
      Given an organization "Acme" with the SCIM connection "Okta"
      Then the stored record of "Okta" holds the SHA-256 of its token and not the token itself

    @REQ-EA-917
    Scenario: A session cookie is never trusted as SCIM authentication
      Given an organization "Acme" with the SCIM connection "Okta"
      And a signed-in user "alice"
      When "alice" requests the user list with only her session cookie
      Then the response is 401

    @REQ-EA-918
    Scenario: No CSRF check applies to a bearer-authenticated write
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" provisions the user "ada@acme.example"
      Then the response is 201

    @REQ-EA-919
    Scenario: A token for connection A cannot read connection B's users
      Given an organization "Acme" with the SCIM connection "Okta"
      And an organization "Acme" with the SCIM connection "Entra"
      And "Entra" has provisioned the user "bo@acme.example"
      When "Okta" reads the user "bo@acme.example"
      Then the response is 404
      And as seen by "Okta", 0 users are listed
      And as seen by "Entra", 1 users are listed

    @REQ-EA-920
    Scenario: A token for connection A cannot read connection B's groups
      Given an organization "Acme" with the SCIM connection "Okta"
      And an organization "Acme" with the SCIM connection "Entra"
      And "Entra" has provisioned the group "Theirs"
      When "Okta" reads the group "Theirs"
      Then the response is 404
      And as seen by "Okta", 0 groups are listed
      And as seen by "Entra", 1 groups are listed

  # BEH-EA-247 — spec/behaviors/30-scim.md; see also ADR-EA-018
  @BEH-EA-247
  Rule: A connection acts only on the users it provisioned, and never adopts an existing account

    @REQ-EA-921
    Scenario: POST creates the user from the primary email, records it for the connection and adds it to the organization
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" provisions the user "Ada" with the primary email "ada@acme.example"
      Then the response is 201
      And the user "Ada" has an "Email" identity with the address "ada@acme.example"
      And the user "Ada" is a member of the organization of "Okta"
      And as seen by "Okta", 1 users are listed

    @REQ-EA-922
    Scenario: An address-shaped userName becomes the email identity when no email is given
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" provisions the user "ada@acme.example"
      Then the user "ada@acme.example" has an "Email" identity with the address "ada@acme.example"

    @REQ-EA-923
    Scenario: A userName that is not an address becomes an Anonymous identity, never a synthetic address
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" provisions the user "svc-account-17"
      Then the user "svc-account-17" has an "Anonymous" identity
      And the user "svc-account-17" has no email address

    @REQ-EA-924
    Scenario: An email already held by another account is 409 uniqueness and the account is left alone
      Given an organization "Acme" with the SCIM connection "Okta"
      And a user "victim@acme.example" who signed up independently of any directory
      When "Okta" provisions the user "victim@acme.example"
      Then the response is 409
      And the error body has scimType "uniqueness"
      And the user "victim@acme.example" still has the status "active"
      And the user "victim@acme.example" is not a member of the organization of "Okta"
      And as seen by "Okta", 0 users are listed

    @REQ-EA-925
    Scenario: A repeated POST with the same externalId converges on the user it already provisioned
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example" with externalId "dir-1"
      When "Okta" provisions the user "ada@acme.example" with externalId "dir-1"
      Then the response names the user it provisioned the first time
      And as seen by "Okta", 1 users are listed

    @REQ-EA-926
    Scenario: A failed provisioning leaves neither the user nor a mapping behind
      Given the organization allows at most 1 members
      And an organization "Acme" with the SCIM connection "Okta"
      When "Okta" provisions the user "extra@acme.example"
      Then the response is 403
      And no user "extra@acme.example" exists
      And as seen by "Okta", 0 users are listed

    @REQ-EA-927
    Scenario Outline: A user that no connection provisioned is not found, and is left untouched
      Given an organization "Acme" with the SCIM connection "Okta"
      And a user "stranger@elsewhere.example" who signed up independently of any directory
      When "Okta" <operation> the user "stranger@elsewhere.example"
      Then the response is 404
      And the user "stranger@elsewhere.example" still has the status "active"

      Examples:
        | operation   |
        | reads       |
        | replaces    |
        | deactivates |
        | deletes     |

    @REQ-EA-928
    Scenario Outline: A user another connection provisioned is not found, and is left untouched for its owner
      Given an organization "Acme" with the SCIM connection "Okta"
      And an organization "Acme" with the SCIM connection "Entra"
      And "Entra" has provisioned the user "bo@acme.example"
      When "Okta" <operation> the user "bo@acme.example"
      Then the response is 404
      And the user "bo@acme.example" still has the status "active"
      And as seen by "Entra", 1 users are listed

      Examples:
        | operation   |
        | reads       |
        | replaces    |
        | deactivates |
        | deletes     |

  # BEH-EA-248 — spec/behaviors/30-scim.md
  @BEH-EA-248
  Rule: `userName` is immutable and the other attributes update per `PUT` and `PATCH`

    @REQ-EA-929
    Scenario: Re-sending the same userName, in another case, is accepted
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" replaces the user "ada@acme.example" sending userName "ADA@acme.example"
      Then the response is 200
      And the user "ada@acme.example" has an "Email" identity with the address "ada@acme.example"

    @REQ-EA-930
    Scenario Outline: A change of userName is refused with 400 mutability and nothing changes
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" <method> a new userName "mallory@acme.example" for the user "ada@acme.example"
      Then the response is 400
      And the error body has scimType "mutability"
      And the user "ada@acme.example" has an "Email" identity with the address "ada@acme.example"

      Examples:
        | method   |
        | PUTs     |
        | PATCHes  |

    @REQ-EA-931
    Scenario: PUT replaces displayName, externalId and active
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example" with externalId "dir-1"
      When "Okta" replaces the user "ada@acme.example" with displayName "Countess Ada", externalId "dir-2" and active false
      Then the response is 200
      And the resource has displayName "Countess Ada"
      And the resource has externalId "dir-2"
      And the resource reports active false

    @REQ-EA-932
    Scenario: A PUT without an externalId clears it
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example" with externalId "dir-1"
      When "Okta" replaces the user "ada@acme.example" without an externalId
      Then the resource has no externalId

    @REQ-EA-933
    Scenario Outline: PATCH accepts add, replace and remove in any case
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example" with externalId "dir-1"
      When "Okta" patches the user "ada@acme.example" with op "<op>" on path "<path>" to "<value>"
      Then the response is 200
      And the resource has displayName "<displayName>"

      Examples:
        | op      | path        | value   | displayName |
        | replace | displayName | Ada L.  | Ada L.      |
        | Replace | displayName | Ada M.  | Ada M.      |
        | ADD     | displayName | Ada N.  | Ada N.      |

    @REQ-EA-934
    Scenario Outline: PATCH remove clears an attribute, in any case
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example" with externalId "dir-1"
      When "Okta" patches the user "ada@acme.example" with op "<op>" on path "externalId"
      Then the resource has no externalId

      Examples:
        | op     |
        | remove |
        | Remove |
        | REMOVE |

    @REQ-EA-935
    Scenario: PATCH accepts a path-less object of attributes, as Okta sends it
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" patches the user "ada@acme.example" with the path-less op "replace" of displayName "Ada L." and title "Analyst"
      Then the response is 200
      And the resource has displayName "Ada L."

    @REQ-EA-936
    Scenario Outline: PATCH accepts a boolean as a JSON boolean or as "True"/"False", as Entra sends it
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" patches the user "ada@acme.example" with op "replace" on path "active" to <value>
      Then the response is 200
      And the resource reports active <active>

      Examples:
        | value          | active |
        | the boolean false | false  |
        | the string "False" | false  |
        | the string "false" | false  |
        | the boolean true  | true   |
        | the string "True" | true   |

    @REQ-EA-937
    Scenario: PATCH ignores attributes it does not manage rather than failing the sync
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" patches the user "ada@acme.example" with op "Add" on path "phoneNumbers[type eq \"work\"].value" to "+15550100"
      Then the response is 200
      And the user "ada@acme.example" has an "Email" identity with the address "ada@acme.example"

    @REQ-EA-938
    Scenario: An unknown operation is 400 invalidSyntax
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" patches the user "ada@acme.example" with op "frobnicate" on path "active"
      Then the response is 400
      And the error body has scimType "invalidSyntax"

  # BEH-EA-249 — spec/behaviors/30-scim.md; see also BEH-EA-046
  @BEH-EA-249
  Rule: `active` is suspension that ends every session, and only its own suspension is lifted

    @REQ-EA-939
    Scenario: active false suspends the user and ends every session at once
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      And the user "ada@acme.example" has 2 live sessions
      When "Okta" deactivates the user "ada@acme.example"
      Then the response is 200
      And the resource reports active false
      And none of the live sessions of "ada@acme.example" is accepted any more
      And the user "ada@acme.example" still has the status "suspended"

    @REQ-EA-940
    Scenario: A suspended user is refused a new sign-in and is not deleted
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" deactivates the user "ada@acme.example"
      Then the user "ada@acme.example" cannot sign in
      And the user "ada@acme.example" has an "Email" identity with the address "ada@acme.example"

    @REQ-EA-941
    Scenario: The suspension is stamped with the connection
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" deactivates the user "ada@acme.example"
      Then the user "ada@acme.example" is suspended with the reason marker of "Okta"

    @REQ-EA-942
    Scenario: active true lifts a suspension the same connection made
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      And "Okta" has deactivated the user "ada@acme.example"
      When "Okta" reactivates the user "ada@acme.example"
      Then the resource reports active true
      And the user "ada@acme.example" still has the status "active"

    @REQ-EA-943
    Scenario: An administrator's ban stays in force and the resource reports it as inactive
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      And an administrator has suspended the user "ada@acme.example" with the reason "admin ban"
      When "Okta" reactivates the user "ada@acme.example"
      Then the resource reports active false
      And the user "ada@acme.example" still has the status "suspended"

    @REQ-EA-944
    Scenario: A suspension another connection made is not this connection's to lift
      Given an organization "Acme" with the SCIM connection "Okta"
      And an organization "Acme" with the SCIM connection "Entra"
      And "Okta" has provisioned the user "ada@acme.example"
      And "Okta" has deactivated the user "ada@acme.example"
      When "Entra" reactivates the user "ada@acme.example"
      Then the response is 404
      And the user "ada@acme.example" still has the status "suspended"

    @REQ-EA-945
    Scenario: Provisioning with active false creates an already-suspended user
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" provisions the user "ada@acme.example" with active false
      Then the resource reports active false
      And the user "ada@acme.example" still has the status "suspended"

    @REQ-EA-946
    Scenario: A repeated POST for a deactivated user reactivates it
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example" with externalId "dir-1"
      And "Okta" has deactivated the user "ada@acme.example"
      When "Okta" provisions the user "ada@acme.example" with externalId "dir-1"
      Then the response names the user it provisioned the first time
      And the resource reports active true
      And the user "ada@acme.example" still has the status "active"

  # BEH-EA-250 — spec/behaviors/30-scim.md; see also BEH-EA-095
  @BEH-EA-250
  Rule: `DELETE` deactivates by default and erases when configured

    @REQ-EA-947
    Scenario: By default DELETE behaves as active false and the user remains
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      And the user "ada@acme.example" has 1 live sessions
      When "Okta" deletes the user "ada@acme.example"
      Then the response is 204
      And the user "ada@acme.example" still has the status "suspended"
      And none of the live sessions of "ada@acme.example" is accepted any more

    @REQ-EA-948
    Scenario: After a default DELETE the resource is still readable, as inactive
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      And "Okta" has deleted the user "ada@acme.example"
      When "Okta" reads the user "ada@acme.example"
      Then the response is 200
      And the resource reports active false

    @REQ-EA-949
    Scenario: Configured to erase, DELETE ends the sessions, removes the mapping and deletes the user
      Given the SCIM plugin is configured with deleteBehavior "erase"
      And an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example" with externalId "dir-1"
      And the user "ada@acme.example" has 1 live sessions
      When "Okta" deletes the user "ada@acme.example"
      Then the response is 204
      And no user "ada@acme.example" exists
      And none of the live sessions of "ada@acme.example" is accepted any more
      And as seen by "Okta", 0 users are listed

    @REQ-EA-950
    Scenario: After an erasing DELETE the external id is free to be provisioned again as a new user
      Given the SCIM plugin is configured with deleteBehavior "erase"
      And an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example" with externalId "dir-1"
      And "Okta" has deleted the user "ada@acme.example"
      When "Okta" provisions the user "ada@acme.example" with externalId "dir-1"
      Then the response is 201
      And the response names a new user

    @REQ-EA-951
    Scenario: A beforeDelete hook that vetoes the erasure makes DELETE a 403 and the user stays
      Given the SCIM plugin is configured with deleteBehavior "erase"
      And a beforeDelete hook that vetoes every user deletion
      And an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" deletes the user "ada@acme.example"
      Then the response is 403
      And the user "ada@acme.example" still has the status "active"
      And as seen by "Okta", 1 users are listed

  # BEH-EA-251 — spec/behaviors/30-scim.md; see also ADR-EA-018
  @BEH-EA-251
  Rule: Groups are organization teams, and a connection only changes the users it provisioned

    @REQ-EA-952
    Scenario: POST creates an organization team with its provisioned members
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      And "Okta" has provisioned the user "bo@acme.example"
      When "Okta" creates the group "Engineering" with the members "ada@acme.example, bo@acme.example"
      Then the response is 201
      And the resource has displayName "Engineering"
      And the team behind the group "Engineering" has exactly the members "ada@acme.example, bo@acme.example"

    @REQ-EA-953
    Scenario: A repeated POST with the same externalId converges on the same group
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the group "Eng" with externalId "grp-1"
      When "Okta" creates the group "Eng" with externalId "grp-1"
      Then the response names the group it provisioned the first time
      And as seen by "Okta", 1 groups are listed

    @REQ-EA-954
    Scenario: A group body naming a user the connection did not provision is 400 invalidValue and creates nothing
      Given an organization "Acme" with the SCIM connection "Okta"
      And a user "stranger@elsewhere.example" who signed up independently of any directory
      When "Okta" creates the group "Eng" with the members "stranger@elsewhere.example"
      Then the response is 400
      And the error body has scimType "invalidValue"
      And as seen by "Okta", 0 groups are listed

    @REQ-EA-955
    Scenario: A group naming a user another connection provisioned is refused
      Given an organization "Acme" with the SCIM connection "Okta"
      And an organization "Acme" with the SCIM connection "Entra"
      And "Entra" has provisioned the user "bo@acme.example"
      When "Okta" creates the group "Eng" with the members "bo@acme.example"
      Then the response is 400
      And the error body has scimType "invalidValue"

    @REQ-EA-956
    Scenario: A team the connection did not create is neither visible nor deletable through it
      Given an organization "Acme" with the SCIM connection "Okta"
      And a team "Made by hand" that an organization admin created in the organization of "Okta"
      Then as seen by "Okta", 0 groups are listed
      When "Okta" deletes the group "Made by hand"
      Then the response is 404
      And the team "Made by hand" still exists in the organization of "Okta"

    @REQ-EA-957
    Scenario: PUT replaces the provisioned members and never removes a member added by hand
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      And "Okta" has provisioned the user "bo@acme.example"
      And "Okta" has provisioned the user "cy@acme.example"
      And "Okta" has provisioned the group "Eng" with the members "ada@acme.example, bo@acme.example"
      And "hand@acme.example" was added to the team behind the group "Eng" by an organization admin
      When "Okta" replaces the group "Eng" with displayName "Platform" and the members "bo@acme.example, cy@acme.example"
      Then the response is 200
      And the resource has displayName "Platform"
      And the team behind the group "Platform" has exactly the members "bo@acme.example, cy@acme.example, hand@acme.example"

    @REQ-EA-958
    Scenario: PATCH adds members
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      And "Okta" has provisioned the user "bo@acme.example"
      And "Okta" has provisioned the group "Eng"
      When "Okta" patches the group "Eng" adding the members "ada@acme.example, bo@acme.example"
      Then the team behind the group "Eng" has exactly the members "ada@acme.example, bo@acme.example"

    @REQ-EA-959
    Scenario: PATCH removes one member by its value filter
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      And "Okta" has provisioned the user "bo@acme.example"
      And "Okta" has provisioned the group "Eng" with the members "ada@acme.example, bo@acme.example"
      When "Okta" patches the group "Eng" removing the member "ada@acme.example"
      Then the team behind the group "Eng" has exactly the members "bo@acme.example"

    @REQ-EA-960
    Scenario: PATCH replaces the members and renames the group
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      And "Okta" has provisioned the user "cy@acme.example"
      And "Okta" has provisioned the group "Eng" with the members "ada@acme.example"
      When "Okta" patches the group "Eng" replacing the members with "cy@acme.example" and renaming it to "Platform"
      Then the resource has displayName "Platform"
      And the team behind the group "Platform" has exactly the members "cy@acme.example"

    @REQ-EA-961
    Scenario: A PATCH adding a user the connection did not provision is 400 invalidValue
      Given an organization "Acme" with the SCIM connection "Okta"
      And a user "stranger@elsewhere.example" who signed up independently of any directory
      And "Okta" has provisioned the group "Eng"
      When "Okta" patches the group "Eng" adding the members "stranger@elsewhere.example"
      Then the response is 400
      And the error body has scimType "invalidValue"

    @REQ-EA-962
    Scenario: DELETE removes the team and the mapping
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the group "Eng"
      When "Okta" deletes the group "Eng"
      Then the response is 204
      And no team "Eng" exists in the organization of "Okta"
      And as seen by "Okta", 0 groups are listed

    @REQ-EA-963
    Scenario: DELETE of a group that has child teams is 409 and the group stays
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the group "Eng"
      And a child team "Backend" of the team behind the group "Eng"
      When "Okta" deletes the group "Eng"
      Then the response is 409
      And the team "Eng" still exists in the organization of "Okta"

    @REQ-EA-964
    Scenario: A group whose team was removed elsewhere is 404 and its stale mapping is dropped
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the group "Eng" with externalId "grp-1"
      And the team behind the group "Eng" is removed by an organization admin
      When "Okta" reads the group "Eng"
      Then the response is 404
      When "Okta" creates the group "Eng" with externalId "grp-1"
      Then the response is 201
      And the response names a new group

  # BEH-EA-252 — spec/behaviors/30-scim.md; see also ADR-EA-028
  @BEH-EA-252
  Rule: The wire format follows RFC 7644: content types, filters, paging, errors and discovery

    @REQ-EA-965
    Scenario Outline: A body is accepted as application/scim+json or application/json and the response is application/scim+json
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" provisions the user "ada@acme.example" sending the content type "<contentType>"
      Then the response is 201
      And the response content type is "application/scim+json"

      Examples:
        | contentType           |
        | application/scim+json |
        | application/json      |

    @REQ-EA-966
    Scenario: A list is a ListResponse with a 1-based startIndex
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the users "u1@acme.example, u2@acme.example, u3@acme.example"
      When "Okta" lists users with startIndex 2 and count 2
      Then the list reports totalResults 3, startIndex 2, itemsPerPage 2 and 2 resources

    @REQ-EA-967
    Scenario: Consecutive pages partition the list, each resource appearing once
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the users "u1@acme.example, u2@acme.example, u3@acme.example"
      When "Okta" lists users with startIndex 1 and count 2
      And "Okta" lists users with startIndex 3 and count 2
      Then the pages listed so far together hold exactly "u1@acme.example, u2@acme.example, u3@acme.example", each once

    @REQ-EA-968
    Scenario: A count of 0 returns no resources but still the total
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the users "u1@acme.example, u2@acme.example"
      When "Okta" lists users with startIndex 1 and count 0
      Then the list reports totalResults 2, startIndex 1, itemsPerPage 0 and 0 resources

    @REQ-EA-969
    Scenario: A count above the configured maximum is bounded by it
      Given the SCIM plugin is configured with maxResults 2
      And an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the users "u1@acme.example, u2@acme.example, u3@acme.example, u4@acme.example"
      When "Okta" lists users with startIndex 1 and count 10
      Then the list reports totalResults 4, startIndex 1, itemsPerPage 2 and 2 resources

    @REQ-EA-970
    Scenario Outline: The supported user filters name one resource
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "u1@acme.example" with externalId "dir-1"
      And "Okta" has provisioned the user "u2@acme.example" with externalId "dir-2"
      When "Okta" lists users with the filter '<filter>'
      Then the response is 200
      And the list resources are "u2@acme.example"

      Examples:
        | filter                       |
        | userName eq "u2@acme.example" |
        | externalId eq "dir-2"        |

    @REQ-EA-971
    Scenario Outline: The supported group filters name one resource
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the group "Eng" with externalId "grp-1"
      And "Okta" has provisioned the group "Ops" with externalId "grp-2"
      When "Okta" lists groups with the filter '<filter>'
      Then the response is 200
      And the list resources are "Ops"

      Examples:
        | filter                  |
        | displayName eq "Ops"    |
        | externalId eq "grp-2"   |

    @REQ-EA-972
    Scenario Outline: Any other filter is 400 invalidFilter
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" lists <resource> with the filter '<filter>'
      Then the response is 400
      And the error body has scimType "invalidFilter"

      Examples:
        | resource | filter                                        |
        | users    | name.familyName co "L"                        |
        | users    | userName sw "a"                               |
        | users    | displayName eq "x"                            |
        | users    | userName eq "a" and externalId eq "b"         |
        | groups   | userName eq "a"                               |
        | groups   | displayName co "E"                            |

    @REQ-EA-973
    Scenario: An error is the RFC 7644 body: schemas, a string status, scimType and a detail
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" provisions the user "ada@acme.example"
      Then the response is 409
      And the error body has status "409" and the RFC 7644 error schema
      And the error body has scimType "uniqueness"
      And the error body has a detail

    @REQ-EA-974
    Scenario: A missing resource is a 404 in the RFC 7644 error body
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" reads the user with the id "no-such-user"
      Then the response is 404
      And the error body has status "404" and the RFC 7644 error schema

    @REQ-EA-975
    Scenario: An unavailable backing store is a 503 in the same body and says nothing of the cause
      Given a Users store that is unavailable when looked up by email
      And an organization "Acme" with the SCIM connection "Okta"
      When "Okta" provisions the user "ada@acme.example" with the primary email "ada@acme.example"
      Then the response is 503
      And the error body has status "503" and the RFC 7644 error schema
      And the error body does not mention "Users.findByEmail" or "StoreUnavailable"

    @REQ-EA-976
    Scenario: ServiceProviderConfig is served behind the token and reports PATCH and filter supported
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" reads the "ServiceProviderConfig" discovery document
      Then the response is 200
      And the ServiceProviderConfig reports patch supported and filter supported
      And the ServiceProviderConfig reports bulk, sort, etag and change password not supported

    @REQ-EA-977
    Scenario: The reported filter maximum is the configured one
      Given the SCIM plugin is configured with maxResults 50
      And an organization "Acme" with the SCIM connection "Okta"
      When "Okta" reads the "ServiceProviderConfig" discovery document
      Then the ServiceProviderConfig reports a filter maximum of 50 results

    @REQ-EA-978
    Scenario Outline: ResourceTypes and Schemas are served behind the same token
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" reads the "<document>" discovery document
      Then the response is 200
      When an unauthenticated request reads the "<document>" discovery document
      Then the response is 401

      Examples:
        | document              |
        | ResourceTypes         |
        | Schemas               |
        | ServiceProviderConfig |

  # BEH-EA-253 — spec/behaviors/30-scim.md; see also BEH-EA-100
  @BEH-EA-253
  Rule: Provisioning lifecycle changes are published as events

    @REQ-EA-979
    Scenario: Provisioning publishes userProvisioned naming the connection, the organization and the user
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" provisions the user "ada@acme.example"
      Then the audit log records 1 "auth.scim.userProvisioned" events
      And the latest "auth.scim.userProvisioned" event names the connection "Okta", its organization and the user "ada@acme.example"
      And the latest "auth.scim.userProvisioned" event records no acting user

    @REQ-EA-980
    Scenario: A repeated POST that converges on an existing user does not publish userProvisioned again
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example" with externalId "dir-1"
      When "Okta" provisions the user "ada@acme.example" with externalId "dir-1"
      Then the audit log records 1 "auth.scim.userProvisioned" events

    @REQ-EA-981
    Scenario: Deactivation and reactivation are published
      Given an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" deactivates the user "ada@acme.example"
      And "Okta" reactivates the user "ada@acme.example"
      Then the audit log records 1 "auth.scim.userDeactivated" events
      And the latest "auth.scim.userDeactivated" event names the connection "Okta", its organization and the user "ada@acme.example"
      And the audit log records 1 "auth.scim.userReactivated" events

    @REQ-EA-982
    Scenario: An erasing DELETE publishes userDeleted
      Given the SCIM plugin is configured with deleteBehavior "erase"
      And an organization "Acme" with the SCIM connection "Okta"
      And "Okta" has provisioned the user "ada@acme.example"
      When "Okta" deletes the user "ada@acme.example"
      Then the audit log records 1 "auth.scim.userDeleted" events
      And the latest "auth.scim.userDeleted" event names the connection "Okta", its organization and the user "ada@acme.example"

    @REQ-EA-983
    Scenario: Creating, changing and removing a group publishes groupChanged with the change
      Given an organization "Acme" with the SCIM connection "Okta"
      When "Okta" creates the group "Eng"
      And "Okta" patches the group "Eng" renaming it to "Platform"
      And "Okta" deletes the group "Platform"
      Then the audit log records 3 "auth.scim.groupChanged" events
      And the "auth.scim.groupChanged" events carry the changes "created, updated, deleted"
