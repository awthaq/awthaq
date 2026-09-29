# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

# MTI-011 (multi-tenant-isolation-specialist) / CWM-006: authored against the
# real, implemented `@awthaq/organization` plugin, like 27-admin-impersonation.feature.
# Every scenario drives the plugin's HTTP group as a real signed-in caller (a real user with a
# verified address and a real session cookie). The isolation Rule (BEH-EA-259) is adversarial
# by construction: an authenticated caller from one tenant aims at another tenant's identifiers.
# Not yet covered here, tracked in the Rule that owns each: see the @skip rationales.

@organization @multi-tenancy
Feature: Organization

  # BEH-EA-258 — spec/behaviors/31-organization.md; see also ADR-EA-018
  @BEH-EA-258
  Rule: An organization has a unique slug, its creator becomes its first member, and creating one is bounded by policy and quota

    @REQ-EA-708
    Scenario: Creating an organization makes its creator the first member with the owner role
      Given a signed-in user "alice"
      When "alice" creates the organization "acme"
      Then the response is 200
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"

    @REQ-EA-709
    Scenario: The configured creator role is what the creator receives
      Given the creator role is "admin"
      And a signed-in user "alice"
      When "alice" creates the organization "acme"
      Then as seen by "alice", the organization "acme" has exactly the members "alice:admin"

    @REQ-EA-710
    Scenario: A slug already held by another organization is refused with 409 and leaves that organization untouched
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      When "bob" creates the organization "acme"
      Then the response is 409
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"
      And "bob" belongs to exactly the organizations ""

    @REQ-EA-711
    Scenario: The slug check reports whether a slug is free
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      When "alice" checks whether the slug "acme" is available
      Then the slug is reported as taken
      When "alice" checks whether the slug "fresh" is available
      Then the slug is reported as free

    @REQ-EA-712
    Scenario: A caller the application does not allow to create organizations is refused with 403 and nothing is written
      Given nobody may create an organization
      And a signed-in user "alice"
      When "alice" creates the organization "acme"
      Then the response is 403
      And "alice" belongs to exactly the organizations ""

    @REQ-EA-713
    Scenario: A caller who already owns the maximum number of organizations is refused with 403
      Given each user may own at most 1 organization
      And a signed-in user "alice"
      And "alice" has created the organization "acme"
      When "alice" creates the organization "second"
      Then the response is 403
      And "alice" belongs to exactly the organizations "acme"

    @REQ-EA-714
    Scenario: Listing organizations shows only those the caller belongs to
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has created the organization "beta"
      Then "alice" belongs to exactly the organizations "acme"
      And "bob" belongs to exactly the organizations "beta"

  # BEH-EA-259 — spec/behaviors/31-organization.md; see also ADR-EA-018
  @BEH-EA-259
  Rule: Organization data is member-only, and a non-member cannot tell an organization that exists from one that does not

    @REQ-EA-715
    Scenario Outline: A non-member gets the same 404 for <method> <path> as for an organization that does not exist
      Given teams are enabled
      And dynamic access control is enabled
      And a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has created the organization "beta"
      When "bob" sends <method> "<path>" with body '<body>'
      Then the response is 404
      And the response is byte-identical to the one for an organization that does not exist
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"

      Examples:
        | method | path                                                     | body                                                    |
        | GET    | /organization/[org:acme]                                 | -                                                       |
        | GET    | /organization/[org:acme]/full                            | -                                                       |
        | PATCH  | /organization/[org:acme]                                 | {"name":"pwned"}                                        |
        | DELETE | /organization/[org:acme]                                 | -                                                       |
        | GET    | /organization/[org:acme]/members                         | -                                                       |
        | DELETE | /organization/[org:acme]/members/[user:alice]            | -                                                       |
        | PATCH  | /organization/[org:acme]/members/[user:alice]            | {"role":["member"]}                                     |
        | POST   | /organization/[org:acme]/leave                           | -                                                       |
        | GET    | /organization/[org:acme]/invitations                     | -                                                       |
        | POST   | /organization/[org:acme]/invitations                     | {"email":"x@example.com","role":["member"]}             |
        | GET    | /organization/[org:acme]/roles                           | -                                                       |
        | POST   | /organization/[org:acme]/roles                           | {"role":"pwn","permission":{"organization":["delete"]}} |
        | GET    | /organization/[org:acme]/teams                           | -                                                       |
        | POST   | /organization/[org:acme]/teams                           | {"name":"pwn"}                                          |
        | GET    | /organization/[org:acme]/teams/mine                      | -                                                       |
        | GET    | /organization/[org:acme]/teams/some-team/members         | -                                                       |

    @REQ-EA-716
    Scenario: An owner of one organization cannot read or change another organization's roster
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has created the organization "beta"
      When "alice" lists the members of the organization "beta"
      Then the response is 404
      When "alice" removes "bob" from the organization "beta"
      Then the response is 404
      And as seen by "bob", the organization "beta" has exactly the members "bob:owner"

    @REQ-EA-717
    Scenario: A team of another organization cannot be reached by naming it under one's own organization
      Given teams are enabled
      And dynamic access control is enabled
      And a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has created the organization "beta"
      And "bob" has created the team "platform" in the organization "beta"
      When "alice" sends PATCH "/organization/[org:acme]/teams/[id:team:platform]" with body '{"name":"pwned"}'
      Then the response is 404
      When "alice" sends DELETE "/organization/[org:acme]/teams/[id:team:platform]" with body '-'
      Then the response is 404
      When "alice" sends POST "/organization/[org:acme]/teams/[id:team:platform]/members" with body '{"userId":"[user:alice]"}'
      Then the response is 404
      And as seen by "bob", the organization "beta" has the teams "platform"
      And as seen by "bob", the team "platform" of the organization "beta" has 0 members

    @REQ-EA-718
    Scenario: A role of another organization cannot be read, changed or deleted by naming it under one's own organization
      Given teams are enabled
      And dynamic access control is enabled
      And a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has created the organization "beta"
      And "bob" has created the role "billing" in the organization "beta" granting "organization:update"
      When "alice" sends GET "/organization/[org:acme]/roles/[id:role:billing]" with body '-'
      Then the response is 404
      When "alice" sends PATCH "/organization/[org:acme]/roles/[id:role:billing]" with body '{"permission":{"organization":["delete"]}}'
      Then the response is 404
      When "alice" sends DELETE "/organization/[org:acme]/roles/[id:role:billing]" with body '-'
      Then the response is 404
      And as seen by "bob", the role "billing" of the organization "beta" grants exactly "organization:update"

    @REQ-EA-719
    Scenario: An invitation of another organization can be neither read nor cancelled by naming its id
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has created the organization "beta"
      And "bob" has invited "carol@example.com" to the organization "beta" as "member"
      When "alice" cancels the invitation mailed to "carol@example.com"
      Then the response is 404
      When "alice" sends GET "/organization/invitations/[invitation:carol@example.com]" with body '-'
      Then the response is 404
      And as seen by "bob", the organization "beta" has 1 pending invitations for "carol@example.com"

    @REQ-EA-720
    Scenario: With teams disabled a non-member still gets the same 404 for a team endpoint as for an unknown organization
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has created the organization "beta"
      When "bob" sends GET "/organization/[org:acme]/teams" with body '-'
      Then the response is 404
      And the response is byte-identical to the one for an organization that does not exist
      When "bob" sends POST "/organization/[org:acme]/teams" with body '{"name":"pwn"}'
      Then the response is 404
      And the response is byte-identical to the one for an organization that does not exist

    @REQ-EA-721
    Scenario: An outsider cannot make another organization her active organization
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has created the organization "beta"
      When "alice" sets the active organization to "beta"
      Then the response is 404
      When "alice" asks for her active organization
      Then the active organization is none

    @REQ-EA-722
    Scenario: Someone who never signed in reaches nothing
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has created the organization "beta"
      When an anonymous caller sends GET "/organization/[org:acme]" with body '-'
      Then the response is 401
      When an anonymous caller sends GET "/organization" with body '-'
      Then the response is 401

    # @skip: blocked by composition — it needs @awthaq/admin installed beside this plugin to open a
    # real impersonation session, and no test composes the two yet. The impersonation session itself
    # is covered by 27-admin-impersonation.feature (BEH-EA-209..220); what this scenario adds
    # (organization reads resolve to the impersonated user) is not asserted anywhere today.
    @skip
    @REQ-EA-723
    Scenario: An impersonating admin sees only the organizations of the user being impersonated
      Given a signed-in admin actively impersonating "bob"
      When the admin lists organizations
      Then only the organizations "bob" belongs to are listed

  # BEH-EA-260 — spec/behaviors/31-organization.md; see also ADR-EA-018
  @BEH-EA-260
  Rule: An organization always keeps an owner, and only an owner may delete it

    @REQ-EA-724
    Scenario: The last owner cannot be removed
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      When "alice" removes "alice" from the organization "acme"
      Then the response is 409
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"

    @REQ-EA-725
    Scenario: The last owner cannot leave
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      When "alice" leaves the organization "acme"
      Then the response is 409
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"

    @REQ-EA-726
    Scenario: The last owner cannot be demoted
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has joined the organization "acme" as "member"
      When "alice" changes the roles of "alice" in the organization "acme" to "member"
      Then the response is 409
      And as seen by "alice", "alice" holds the roles "owner" in the organization "acme"

    @REQ-EA-727
    Scenario: With a second owner the first owner can leave, and the remaining owner is then the last
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has joined the organization "acme" as "owner"
      When "alice" leaves the organization "acme"
      Then the response is 204
      And as seen by "bob", the organization "acme" has exactly the members "bob:owner"
      When "bob" leaves the organization "acme"
      Then the response is 409

    @REQ-EA-728
    Scenario: An admin cannot delete the organization
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has joined the organization "acme" as "admin"
      When "bob" deletes the organization "acme"
      Then the response is 403
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner,bob:admin"

    @REQ-EA-729
    Scenario: An owner deleting the organization removes it and everything that belonged to it
      Given teams are enabled
      And a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has joined the organization "acme" as "member"
      And "alice" has created the team "platform" in the organization "acme"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "alice" deletes the organization "acme"
      Then the response is 204
      And the organization "acme" answers 404 to "alice"
      And "bob" belongs to exactly the organizations ""
      And no membership, invitation, team or role rows remain for the organization "acme"

    @REQ-EA-730
    Scenario: A deployment that disables deletion refuses even an owner
      Given organization deletion is disabled
      And a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      When "alice" deletes the organization "acme"
      Then the response is 403
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"

  # BEH-EA-261 — spec/behaviors/31-organization.md; see also BEH-EA-060
  @BEH-EA-261
  Rule: An invitation is an emailed capability for one address, with its own lifecycle

    @REQ-EA-731
    Scenario: Inviting mails a token to the address and never shows it on the wire
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      When "alice" invites "carol@example.com" to the organization "acme" as "member"
      Then the response is 200
      And "carol@example.com" was mailed an organization invitation carrying a token
      And no response so far carries that token or any token hash
      When "alice" lists the invitations of the organization "acme"
      Then no response so far carries that token or any token hash

    @REQ-EA-732
    Scenario: The invited user accepts with the emailed token and becomes a member with the invited role
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      And a signed-in user "carol"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 200
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner,carol:member"
      And as seen by "alice", the newest invitation for "carol@example.com" to the organization "acme" is "accepted"

    @REQ-EA-733
    Scenario: An accepted invitation cannot be accepted again
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      And a signed-in user "carol"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      And "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      When "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 409

    @REQ-EA-734
    Scenario: A wrong token is indistinguishable from an invitation that does not exist
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      And a signed-in user "carol"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "carol" accepts the invitation to the organization "acme" with the token "not-the-token"
      Then the response is 404
      And the response is a "InvitationNotFound" error
      When "carol" accepts an invitation that does not exist
      Then the response is 404
      And the response is a "InvitationNotFound" error
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"

    @REQ-EA-735
    Scenario: Someone else holding the forwarded token cannot accept an invitation addressed to another address
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      And a signed-in user "carol"
      And a signed-in user "dave"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "dave" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 403
      And the response is a "InvitationEmailMismatch" error
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"

    @REQ-EA-736
    Scenario: A user whose address is not verified cannot accept, by default
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      And a signed-in user "carol" whose email is not verified
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 403
      And the response is a "EmailVerificationRequired" error
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"

    @REQ-EA-737
    Scenario: An invitation past its expiry is refused with 410 and marked expired
      Given invitations expire after 1 ms
      And a signed-in user "alice"
      And a signed-in user "carol"
      And "alice" has created the organization "acme"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When 25 ms pass
      And "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 410
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"
      And as seen by "alice", the newest invitation for "carol@example.com" to the organization "acme" is "expired"

    @REQ-EA-738
    Scenario: A cancelled invitation cannot be accepted
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      And a signed-in user "carol"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "alice" cancels the invitation mailed to "carol@example.com"
      Then the response is 204
      When "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 409
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner"

    @REQ-EA-739
    Scenario: A rejected invitation cannot be accepted afterwards
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      And a signed-in user "carol"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "carol" rejects the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 204
      When "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 409
      And as seen by "alice", the newest invitation for "carol@example.com" to the organization "acme" is "rejected"

    @REQ-EA-740
    Scenario: Inviting an address that already belongs to a member is refused with 409
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      And a signed-in user "bob"
      And "bob" has joined the organization "acme" as "member"
      When "alice" invites "bob@example.com" to the organization "acme" as "member"
      Then the response is 409

    @REQ-EA-741
    Scenario: Re-inviting a pending address returns the pending invitation instead of creating a second
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "alice" invites "carol@example.com" to the organization "acme" as "member"
      Then the response is 200
      And as seen by "alice", the organization "acme" has 1 pending invitations for "carol@example.com"

    @REQ-EA-742
    Scenario: Where configured, re-inviting cancels the pending invitation and issues a fresh one
      Given re-inviting cancels the pending invitation
      And a signed-in user "alice"
      And a signed-in user "carol"
      And "alice" has created the organization "acme"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      Then as seen by "alice", the organization "acme" has 1 pending invitations for "carol@example.com"
      When "carol" accepts the invitation to the organization "acme" with the first token mailed to "carol@example.com"
      Then the response is 409
      When "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 200

    @REQ-EA-743
    Scenario: A resend mints a new token for the pending invitation and retires the mailed one
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      And a signed-in user "carol"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "alice" invites "carol@example.com" to the organization "acme" as "member" asking for a resend
      Then the response is 200
      And as seen by "alice", the organization "acme" has 1 pending invitations for "carol@example.com"
      When "carol" accepts the invitation to the organization "acme" with the first token mailed to "carol@example.com"
      Then the response is 404
      When "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 200

  # BEH-EA-262 — spec/behaviors/31-organization.md; see also ADR-EA-018
  @BEH-EA-262
  Rule: Membership, invitation and team quotas are enforced per organization

    @REQ-EA-744
    Scenario: A member beyond the membership limit is refused and the invitation stays pending
      Given the membership limit is 2
      And a signed-in user "alice"
      And a signed-in user "bob"
      And a signed-in user "carol"
      And "alice" has created the organization "acme"
      And "bob" has joined the organization "acme" as "member"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the response is 403
      And the response is a "MembershipLimitReached" error
      And as seen by "alice", the organization "acme" has exactly the members "alice:owner,bob:member"
      And as seen by "alice", the newest invitation for "carol@example.com" to the organization "acme" is "pending"

    @REQ-EA-745
    Scenario: An inviter beyond the invitation limit is refused
      Given the invitation limit is 1 per inviter
      And a signed-in user "alice"
      And "alice" has created the organization "acme"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "alice" invites "dave@example.com" to the organization "acme" as "member"
      Then the response is 403
      And the response is a "InvitationLimitReached" error

    @REQ-EA-746
    Scenario: A team beyond the team limit is refused
      Given teams are enabled
      And the team limit is 1
      And a signed-in user "alice"
      And "alice" has created the organization "acme"
      And "alice" has created the team "platform" in the organization "acme"
      When "alice" sends POST "/organization/[org:acme]/teams" with body '{"name":"second"}'
      Then the response is 403
      And the response is a "TeamLimitReached" error
      And as seen by "alice", the organization "acme" has the teams "platform"

    @REQ-EA-747
    Scenario: A team member beyond the per-team limit is refused
      Given teams are enabled
      And the team member limit is 1
      And a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has joined the organization "acme" as "member"
      And "alice" has created the team "platform" in the organization "acme"
      And "alice" has added "alice" to the team "platform" of the organization "acme"
      When "alice" sends POST "/organization/[org:acme]/teams/[id:team:platform]/members" with body '{"userId":"[user:bob]"}'
      Then the response is 403
      And the response is a "TeamMemberLimitReached" error
      And as seen by "alice", the team "platform" of the organization "acme" has 1 members

    @REQ-EA-748
    Scenario: A per-organization override applies to that organization only
      Given the application grants per-organization quotas
      And a signed-in user "alice"
      And a signed-in user "bob"
      And a signed-in user "carol"
      And "alice" has created the organization "acme"
      And "alice" has created the organization "beta"
      And the organization "acme" is on a plan with at most 1 members
      And "alice" has invited "bob@example.com" to the organization "acme" as "member"
      And "alice" has invited "carol@example.com" to the organization "beta" as "member"
      When "bob" accepts the invitation to the organization "acme" with the latest token mailed to "bob@example.com"
      Then the response is 403
      And the response is a "MembershipLimitReached" error
      When "carol" accepts the invitation to the organization "beta" with the latest token mailed to "carol@example.com"
      Then the response is 200

  # BEH-EA-263 — spec/behaviors/31-organization.md; see also ADR-EA-025
  @BEH-EA-263
  Rule: A role can only be conferred by someone who holds everything it grants

    Background:
      Given dynamic access control is enabled
      And a signed-in user "alice"
      And a signed-in user "bob"
      And a signed-in user "carol"
      And "alice" has created the organization "acme"
      And "bob" has joined the organization "acme" as "admin"
      And "carol" has joined the organization "acme" as "member"

    @REQ-EA-749
    Scenario: An admin cannot invite someone as an owner
      When "bob" invites "dave@example.com" to the organization "acme" as "owner"
      Then the response is 403
      And no mail was sent to "dave@example.com"

    @REQ-EA-750
    Scenario: An admin cannot promote a member to owner
      When "bob" changes the roles of "carol" in the organization "acme" to "owner"
      Then the response is 403
      And as seen by "alice", "carol" holds the roles "member" in the organization "acme"

    @REQ-EA-751
    Scenario: An admin cannot change the role of an owner
      Given a signed-in user "dave"
      And "dave" has joined the organization "acme" as "owner"
      When "bob" changes the roles of "alice" in the organization "acme" to "member"
      Then the response is 403
      And as seen by "alice", "alice" holds the roles "owner" in the organization "acme"

    @REQ-EA-752
    Scenario: A member, who holds no mutating statement, cannot invite at all
      When "carol" invites "dave@example.com" to the organization "acme" as "member"
      Then the response is 403
      And no mail was sent to "dave@example.com"

    @REQ-EA-753
    Scenario: A role name nobody defined is refused with 422
      When "alice" invites "dave@example.com" to the organization "acme" as "wizard"
      Then the response is 422

    @REQ-EA-754
    Scenario: A dynamic role granting more than its creator holds is refused
      When "bob" sends POST "/organization/[org:acme]/roles" with body '{"role":"deleter","permission":{"organization":["delete"]}}'
      Then the response is 403
      And the response is a "RolePermissionEscalation" error

    @REQ-EA-755
    Scenario: A dynamic role within its creator's own statements is created
      When "bob" sends POST "/organization/[org:acme]/roles" with body '{"role":"billing","permission":{"organization":["update"]}}'
      Then the response is 200

    @REQ-EA-756
    Scenario: An existing dynamic role cannot be widened beyond what the editor holds
      Given "alice" has created the role "billing" in the organization "acme" granting "organization:update"
      When "bob" sends PATCH "/organization/[org:acme]/roles/[id:role:billing]" with body '{"permission":{"organization":["delete"]}}'
      Then the response is 403
      And as seen by "alice", the role "billing" of the organization "acme" grants exactly "organization:update"

    @REQ-EA-757
    Scenario Outline: A dynamic role cannot take the reserved name <name>
      When "alice" sends POST "/organization/[org:acme]/roles" with body '{"role":"<name>","permission":{"organization":["update"]}}'
      Then the response is 409

      Examples:
        | name   |
        | owner  |
        | admin  |
        | member |

  # BEH-EA-264 — spec/behaviors/31-organization.md
  @BEH-EA-264
  Rule: The active organization is per session, requires membership, and never outlives it

    Background:
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"

    @REQ-EA-758
    Scenario: A member sets and reads back her active organization
      When "alice" sets the active organization to "acme"
      Then the response is 200
      When "alice" asks for her active organization
      Then the active organization is "acme"

    @REQ-EA-759
    Scenario: Clearing the active organization returns the session to no organization
      Given "alice" has set the active organization to "acme"
      When "alice" clears the active organization
      Then the response is 200
      When "alice" asks for her active organization
      Then the active organization is none

    @REQ-EA-760
    Scenario: Two sessions of one user hold independent active organizations
      Given a second session "alice's phone" for "alice"
      And "alice" has set the active organization to "acme"
      When "alice's phone" asks for her active organization
      Then the active organization is none

    @REQ-EA-761
    Scenario: Someone who is not a member cannot make the organization active
      Given a signed-in user "bob"
      When "bob" sets the active organization to "acme"
      Then the response is 404
      When "bob" asks for her active organization
      Then the active organization is none

    @REQ-EA-762
    Scenario: Once removed from the organization the active context reads as cleared
      Given a signed-in user "bob"
      And "bob" has joined the organization "acme" as "member"
      And "bob" has set the active organization to "acme"
      When "alice" removes "bob" from the organization "acme"
      Then the response is 204
      When "bob" asks for her active organization
      Then the active organization is none

    @REQ-EA-763
    Scenario: Once the user has left the organization the active context reads as cleared
      Given a signed-in user "bob"
      And "bob" has joined the organization "acme" as "member"
      And "bob" has set the active organization to "acme"
      When "bob" leaves the organization "acme"
      Then the response is 204
      When "bob" asks for her active organization
      Then the active organization is none

  # BEH-EA-265 — spec/behaviors/31-organization.md; see also BEH-EA-090, BEH-EA-092
  @BEH-EA-265
  Rule: Organization changes are published as events, and a hook can veto them

    @REQ-EA-764
    Scenario: Inviting publishes one invitationCreated event that names ids only
      Given a signed-in user "alice"
      And "alice" has created the organization "acme"
      When "alice" invites "carol@example.com" to the organization "acme" as "member"
      Then the event "auth.organization.invitationCreated" was published 1 times
      And the published "auth.organization.invitationCreated" event carries no email address and no token

    @REQ-EA-765
    Scenario: Accepting an invitation publishes a memberAdded event
      Given a signed-in user "alice"
      And a signed-in user "carol"
      And "alice" has created the organization "acme"
      And "alice" has invited "carol@example.com" to the organization "acme" as "member"
      When "carol" accepts the invitation to the organization "acme" with the latest token mailed to "carol@example.com"
      Then the event "auth.organization.memberAdded" was published once for "carol"
      And the event "auth.organization.invitationAccepted" was published 1 times

    @REQ-EA-766
    Scenario: Removing a member publishes a memberRemoved event
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has joined the organization "acme" as "member"
      When "alice" removes "bob" from the organization "acme"
      Then the response is 204
      And the event "auth.organization.memberRemoved" was published once for "bob"

    @REQ-EA-767
    Scenario: A veto hook aborts an invitation with a typed 403 and nothing is written or mailed
      Given a hook vetoes invitations to "blocked@example.com"
      And a signed-in user "alice"
      And "alice" has created the organization "acme"
      When "alice" invites "blocked@example.com" to the organization "acme" as "member"
      Then the response is 403
      And the response is a "HookAborted" error
      And no mail was sent to "blocked@example.com"
      And as seen by "alice", the organization "acme" has 0 pending invitations for "blocked@example.com"

    @REQ-EA-768
    Scenario: A failing observer hook never changes the outcome of the operation it observes
      Given a hook observer fails after every organization creation
      And a signed-in user "alice"
      When "alice" creates the organization "acme"
      Then the response is 200
      And "alice" belongs to exactly the organizations "acme"

    @REQ-EA-769
    Scenario: Erasing an account removes its memberships, invitations and active context
      Given a signed-in user "alice"
      And a signed-in user "bob"
      And "alice" has created the organization "acme"
      And "bob" has joined the organization "acme" as "admin"
      And "bob" has set the active organization to "acme"
      And "bob" has invited "carol@example.com" to the organization "acme" as "member"
      When the account of "bob" is erased
      Then as seen by "alice", the organization "acme" has exactly the members "alice:owner"
      And as seen by "alice", the organization "acme" has 0 pending invitations for "carol@example.com"
