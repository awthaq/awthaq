# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@domain @users-accounts
@skip @unwired
Feature: Users and Accounts

  # BEH-EA-041 — spec/behaviors/06-domain-users-accounts.md
  @BEH-EA-041
  Rule: A User is identified by a case-insensitively unique email

    @REQ-EA-109
    Scenario: An email is lower-cased before it is stored
      Given a signup submitted with email "Alice@Example.com"
      When the User row is persisted
      Then the stored email is "alice@example.com"

    @REQ-EA-110
    Scenario: A signup with an email differing only in case from an existing User is rejected as a duplicate
      Given a User already exists with email "alice@example.com"
      When a new signup attempts to create a User with email "ALICE@example.com"
      Then the creation is rejected as a duplicate email

    @REQ-EA-111
    Scenario: The uniqueness constraint holds under two concurrent signups differing only in case
      Given no User exists with email "bob@example.com"
      When two concurrent signups race to create a User with email "bob@example.com" and "BOB@example.com" respectively
      Then only one creation succeeds
      And the other is rejected by the schema-level unique constraint, not by an application-level lookup that could lose the race

  # BEH-EA-042 — spec/behaviors/06-domain-users-accounts.md
  @BEH-EA-042
  Rule: emailVerified is monotone and never client-settable through a generic write

    @REQ-EA-112
    Scenario: A newly created user has emailVerified set to false
      Given a signup submitted with email "carol@example.com"
      When the User row is created
      Then "emailVerified" is "false"

    @REQ-EA-113
    Scenario: A generic update request attempting to set emailVerified is not honored
      Given a signed-in user "carol" whose "emailVerified" is "false"
      When "carol" submits a generic profile update with "emailVerified: true"
      Then the update path does not set "emailVerified" to "true"
      And "emailVerified" remains "false"

    @REQ-EA-114
    Scenario: Consuming an email-verification token flips emailVerified from false to true
      Given a signed-in user "carol" whose "emailVerified" is "false"
      When "carol" consumes a valid email-verification token for her own address
      Then "emailVerified" transitions to "true"

    @REQ-EA-115
    Scenario: No core operation resets emailVerified back to false once it is true
      Given a signed-in user "carol" whose "emailVerified" is "true"
      When "carol" performs an ordinary profile update unrelated to verification
      Then "emailVerified" remains "true"

  # BEH-EA-043 — spec/behaviors/06-domain-users-accounts.md
  @BEH-EA-043
  Rule: An Account is identified by (providerId, subject), enforced as a schema-level unique constraint

    @REQ-EA-116
    Scenario: Linking a provider identity that no other Account holds succeeds
      Given no Account exists with providerId "google" and subject "g-100"
      When a User links an Account with providerId "google" and subject "g-100"
      Then the Account is created

    @REQ-EA-117
    Scenario: Linking a second Account with the same (providerId, subject) pair is rejected
      Given an Account already exists with providerId "google" and subject "g-100"
      When another link attempt uses providerId "google" and subject "g-100"
      Then the second link attempt is rejected as a duplicate

    @REQ-EA-118
    Scenario: The (providerId, subject) uniqueness holds under two concurrent link attempts
      Given no Account exists with providerId "google" and subject "g-200"
      When two concurrent requests race to link providerId "google" and subject "g-200"
      Then only one link attempt succeeds
      And the other is rejected by the database-level constraint, not by application-level query discipline that could lose the race

  # BEH-EA-044 — spec/behaviors/06-domain-users-accounts.md
  @BEH-EA-044
  Rule: A password credential is an ordinary Account row, not a separate entity

    @REQ-EA-119
    Scenario: Setting a password for a user creates an Account row scoped to that user
      Given a signed-in user "dave" with no password credential
      When "dave" sets a password
      Then an Account row is created with providerId "password" and subject equal to "dave"'s own user id

    @REQ-EA-120
    Scenario: Whether a user has a password is answered by the presence of that Account row
      Given a signed-in user "dave" with no Account row where providerId is "password"
      When the system checks whether "dave" has a password credential
      Then the check reports "no password credential", derived from Account row absence, not from a flag on "User"

    @REQ-EA-121
    Scenario: A user can hold at most one password credential
      Given a signed-in user "dave" who already has an Account row with providerId "password"
      When "dave" attempts to set a second password credential
      Then the attempt is rejected as a duplicate (providerId, subject) pair

  # BEH-EA-045 — spec/behaviors/06-domain-users-accounts.md
  @BEH-EA-045
  Rule: A User is never left with zero linked credentials by an unlink operation

    @REQ-EA-122
    Scenario: Unlinking one of several Accounts succeeds
      Given a signed-in user "erin" with Accounts "password" and "google"
      When "erin" unlinks the "google" Account
      Then the "google" Account is removed
      And "erin" still has the "password" Account

    @REQ-EA-123
    Scenario: Unlinking a User's only remaining Account is refused
      Given a signed-in user "frank" with exactly one Account, "password"
      When "frank" attempts to unlink the "password" Account
      Then the unlink is refused

    @REQ-EA-124
    Scenario: The refusal is attributed to the request, not reported as a system failure
      Given a signed-in user "frank" with exactly one Account, "password"
      When "frank" attempts to unlink his only Account
      Then the refusal is reported as an invalid request outcome
      And it is not reported as a system defect

    @REQ-EA-125
    Scenario: A deployment that explicitly allows zero-credential accounts permits the unlink
      Given a signed-in user "grace" with exactly one Account, "password"
      And the deployment's policy explicitly allows leaving a User with zero Accounts
      When "grace" unlinks her only Account
      Then the unlink succeeds

  # BEH-EA-046 — spec/behaviors/06-domain-users-accounts.md
  @BEH-EA-046
  Rule: Deleting a User cascades to its Accounts and Sessions; deleting or unlinking an Account never cascades to Sessions

    @REQ-EA-126
    Scenario: Deleting a User makes every one of its Accounts unreachable
      Given a signed-in user "hank" with Accounts "password" and "google"
      When "hank"'s User row is deleted
      Then both the "password" and "google" Accounts are unreachable

    @REQ-EA-127
    Scenario: Deleting a User makes every one of its Sessions unreachable
      Given a signed-in user "hank" with sessions "s1" and "s2"
      When "hank"'s User row is deleted
      Then both "s1" and "s2" are unreachable

    @REQ-EA-128
    Scenario: Unlinking one Account leaves the User's other Accounts intact
      Given a signed-in user "ivy" with Accounts "password" and "google"
      When "ivy" unlinks the "google" Account
      Then the "password" Account remains intact

    @REQ-EA-129
    Scenario: Unlinking one Account leaves the User's Sessions intact
      Given a signed-in user "ivy" with Accounts "password" and "google", and an active session "s1"
      When "ivy" unlinks the "google" Account
      Then session "s1" remains valid

  # BEH-EA-047 — spec/behaviors/06-domain-users-accounts.md
  @BEH-EA-047
  Rule: A User may have any number of Accounts and any number of concurrent Sessions

    @REQ-EA-130
    Scenario: A User links a password credential, two OAuth providers, and a passkey without limit
      Given a signed-in user "jill" with a password credential
      When "jill" links two OAuth providers and a passkey in addition to her password credential
      Then all four Accounts coexist on "jill"'s User row

    @REQ-EA-131
    Scenario: A User holds many concurrent Sessions without limit
      Given a signed-in user "jill"
      When "jill" signs in from a laptop, a phone, and a CI service account acting on her behalf
      Then all three Sessions are simultaneously valid

    @REQ-EA-132
    Scenario: Signing in on a new device does not revoke a pre-existing session by default
      Given a signed-in user "jill" with an existing valid session "s1"
      When "jill" signs in again from a second device
      Then a new session "s2" is issued
      And session "s1" remains valid, since the base model enforces no single-active-session policy

  # BEH-EA-048 — spec/behaviors/06-domain-users-accounts.md
  @BEH-EA-048
  Rule: A plugin-contributed field on User or Account defaults to client-writable unless the plugin declares otherwise

    @REQ-EA-133
    Scenario: A plugin-contributed field with no explicit write-gate is writable through the generic input path
      Given a plugin contributes a field "nickname" to "User" without declaring it non-writable
      When a client submits a generic update setting "nickname"
      Then the update is applied

    @REQ-EA-134
    Scenario: A plugin that declares a contributed field non-writable prevents client writes to it
      Given a plugin contributes a field "billingTier" to "User" and declares it non-writable in its own schema
      When a client submits a generic update setting "billingTier"
      Then the update to "billingTier" is not applied

    @REQ-EA-135
    Scenario: The base system provides no default protection for a plugin field that omits the write-gate
      Given a plugin contributes a system-authority field "isElevated" to "User" without declaring it non-writable
      When a client submits a generic update setting "isElevated"
      Then the update is applied
      And the resulting corruption is attributable to the contributing plugin's own schema, not to the base system or to any other plugin that later trusts the field
