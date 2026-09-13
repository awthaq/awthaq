# Shipping-gap map (.scratch/shipping-gaps), ticket 24: authored against
# the real, already-implemented `@effect-auth/admin` plugin (unlike every
# other file in this directory, written before implementation existed) —
# spec/behaviors/27-admin-impersonation.md never got its own `.feature`
# file at spec-authoring time. REQ-EA numbers below continue past 381
# (Passkey's own last), assigned here for the first time.

@admin @impersonation
Feature: Admin and Impersonation

  # BEH-EA-209 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-209
  Rule: actingAs becomes a real, generic field on session issuance

    @REQ-EA-400
    Scenario: A successful impersonate call persists actingAs on the newly-issued session row itself
      Given a signed-in admin permitted to impersonate
      When the admin calls "admin.impersonate" for a target user with a valid reason
      Then the target's newly-issued session row carries "actingAs" set to the admin's own identity

  # BEH-EA-210 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-210
  Rule: A session carrying actingAs never idle-refreshes

    @REQ-EA-401
    Scenario: An impersonation session's idleExpiresAt equals its absoluteExpiresAt at issuance
      Given a signed-in admin permitted to impersonate
      When the admin calls "admin.impersonate" for a target user with a valid reason
      Then the newly-issued session's "idleExpiresAt" equals its "absoluteExpiresAt"

  # BEH-EA-211 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-211
  Rule: resolvePrincipal closes the loop to UserPrincipal.actingAs

    @REQ-EA-402
    Scenario: Resolving the principal for an impersonation session's own token surfaces actingAs on the principal
      Given a signed-in admin actively impersonating a target user
      When the impersonation session's own token is resolved to a principal
      Then the resolved "UserPrincipal" carries "actingAs" set to the admin's own identity

  # BEH-EA-212 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-212
  Rule: The admin gate is a config-supplied predicate, fail-closed by default

    @REQ-EA-382
    Scenario: With no explicit canImpersonate configured, impersonation is denied by default
      Given an application composing "Admin" with no explicit "canImpersonate" predicate configured
      When a signed-in user calls "admin.impersonate" for another user
      Then the call is denied with "403 Forbidden"

    @REQ-EA-383
    Scenario: A configured predicate that resolves true allows the call to proceed
      Given "Admin" configured with a "canImpersonate" predicate that always resolves "true"
      When a signed-in user calls "admin.impersonate" for another user with a valid reason
      Then the call succeeds

    @REQ-EA-384
    Scenario: A configured predicate that resolves false denies the call before any session is issued
      Given "Admin" configured with a "canImpersonate" predicate that always resolves "false"
      When a signed-in user calls "admin.impersonate" for another user
      Then the call is denied with "403 Forbidden"
      And no new session is issued for the target user

  # BEH-EA-213 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-213
  Rule: impersonate issues a new, dual-identity session for the target

    @REQ-EA-385
    Scenario: A successful impersonate call answers with a session cookie for the target, leaving the caller's own session untouched
      Given a signed-in admin with an active session of their own
      When the admin calls "admin.impersonate" for a target user with a valid reason
      Then the response carries a new session cookie, distinct from the admin's own
      And the admin's own original session cookie still authenticates afterward

    @REQ-EA-386
    Scenario: A reason that is empty after trimming is rejected
      Given a signed-in admin permitted to impersonate
      When the admin calls "admin.impersonate" for a target user with a reason of only whitespace
      Then the call is rejected with "400 Bad Request"

    @REQ-EA-387
    Scenario: A reason longer than 1000 characters is rejected
      Given a signed-in admin permitted to impersonate
      When the admin calls "admin.impersonate" for a target user with a reason over 1000 characters long
      Then the call is rejected with "400 Bad Request"

  # BEH-EA-214 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-214
  Rule: Self-impersonation and nested impersonation are refused

    @REQ-EA-388
    Scenario: Impersonating oneself is refused
      Given a signed-in admin permitted to impersonate
      When the admin calls "admin.impersonate" naming their own user id as the target
      Then the call is rejected with "400 Bad Request" and the typed error "AdminSelfImpersonationRefused"

    @REQ-EA-389
    Scenario: Starting a second impersonation from an already-impersonating session is refused
      Given a signed-in admin actively impersonating a target user
      When the admin's impersonation session calls "admin.impersonate" for a different target user
      Then the call is rejected with "409 Conflict" and the typed error "AdminAlreadyImpersonating"

  # BEH-EA-215 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-215
  Rule: admin_impersonation is a durable audit trail

    @REQ-EA-390
    Scenario: A successful impersonate call inserts one audit row at the same time it issues the session
      Given a signed-in admin permitted to impersonate
      When the admin calls "admin.impersonate" for a target user with a valid reason
      Then a new row appears in the impersonation audit trail for that admin, target, and session
      And its "endedAt"/"endedBy" fields are still unset

    @REQ-EA-391
    Scenario: endedAt/endedBy are populated exactly once, by whichever stop path runs first
      Given a signed-in admin actively impersonating a target user
      When the admin calls "admin.stopImpersonating"
      Then the matching audit row's "endedAt" and "endedBy" are set to "self"

  # BEH-EA-216 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-216
  Rule: stopImpersonating revokes with no session handback

    @REQ-EA-392
    Scenario: stopImpersonating revokes the caller's current impersonation session and issues no replacement
      Given a signed-in admin actively impersonating a target user
      When the admin's impersonation session calls "admin.stopImpersonating"
      Then the call succeeds with "204 No Content" and no new session cookie is issued
      And the revoked impersonation session no longer authenticates
      And the admin's own original session cookie still authenticates

    @REQ-EA-393
    Scenario: stopImpersonating called from a session that never carried actingAs fails
      Given a signed-in admin with an ordinary, non-impersonating session
      When that session calls "admin.stopImpersonating"
      Then the call fails, since the session carries no "actingAs" to end

  # BEH-EA-217 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-217
  Rule: forceStop lets another admin end someone else's impersonation

    @REQ-EA-394
    Scenario: A second admin can force-stop another admin's active impersonation episode
      Given one admin actively impersonating a target user, identified by that impersonation session's id
      When a second admin permitted to impersonate calls "admin.forceStop" naming that session id
      Then the call succeeds with "204 No Content"
      And the named impersonation session no longer authenticates
      And the matching audit row's "endedBy" is set to "forcedByAdmin"

    @REQ-EA-395
    Scenario: forceStop on an already-ended or unknown session id fails
      Given an impersonation session id that has already been force-stopped once
      When "admin.forceStop" is called again naming that same session id
      Then the call fails with "404 Not Found" and the typed error "AdminImpersonationNotFound"

    @REQ-EA-396
    Scenario: forceStop is gated by the identical canImpersonate predicate impersonate uses
      Given "Admin" configured with a "canImpersonate" predicate that always resolves "false"
      When a signed-in user calls "admin.forceStop" naming any session id
      Then the call is denied with "403 Forbidden", the same gate "admin.impersonate" itself is held to

  # BEH-EA-218 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-218
  Rule: Three audit events bound the impersonation lifecycle

    @REQ-EA-403
    Scenario: A successful impersonate publishes auth.admin.impersonationStarted
      Given a signed-in admin permitted to impersonate
      When the admin calls "admin.impersonate" for a target user with a valid reason
      Then an "auth.admin.impersonationStarted" event is published, carrying the admin, target, reason, and session id

    @REQ-EA-404
    Scenario: Either stop path publishes auth.admin.impersonationStopped
      Given a signed-in admin actively impersonating a target user
      When the admin's impersonation session calls "admin.stopImpersonating"
      Then an "auth.admin.impersonationStopped" event is published, carrying the session id and "self"

    @REQ-EA-405
    Scenario: A denied gate publishes auth.admin.impersonationDenied
      Given "Admin" configured with a "canImpersonate" predicate that always resolves "false"
      When a signed-in user calls "admin.impersonate" for another user
      Then an "auth.admin.impersonationDenied" event is published

    @REQ-EA-406
    Scenario: Self-impersonation and already-impersonating refusals do not publish impersonationDenied
      Given a signed-in admin permitted to impersonate
      When the admin calls "admin.impersonate" naming their own user id as the target
      Then no "auth.admin.impersonationDenied" event is published, since this is an ordinary validation failure, not a gate rejection

  # BEH-EA-219 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-219
  Rule: The audit trail is queryable

    @REQ-EA-397
    Scenario: Listing with no filter returns the full impersonation history, newest first
      Given an admin who has both an ended and a currently-active impersonation episode
      When the admin calls "admin.list" with no filter
      Then both episodes are returned, ordered newest first

    @REQ-EA-398
    Scenario: Listing with active=true narrows to episodes whose endedAt is still null
      Given an admin who has both an ended and a currently-active impersonation episode
      When the admin calls "admin.list" with "active=true"
      Then only the currently-active episode is returned

  # BEH-EA-220 — spec/behaviors/27-admin-impersonation.md
  @BEH-EA-220
  Rule: Impersonation never touches the target's own sessions

    @REQ-EA-399
    Scenario: A target user's own pre-existing session remains valid and untouched by being impersonated
      Given a target user with their own active session, issued before any impersonation begins
      When an admin impersonates that target user
      Then the target's own original session cookie still authenticates afterward, unaffected
